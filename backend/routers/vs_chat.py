import json
import re
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import text

import vertexai
from vertexai.generative_models import GenerativeModel
from google.cloud import discoveryengine_v1 as discoveryengine
from google.protobuf import json_format, struct_pb2

from config import PROJECT_ID, LOCATION
from database import get_db
from routers.vs_common import engine_serving_config_path

vertexai.init(project=PROJECT_ID, location=LOCATION)

router = APIRouter()

_NO_RESULTS_MSG = "No results could be found. Try rephrasing the search query."

_SUMMARY_FAILURE_RE = re.compile(
    r"no results could be found|try rephrasing",
    re.I,
)

# Summary claims absence; prefer Gemini when we also have retrieved passages
_SUMMARY_NEGATIVE_RE = re.compile(
    r"no .+ listed|there are no|not listed|cannot provide|cannot list|"
    r"do(?:es)? not contain|don't contain|no definitions|"
    r"nothing listed|i am sorry|i'm sorry|provided document does not",
    re.I,
)

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.I,
)


def _struct_as_dict(data: Any) -> dict[str, Any]:
    if not data:
        return {}
    if isinstance(data, dict):
        return data
    try:
        return json_format.MessageToDict(data, preserving_proto_field_name=False)
    except (TypeError, ValueError):
        pass
    try:
        return dict(data)
    except (TypeError, ValueError):
        return {}

def _append_passage(passages: list[str], seen: set[str], text: str) -> None:
    cleaned = (text or "").strip()
    if cleaned and cleaned not in seen:
        seen.add(cleaned)
        passages.append(cleaned)


def _passages_from_document_data(data: dict[str, Any], passages: list[str], seen: set[str]) -> None:
    for seg in data.get("extractive_segments") or []:
        content = seg.get("content", "") if isinstance(seg, dict) else getattr(seg, "content", "") or ""
        _append_passage(passages, seen, content)
    for ans in data.get("extractive_answers") or []:
        if isinstance(ans, dict):
            content = ans.get("content") or ans.get("answer") or ""
        else:
            content = getattr(ans, "content", None) or getattr(ans, "answer", None) or str(ans)
        _append_passage(passages, seen, content)
    for snip in data.get("snippets") or []:
        snippet = snip.get("snippet", "") if isinstance(snip, dict) else getattr(snip, "snippet", "") or str(snip)
        _append_passage(passages, seen, snippet)


def _collect_passages(response) -> list[str]:
    passages: list[str] = []
    seen: set[str] = set()
    for result in response.results:
        chunk = result.chunk
        if chunk and chunk.content:
            _append_passage(passages, seen, chunk.content)
            continue
        doc = result.document
        if not doc:
            continue
        for raw in (doc.derived_struct_data, doc.struct_data):
            _passages_from_document_data(_struct_as_dict(raw), passages, seen)
    return passages


def _merge_passages(accumulated: list[str], seen: set[str], response) -> None:
    for passage in _collect_passages(response):
        _append_passage(accumulated, seen, passage)


def _collect_sources(response) -> list[str]:
    sources: list[str] = []
    for result in response.results:
        chunk = result.chunk
        if chunk and chunk.document_metadata:
            meta = chunk.document_metadata
            source = meta.title or meta.uri or ""
            if source and source not in sources:
                sources.append(source)
            continue
        doc = result.document
        if not doc:
            continue
        data = _struct_as_dict(doc.derived_struct_data)
        source = data.get("title") or data.get("link") or doc.name.split("/")[-1]
        if source and source not in sources:
            sources.append(source)
    return sources


def _summary_usable(summary_text: str) -> bool:
    return bool(summary_text and not _SUMMARY_FAILURE_RE.search(summary_text))


def _summary_denies_content(summary_text: str) -> bool:
    """Vertex summary claims content is missing; prefer Gemini when passages exist."""
    return bool(summary_text and _SUMMARY_NEGATIVE_RE.search(summary_text))


