import json
from typing import Optional

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import text

import vertexai
from vertexai.generative_models import GenerativeModel
from vertexai.preview import rag

from config import PROJECT_ID, LOCATION
from database import get_db
from flow_stream import ndjson_line

vertexai.init(project=PROJECT_ID, location=LOCATION)

router = APIRouter()


class ChatRequest(BaseModel):
    corpus_name: str
    corpus_display_name: str
    question: str
    top_k: int = 5
    conversation_id: Optional[str] = None


@router.post("/")
def chat(req: ChatRequest, db: Session = Depends(get_db)):
    def stream():
        conversation_id = req.conversation_id
        contexts = []
        answer = ""

        try:
            yield ndjson_line({
                "phase": "retrieving",
                "message": "rag.retrieval_query · similarity_top_k…",
            })

            try:
                response = rag.retrieval_query(
                    rag_resources=[rag.RagResource(rag_corpus=req.corpus_name)],
                    text=req.question,
                    similarity_top_k=req.top_k,
                )
                contexts = [c.text for c in response.contexts.contexts]
            except Exception:
                contexts = []

            yield ndjson_line({
                "phase": "retrieved",
                "message": f"Retrieved {len(contexts)} chunk(s)",
                "chunks_used": len(contexts),
            })

            combined_context = (
                "\n\n".join(contexts) if contexts else "No relevant context found."
            )

            yield ndjson_line({
                "phase": "generating",
                "message": "Gemini 2.5 Flash · generate…",
            })

            prompt = f"""Answer using the context below. If the context does not contain enough information, say so clearly.

Context:
{combined_context}

Question:
{req.question}"""

            result = GenerativeModel("gemini-2.5-flash").generate_content(prompt)
            answer = result.text

            yield ndjson_line({
                "phase": "saving",
                "message": "PostgreSQL · persist conversation…",
            })

            if not conversation_id:
                title = req.question[:60]
                row = db.execute(text("""
                    INSERT INTO conversations
                        (corpus_name, corpus_display_name, title, messages)
                    VALUES
                        (:cn, :cdn, :title, '[]'::jsonb)
                    RETURNING id
                """), {
                    "cn": req.corpus_name,
                    "cdn": req.corpus_display_name,
                    "title": title,
                })
                conversation_id = str(row.fetchone()[0])
                db.commit()

            new_msgs = json.dumps([
                {"role": "user", "text": req.question},
                {"role": "assistant", "text": answer, "chunks_used": len(contexts)},
            ])

            db.execute(text("""
                UPDATE conversations
                SET messages   = messages || CAST(:new_msgs AS jsonb),
                    updated_at = NOW()
                WHERE id = :id
            """), {"new_msgs": new_msgs, "id": conversation_id})
            db.commit()

            yield ndjson_line({
                "phase": "complete",
                "answer": answer,
                "chunks_used": len(contexts),
                "conversation_id": conversation_id,
            })
        except Exception as exc:
            db.rollback()
            yield ndjson_line({"phase": "error", "detail": str(exc)})

    return StreamingResponse(stream(), media_type="application/x-ndjson")


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
            "id": str(r[0]),
            "title": r[1] or "Untitled",
            "updated_at": str(r[2]),
        }
        for r in rows
    ]


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
        "id": str(row[0]),
        "title": row[1] or "Untitled",
        "messages": row[2],
    }


@router.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: str, db: Session = Depends(get_db)):
    db.execute(text("DELETE FROM conversations WHERE id = :id"), {"id": conversation_id})
    db.commit()
    return {"deleted": conversation_id}
