import os
import tempfile

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session
from sqlalchemy import text
from google.cloud import bigquery

import vertexai
from vertexai.preview import rag
from vertexai.resources.preview import feature_store

from config import PROJECT_ID, LOCATION
from database import get_db

vertexai.init(project=PROJECT_ID, location=LOCATION)

router = APIRouter()

ALLOWED_EXTENSIONS = {".pdf", ".txt", ".docx", ".csv", ".xlsx", ".xls"}


# ── POST /fs-documents/upload ──────────────────────────────────────────────────
# 1. Upload file directly to Vertex RAG corpus (same as RAG Managed DB)
# 2. Auto-trigger Feature Store sync so embeddings go into the online index

@router.post("/upload")
async def upload_document(
    corpus_name:             str,
    feature_view_resource:   str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"File type '{ext}' not supported.")

    # 1. Write to temp file
    with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        # 2. Upload to Vertex RAG corpus
        rag_file = rag.upload_file(
            corpus_name=corpus_name,
            path=tmp_path,
            display_name=file.filename,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {e}")
    finally:
        os.unlink(tmp_path)

    # 3. Auto-sync Feature Store (non-blocking — fire and don't wait)
    sync_status = "sync_started"
    try:
        fv        = feature_store.FeatureView(feature_view_resource)
        sync_job  = fv.sync()
        # sync_job.wait() would block for minutes — we skip waiting intentionally.
        # The frontend polls /fs-documents/sync-status to check progress.
        sync_name = getattr(sync_job, "resource_name", str(sync_job))
    except Exception as e:
        sync_status = f"sync_failed: {e}"
        sync_name   = None

    return {
        "name":         rag_file.name,
        "display_name": file.filename,
        "sync_status":  sync_status,
        "sync_job":     sync_name,
    }


# ── GET /fs-documents/sync-status ─────────────────────────────────────────────
# Frontend polls this after upload to show progress

@router.get("/sync-status")
def sync_status(feature_view_resource: str):
    try:
        fv         = feature_store.FeatureView(feature_view_resource)
        latest     = fv.list_syncs()
        if not latest:
            return {"status": "no_syncs", "done": False}
        last_sync  = latest[0]
        state      = str(getattr(last_sync, "state", "")).upper()
        done       = "SUCCEEDED" in state or "FAILED" in state
        return {
            "status": state,
            "done":   done,
            "sync":   str(last_sync),
        }
    except Exception as e:
        return {"status": f"error: {e}", "done": False}


# ── GET /fs-documents/ ────────────────────────────────────────────────────────

@router.get("/")
def list_files(corpus_name: str):
    try:
        files = list(rag.list_files(corpus_name=corpus_name))
        return [{"name": f.name, "display_name": f.display_name} for f in files]
    except Exception:
        return []


def _rag_corpus_id(corpus_name: str) -> str:
    """Extract numeric corpus id from a RAG corpus resource name."""
    return corpus_name.rstrip("/").split("/")[-1]


def _rag_file_id(file_name: str) -> str:
    """Extract numeric rag file id from a RAG file resource name."""
    return file_name.rstrip("/").split("/")[-1]


def _delete_rag_file(file_name: str) -> None:
    try:
        rag.delete_file(name=file_name)
    except Exception as e:
        err = str(e).lower()
        if "not found" in err or "does not exist" in err:
            return
        raise


# ── DELETE /fs-documents/ ─────────────────────────────────────────────────────
# 1. Delete from Vertex RAG corpus
# 2. Delete chunk rows for this file_id in BigQuery
# 3. Sync Feature View (BQ → online index)

@router.delete("/")
def delete_file(file_name: str, corpus_name: str, db: Session = Depends(get_db)):
    row = db.execute(text("""
        SELECT bq_dataset_id, bq_table_id, feature_view_resource
        FROM   fs_corpora
        WHERE  corpus_name = :cn
    """), {"cn": corpus_name}).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Corpus not found")

    bq_dataset_id, bq_table_id, feature_view_resource = row
    corpus_id   = _rag_corpus_id(corpus_name)
    rag_file_id = _rag_file_id(file_name)

    try:
        _delete_rag_file(file_name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"RAG delete failed: {e}") from e

    bq_deleted = 0
    try:
        client = bigquery.Client(project=PROJECT_ID, location=LOCATION)
        table  = f"`{PROJECT_ID}.{bq_dataset_id}.{bq_table_id}`"
        job    = client.query(
            f"""
            DELETE FROM {table}
            WHERE corpus_id = @corpus_id
              AND file_id IN UNNEST(@file_ids)
            """,
            job_config=bigquery.QueryJobConfig(
                query_parameters=[
                    bigquery.ScalarQueryParameter("corpus_id", "STRING", corpus_id),
                    bigquery.ArrayQueryParameter(
                        "file_ids", "STRING", [rag_file_id, file_name]
                    ),
                ],
            ),
        )
        job.result()
        bq_deleted = job.num_dml_affected_rows or 0
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"BigQuery delete failed: {e}") from e

    sync_status = "sync_started"
    sync_name   = None
    try:
        if feature_view_resource:
            fv       = feature_store.FeatureView(feature_view_resource)
            sync_job = fv.sync()
            sync_name = getattr(sync_job, "resource_name", str(sync_job))
    except Exception as e:
        sync_status = f"sync_failed: {e}"

    return {
        "deleted":          file_name,
        "bq_rows_deleted":  bq_deleted,
        "sync_status":      sync_status,
        "sync_job":         sync_name,
    }