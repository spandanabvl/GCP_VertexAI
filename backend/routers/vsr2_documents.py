import os
import tempfile

from fastapi import APIRouter, File, HTTPException, UploadFile
from google.cloud import aiplatform
from vertexai.preview import rag

from config import PROJECT_ID

VS2_LOCATION = "us-central1"

router = APIRouter()

ALLOWED_EXTENSIONS = {".pdf", ".txt", ".docx", ".csv", ".xlsx", ".xls"}


def _init():
    aiplatform.init(project=PROJECT_ID, location=VS2_LOCATION)


# ── POST /vsr2-documents/upload ────────────────────────────────────────────────

@router.post("/upload")
async def upload_document(corpus_name: str, file: UploadFile = File(...)):
    _init()
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"File type '{ext}' not supported.")

    with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        rag_file = rag.upload_file(
            corpus_name=corpus_name,
            path=tmp_path,
            display_name=file.filename,
            description=f"Uploaded via RAG Studio VS2.0",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {e}")
    finally:
        os.unlink(tmp_path)

    # Expose file_status.state (ACTIVE / PROCESSING / FAILED) from VS2 API
    try:
        state = str(rag_file.file_status.state) if rag_file.file_status else "PROCESSING"
    except Exception:
        state = "PROCESSING"

    return {
        "name":         rag_file.name,
        "display_name": file.filename,
        "state":        state,
    }


# ── GET /vsr2-documents/ ───────────────────────────────────────────────────────

@router.get("/")
def list_files(corpus_name: str):
    _init()
    try:
        files = list(rag.list_files(corpus_name=corpus_name))
        result = []
        for f in files:
            try:
                state = str(f.file_status.state) if f.file_status else "UNKNOWN"
            except Exception:
                state = "UNKNOWN"
            result.append({
                "name":         f.name,
                "display_name": f.display_name,
                "state":        state,   # ACTIVE | PROCESSING | FAILED
            })
        return result
    except Exception:
        return []


# ── DELETE /vsr2-documents/ ────────────────────────────────────────────────────
# Delete logic matches the notebook exactly:
# 1. list_files to confirm existence
# 2. rag.delete_file by resource name

@router.delete("/")
def delete_file(corpus_name: str, file_name: str):
    _init()
    try:
        # Verify file exists in this corpus before deleting (as in notebook)
        files = list(rag.list_files(corpus_name=corpus_name))
        match = next((f for f in files if f.name == file_name), None)
        if not match:
            raise HTTPException(
                status_code=404,
                detail=f"File '{file_name}' not found in corpus '{corpus_name}'"
            )
        rag.delete_file(name=file_name)
        return {"deleted": file_name}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))