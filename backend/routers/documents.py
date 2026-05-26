import csv
import os
import tempfile

import vertexai
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from vertexai.preview import rag

from config import LOCATION, PROJECT_ID
from flow_stream import ndjson_line

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

    def stream():
        converted_path: str | None = None
        upload_path = raw_path
        try:
            if ext == ".csv":
                converted_path = _csv_to_txt(raw_path)
                upload_path = converted_path

            yield ndjson_line({
                "phase": "ingest",
                "message": "Vertex RAG Corpus · rag.upload_file (ingest)…",
            })

            rag_file = rag.upload_file(
                corpus_name=corpus_name,
                path=upload_path,
                display_name=file.filename,
            )

            yield ndjson_line({
                "phase": "indexed",
                "message": "RAG Managed DB · embed / index complete",
            })

            yield ndjson_line({
                "phase": "complete",
                "file": {"name": rag_file.name, "display_name": file.filename},
            })
        except RuntimeError as exc:
            detail = str(exc)
            if "not supported" in detail.lower():
                detail = (
                    f"Vertex AI RAG does not accept '{ext}' files. Use PDF, TXT, or DOCX."
                )
            yield ndjson_line({"phase": "error", "detail": detail})
        except Exception as exc:
            yield ndjson_line({"phase": "error", "detail": str(exc)})
        finally:
            _safe_unlink(raw_path)
            if converted_path and converted_path != raw_path:
                _safe_unlink(converted_path)

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@router.get("/")
def list_files(corpus_name: str):
    files = rag.list_files(corpus_name=corpus_name)
    return [{"name": f.name, "display_name": f.display_name} for f in files]


@router.delete("/")
def delete_file(corpus_name: str, file_name: str):
    def stream():
        try:
            yield ndjson_line({
                "phase": "deleting",
                "step": "file",
                "message": "DELETE /documents/ · request received",
            })
            yield ndjson_line({
                "phase": "deleting",
                "step": "corpus",
                "message": "Vertex RAG Corpus · rag.delete_file…",
            })
            rag.delete_file(name=file_name)
            yield ndjson_line({
                "phase": "deleting",
                "step": "vectors",
                "message": "RAG Managed DB · vectors removed",
            })
            yield ndjson_line({
                "phase": "complete",
                "deleted": file_name,
            })
        except Exception as exc:
            yield ndjson_line({"phase": "error", "detail": str(exc)})

    return StreamingResponse(stream(), media_type="application/x-ndjson")
