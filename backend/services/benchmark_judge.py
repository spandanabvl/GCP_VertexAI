"""LLM judge — one Gemini 2.5 Pro call after the full benchmark batch."""

from __future__ import annotations

import json
import os
import re
from typing import Any

from google import genai
from google.genai.types import GenerateContentConfig

from config import PROJECT_ID
from utils.telemetry import ENGINE_DISPLAY, QueryRun

JUDGE_LOCATION = os.getenv("JUDGE_LOCATION", "us-central1")
JUDGE_MODEL = os.getenv("JUDGE_MODEL", "gemini-2.5-pro")

_judge_client = genai.Client(
    vertexai=True,
    project=PROJECT_ID,
    location=JUDGE_LOCATION,
)


def _format_chunks(chunks: list[str]) -> str:
    if not chunks:
        return "(no retrieved context)"
    parts = []
    for i, c in enumerate(chunks[:10], 1):
        text = (c or "").strip()
        if text:
            parts.append(f"[Chunk {i}]\n{text}")
    return "\n\n".join(parts) if parts else "(empty context)"


def _default_scores(question_count: int) -> list[tuple[int, int]]:
    return [(3, 3)] * question_count


def _parse_engine_scores(
    data: dict[str, Any],
    engine_types: list[str],
    question_count: int,
) -> dict[str, list[tuple[int, int]]]:
    out: dict[str, list[tuple[int, int]]] = {}
    engines_block = data.get("engines") if isinstance(data, dict) else None
    if not isinstance(engines_block, dict):
        engines_block = data if isinstance(data, dict) else {}

    for et in engine_types:
        raw_list = engines_block.get(et)
        if not isinstance(raw_list, list):
            raw_list = engines_block.get(ENGINE_DISPLAY.get(et, et))
        scores: list[tuple[int, int]] = []
        if isinstance(raw_list, list):
            for item in raw_list[:question_count]:
                if isinstance(item, dict):
                    acc = max(1, min(5, int(item.get("accuracy", 3))))
                    rel = max(1, min(5, int(item.get("relevance", 3))))
                    scores.append((acc, rel))
        while len(scores) < question_count:
            scores.append((3, 3))
        out[et] = scores[:question_count]
    return out


def _build_batch_prompt(runs_by_engine: dict[str, list[QueryRun]]) -> str:
    sections: list[str] = []
    for et, runs in runs_by_engine.items():
        label = ENGINE_DISPLAY.get(et, et)
        sections.append(f"######## ENGINE: {label} (id: {et}) ########")
        for i, run in enumerate(runs, 1):
            sections.append(
                f"\n--- Question {i} ---\n"
                f"USER QUESTION:\n{run.question}\n\n"
                f"RETRIEVED CONTEXT:\n{_format_chunks(run.chunks)}\n\n"
                f"ASSISTANT ANSWER:\n{run.answer}\n"
            )
    body = "\n".join(sections)
    engine_ids = list(runs_by_engine.keys())
    ids_json = json.dumps(engine_ids)
    return f"""You are an expert, impartial RAG evaluation judge.
You will score EVERY question for EVERY engine below in a single pass.

Rubric (per question, per engine):
- accuracy (1-5): Supported by retrieved context? 1=hallucination, 3=partial, 5=fully grounded.
- relevance (1-5): Answers the question? 1=off-topic, 3=partial, 5=complete.

Penalize invented facts, ignoring context, vague filler, wrong focus.
Do NOT default to 5. Typical good answers: 3-4.

=== BENCHMARK DATA ===
{body}

Return ONLY valid JSON with one array per engine id (same order as questions above):
{{
  "engines": {{
    "<engine_id>": [{{"accuracy": <int>, "relevance": <int>}}, ...],
    ...
  }}
}}

Required engine ids (use these keys exactly): {ids_json}
Each array length must equal the number of questions for that engine."""


def judge_benchmark_batch(
    runs_by_engine: dict[str, list[QueryRun]],
) -> dict[str, list[tuple[int, int]]]:
    """
    Single Pro call after all RAG work completes.
    Returns per-engine list of (accuracy, relevance) per question.
    """
    if not runs_by_engine:
        return {}

    engine_types = list(runs_by_engine.keys())
    question_count = max(len(v) for v in runs_by_engine.values()) or 0
    if question_count == 0:
        return {et: [] for et in engine_types}

    prompt = _build_batch_prompt(runs_by_engine)
    try:
        response = _judge_client.models.generate_content(
            model=JUDGE_MODEL,
            contents=[{"role": "user", "parts": [{"text": prompt}]}],
            config=GenerateContentConfig(
                temperature=0.1,
                response_mime_type="application/json",
            ),
        )
        text = (response.text or "").strip()
        match = re.search(r"\{.*\}", text, re.DOTALL)
        raw = match.group() if match else text
        data = json.loads(raw)
        return _parse_engine_scores(data, engine_types, question_count)
    except Exception:
        pass

    return {et: _default_scores(len(runs)) for et, runs in runs_by_engine.items()}


def judge_answer(question: str, answer: str, chunks: list[str]) -> tuple[int, int]:
    """Legacy per-question judge (unused by benchmark; kept for compatibility)."""
    single = judge_benchmark_batch(
        {"_single": [QueryRun(question, answer, chunks, 0, 0, 0.0)]}
    )
    scores = single.get("_single", [(3, 3)])
    return scores[0] if scores else (3, 3)
