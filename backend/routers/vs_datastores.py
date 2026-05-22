import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import text

from google.api_core import exceptions as google_exceptions
from google.cloud import storage
from google.cloud import discoveryengine_v1 as discoveryengine

from config import PROJECT_ID
from database import get_db
from routers.vs_common import VS_COLLECTION, collection_path, normalize_gcs_bucket

VS_LOCATION = "global"

router = APIRouter()


def _ds_client():
    return discoveryengine.DataStoreServiceClient()


def _engine_client():
    return discoveryengine.EngineServiceClient()


def _is_missing_gcp_resource(exc: Exception) -> bool:
    if isinstance(exc, google_exceptions.NotFound):
        return True
    msg = str(exc).lower()
    return "not found" in msg or "does not exist" in msg


def _is_broken_lro_state_error(exc: Exception) -> bool:
    """GCP delete LROs often finish with done=True but no response/error payload."""
    msg = str(exc).lower()
    return "neither response nor error" in msg or "unexpected state" in msg


def _is_retryable_gcp_delete_error(exc: Exception) -> bool:
    if isinstance(
        exc,
        (
            google_exceptions.FailedPrecondition,
            google_exceptions.Aborted,
            google_exceptions.ServiceUnavailable,
            google_exceptions.DeadlineExceeded,
        ),
    ):
        return True
    msg = str(exc).lower()
    return any(
        phrase in msg
        for phrase in (
            "failed precondition",
            "still in use",
            "still being used",
            "referenced",
            "not ready",
            "retry",
        )
    )


def _normalize_datastore_id(raw: str) -> str:
    """Extract bare datastore id from API id or full resource name."""
    value = (raw or "").strip().strip("/")
    if not value:
        return value
    marker = "/dataStores/"
    if marker in value:
        return value.split(marker)[-1].split("/")[0]
    if value.startswith("projects/"):
        return value.rsplit("/", 1)[-1]
    return value


def _datastore_resource_name(datastore_id: str) -> str:
    ds_id = _normalize_datastore_id(datastore_id)
    return f"{collection_path(PROJECT_ID)}/dataStores/{ds_id}"


def _engine_resource_name(engine_id: str) -> str:
    return discoveryengine.EngineServiceClient.engine_path(
        PROJECT_ID, VS_LOCATION, VS_COLLECTION, _normalize_datastore_id(engine_id)
    )


def _engine_exists(eng_client, engine_id: str) -> bool:
    try:
        eng_client.get_engine(name=_engine_resource_name(engine_id))
        return True
    except Exception as e:
        if _is_missing_gcp_resource(e):
            return False
        raise


def _datastore_exists(ds_client, datastore_id: str) -> bool:
    try:
        ds_client.get_data_store(name=_datastore_resource_name(datastore_id))
        return True
    except Exception as e:
        if _is_missing_gcp_resource(e):
            return False
        raise


def _wait_for_delete_lro(operation, *, resource_gone, timeout: int = 600) -> None:
    """Wait for a GCP delete LRO; empty done responses are treated as success when gone."""
    deadline = time.monotonic() + timeout
    poll_interval = 2.0

    while time.monotonic() < deadline:
        if resource_gone():
            return

        try:
            if operation.done():
                try:
                    operation.result(timeout=1)
                except Exception as e:
                    if _is_missing_gcp_resource(e) or _is_broken_lro_state_error(e):
                        if resource_gone():
                            return
                    elif not _is_retryable_gcp_delete_error(e):
                        raise
                else:
                    return
                if resource_gone():
                    return
        except Exception as e:
            if _is_missing_gcp_resource(e) and resource_gone():
                return
            if not _is_retryable_gcp_delete_error(e) and not _is_broken_lro_state_error(e):
                raise

        time.sleep(poll_interval)

    if resource_gone():
        return
    raise TimeoutError(f"Delete operation timed out after {timeout}s")


def _try_delete_gcp_datastore(datastore_id: str) -> None:
    """Best-effort cleanup if engine creation fails after a new datastore was created."""
    ds_client = _ds_client()
    ds_id = _normalize_datastore_id(datastore_id)
    if not _datastore_exists(ds_client, ds_id):
        return
    try:
        op = ds_client.delete_data_store(name=_datastore_resource_name(ds_id))
        _wait_for_delete_lro(op, resource_gone=lambda: not _datastore_exists(ds_client, ds_id))
    except Exception:
        pass