def _build_search_request(
    serving_config: str,
    query: str,
    top_k: int,
    *,
    with_summary: bool,
    chunks_mode: bool,
) -> discoveryengine.SearchRequest:
    spec_cls = discoveryengine.SearchRequest.ContentSearchSpec
    summary_spec = None
    if with_summary:
        summary_spec = spec_cls.SummarySpec(
            summary_result_count=top_k,
            include_citations=True,
            ignore_adversarial_query=False,
            ignore_non_summary_seeking_query=False,
            model_spec=spec_cls.SummarySpec.ModelSpec(version="preview"),
            model_prompt_spec=spec_cls.SummarySpec.ModelPromptSpec(
                preamble=(
                        "You are a helpful AI assistant.\n"
                        "Answer using the provided document context.\n"
                        "If partial information is available, provide the best possible answer.\n"
                        "Do not say you don't know unless absolutely no relevant context exists.\n"
                        "Be clear and slightly detailed."
                ),
            ),
        )

    if chunks_mode:
        content_search_spec = spec_cls(
            search_result_mode=spec_cls.SearchResultMode.CHUNKS,
            chunk_spec=spec_cls.ChunkSpec(num_previous_chunks=2, num_next_chunks=2),
            summary_spec=summary_spec,
        )
    else:
        content_search_spec = spec_cls(
            search_result_mode=spec_cls.SearchResultMode.DOCUMENTS,
            snippet_spec=spec_cls.SnippetSpec(return_snippet=True, max_snippet_count=top_k),
            extractive_content_spec=spec_cls.ExtractiveContentSpec(
                max_extractive_answer_count=top_k,
                max_extractive_segment_count=top_k,
            ),
            summary_spec=summary_spec,
        )

    return discoveryengine.SearchRequest(
        serving_config=serving_config,
        query=query,
        page_size=top_k,
        query_expansion_spec=discoveryengine.SearchRequest.QueryExpansionSpec(
            condition=discoveryengine.SearchRequest.QueryExpansionSpec.Condition.AUTO,
        ),
        spell_correction_spec=discoveryengine.SearchRequest.SpellCorrectionSpec(
            mode=discoveryengine.SearchRequest.SpellCorrectionSpec.Mode.AUTO,
        ),
        content_search_spec=content_search_spec,
    )


def _answer_with_gemini(question: str, passages: list[str]) -> str:
    context = "\n\n---\n\n".join(passages[:15])
    prompt = f"""Answer using only the context below.
If the question asks for a list, list every matching item found in the context.
If the context contains the answer, state it clearly with names and details.
Only say information is missing if it truly does not appear in the context.

Context:
{context}

Question:
{question}"""
    return GenerativeModel("gemini-2.5-flash").generate_content(prompt).text

# ── Request model ──────────────────────────────────────────────────────────────

class VSChatRequest(BaseModel):
    datastore_id:    str
    question:        str
    page_size:       int = 5
    conversation_id: Optional[str] = None


# ── POST /vs-chat/  ────────────────────────────────────────────────────────────

