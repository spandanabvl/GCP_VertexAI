import os
import re
import tempfile
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import text
from sqlalchemy.orm import Session

from google.api_core import exceptions as google_exceptions
from google.cloud import storage, discoveryengine_v1 as discoveryengine

from config import PROJECT_ID
from database import get_db
from routers.vs_common import data_store_branch_path, normalize_gcs_bucket

router = APIRouter()

ALLOWED_EXTENSIONS = {".pdf", ".txt", ".docx", ".csv", ".xlsx", ".xls"}
_HEX_ID_RE = re.compile(r"^[0-9a-f]{32}$", re.I)


def _doc_client():
    return discoveryengine.DocumentServiceClient()


def _struct_as_dict(data: Any) -> dict[str, Any]:
    if not data:
        return {}
    if isinstance(data, dict):
        return data
    try:
        return dict(data)
    except (TypeError, ValueError):
        return {}


def _basename_from_gcs_uri(uri: str) -> str:
    if not uri:
        return ""
    path = uri[5:] if uri.lower().startswith("gs://") else uri
    return path.split("/")[-1] if path else uri


def _looks_like_internal_id(name: str) -> bool:
    return bool(name and _HEX_ID_RE.match(name))


def _gcs_uri_map(bucket_name: str) -> dict[str, str]:
    if not bucket_name:
        return {}
    try:
        client = storage.Client(project=PROJECT_ID)
        bucket = client.bucket(bucket_name)
        return {
            f"gs://{bucket_name}/{blob.name}": blob.name
            for blob in bucket.list_blobs()
        }
    except Exception:
        return {}


def _filename_lookup(db: Session, datastore_id: str) -> dict[str, str]:
    rows = db.execute(
        text("""
            SELECT gcs_uri, original_filename
            FROM vs_document_files
            WHERE datastore_id = :did
        """),
        {"did": datastore_id},
    ).fetchall()
    return {r[0]: r[1] for r in rows}


def _resolve_display_name(
    doc: discoveryengine.Document,
    gcs_map: dict[str, str],
    saved_names: dict[str, str],
) -> str:
    uri = ""
    if doc.content and doc.content.uri:
        uri = doc.content.uri
        if uri in saved_names:
            return saved_names[uri]
        if uri in gcs_map:
            return gcs_map[uri]
        base = _basename_from_gcs_uri(uri)
        if base and not _looks_like_internal_id(base):
            return base

    for data in (_struct_as_dict(doc.struct_data), _struct_as_dict(doc.derived_struct_data)):
        for key in ("title", "filename", "name"):
            val = data.get(key)
            if isinstance(val, str) and val.strip():
                if val.startswith("gs://"):
                    base = _basename_from_gcs_uri(val)
                    if base and not _looks_like_internal_id(base):
                        return base
                elif not _looks_like_internal_id(val.strip()):
                    return val.strip()
        link = data.get("link")
        if isinstance(link, str) and link.strip():
            base = _basename_from_gcs_uri(link) if "/" in link else link.strip()
            if base and not _looks_like_internal_id(base):
                return base

    doc_id = doc.id or (doc.name.split("/")[-1] if doc.name else "Document")
    return doc_id


def _save_upload_filename(db: Session, datastore_id: str, gcs_uri: str, filename: str) -> None:
    db.execute(
        text("""
            INSERT INTO vs_document_files (datastore_id, gcs_uri, original_filename)
            VALUES (:did, :uri, :fn)
            ON CONFLICT (datastore_id, gcs_uri)
            DO UPDATE SET original_filename = EXCLUDED.original_filename
        """),
        {"did": datastore_id, "uri": gcs_uri, "fn": filename},
    )
    db.commit()


def _backfill_gcs_filenames(
    db: Session, datastore_id: str, gcs_map: dict[str, str]
) -> dict[str, str]:
    """Seed filename map from bucket listing for uploads made before we tracked names."""
    if not gcs_map:
        return {}
    for uri, fname in gcs_map.items():
        db.execute(
            text("""
                INSERT INTO vs_document_files (datastore_id, gcs_uri, original_filename)
                VALUES (:did, :uri, :fn)
                ON CONFLICT (datastore_id, gcs_uri) DO NOTHING
            """),
            {"did": datastore_id, "uri": uri, "fn": fname},
        )
    db.commit()
    return _filename_lookup(db, datastore_id)


