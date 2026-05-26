"""Unified tool-based RAG workers (google.genai) for benchmark evaluation."""



from __future__ import annotations



import time

from typing import Any



from google import genai

from google.genai.types import (

    GenerateContentConfig,

    RagRetrievalConfig,

    RagRetrievalConfigHybridSearch,

    Retrieval,

    Tool,

    VertexRagStore,

    VertexRagStoreRagResource,

)



from config import LOCATION, PROJECT_ID

from utils.telemetry import CorpusProfile, QueryRun, sanitize_input_tokens



_clients: dict[tuple[str, str], genai.Client] = {}


def _parse_project_location(resource_name: str) -> tuple[str, str]:
    """
    Extract (project, location) from a Vertex resource name like:
    projects/<project>/locations/<location>/ragCorpora/<id>
    Falls back to config defaults when parsing fails.
    """
    try:
        parts = (resource_name or "").split("/")
        p_idx = parts.index("projects") + 1 if "projects" in parts else -1
        l_idx = parts.index("locations") + 1 if "locations" in parts else -1
        project = parts[p_idx] if p_idx > 0 and p_idx < len(parts) else PROJECT_ID
        location = parts[l_idx] if l_idx > 0 and l_idx < len(parts) else LOCATION
        return project or PROJECT_ID, location or LOCATION
    except Exception:
        return PROJECT_ID, LOCATION


def _get_client_for_resource(resource_name: str) -> genai.Client:
    project, location = _parse_project_location(resource_name)
    key = (project, location)
    client = _clients.get(key)
    if client is None:
        client = genai.Client(vertexai=True, project=project, location=location)
        _clients[key] = client
    return client

_MODEL = "gemini-2.5-flash"



_DEFAULT_TOP_K = {

    "ragmanageddb": 5,

    "feature_store_rag": 5,

    "vector_search_rag": 10,

}





def _extract_grounding_chunks(response: Any) -> list[str]:

    chunks: list[str] = []

    try:

        candidates = getattr(response, "candidates", None) or []

        if not candidates:

            return chunks

        g_meta = getattr(candidates[0], "grounding_metadata", None)

        if not g_meta:

            return chunks

        for gc in getattr(g_meta, "grounding_chunks", None) or []:

            rc = getattr(gc, "retrieved_context", None)

            if rc is None:

                continue

            text = getattr(rc, "text", None)

            if text and str(text).strip():

                chunks.append(str(text).strip())

                continue

            rag_chunk = getattr(rc, "rag_chunk", None)

            if rag_chunk:

                chunk_text = getattr(rag_chunk, "text", None)

                if chunk_text and str(chunk_text).strip():

                    chunks.append(str(chunk_text).strip())

    except Exception:

        pass

    return chunks





def _build_rag_tool(profile: CorpusProfile, top_k: int) -> Tool:

    store_kwargs: dict[str, Any] = {

        "rag_resources": [

            VertexRagStoreRagResource(rag_corpus=profile.gcp_resource_name)

        ],

    }



    if profile.engine_type == "feature_store_rag":

        store_kwargs["rag_retrieval_config"] = RagRetrievalConfig(

            top_k=top_k,

            hybrid_search=RagRetrievalConfigHybridSearch(alpha=0.5),

        )

    elif profile.engine_type == "vector_search_rag":

        store_kwargs["rag_retrieval_config"] = RagRetrievalConfig(top_k=top_k)

        store_kwargs["vector_distance_threshold"] = 0.4

    else:

        store_kwargs["rag_retrieval_config"] = RagRetrievalConfig(top_k=top_k)



    return Tool(

        retrieval=Retrieval(

            vertex_rag_store=VertexRagStore(**store_kwargs),

        )

    )





def run_unified_tool_worker(profile: CorpusProfile, question: str, top_k: int | None = None) -> QueryRun:

    """

    Tool-calling RAG for all engines via google.genai.

    Chunks from grounding_metadata; input tokens sanitized in telemetry.

    """

    if top_k is None:

        top_k = _DEFAULT_TOP_K.get(profile.engine_type, 5)



    t0 = time.perf_counter()

    tool = _build_rag_tool(profile, top_k)
    client = _get_client_for_resource(profile.gcp_resource_name)



    try:

        response = client.models.generate_content(

            model=_MODEL,

            contents=[{"role": "user", "parts": [{"text": question}]}],

            config=GenerateContentConfig(tools=[tool]),

        )

        answer = response.text or ""

        meta = getattr(response, "usage_metadata", None)

        raw_in = int(getattr(meta, "prompt_token_count", 0) or 0)

        out_tok = int(getattr(meta, "candidates_token_count", 0) or 0)

        chunks = _extract_grounding_chunks(response)

        clean_in = sanitize_input_tokens(raw_in, question, chunks)

    except Exception as e:

        answer = f"Generation failed: {e}"

        chunks = []

        clean_in, out_tok = sanitize_input_tokens(0, question, []), 0



    return QueryRun(

        question=question,

        answer=answer,

        chunks=chunks,

        input_tokens=clean_in,

        output_tokens=out_tok,

        latency_sec=time.perf_counter() - t0,

    )





def run_worker(profile: CorpusProfile, question: str) -> QueryRun:

    return run_unified_tool_worker(profile, question)


