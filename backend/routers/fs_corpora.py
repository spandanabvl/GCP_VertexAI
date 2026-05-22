from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import text

import vertexai
from vertexai.preview import rag
from vertexai.resources.preview import feature_store
from google.cloud import bigquery

from config import PROJECT_ID, LOCATION
from database import get_db
from services.fs_infra import teardown_fs_infra

vertexai.init(project=PROJECT_ID, location=LOCATION)

router = APIRouter()


# ── Request model ──────────────────────────────────────────────────────────────

class CreateFSCorpusRequest(BaseModel):
    display_name:            str
    bq_dataset_id:           str
    bq_table_id:             str
    feature_online_store_id: str
    feature_view_id:         str


# ── BQ schema for RAG embeddings ───────────────────────────────────────────────

BQ_SCHEMA = [
    bigquery.SchemaField("corpus_id",        "STRING",  mode="REQUIRED"),
    bigquery.SchemaField("file_id",           "STRING",  mode="REQUIRED"),
    bigquery.SchemaField("chunk_id",          "STRING",  mode="REQUIRED"),
    bigquery.SchemaField("chunk_data_type",   "STRING",  mode="NULLABLE"),
    bigquery.SchemaField("chunk_data",        "STRING",  mode="NULLABLE"),
    bigquery.SchemaField("file_original_uri", "STRING",  mode="NULLABLE"),
    bigquery.SchemaField("embeddings",        "FLOAT64", mode="REPEATED"),
]


def _ensure_bq(project_id: str, dataset_id: str, table_id: str) -> str:
    """Create BQ dataset + table if they don't exist. Returns bq:// URI."""
    client     = bigquery.Client(project=project_id)
    ds_ref     = bigquery.DatasetReference(project_id, dataset_id)
    try:
        client.get_dataset(ds_ref)
    except Exception:
        ds          = bigquery.Dataset(ds_ref)
        ds.location = LOCATION
        client.create_dataset(ds)

    table_ref = ds_ref.table(table_id)
    try:
        table = client.get_table(table_ref)
    except Exception:
        table = bigquery.Table(table_ref, schema=BQ_SCHEMA)
        table = client.create_table(table)

    return f"bq://{table.full_table_id.replace(':', '.')}"


def _ensure_feature_store(
    feature_online_store_id: str,
    feature_view_id: str,
    bq_uri: str,
) -> str:
    """Create Feature Online Store + Feature View if they don't exist. Returns resource name."""
    try:
        fos = feature_store.FeatureOnlineStore(feature_online_store_id)
    except Exception:
        fos = feature_store.FeatureOnlineStore.create_optimized_store(feature_online_store_id)

    try:
        fv = fos.get_feature_view(feature_view_id)
    except Exception:
        fv = fos.create_feature_view(
            name=feature_view_id,
            source=feature_store.utils.FeatureViewVertexRagSource(uri=bq_uri),
        )

    return fv.resource_name


# ── POST /fs-corpora/ ──────────────────────────────────────────────────────────

@router.post("/")
def create_corpus(req: CreateFSCorpusRequest, db: Session = Depends(get_db)):
    try:
        # 1. Ensure BQ dataset + table
        bq_uri = _ensure_bq(PROJECT_ID, req.bq_dataset_id, req.bq_table_id)

        # 2. Ensure Feature Online Store + Feature View
        fv_resource = _ensure_feature_store(
            req.feature_online_store_id,
            req.feature_view_id,
            bq_uri,
        )

        # 3. Create Vertex RAG corpus backed by Feature Store
        vector_db  = rag.VertexFeatureStore(resource_name=fv_resource)
        rag_corpus = rag.create_corpus(
            display_name=req.display_name,
            vector_db=vector_db,
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Corpus creation failed: {e}")

    # 4. Save metadata to Postgres
    db.execute(text("""
        INSERT INTO fs_corpora
            (corpus_name, display_name, bq_dataset_id, bq_table_id,
             feature_online_store_id, feature_view_id, feature_view_resource)
        VALUES
            (:cn, :dn, :ds, :tbl, :fos, :fv, :fvr)
        ON CONFLICT (corpus_name) DO NOTHING
    """), {
        "cn":  rag_corpus.name,
        "dn":  req.display_name,
        "ds":  req.bq_dataset_id,
        "tbl": req.bq_table_id,
        "fos": req.feature_online_store_id,
        "fv":  req.feature_view_id,
        "fvr": fv_resource,
    })
    db.commit()

    return {
        "corpus_name":             rag_corpus.name,
        "display_name":            req.display_name,
        "bq_dataset_id":           req.bq_dataset_id,
        "bq_table_id":             req.bq_table_id,
        "feature_online_store_id": req.feature_online_store_id,
        "feature_view_id":         req.feature_view_id,
        "feature_view_resource":   fv_resource,
    }


# ── GET /fs-corpora/ ───────────────────────────────────────────────────────────

@router.get("/")
def list_corpora(db: Session = Depends(get_db)):
    rows = db.execute(text("""
        SELECT corpus_name, display_name, bq_dataset_id, bq_table_id,
               feature_online_store_id, feature_view_id, feature_view_resource
        FROM   fs_corpora
        ORDER  BY created_at DESC
    """)).fetchall()
    return [
        {
            "corpus_name":             r[0],
            "display_name":            r[1],
            "bq_dataset_id":           r[2],
            "bq_table_id":             r[3],
            "feature_online_store_id": r[4],
            "feature_view_id":         r[5],
            "feature_view_resource":   r[6],
        }
        for r in rows
    ]


def _rag_corpus_id(corpus_name: str) -> str:
    return corpus_name.rstrip("/").split("/")[-1]


# ── DELETE /fs-corpora/ ────────────────────────────────────────────────────────

@router.delete("/")
def delete_corpus(corpus_name: str, db: Session = Depends(get_db)):
    row = db.execute(text("""
        SELECT bq_dataset_id, bq_table_id, feature_online_store_id,
               feature_view_id, feature_view_resource
        FROM   fs_corpora
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
    if row:
        try:
            infra_deleted = teardown_fs_infra(
                db,
                corpus_id=_rag_corpus_id(corpus_name),
                corpus_name=corpus_name,
                bq_dataset_id=row[0],
                bq_table_id=row[1],
                feature_online_store_id=row[2],
                feature_view_id=row[3],
                feature_view_resource=row[4],
            )
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Feature Store / BigQuery cleanup failed: {e}",
            ) from e

    db.execute(text("DELETE FROM fs_corpora WHERE corpus_name = :cn"), {"cn": corpus_name})
    db.execute(text("DELETE FROM fs_conversations WHERE corpus_name = :cn"), {"cn": corpus_name})
    db.commit()

    result = {"deleted": corpus_name, "documents_deleted": documents_deleted}
    if infra_deleted:
        result["infrastructure"] = infra_deleted
    return result