@router.post("/upload")
async def upload_document(
    datastore_id: str,
    gcs_bucket: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"File type '{ext}' not supported.")

    bucket_name = normalize_gcs_bucket(gcs_bucket)
    if not bucket_name:
        raise HTTPException(status_code=400, detail="Invalid GCS bucket name.")

    with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        gcs_client = storage.Client(project=PROJECT_ID)
        bucket = gcs_client.bucket(bucket_name)
        blob = bucket.blob(file.filename)
        try:
            blob.upload_from_filename(tmp_path)
        except google_exceptions.Forbidden as e:
            raise HTTPException(status_code=403, detail=str(e)) from e
        except google_exceptions.GoogleAPICallError as e:
            raise HTTPException(status_code=502, detail=f"GCS upload failed: {e}") from e
        gcs_uri = f"gs://{bucket_name}/{file.filename}"
    finally:
        os.unlink(tmp_path)

    _save_upload_filename(db, datastore_id, gcs_uri, file.filename)

    doc_client = _doc_client()
    branch = data_store_branch_path(PROJECT_ID, datastore_id, "default_branch")

    try:
        import_op = doc_client.import_documents(
            request=discoveryengine.ImportDocumentsRequest(
                parent=branch,
                gcs_source=discoveryengine.GcsSource(
                    input_uris=[gcs_uri],
                    data_schema="content",
                ),
                reconciliation_mode=discoveryengine.ImportDocumentsRequest.ReconciliationMode.INCREMENTAL,
            )
        )
    except google_exceptions.GoogleAPICallError as e:
        raise HTTPException(status_code=502, detail=f"Discovery Engine import failed: {e}") from e

    return {
        "filename": file.filename,
        "gcs_uri": gcs_uri,
        "operation_name": import_op.operation.name,
        "status": "importing",
    }


@router.get("/operation-status")
def operation_status(operation_name: str):
    """Poll import progress using the same credentials as DocumentService."""
    doc_client = _doc_client()
    try:
        op = doc_client.get_operation({"name": operation_name})
        return {"done": op.done, "operation_name": operation_name}
    except Exception:
        return {"done": False, "operation_name": operation_name}


@router.get("/")
def list_documents(datastore_id: str, db: Session = Depends(get_db)):
    row = db.execute(
        text("SELECT gcs_bucket FROM vs_datastores WHERE datastore_id = :did"),
        {"did": datastore_id},
    ).fetchone()
    bucket_name = normalize_gcs_bucket(row[0]) if row else ""

    doc_client = _doc_client()
    branch = data_store_branch_path(PROJECT_ID, datastore_id, "default_branch")
    gcs_map = _gcs_uri_map(bucket_name)
    saved_names = _filename_lookup(db, datastore_id)
    if gcs_map and not saved_names:
        saved_names = _backfill_gcs_filenames(db, datastore_id, gcs_map)

    try:
        docs = list(doc_client.list_documents(parent=branch))
        result = []
        for d in docs:
            doc = d
            if not (d.content and d.content.uri):
                try:
                    doc = doc_client.get_document(name=d.name)
                except Exception:
                    doc = d

            display = _resolve_display_name(doc, gcs_map, saved_names)

            # Last resort: match a single unmatched GCS object when only one blob exists
            if _looks_like_internal_id(display) and len(gcs_map) == 1:
                display = next(iter(gcs_map.values()))

            result.append({
                "name": doc.name,
                "display_name": display,
                "id": doc.id,
            })
        return result
    except Exception:
        return []


@router.delete("/")
def delete_document(document_name: str, db: Session = Depends(get_db)):
    doc_client = _doc_client()
    try:
        uri = ""
        try:
            doc = doc_client.get_document(name=document_name)
            if doc.content and doc.content.uri:
                uri = doc.content.uri
        except Exception:
            pass

        doc_client.delete_document(name=document_name)

        if uri:
            db.execute(
                text("DELETE FROM vs_document_files WHERE gcs_uri = :uri"),
                {"uri": uri},
            )
            db.commit()

        return {"deleted": document_name}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