def _delete_gcp_engine(eng_client, engine_id: str) -> None:
    engine_id = _normalize_datastore_id(engine_id)
    if not _engine_exists(eng_client, engine_id):
        return
    try:
        op = eng_client.delete_engine(name=_engine_resource_name(engine_id))
        _wait_for_delete_lro(
            op, resource_gone=lambda: not _engine_exists(eng_client, engine_id)
        )
    except TimeoutError as e:
        raise HTTPException(status_code=500, detail=f"GCP engine delete timed out: {e}") from e
    except HTTPException:
        raise
    except Exception as e:
        if _is_missing_gcp_resource(e) or (
            _is_broken_lro_state_error(e) and not _engine_exists(eng_client, engine_id)
        ):
            return
        raise HTTPException(status_code=500, detail=f"GCP engine delete failed: {e}") from e


def _delete_gcp_datastore(ds_client, datastore_id: str) -> None:
    ds_id = _normalize_datastore_id(datastore_id)
    if not _datastore_exists(ds_client, ds_id):
        return

    retry_delays_sec = (2, 4, 8, 16, 32)
    last_error: Exception | None = None

    for attempt in range(len(retry_delays_sec) + 1):
        if not _datastore_exists(ds_client, ds_id):
            return
        try:
            op = ds_client.delete_data_store(name=_datastore_resource_name(ds_id))
            _wait_for_delete_lro(
                op, resource_gone=lambda: not _datastore_exists(ds_client, ds_id)
            )
            return
        except TimeoutError as e:
            last_error = e
        except Exception as e:
            last_error = e
            if _is_missing_gcp_resource(e):
                return
            if attempt < len(retry_delays_sec) and _is_retryable_gcp_delete_error(e):
                time.sleep(retry_delays_sec[attempt])
                continue
            raise HTTPException(
                status_code=500,
                detail=f"GCP datastore delete failed for '{ds_id}': {e}",
            ) from e

        if not _datastore_exists(ds_client, ds_id):
            return
        if attempt < len(retry_delays_sec):
            time.sleep(retry_delays_sec[attempt])

    if last_error:
        raise HTTPException(
            status_code=500,
            detail=f"GCP datastore delete failed for '{ds_id}': {last_error}",
        ) from last_error


def _cleanup_datastore_db(db: Session, datastore_id: str) -> None:
    did = _normalize_datastore_id(datastore_id)
    db.execute(text("DELETE FROM vs_document_files WHERE datastore_id = :did"), {"did": did})
    db.execute(text("DELETE FROM vs_conversations WHERE datastore_id = :did"), {"did": did})
    db.execute(text("DELETE FROM vs_datastores WHERE datastore_id = :did"), {"did": did})
    db.commit()


def _ensure_gcs_bucket(bucket_name: str, project_id: str) -> None:
    """Create the bucket in project_id if it does not exist."""
    client = storage.Client(project=project_id)
    bucket = client.bucket(bucket_name)
    try:
        exists = bucket.exists()
    except google_exceptions.Forbidden as e:
        raise HTTPException(
            status_code=403,
            detail=(
                f"Cannot access bucket '{bucket_name}': your account needs permission "
                f"to read bucket metadata (e.g. roles/storage.legacyBucketReader or "
                f"Storage Admin on that bucket). If the bucket is in another project, "
                f"grant access or use a bucket in project '{project_id}'. Original error: {e}"
            ),
        ) from e
    except google_exceptions.GoogleAPICallError as e:
        raise HTTPException(
            status_code=502,
            detail=f"GCS error while checking bucket '{bucket_name}': {e}",
        ) from e

    if exists:
        return
    try:
        client.create_bucket(bucket_name, location="US")
    except google_exceptions.Conflict as e:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Bucket name '{bucket_name}' is already taken globally in GCS by another "
                f"project. Pick a different bucket name. ({e})"
            ),
        ) from e
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=(
                f"GCS bucket '{bucket_name}' was not found and could not be created. "
                f"Create it in Console or grant storage.buckets.create. Error: {e}"
            ),
        ) from e


class CreateDatastoreRequest(BaseModel):
    datastore_id: str
    display_name: str
    gcs_bucket: str


