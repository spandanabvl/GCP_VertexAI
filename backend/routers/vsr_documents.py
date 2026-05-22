import os
import tempfile

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

import vertexai
from vertexai import rag

from config import PROJECT_ID, LOCATION
from database import get_db

vertexai.init(project=PROJECT_ID, location=LOCATION)

router = APIRouter()

ALLOWED_EXTENSIONS = {".pdf", ".txt", ".docx", ".csv", ".xlsx", ".xls"}


# ── POST /vsr-documents/upload ─────────────────────────────────────────────────
# Vector Search uses STREAM_UPDATE index — embeddings are pushed automatically
# on upload, no manual sync needed (unlike Feature Store RAG).

@router.post("/upload")
async def upload_document(
    corpus_name: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
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
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {e}")
    finally:
        os.unlink(tmp_path)

    # STREAM_UPDATE index automatically indexes new embeddings — no sync step.
    return {
        "name":         rag_file.name,
        "display_name": file.filename,
    }


# ── GET /vsr-documents/ ────────────────────────────────────────────────────────

@router.get("/")
def list_files(corpus_name: str):
    try:
        files = list(rag.list_files(corpus_name=corpus_name))
        return [{"name": f.name, "display_name": f.display_name} for f in files]
    except Exception:
        return []


# ── DELETE /vsr-documents/ ────────────────────────────────────────────────────

@router.delete("/")
def delete_file(file_name: str):
    try:
        rag.delete_file(name=file_name)
        return {"deleted": file_name}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
