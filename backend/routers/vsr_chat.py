import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import text

from google import genai
from google.genai.types import (
    GenerateContentConfig,
    Retrieval,
    Tool,
    VertexRagStore,
    VertexRagStoreRagResource,
)

from config import PROJECT_ID, LOCATION
from database import get_db

router = APIRouter()

MODEL_ID = "gemini-2.5-flash"

# Initialise google.genai client (different from vertexai SDK used elsewhere)
_client = genai.Client(
    vertexai=True,
    project=PROJECT_ID,
    location=LOCATION,
)


# ── Request model ──────────────────────────────────────────────────────────────

class VSRChatRequest(BaseModel):
    corpus_name:              str
    question:                 str
    similarity_top_k:         int   = 10
    vector_distance_threshold: float = 0.4
    conversation_id:          Optional[str] = None


# ── POST /vsr-chat/ ────────────────────────────────────────────────────────────

@router.post("/")
def vsr_chat(req: VSRChatRequest, db: Session = Depends(get_db)):

    # 1. Resolve or create conversation
    if not req.conversation_id:
        row = db.execute(text("""
            INSERT INTO vsr_conversations (corpus_name, title, messages)
            VALUES (:cn, :title, '[]'::jsonb)
            RETURNING id
        """), {"cn": req.corpus_name, "title": req.question[:60]})
        conversation_id = str(row.fetchone()[0])
        db.commit()
    else:
        conversation_id = req.conversation_id

    # 2. Build retrieval tool with user-controlled parameters
    rag_retrieval_tool = Tool(
        retrieval=Retrieval(
            vertex_rag_store=VertexRagStore(
                rag_resources=[
                    VertexRagStoreRagResource(rag_corpus=req.corpus_name)
                ],
                similarity_top_k=req.similarity_top_k,
                vector_distance_threshold=req.vector_distance_threshold,
            )
        )
    )

    # 3. Build conversation history for multi-turn context
    conv_row = db.execute(text("""
        SELECT messages FROM vsr_conversations WHERE id = CAST(:id AS uuid)
    """), {"id": conversation_id}).fetchone()
    prior = conv_row[0] if conv_row else []

    # google.genai uses a flat contents list for history
    contents = []
    for m in (prior if isinstance(prior, list) else []):
        role    = "user" if m.get("role") == "user" else "model"
        content = m.get("text", "")
        if content:
            contents.append({"role": role, "parts": [{"text": content}]})

    # Add the new user question
    contents.append({"role": "user", "parts": [{"text": req.question}]})

    # 4. Generate with google.genai client (as in the notebook)
    try:
        response = _client.models.generate_content(
            model=MODEL_ID,
            contents=contents,
            config=GenerateContentConfig(tools=[rag_retrieval_tool]),
        )
        answer = response.text
    except Exception as e:
        answer = f"Generation failed: {e}"

    # 5. Save to DB
    new_msgs = json.dumps([
        {"role": "user",      "text": req.question},
        {
            "role":                     "assistant",
            "text":                     answer,
            "similarity_top_k":         req.similarity_top_k,
            "vector_distance_threshold": req.vector_distance_threshold,
        },
    ])
    db.execute(text("""
        UPDATE vsr_conversations
        SET messages   = messages || CAST(:new_msgs AS jsonb),
            updated_at = NOW()
        WHERE id = CAST(:id AS uuid)
    """), {"new_msgs": new_msgs, "id": conversation_id})
    db.commit()

    return {
        "answer":                     answer,
        "similarity_top_k":           req.similarity_top_k,
        "vector_distance_threshold":  req.vector_distance_threshold,
        "conversation_id":            conversation_id,
    }


# ── GET /vsr-chat/conversations ────────────────────────────────────────────────

@router.get("/conversations")
def list_conversations(corpus_name: str, db: Session = Depends(get_db)):
    rows = db.execute(text("""
        SELECT id, title, updated_at
        FROM   vsr_conversations
        WHERE  corpus_name = :cn
        ORDER  BY updated_at DESC
    """), {"cn": corpus_name}).fetchall()
    return [{"id": str(r[0]), "title": r[1] or "Untitled", "updated_at": str(r[2])} for r in rows]


# ── GET /vsr-chat/conversations/{id} ──────────────────────────────────────────

@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: str, db: Session = Depends(get_db)):
    row = db.execute(text("""
        SELECT id, title, messages FROM vsr_conversations WHERE id = CAST(:id AS uuid)
    """), {"id": conversation_id}).fetchone()
    if not row:
        return {"error": "Not found"}
    return {"id": str(row[0]), "title": row[1] or "Untitled", "messages": row[2]}


# ── DELETE /vsr-chat/conversations/{id} ───────────────────────────────────────

@router.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: str, db: Session = Depends(get_db)):
    db.execute(
        text("DELETE FROM vsr_conversations WHERE id = CAST(:id AS uuid)"),
        {"id": conversation_id},
    )
    db.commit()
    return {"deleted": conversation_id}