@router.post("/")
def create_datastore(req: CreateDatastoreRequest, db: Session = Depends(get_db)):
    bucket_name = normalize_gcs_bucket(req.gcs_bucket)
    if not bucket_name:
        raise HTTPException(status_code=400, detail="GCS bucket name is required.")

    _ensure_gcs_bucket(bucket_name, PROJECT_ID)

    ds_client = _ds_client()
    eng_client = _engine_client()
    parent = collection_path(PROJECT_ID)

    datastore_created_this_request = False
    try:
        ds_op = ds_client.create_data_store(
            parent=parent,
            data_store_id=req.datastore_id,
            data_store=discoveryengine.DataStore(
                display_name=req.display_name,
                industry_vertical="GENERIC",
                content_config="CONTENT_REQUIRED",
                solution_types=["SOLUTION_TYPE_SEARCH"],
            ),
        )
        ds_op.result()
        datastore_created_this_request = True
    except Exception as e:
        if "already exists" not in str(e).lower():
            raise HTTPException(status_code=500, detail=f"Datastore creation failed: {e}") from e

    try:
        eng_op = eng_client.create_engine(
            parent=parent,
            engine_id=req.datastore_id,
            engine=discoveryengine.Engine(
                display_name=req.display_name,
                solution_type="SOLUTION_TYPE_SEARCH",
                data_store_ids=[req.datastore_id],
                search_engine_config={
                    "search_tier": "SEARCH_TIER_ENTERPRISE",
                    "search_add_ons": ["SEARCH_ADD_ON_LLM"],
                },
            ),
        )
        eng_op.result()
    except Exception as e:
        if "already exists" not in str(e).lower():
            if datastore_created_this_request:
                _try_delete_gcp_datastore(req.datastore_id)
            raise HTTPException(status_code=500, detail=f"Engine creation failed: {e}") from e

    db.execute(
        text("""
        INSERT INTO vs_datastores (datastore_id, display_name, gcs_bucket)
        VALUES (:did, :dn, :bucket)
        ON CONFLICT (datastore_id) DO UPDATE
            SET display_name = EXCLUDED.display_name,
                gcs_bucket   = EXCLUDED.gcs_bucket
    """),
        {"did": req.datastore_id, "dn": req.display_name, "bucket": bucket_name},
    )
    db.commit()

    return {
        "datastore_id": req.datastore_id,
        "display_name": req.display_name,
        "gcs_bucket": bucket_name,
    }


@router.get("/")
def list_datastores(db: Session = Depends(get_db)):
    rows = db.execute(
        text("""
        SELECT datastore_id, display_name, gcs_bucket, created_at
        FROM   vs_datastores
        ORDER  BY created_at DESC
    """)
    ).fetchall()
    return [
        {
            "datastore_id": r[0],
            "display_name": r[1],
            "gcs_bucket": r[2],
            "created_at": str(r[3]),
        }
        for r in rows
    ]


def _linked_datastore_ids_from_engine(eng_client, engine_id: str) -> list[str]:
    """Read data_store_ids from the engine before it is deleted."""
    try:
        engine = eng_client.get_engine(name=_engine_resource_name(engine_id))
    except Exception as e:
        if _is_missing_gcp_resource(e):
            return []
        raise HTTPException(status_code=500, detail=f"GCP engine lookup failed: {e}") from e
    return [_normalize_datastore_id(ds_id) for ds_id in engine.data_store_ids if ds_id]


def _datastore_ids_to_delete(engine_id: str, eng_client) -> list[str]:
    engine_id = _normalize_datastore_id(engine_id)
    linked = _linked_datastore_ids_from_engine(eng_client, engine_id)
    ids: list[str] = []
    seen: set[str] = set()
    for candidate in [*linked, engine_id]:
        if candidate and candidate not in seen:
            seen.add(candidate)
            ids.append(candidate)
    return ids


@router.delete("/")
def delete_datastore(datastore_id: str, db: Session = Depends(get_db)):
    datastore_id = _normalize_datastore_id(datastore_id)
    if not datastore_id:
        raise HTTPException(status_code=400, detail="datastore_id is required")

    ds_client = _ds_client()
    eng_client = _engine_client()

    gcp_datastore_ids = _datastore_ids_to_delete(datastore_id, eng_client)

    _delete_gcp_engine(eng_client, datastore_id)

    for linked_id in gcp_datastore_ids:
        _delete_gcp_datastore(ds_client, linked_id)

    _cleanup_datastore_db(db, datastore_id)

    return {"deleted": datastore_id, "gcp_datastore_ids": gcp_datastore_ids}