@router.post("/")
def vs_chat(req: VSChatRequest, db: Session = Depends(get_db)):

    cid = (req.conversation_id or "").strip()

    # 1. Resolve conversation row (new or existing for this datastore)
    if not cid:
        row = db.execute(text("""
            INSERT INTO vs_conversations (datastore_id, title, messages)
            VALUES (:did, :title, '[]'::jsonb)
            RETURNING id
        """), {"did": req.datastore_id, "title": req.question[:60]})
        conversation_id = str(row.fetchone()[0])
        db.commit()
    else:
        if not _UUID_RE.match(cid):
            raise HTTPException(status_code=400, detail="Invalid conversation_id")
        exists = db.execute(
            text("""
            SELECT 1 FROM vs_conversations
            WHERE id = CAST(:id AS uuid) AND datastore_id = :did
        """),
            {"id": cid, "did": req.datastore_id},
        ).fetchone()
        if not exists:
            raise HTTPException(
                status_code=404,
                detail="Conversation not found for this datastore.",
            )
        conversation_id = cid

    # 2. Load prior nav_token if exists (for conversation threading)
    conv_row = db.execute(
        text("SELECT messages FROM vs_conversations WHERE id = CAST(:id AS uuid)"),
        {"id": conversation_id},
    ).fetchone()
    messages_so_far = conv_row[0] if conv_row else []
    if not isinstance(messages_so_far, list):
        messages_so_far = []
    nav_token = None
    for m in reversed(messages_so_far):
        if m.get("role") == "assistant" and m.get("nav_token"):
            nav_token = m["nav_token"]
            break

    # 3. Call Vertex AI Search (Search app / Engine linked to this datastore at create time)
    search_client = discoveryengine.SearchServiceClient()
    serving_config = engine_serving_config_path(PROJECT_ID, req.datastore_id)

    top_k = max(req.page_size or 10, 10)
    question = req.question.strip()

    def _do_search(query: str, *, with_summary: bool, chunks_mode: bool):
        request = _build_search_request(
            serving_config, query, top_k, with_summary=with_summary, chunks_mode=chunks_mode
        )
        if nav_token and with_summary:
            params = struct_pb2.Struct()
            params.update({"conversation_token": nav_token})
            request.params.update(params)
        return search_client.search(request)

    try:
        response = _do_search(question, with_summary=True, chunks_mode=True)
    except Exception as e:
        return {
            "answer": f"Search failed: {e}",
            "sources": [],
            "passages_used": 0,
            "conversation_id": conversation_id,
        }

    passages: list[str] = []
    seen_passages: set[str] = set()
    _merge_passages(passages, seen_passages, response)
    sources = _collect_sources(response)
    summary_text = (response.summary.summary_text or "").strip() if response.summary else ""

    # Retry retrieval when summary failed or denies content and we need passages for Gemini
    need_more = not _summary_usable(summary_text) or _summary_denies_content(summary_text)
    if need_more and len(passages) < 3:
        for query, chunks_mode, with_summary in (
            (question, True, False),
            (question, False, True),
            (question, False, False),
        ):
            try:
                retry = _do_search(query, with_summary=with_summary, chunks_mode=chunks_mode)
            except Exception:
                continue
            _merge_passages(passages, seen_passages, retry)
            if not _summary_usable(summary_text) and retry.summary and retry.summary.summary_text:
                summary_text = (retry.summary.summary_text or "").strip()
            if len(passages) >= 3:
                response = retry
                sources = _collect_sources(response)
                break

    new_token = (
        getattr(response.summary, "conversation_token", None) if response.summary else None
    )

    use_summary = _summary_usable(summary_text) and not _summary_denies_content(summary_text)

    # 1) Usable, non-negative summary → Vertex summary
    # 2) Otherwise passages/chunks → Gemini
    # 3) Neither → standard no-results message
    if use_summary:
        answer = summary_text
    elif passages:
        answer = _answer_with_gemini(req.question, passages)
    else:
        answer = _NO_RESULTS_MSG

    passages_used = len(passages)

    # 5. Save to DB
    new_msgs = json.dumps([
        {"role": "user", "text": req.question},
        {
            "role": "assistant",
            "text": answer,
            "sources": sources,
            "passages_used": passages_used,
            "nav_token": new_token,
        },
    ])
    db.execute(
        text("""
        UPDATE vs_conversations
        SET messages   = messages || CAST(:new_msgs AS jsonb),
            updated_at = NOW()
        WHERE id = CAST(:id AS uuid)
    """),
        {"new_msgs": new_msgs, "id": conversation_id},
    )
    db.commit()

    return {
        "answer": answer,
        "sources": sources,
        "passages_used": passages_used,
        "conversation_id": conversation_id,
    }


# ── GET /vs-chat/conversations ─────────────────────────────────────────────────

@router.get("/conversations")
def list_conversations(datastore_id: str, db: Session = Depends(get_db)):
    rows = db.execute(text("""
        SELECT id, title, updated_at
        FROM   vs_conversations
        WHERE  datastore_id = :did
        ORDER  BY updated_at DESC
    """), {"did": datastore_id}).fetchall()
    return [{"id": str(r[0]), "title": r[1] or "Untitled", "updated_at": str(r[2])} for r in rows]


# ── GET /vs-chat/conversations/{id} ───────────────────────────────────────────

@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: str, db: Session = Depends(get_db)):
    row = db.execute(
        text("""
        SELECT id, title, messages FROM vs_conversations WHERE id = CAST(:id AS uuid)
    """),
        {"id": conversation_id},
    ).fetchone()
    if not row:
        return {"error": "Not found"}
    return {"id": str(row[0]), "title": row[1] or "Untitled", "messages": row[2]}


# ── DELETE /vs-chat/conversations/{id} ────────────────────────────────────────

@router.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: str, db: Session = Depends(get_db)):
    db.execute(
        text("DELETE FROM vs_conversations WHERE id = CAST(:id AS uuid)"),
        {"id": conversation_id},
    )
    db.commit()
    return {"deleted": conversation_id}
