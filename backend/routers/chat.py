import json
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import text

import vertexai
from vertexai.generative_models import GenerativeModel
from vertexai.preview import rag

from config import PROJECT_ID, LOCATION
from database import get_db

vertexai.init(project=PROJECT_ID, location=LOCATION)

router = APIRouter()


# ── Request / Response models ──────────────────────────────────────────────────

class ChatRequest(BaseModel):
    corpus_name: str
    corpus_display_name: str
    question: str
    top_k: int = 5
    conversation_id: Optional[str] = None   # None → start a new conversation


# ── POST /chat/  (send a message) ─────────────────────────────────────────────

@router.post("/")
def chat(req: ChatRequest, db: Session = Depends(get_db)):

    # 1. Create a new conversation row if this is the first message
    if not req.conversation_id:
        title = req.question[:60]
        row = db.execute(text("""
            INSERT INTO conversations
                (corpus_name, corpus_display_name, title, messages)
            VALUES
                (:cn, :cdn, :title, '[]'::jsonb)
            RETURNING id
        """), {
            "cn":    req.corpus_name,
            "cdn":   req.corpus_display_name,
            "title": title,
        })
        conversation_id = str(row.fetchone()[0])
        db.commit()
    else:
        conversation_id = req.conversation_id

    # 2. RAG retrieval
    try:
        response = rag.retrieval_query(
            rag_resources=[rag.RagResource(rag_corpus=req.corpus_name)],
            text=req.question,
            similarity_top_k=req.top_k,
        )
        contexts = [c.text for c in response.contexts.contexts]
    except Exception as e:
        contexts = []

    combined_context = "\n\n".join(contexts) if contexts else "No relevant context found."

    # 3. Generate answer with Gemini
    prompt = f"""Answer using the context below. If the context does not contain enough information, say so clearly.

Context:
{combined_context}

Question:
{req.question}"""

    result = GenerativeModel("gemini-2.5-flash").generate_content(prompt)
    answer = result.text

    # 4. Append both messages to the JSONB array in one atomic update
    new_msgs = json.dumps([
        {"role": "user",      "text": req.question},
        {"role": "assistant", "text": answer, "chunks_used": len(contexts)},
    ])

    db.execute(text("""
        UPDATE conversations
        SET messages   = messages || CAST(:new_msgs AS jsonb),
            updated_at = NOW()
        WHERE id = :id
    """), {"new_msgs": new_msgs, "id": conversation_id})
    db.commit()

    return {
        "answer":          answer,
        "chunks_used":     len(contexts),
        "conversation_id": conversation_id,
    }


# ── GET /chat/conversations  (list for a corpus) ──────────────────────────────

@router.get("/conversations")
def list_conversations(corpus_name: str, db: Session = Depends(get_db)):
    rows = db.execute(text("""
        SELECT id, title, updated_at
        FROM   conversations
        WHERE  corpus_name = :cn
        ORDER  BY updated_at DESC
    """), {"cn": corpus_name}).fetchall()

    return [
        {
            "id":         str(r[0]),
            "title":      r[1] or "Untitled",
            "updated_at": str(r[2]),
        }
        for r in rows
    ]


# ── GET /chat/conversations/{id}  (load full history) ─────────────────────────

@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: str, db: Session = Depends(get_db)):
    row = db.execute(text("""
        SELECT id, title, messages
        FROM   conversations
        WHERE  id = :id
    """), {"id": conversation_id}).fetchone()

    if not row:
        return {"error": "Conversation not found"}

    return {
        "id":       str(row[0]),
        "title":    row[1] or "Untitled",
        "messages": row[2],   # already a list of dicts (JSONB → Python)
    }


# ── DELETE /chat/conversations/{id} ───────────────────────────────────────────

@router.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: str, db: Session = Depends(get_db)):
    db.execute(text("DELETE FROM conversations WHERE id = :id"), {"id": conversation_id})
    db.commit()
    return {"deleted": conversation_id}
