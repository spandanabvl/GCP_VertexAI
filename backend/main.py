from contextlib import asynccontextmanager

import config  # noqa: F401 — load .env before database engine

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import init_db
from routers import corpora, documents, chat
from routers import vs_datastores, vs_documents, vs_chat
from routers import fs_corpora, fs_documents, fs_chat
from routers import vsr_corpora, vsr_documents, vsr_chat
from routers import benchmark


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

app.include_router(corpora.router, prefix="/corpora")
app.include_router(documents.router, prefix="/documents")
app.include_router(chat.router, prefix="/chat")

# ── Vertex AI Search ───────────────────────────────────────────────────────────
app.include_router(vs_datastores.router, prefix="/vs-datastores")
app.include_router(vs_documents.router,  prefix="/vs-documents")
app.include_router(vs_chat.router,       prefix="/vs-chat")

# ── Feature Store RAG ──────────────────────────────────────────────────────────
app.include_router(fs_corpora.router,   prefix="/fs-corpora")
app.include_router(fs_documents.router, prefix="/fs-documents")
app.include_router(fs_chat.router,      prefix="/fs-chat")

# ── Vector Search RAG ──────────────────────────────────────────────────────────
app.include_router(vsr_corpora.router,   prefix="/vsr-corpora")
app.include_router(vsr_documents.router, prefix="/vsr-documents")
app.include_router(vsr_chat.router,      prefix="/vsr-chat")

# ── RAG Benchmark & Telemetry ───────────────────────────────────────────────────
app.include_router(benchmark.router, prefix="/api")