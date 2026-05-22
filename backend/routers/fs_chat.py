import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import text

import vertexai
from vertexai.preview import rag
from vertexai.generative_models import Content, GenerativeModel, Part, Tool

from config import PROJECT_ID, LOCATION
from database import get_db

vertexai.init(project=PROJECT_ID, location=LOCATION)

router = APIRouter()


# ── Request model ──────────────────────────────────────────────────────────────

class FSChatRequest(BaseModel):
    corpus_name:     str
    question:        str
    top_k:           int   = 5
    alpha:           float = 0.5   # 0 = sparse/keyword, 1 = dense/semantic
    conversation_id: Optional[str] = None


# ── POST /fs-chat/ ─────────────────────────────────────────────────────────────

@router.post("/")
def fs_chat(req: FSChatRequest, db: Session = Depends(get_db)):

    # 1. Resolve conversation row
    if not req.conversation_id:
        row = db.execute(text("""
            INSERT INTO fs_conversations (corpus_name, title, messages)
            VALUES (:cn, :title, '[]'::jsonb)
            RETURNING id
        """), {"cn": req.corpus_name, "title": req.question[:60]})
        conversation_id = str(row.fetchone()[0])
        db.commit()
    else:
        conversation_id = req.conversation_id

    # 2. Build RAG retrieval tool with hybrid search
    rag_tool = Tool.from_retrieval(
        retrieval=rag.Retrieval(
            source=rag.VertexRagStore(
                rag_resources=[rag.RagResource(rag_corpus=req.corpus_name)],
                rag_retrieval_config=rag.RagRetrievalConfig(
                    top_k=req.top_k,
                    hybrid_search=rag.HybridSearch(alpha=req.alpha),
                ),
            ),
        )
    )

    # 3. Build conversation history for Gemini context
    conv_row = db.execute(text("""
        SELECT messages FROM fs_conversations WHERE id = CAST(:id AS uuid)
    """), {"id": conversation_id}).fetchone()
    prior_messages = conv_row[0] if conv_row else []

    # Convert stored messages into Gemini-compatible history (Content objects required)
    gemini_history = []
    for m in (prior_messages if isinstance(prior_messages, list) else []):
        role    = "user" if m.get("role") == "user" else "model"
        content = m.get("text", "")
        if content:
            gemini_history.append(
                Content(role=role, parts=[Part.from_text(content)])
            )

    # 4. Generate answer with Gemini using RAG tool
    try:
        model = GenerativeModel(
            model_name="gemini-2.5-flash",
            tools=[rag_tool],
        )
        # Use chat for multi-turn context
        chat  = model.start_chat(history=gemini_history)
        response = chat.send_message(req.question)
        answer   = response.text
    except Exception as e:
        answer = f"Generation failed: {e}"

    # 5. Save to DB
    new_msgs = json.dumps([
        {"role": "user",      "text": req.question},
        {"role": "assistant", "text": answer, "top_k": req.top_k, "alpha": req.alpha},
    ])
    db.execute(text("""
        UPDATE fs_conversations
        SET messages   = messages || CAST(:new_msgs AS jsonb),
            updated_at = NOW()
        WHERE id = CAST(:id AS uuid)
    """), {"new_msgs": new_msgs, "id": conversation_id})
    db.commit()

    return {
        "answer":          answer,
        "top_k":           req.top_k,
        "alpha":           req.alpha,
        "conversation_id": conversation_id,
    }


# ── GET /fs-chat/conversations ─────────────────────────────────────────────────

@router.get("/conversations")
def list_conversations(corpus_name: str, db: Session = Depends(get_db)):
    rows = db.execute(text("""
        SELECT id, title, updated_at
        FROM   fs_conversations
        WHERE  corpus_name = :cn
        ORDER  BY updated_at DESC
    """), {"cn": corpus_name}).fetchall()
    return [{"id": str(r[0]), "title": r[1] or "Untitled", "updated_at": str(r[2])} for r in rows]


# ── GET /fs-chat/conversations/{id} ───────────────────────────────────────────

@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: str, db: Session = Depends(get_db)):
    row = db.execute(text("""
        SELECT id, title, messages FROM fs_conversations WHERE id = CAST(:id AS uuid)
    """), {"id": conversation_id}).fetchone()
    if not row:
        return {"error": "Not found"}
    return {"id": str(row[0]), "title": row[1] or "Untitled", "messages": row[2]}


# ── DELETE /fs-chat/conversations/{id} ────────────────────────────────────────

@router.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: str, db: Session = Depends(get_db)):
    db.execute(
        text("DELETE FROM fs_conversations WHERE id = CAST(:id AS uuid)"),
        {"id": conversation_id},
    )
    db.commit()
    return {"deleted": conversation_id}