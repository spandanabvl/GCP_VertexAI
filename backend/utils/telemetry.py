"""
RAG Benchmark telemetry: 9 characteristics with engine-specific cost rules (2026 Gemini 2.5 Flash).
Multi-question batches aggregate per-engine runs (sum cost/tokens/latency, avg quality).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# Gemini 2.5 Flash (per 1M tokens) — RAG workers only
INPUT_RATE = 0.30 / 1_000_000
OUTPUT_RATE = 2.50 / 1_000_000
CACHED_INPUT_RATE = 0.03 / 1_000_000

RAG_RETRIEVAL_FEE = 0.0025
RERANKER_PREMIUM = 0.0010

PARSER_BASIC = 0.00
PARSER_OCR = 1.50
VSR_INDEX_GIB_FEE = 3.00

ARCHITECTURE_LABELS = {
    "ragmanageddb": "Managed Orchestration & Spanner Layer",
    "vector_search_rag": "Low-Latency Raw Vector ANN",
    "feature_store_rag": "Optimized Online Entity Serving",
}

ENGINE_DISPLAY = {
    "ragmanageddb": "RAG Managed DB",
    "vector_search_rag": "Vector Search RAG",
    "feature_store_rag": "Feature Store RAG",
}

FEATURE_NAMES = [
    "Engine Architecture Model",
    "Active Configuration Toggles",
    "Processing Latency Speed",
    "Setup Ingestion Fee",
    "Accumulated Query Test Cost",
    "Continuous Idle Maintenance Rate",
    "Total Words Processed (Tokens)",
    "System Quality Scores",
    "Generated Engine Responses",
]


@dataclass
class QueryRun:
    question: str
    answer: str
    chunks: list[str]
    input_tokens: int
    output_tokens: int
    latency_sec: float
    accuracy_score: int = 0
    relevance_score: int = 0


@dataclass
class CorpusProfile:
    engine_type: str
    name: str
    gcp_resource_name: str
    total_document_pages: int = 0
    total_documents_count: int = 0
    advanced_layout_parser: bool = False
    ocr_enabled: bool = False
    reranker_enabled: bool = False
    prompt_cache_enabled: bool = False
    multimodal_active: bool = False


def active_toggles(profile: CorpusProfile) -> list[str]:
    badges: list[str] = []
    if profile.ocr_enabled:
        badges.append("OCR")
    if profile.reranker_enabled:
        badges.append("Reranker")
    if profile.prompt_cache_enabled:
        badges.append("Prompt Cache")
    if profile.multimodal_active:
        badges.append("Multimodal")
    if profile.advanced_layout_parser:
        badges.append("Layout Parser")
    return badges or ["Standard"]


def setup_ingestion_fee(profile: CorpusProfile) -> float:
    parser_rate = PARSER_OCR if profile.ocr_enabled else PARSER_BASIC
    fee = (profile.total_document_pages / 1000.0) * parser_rate
    if profile.engine_type == "vector_search_rag":
        gib = max(0.1, profile.total_document_pages / 500.0)
        fee += gib * VSR_INDEX_GIB_FEE
    return round(fee, 6)


def query_cost(profile: CorpusProfile, input_tokens: int, output_tokens: int) -> float:
    in_rate = CACHED_INPUT_RATE if profile.prompt_cache_enabled else INPUT_RATE
    cost = (input_tokens * in_rate) + (output_tokens * OUTPUT_RATE)
    if profile.engine_type == "ragmanageddb":
        cost += RAG_RETRIEVAL_FEE
    if profile.reranker_enabled:
        cost += RERANKER_PREMIUM
    return cost


def format_processing_latency(runs: list[QueryRun]) -> tuple[str, dict[str, Any]]:
    """
    Per-question time for one engine: retrieval + Gemini Flash answer only.
    Questions run sequentially; total = sum(per_question). Judge is excluded.
    """
    per_q = [round(r.latency_sec, 3) for r in runs]
    total = sum(r.latency_sec for r in runs)
    n = len(runs)
    avg = total / n if n else 0.0
    if n <= 1:
        display = f"{total:.3f}s"
    else:
        display = f"{total:.3f}s · avg {avg:.3f}s per question"
    return display, {
        "total_sec": round(total, 3),
        "avg_sec": round(avg, 3),
        "per_question_sec": per_q,
        "question_count": n,
    }


LATENCY_METHODOLOGY = {
    "measured_steps": [
        "RAG retrieval (chunks)",
        "Gemini 2.5 Flash answer generation",
    ],
    "excluded_steps": [
        "Gemini 2.5 Pro judge (one batch call after all questions finish; not in latency)",
    ],
    "per_question": (
        "For each question, all selected engines run in parallel. "
        "Per-question latency = retrieval time + Flash generation time for that engine only."
    ),
    "multi_question": (
        "Questions run one after another. Total latency for an engine = "
        "sum of (retrieval + generation) across all questions. Average = total ÷ question count."
    ),
    "quality_scores": (
        "After every engine finishes every question, a single Pro judge call scores "
        "all engines at once (per-question accuracy and relevance per engine)."
    ),
    "example": (
        "2 questions, RAG Managed DB only: Q1 retrieval 1.2s + generation 2.8s = 4.0s; "
        "Q2 retrieval 1.1s + generation 3.0s = 4.1s → matrix shows 8.1s · avg 4.05s per question. "
        "Judge runs once after both questions complete."
    ),
}


def idle_hourly_rate(profile: CorpusProfile) -> float:
    if profile.engine_type == "ragmanageddb":
        return 1.23
    if profile.engine_type == "feature_store_rag":
        return 0.30
    if profile.engine_type == "vector_search_rag":
        return 0.616 if profile.multimodal_active else 0.094
    return 0.0


def build_engine_telemetry(
    profile: CorpusProfile,
    runs: list[QueryRun],
) -> dict[str, Any]:
    n = len(runs)
    total_in = sum(r.input_tokens for r in runs)
    total_out = sum(r.output_tokens for r in runs)
    query_costs = [query_cost(profile, r.input_tokens, r.output_tokens) for r in runs]
    total_query_cost = sum(query_costs)
    acc = [r.accuracy_score for r in runs if r.accuracy_score]
    rel = [r.relevance_score for r in runs if r.relevance_score]
    acc_avg = round(sum(acc) / len(acc), 2) if acc else 0.0
    rel_avg = round(sum(rel) / len(rel), 2) if rel else 0.0

    latency_display, latency_detail = format_processing_latency(runs)

    if n > 1:
        cost_display = f"${total_query_cost:.6f} total"
        token_display = (
            f"{total_in + total_out:,} tokens · "
            f"{total_in:,} in / {total_out:,} out"
        )
    else:
        cost_display = f"${total_query_cost:.6f}"
        token_display = f"{total_in + total_out:,} · {total_in:,} in / {total_out:,} out"

    return {
        "engine_architecture_model": ARCHITECTURE_LABELS.get(
            profile.engine_type, profile.engine_type
        ),
        "active_configuration_toggles": active_toggles(profile),
        "processing_latency_speed": latency_display,
        "setup_ingestion_fee": f"${setup_ingestion_fee(profile):.4f}",
        "accumulated_query_test_cost": cost_display,
        "continuous_idle_maintenance_rate": f"${idle_hourly_rate(profile):.3f} / hour",
        "total_words_processed_tokens": token_display,
        "system_quality_scores": {
            "accuracy": acc_avg,
            "relevance": rel_avg,
            "question_count": n,
            "aggregation": "mean across questions" if n > 1 else "single question",
        },
        "_meta": {
            "question_count": n,
            "input_tokens": total_in,
            "output_tokens": total_out,
            "query_costs_per_question": query_costs,
            "total_query_cost": total_query_cost,
            "latency": latency_detail,
            "accuracy_per_question": acc,
            "relevance_per_question": rel,
        },
    }


def build_benchmark_matrix(
    profiles: list[CorpusProfile],
    runs_by_engine: dict[str, list[QueryRun]],
    grounding_by_engine: dict[str, list[list[str]]],
) -> dict[str, Any]:
    columns: dict[str, dict[str, Any]] = {}
    for p in profiles:
        et = p.engine_type
        runs = runs_by_engine.get(et, [])
        columns[et] = build_engine_telemetry(p, runs)

    matrix: dict[str, dict[str, Any]] = {name: {} for name in FEATURE_NAMES}
    for feat in FEATURE_NAMES:
        for p in profiles:
            et = p.engine_type
            col = columns[et]
            runs = runs_by_engine.get(et, [])
            if feat == "Engine Architecture Model":
                matrix[feat][et] = col["engine_architecture_model"]
            elif feat == "Active Configuration Toggles":
                matrix[feat][et] = col["active_configuration_toggles"]
            elif feat == "Processing Latency Speed":
                matrix[feat][et] = col["processing_latency_speed"]
            elif feat == "Setup Ingestion Fee":
                matrix[feat][et] = col["setup_ingestion_fee"]
            elif feat == "Accumulated Query Test Cost":
                matrix[feat][et] = col["accumulated_query_test_cost"]
            elif feat == "Continuous Idle Maintenance Rate":
                matrix[feat][et] = col["continuous_idle_maintenance_rate"]
            elif feat == "Total Words Processed (Tokens)":
                matrix[feat][et] = col["total_words_processed_tokens"]
            elif feat == "System Quality Scores":
                matrix[feat][et] = col["system_quality_scores"]
            elif feat == "Generated Engine Responses":
                n = len(runs)
                matrix[feat][et] = (
                    f"{n} response{'s' if n != 1 else ''} · View answers"
                )

    answers_by_engine: dict[str, list[dict[str, str]]] = {}
    for et, runs in runs_by_engine.items():
        answers_by_engine[et] = [
            {"question": r.question, "answer": r.answer} for r in runs
        ]

    return {
        "feature_names": FEATURE_NAMES,
        "engines": [p.engine_type for p in profiles],
        "engine_labels": {
            p.engine_type: ENGINE_DISPLAY.get(p.engine_type, p.name) for p in profiles
        },
        "matrix": matrix,
        "columns": columns,
        "grounding": grounding_by_engine,
        "answers": answers_by_engine,
        "latency_methodology": LATENCY_METHODOLOGY,
    }
