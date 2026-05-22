import os

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:spandana@localhost:5432/ragdb",
)

engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Run once on startup to create the table if it doesn't exist."""
    with engine.connect() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS conversations (
                id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                corpus_name         TEXT NOT NULL,
                corpus_display_name TEXT NOT NULL,
                title               TEXT,
                messages            JSONB NOT NULL DEFAULT '[]'::jsonb,
                created_at          TIMESTAMPTZ DEFAULT NOW(),
                updated_at          TIMESTAMPTZ DEFAULT NOW()
            )
        """))
        conn.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_conversations_corpus
            ON conversations(corpus_name)
        """))


         # ── Vertex AI Search: datastore metadata (stores bucket per store) ──
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS vs_datastores (
                id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                datastore_id    TEXT NOT NULL UNIQUE,
                display_name    TEXT NOT NULL,
                gcs_bucket      TEXT NOT NULL,
                created_at      TIMESTAMPTZ DEFAULT NOW()
            )
        """))

        # ── Vertex AI Search conversations ─────────────────────────────────
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS vs_conversations (
                id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                datastore_id    TEXT NOT NULL,
                title           TEXT,
                messages        JSONB NOT NULL DEFAULT '[]'::jsonb,
                created_at      TIMESTAMPTZ DEFAULT NOW(),
                updated_at      TIMESTAMPTZ DEFAULT NOW()
            )
        """))
        conn.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_vs_conversations_datastore
            ON vs_conversations(datastore_id)
        """))

        # Original filenames for Vertex Search docs (keyed by GCS URI at upload time)
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS vs_document_files (
                datastore_id        TEXT NOT NULL,
                gcs_uri             TEXT NOT NULL,
                original_filename   TEXT NOT NULL,
                document_name       TEXT,
                created_at          TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (datastore_id, gcs_uri)
            )
        """))

        # ── Feature Store RAG: corpus metadata ─────────────────────────────
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS fs_corpora (
                id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                corpus_name             TEXT NOT NULL UNIQUE,
                display_name            TEXT NOT NULL,
                bq_dataset_id           TEXT NOT NULL,
                bq_table_id             TEXT NOT NULL,
                feature_online_store_id TEXT NOT NULL,
                feature_view_id         TEXT NOT NULL,
                feature_view_resource   TEXT,
                created_at              TIMESTAMPTZ DEFAULT NOW()
            )
        """))
 
        # ── Feature Store RAG conversations ────────────────────────────────
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS fs_conversations (
                id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                corpus_name     TEXT NOT NULL,
                title           TEXT,
                messages        JSONB NOT NULL DEFAULT '[]'::jsonb,
                created_at      TIMESTAMPTZ DEFAULT NOW(),
                updated_at      TIMESTAMPTZ DEFAULT NOW()
            )
        """))
        conn.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_fs_conversations_corpus
            ON fs_conversations(corpus_name)
        """))
 
        # ── Vector Search RAG: corpus metadata ─────────────────────────────
        # Index + endpoint are provisioned in GCP on corpus create; deploy may take 20–30 min.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS vsr_corpora (
                id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                corpus_name             TEXT NOT NULL UNIQUE,
                display_name            TEXT NOT NULL,
                index_resource_name     TEXT NOT NULL,
                endpoint_resource_name  TEXT NOT NULL,
                deployed_index_id       TEXT NOT NULL,
                created_at              TIMESTAMPTZ DEFAULT NOW()
            )
        """))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS vsr_conversations (
                id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                corpus_name     TEXT NOT NULL,
                title           TEXT,
                messages        JSONB NOT NULL DEFAULT '[]'::jsonb,
                created_at      TIMESTAMPTZ DEFAULT NOW(),
                updated_at      TIMESTAMPTZ DEFAULT NOW()
            )
        """))
        conn.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_vsr_conversations_corpus
            ON vsr_conversations(corpus_name)
        """))

        conn.commit()

