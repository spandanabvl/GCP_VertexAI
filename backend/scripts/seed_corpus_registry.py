"""Seed corpus_registry for benchmark telemetry toggles. Run from backend/."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config  # noqa: F401
from database import SessionLocal, init_db
from models import CorpusRegistry


def main():
    init_db()
    db = SessionLocal()
    try:
        seeds = [
            dict(
                name="RAG Managed DB Default",
                engine_type="ragmanageddb",
                gcp_resource_name="__placeholder_rag__",
                total_document_pages=500,
                prompt_cache_enabled=True,
            ),
            dict(
                name="Vector Search RAG Default",
                engine_type="vector_search_rag",
                gcp_resource_name="__placeholder_vsr__",
                total_document_pages=500,
                multimodal_active=False,
            ),
            dict(
                name="Feature Store RAG Default",
                engine_type="feature_store_rag",
                gcp_resource_name="__placeholder_fs__",
                total_document_pages=500,
                reranker_enabled=True,
            ),
        ]
        for s in seeds:
            exists = (
                db.query(CorpusRegistry)
                .filter(CorpusRegistry.engine_type == s["engine_type"])
                .first()
            )
            if not exists:
                db.add(CorpusRegistry(**s))
        db.commit()
        for r in db.query(CorpusRegistry).all():
            print(f"[{r.id}] {r.engine_type}: {r.name}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
