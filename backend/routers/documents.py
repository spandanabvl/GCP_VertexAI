import csv
import os
import tempfile

import vertexai
from fastapi import APIRouter, File, HTTPException, UploadFile
from vertexai.preview import rag

from config import LOCATION, PROJECT_ID

vertexai.init(project=PROJECT_ID, location=LOCATION)
router = APIRouter()

ALLOWED_EXTENSIONS = {".pdf", ".txt", ".docx", ".csv"}


def _safe_unlink(path: str | None) -> None:
    if not path:
        return
    try:
        os.unlink(path)
    except OSError:
        pass


def _csv_to_txt(src_path: str) -> str:
    fd, txt_path = tempfile.mkstemp(suffix=".txt")
    os.close(fd)
    with open(src_path, newline="", encoding="utf-8", errors="replace") as src:
        with open(txt_path, "w", encoding="utf-8") as out:
            for row in csv.reader(src):
                out.write("\t".join(row))
                out.write("\n")
    return txt_path


@router.post("/upload")
async def upload_document(corpus_name: str, file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"File type '{ext}' not supported.")

    with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
        tmp.write(await file.read())
        raw_path = tmp.name

    converted_path: str | None = None
    upload_path = raw_path
    try:
        if ext == ".csv":
            converted_path = _csv_to_txt(raw_path)
            upload_path = converted_path

        rag_file = rag.upload_file(
            corpus_name=corpus_name,
            path=upload_path,
            display_name=file.filename,
        )
        return {"name": rag_file.name, "display_name": file.filename}
    except RuntimeError as exc:
        detail = str(exc)
        if "not supported" in detail.lower():
            raise HTTPException(
                status_code=400,
                detail=f"Vertex AI RAG does not accept '{ext}' files. Use PDF, TXT, or DOCX.",
            ) from exc
        raise HTTPException(status_code=502, detail=detail) from exc
    finally:
        _safe_unlink(raw_path)
        if converted_path and converted_path != raw_path:
            _safe_unlink(converted_path)


@router.get("/")
def list_files(corpus_name: str):
    files = rag.list_files(corpus_name=corpus_name)
    return [{"name": f.name, "display_name": f.display_name} for f in files]


@router.delete("/")
def delete_file(corpus_name: str, file_name: str):
    rag.delete_file(name=file_name)
    return {"deleted": file_name}
