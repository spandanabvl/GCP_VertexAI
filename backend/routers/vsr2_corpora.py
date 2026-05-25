from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import text

from google.cloud import aiplatform
from vertexai.preview import rag

from config import PROJECT_ID
from database import get_db

# Vector Search 2.0 MUST use us-central1
VS2_LOCATION = "us-central1"

router = APIRouter()


class CreateVSR2CorpusRequest(BaseModel):
    display_name: str


def _init_serverless():
    """Switch project to RAG serverless mode and init aiplatform."""
    aiplatform.init(project=PROJECT_ID, location=VS2_LOCATION)
    rag_engine_config_name = f"projects/{PROJECT_ID}/locations/{VS2_LOCATION}/ragEngineConfig"
    new_config = rag.RagEngineConfig(
        name=rag_engine_config_name,
        rag_managed_db_config=rag.RagManagedDbConfig(mode=rag.Serverless()),
    )
    rag.rag_data.update_rag_engine_config(rag_engine_config=new_config)


# ── POST /vsr2-corpora/ ────────────────────────────────────────────────────────

@router.post("/")
def create_corpus(req: CreateVSR2CorpusRequest, db: Session = Depends(get_db)):
    try:
        _init_serverless()
        vector_db  = rag.RagManagedVertexVectorSearch()
        rag_corpus = rag.create_corpus(
            display_name=req.display_name,
            backend_config=rag.RagVectorDbConfig(vector_db=vector_db),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Corpus creation failed: {e}")

    db.execute(text("""
        INSERT INTO vsr2_corpora (corpus_name, display_name)
        VALUES (:cn, :dn)
        ON CONFLICT (corpus_name) DO NOTHING
    """), {"cn": rag_corpus.name, "dn": req.display_name})
    db.commit()

    return {
        "corpus_name":  rag_corpus.name,
        "display_name": req.display_name,
    }


# ── GET /vsr2-corpora/ ─────────────────────────────────────────────────────────

@router.get("/")
def list_corpora(db: Session = Depends(get_db)):
    rows = db.execute(text("""
        SELECT corpus_name, display_name, created_at
        FROM   vsr2_corpora
        ORDER  BY created_at DESC
    """)).fetchall()
    return [
        {"corpus_name": r[0], "display_name": r[1], "created_at": str(r[2])}
        for r in rows
    ]


# ── DELETE /vsr2-corpora/ ──────────────────────────────────────────────────────

@router.delete("/")
def delete_corpus(corpus_name: str, db: Session = Depends(get_db)):
    aiplatform.init(project=PROJECT_ID, location=VS2_LOCATION)
    try:
        rag.delete_corpus(name=corpus_name)
    except Exception as e:
        if "not found" not in str(e).lower():
            raise HTTPException(status_code=500, detail=str(e))

    db.execute(text("DELETE FROM vsr2_corpora WHERE corpus_name = :cn"), {"cn": corpus_name})
    db.execute(text("DELETE FROM vsr2_conversations WHERE corpus_name = :cn"), {"cn": corpus_name})
    db.commit()
    return {"deleted": corpus_name}