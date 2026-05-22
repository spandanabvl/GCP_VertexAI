from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session
import vertexai
from vertexai.preview import rag

from config import PROJECT_ID, LOCATION
from database import get_db

vertexai.init(project=PROJECT_ID, location=LOCATION)
router = APIRouter()


def _is_rag_managed_db_corpus(corpus) -> bool:
    """True when the corpus backend is Vertex RAG Managed DB (not VSR / Feature Store / etc.)."""
    vdb = getattr(corpus, "vector_db_config", None) or getattr(
        corpus, "rag_vector_db_config", None
    )
    if not vdb:
        return False
    try:
        return vdb.__contains__("rag_managed_db")
    except AttributeError:
        try:
            return vdb._pb.HasField("rag_managed_db")
        except Exception:
            return False


@router.post("/")
def create_corpus(display_name: str):
    vector_db = rag.RagManagedDb(retrieval_strategy=rag.KNN())
    corpus = rag.create_corpus(
        display_name=display_name,
        backend_config=rag.RagVectorDbConfig(vector_db=vector_db)
    )
    return {"name": corpus.name, "display_name": display_name}

@router.get("/")
def list_corpora():
    corpora = rag.list_corpora()
    managed = [c for c in corpora if _is_rag_managed_db_corpus(c)]
    return [{"name": c.name, "display_name": c.display_name} for c in managed]

@router.delete("/")
def delete_corpus(corpus_name: str, db: Session = Depends(get_db)):
    # 1. Delete all documents in the corpus (GCP)
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

    # 2. Delete the corpus (GCP)
    try:
        rag.delete_corpus(name=corpus_name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Corpus delete failed: {e}") from e

    # 3. Delete conversations tied to this corpus (Postgres)
    result = db.execute(
        text("DELETE FROM conversations WHERE corpus_name = :cn"),
        {"cn": corpus_name},
    )
    db.commit()

    return {
        "deleted": corpus_name,
        "documents_deleted": documents_deleted,
        "conversations_deleted": result.rowcount,
    }