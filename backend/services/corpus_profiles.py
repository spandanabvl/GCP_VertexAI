"""Resolve CorpusRegistry / monitoring targets into telemetry profiles."""

from __future__ import annotations

import logging

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from models import CorpusRegistry
from utils.telemetry import CorpusProfile

logger = logging.getLogger(__name__)

ENGINE_ALIASES = {
    "ragmanageddb": "ragmanageddb",
    "rag_managed_db": "ragmanageddb",
    "rag": "ragmanageddb",
    "vector_search_rag": "vector_search_rag",
    "vsr": "vector_search_rag",
    "feature_store_rag": "feature_store_rag",
    "fs": "feature_store_rag",
}


def normalize_engine(engine_type: str) -> str:
    return ENGINE_ALIASES.get((engine_type or "").lower().strip(), engine_type)


def registry_to_profile(row: CorpusRegistry) -> CorpusProfile:
    ocr = getattr(row, "ocr_enabled", None)
    if ocr is None:
        ocr = getattr(row, "ocr_scanned_enabled", False)
    reranker = getattr(row, "reranker_enabled", None)
    if reranker is None:
        reranker = getattr(row, "vertex_reranker_active", False)
    cache = getattr(row, "prompt_cache_enabled", None)
    if cache is None:
        cache = getattr(row, "prompt_caching_enabled", False)

    return CorpusProfile(
        engine_type=normalize_engine(row.engine_type),
        name=row.name,
        gcp_resource_name=row.gcp_resource_name,
        total_document_pages=row.total_document_pages or 0,
        total_documents_count=row.total_documents_count or 0,
        advanced_layout_parser=bool(row.advanced_layout_parser),
        ocr_enabled=bool(ocr),
        reranker_enabled=bool(reranker),
        prompt_cache_enabled=bool(cache),
        multimodal_active=bool(getattr(row, "multimodal_active", False)),
    )


def default_profile(
    engine_type: str,
    corpus_name: str,
    display_name: str = "",
) -> CorpusProfile:
    et = normalize_engine(engine_type)
    return CorpusProfile(
        engine_type=et,
        name=display_name or corpus_name.split("/")[-1],
        gcp_resource_name=corpus_name,
        total_document_pages=500,
        total_documents_count=25,
    )


def _safe_registry_lookup(db: Session, query_fn):
    try:
        return query_fn()
    except SQLAlchemyError as e:
        logger.warning("corpus_registry lookup skipped: %s", e)
        db.rollback()
        return None


def resolve_profile(
    db: Session,
    *,
    engine_type: str,
    corpus_name: str,
    display_name: str = "",
    corpus_id: int | None = None,
) -> CorpusProfile:
    et = normalize_engine(engine_type)

    if corpus_id is not None:
        row = _safe_registry_lookup(
            db,
            lambda: db.query(CorpusRegistry).filter(CorpusRegistry.id == corpus_id).first(),
        )
        if row:
            return registry_to_profile(row)

    row = _safe_registry_lookup(
        db,
        lambda: db.query(CorpusRegistry)
        .filter(
            CorpusRegistry.gcp_resource_name == corpus_name,
            CorpusRegistry.engine_type == et,
        )
        .first(),
    )
    if row:
        return registry_to_profile(row)

    row = _safe_registry_lookup(
        db,
        lambda: db.query(CorpusRegistry)
        .filter(CorpusRegistry.engine_type == et)
        .order_by(CorpusRegistry.id.desc())
        .first(),
    )
    if row:
        p = registry_to_profile(row)
        p.gcp_resource_name = corpus_name
        p.name = display_name or p.name
        return p

    return default_profile(et, corpus_name, display_name)
