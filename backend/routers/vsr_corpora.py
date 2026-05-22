from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import text

import vertexai
from vertexai import rag

from config import PROJECT_ID, LOCATION
from database import get_db
from services.vsr_vector_infra import provision_vector_search, teardown_vector_search

vertexai.init(project=PROJECT_ID, location=LOCATION)

router = APIRouter()


class CreateVSRCorpusRequest(BaseModel):
    display_name:            str   # RAG corpus display name
    index_display_name:      str   # Vector Search index display name (created in GCP)
    endpoint_display_name:   str   # Vector Search endpoint display name (created in GCP)


# ── POST /vsr-corpora/ ─────────────────────────────────────────────────────────

@router.post("/")
def create_corpus(req: CreateVSRCorpusRequest, db: Session = Depends(get_db)):
    try:
        infra = provision_vector_search(
            req.index_display_name.strip(),
            req.endpoint_display_name.strip(),
        )
        vector_db = rag.VertexVectorSearch(
            index=infra["index_resource_name"],
            index_endpoint=infra["endpoint_resource_name"],
        )
        rag_corpus = rag.create_corpus(
            display_name=req.display_name,
            backend_config=rag.RagVectorDbConfig(vector_db=vector_db),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Corpus creation failed: {e}")

    db.execute(text("""
        INSERT INTO vsr_corpora
            (corpus_name, display_name, index_resource_name,
             endpoint_resource_name, deployed_index_id)
        VALUES (:cn, :dn, :idx, :ep, :did)
        ON CONFLICT (corpus_name) DO NOTHING
    """), {
        "cn":  rag_corpus.name,
        "dn":  req.display_name,
        "idx": infra["index_resource_name"],
        "ep":  infra["endpoint_resource_name"],
        "did": infra["deployed_index_id"],
    })
    db.commit()

    return {
        "corpus_name":            rag_corpus.name,
        "display_name":           req.display_name,
        "index_display_name":     req.index_display_name,
        "endpoint_display_name":  req.endpoint_display_name,
        "index_resource_name":    infra["index_resource_name"],
        "endpoint_resource_name": infra["endpoint_resource_name"],
        "deployed_index_id":      infra["deployed_index_id"],
        "deployment_note": (
            "Index deployment started in GCP. First deployment may take 20–30 minutes."
        ),
    }


# ── GET /vsr-corpora/ ──────────────────────────────────────────────────────────

@router.get("/")
def list_corpora(db: Session = Depends(get_db)):
    rows = db.execute(text("""
        SELECT corpus_name, display_name, index_resource_name,
               endpoint_resource_name, deployed_index_id
        FROM   vsr_corpora
        ORDER  BY created_at DESC
    """)).fetchall()
    return [
        {
            "corpus_name":            r[0],
            "display_name":           r[1],
            "index_resource_name":    r[2],
            "endpoint_resource_name": r[3],
            "deployed_index_id":      r[4],
        }
        for r in rows
    ]


# ── DELETE /vsr-corpora/ ───────────────────────────────────────────────────────

@router.delete("/")
def delete_corpus(corpus_name: str, db: Session = Depends(get_db)):
    row = db.execute(text("""
        SELECT index_resource_name, endpoint_resource_name, deployed_index_id
        FROM   vsr_corpora
        WHERE  corpus_name = :cn
    """), {"cn": corpus_name}).fetchone()

    documents_deleted = 0
    try:
        for f in rag.list_files(corpus_name=corpus_name):
            try:
                rag.delete_file(name=f.name)
                documents_deleted += 1
            except Exception:
                pass
    except Exception:
        pass

    try:
        rag.delete_corpus(name=corpus_name)
    except Exception as e:
        if "not found" not in str(e).lower():
            raise HTTPException(status_code=500, detail=f"Corpus delete failed: {e}") from e

    infra_deleted = None
    if row and row[0] and row[1]:
        try:
            infra_deleted = teardown_vector_search(
                index_resource_name=row[0],
                endpoint_resource_name=row[1],
                deployed_index_id=row[2] or "",
            )
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Vector Search cleanup failed: {e}",
            ) from e

    db.execute(text("DELETE FROM vsr_corpora WHERE corpus_name = :cn"), {"cn": corpus_name})
    db.execute(text("DELETE FROM vsr_conversations WHERE corpus_name = :cn"), {"cn": corpus_name})
    db.commit()

    result = {"deleted": corpus_name, "documents_deleted": documents_deleted}
    if infra_deleted:
        result["vector_search"] = infra_deleted
    return result
