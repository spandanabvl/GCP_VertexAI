from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.orm import Session
import vertexai
from vertexai.preview import rag

from config import PROJECT_ID, LOCATION
from database import get_db
from flow_stream import ndjson_line

vertexai.init(project=PROJECT_ID, location=LOCATION)
router = APIRouter()


def _is_rag_managed_db_corpus(corpus) -> bool:
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
        backend_config=rag.RagVectorDbConfig(vector_db=vector_db),
    )
    return {"name": corpus.name, "display_name": display_name}


@router.get("/")
def list_corpora():
    corpora = rag.list_corpora()
    managed = [c for c in corpora if _is_rag_managed_db_corpus(c)]
    return [{"name": c.name, "display_name": c.display_name} for c in managed]


@router.delete("/")
def delete_corpus(corpus_name: str, db: Session = Depends(get_db)):
    def stream():
        documents_deleted = 0
        conversations_deleted = 0

        try:
            yield ndjson_line({
                "phase": "deleting",
                "step": "files",
                "message": "Deleting all files · rag.delete_file…",
            })

            try:
                for f in rag.list_files(corpus_name=corpus_name):
                    try:
                        rag.delete_file(name=f.name)
                        documents_deleted += 1
                    except Exception:
                        pass
            except Exception:
                pass

            yield ndjson_line({
                "phase": "deleting",
                "step": "corpus",
                "message": "Deleting Vertex RAG Corpus · rag.delete_corpus…",
            })

            try:
                rag.delete_corpus(name=corpus_name)
            except Exception as e:
                yield ndjson_line({
                    "phase": "error",
                    "detail": f"Corpus delete failed: {e}",
                })
                return

            yield ndjson_line({
                "phase": "deleting",
                "step": "postgres",
                "message": "PostgreSQL · DELETE conversations…",
            })

            result = db.execute(
                text("DELETE FROM conversations WHERE corpus_name = :cn"),
                {"cn": corpus_name},
            )
            db.commit()
            conversations_deleted = result.rowcount

            yield ndjson_line({
                "phase": "complete",
                "deleted": corpus_name,
                "documents_deleted": documents_deleted,
                "conversations_deleted": conversations_deleted,
            })
        except Exception as exc:
            db.rollback()
            yield ndjson_line({"phase": "error", "detail": str(exc)})

    return StreamingResponse(stream(), media_type="application/x-ndjson")
