"""Synchronous RAG workers (run via asyncio.to_thread in benchmark route)."""

from __future__ import annotations

import time
from typing import Any

import vertexai
from google import genai
from google.genai.types import GenerateContentConfig, Retrieval, Tool, VertexRagStore, VertexRagStoreRagResource
from vertexai.generative_models import GenerativeModel, Tool as VTool
from vertexai.preview import rag

from config import LOCATION, PROJECT_ID
from utils.telemetry import CorpusProfile, QueryRun

vertexai.init(project=PROJECT_ID, location=LOCATION)

_genai = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)
_MODEL = "gemini-2.5-flash"


def _usage_from_vertex(result: Any) -> tuple[int, int]:
    meta = getattr(result, "usage_metadata", None)
    if not meta:
        return 0, 0
    return (
        int(getattr(meta, "prompt_token_count", 0) or 0),
        int(getattr(meta, "candidates_token_count", 0) or 0),
    )


def _usage_from_genai(response: Any) -> tuple[int, int]:
    meta = getattr(response, "usage_metadata", None)
    if not meta:
        return 0, 0
    return (
        int(getattr(meta, "prompt_token_count", 0) or 0),
        int(getattr(meta, "candidates_token_count", 0) or 0),
    )


def _retrieve_chunks(corpus_name: str, question: str, top_k: int = 5) -> list[str]:
    try:
        resp = rag.retrieval_query(
            rag_resources=[rag.RagResource(rag_corpus=corpus_name)],
            text=question,
            similarity_top_k=top_k,
        )
        return [c.text for c in resp.contexts.contexts if c.text]
    except Exception:
        return []


def run_rag_managed(profile: CorpusProfile, question: str, top_k: int = 5) -> QueryRun:
    t_ret = time.perf_counter()
    chunks = _retrieve_chunks(profile.gcp_resource_name, question, top_k)
    retrieval_sec = time.perf_counter() - t_ret

    combined = "\n\n".join(chunks) if chunks else "No relevant context found."
    prompt = f"""Answer using the context below. If the context does not contain enough information, say so clearly.

Context:
{combined}

Question:
{question}"""

    t_gen = time.perf_counter()
    result = GenerativeModel(_MODEL).generate_content(prompt)
    answer = result.text or ""
    in_tok, out_tok = _usage_from_vertex(result)
    generation_sec = time.perf_counter() - t_gen

    return QueryRun(
        question=question,
        answer=answer,
        chunks=chunks,
        input_tokens=in_tok,
        output_tokens=out_tok,
        latency_sec=retrieval_sec + generation_sec,
    )


def run_feature_store(profile: CorpusProfile, question: str, top_k: int = 5, alpha: float = 0.5) -> QueryRun:
    t_ret = time.perf_counter()
    chunks = _retrieve_chunks(profile.gcp_resource_name, question, top_k)
    retrieval_sec = time.perf_counter() - t_ret

    rag_tool = VTool.from_retrieval(
        retrieval=rag.Retrieval(
            source=rag.VertexRagStore(
                rag_resources=[rag.RagResource(rag_corpus=profile.gcp_resource_name)],
                rag_retrieval_config=rag.RagRetrievalConfig(
                    top_k=top_k,
                    hybrid_search=rag.HybridSearch(alpha=alpha),
                ),
            ),
        )
    )
    t_gen = time.perf_counter()
    try:
        model = GenerativeModel(model_name=_MODEL, tools=[rag_tool])
        response = model.generate_content(question)
        answer = response.text or ""
        in_tok, out_tok = _usage_from_vertex(response)
    except Exception as e:
        answer = f"Generation failed: {e}"
        in_tok, out_tok = 0, 0
    generation_sec = time.perf_counter() - t_gen

    return QueryRun(
        question=question,
        answer=answer,
        chunks=chunks,
        input_tokens=in_tok,
        output_tokens=out_tok,
        latency_sec=retrieval_sec + generation_sec,
    )


def run_vector_search(profile: CorpusProfile, question: str, top_k: int = 10) -> QueryRun:
    t_ret = time.perf_counter()
    chunks = _retrieve_chunks(profile.gcp_resource_name, question, top_k)
    retrieval_sec = time.perf_counter() - t_ret

    rag_tool = Tool(
        retrieval=Retrieval(
            vertex_rag_store=VertexRagStore(
                rag_resources=[VertexRagStoreRagResource(rag_corpus=profile.gcp_resource_name)],
                similarity_top_k=top_k,
                vector_distance_threshold=0.4,
            )
        )
    )
    t_gen = time.perf_counter()
    try:
        response = _genai.models.generate_content(
            model=_MODEL,
            contents=[{"role": "user", "parts": [{"text": question}]}],
            config=GenerateContentConfig(tools=[rag_tool]),
        )
        answer = response.text or ""
        in_tok, out_tok = _usage_from_genai(response)
    except Exception as e:
        answer = f"Generation failed: {e}"
        in_tok, out_tok = 0, 0
    generation_sec = time.perf_counter() - t_gen

    return QueryRun(
        question=question,
        answer=answer,
        chunks=chunks,
        input_tokens=in_tok,
        output_tokens=out_tok,
        latency_sec=retrieval_sec + generation_sec,
    )


def run_worker(profile: CorpusProfile, question: str) -> QueryRun:
    et = profile.engine_type
    if et == "ragmanageddb":
        return run_rag_managed(profile, question)
    if et == "feature_store_rag":
        return run_feature_store(profile, question)
    if et == "vector_search_rag":
        return run_vector_search(profile, question)
    raise ValueError(f"Unknown engine_type: {et}")
