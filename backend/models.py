from sqlalchemy import Boolean, Column, Integer, String

from database import Base


class CorpusRegistry(Base):
    __tablename__ = "corpus_registry"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    engine_type = Column(String, nullable=False)
    # ragmanageddb | vector_search_rag | feature_store_rag
    gcp_resource_name = Column(String, nullable=False)
    total_document_pages = Column(Integer, default=0)
    total_documents_count = Column(Integer, default=0)
    advanced_layout_parser = Column(Boolean, default=False)
    ocr_enabled = Column(Boolean, default=False)
    reranker_enabled = Column(Boolean, default=False)
    prompt_cache_enabled = Column(Boolean, default=False)
    multimodal_active = Column(Boolean, default=False)
