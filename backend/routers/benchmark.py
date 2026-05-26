"""POST /api/benchmark — async batch RAG evaluation across 3 engines."""

from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database import get_db
from models import CorpusRegistry
from services.benchmark_judge import judge_benchmark_batch
from services.benchmark_workers import run_worker
from services.corpus_profiles import normalize_engine, resolve_profile
from utils.telemetry import (
    ENGINE_DISPLAY,
    FEATURE_NAMES,
    build_benchmark_matrix,
    CorpusProfile,
    QueryRun,
)

router = APIRouter()


class BenchmarkTarget(BaseModel):
    engine_type: str
    corpus_name: str = ""
    display_name: str = ""
    corpus_id: Optional[int] = None


class BenchmarkRequest(BaseModel):
    questions: list[str] = Field(..., min_length=1)
    targets: list[BenchmarkTarget] = Field(default_factory=list)
    corpus_ids: list[int] = Field(default_factory=list)


def _resolve_profiles(db: Session, req: BenchmarkRequest) -> list[CorpusProfile]:
    profiles: list[CorpusProfile] = []

    if req.corpus_ids:
        for cid in req.corpus_ids:
            row = db.query(CorpusRegistry).filter(CorpusRegistry.id == cid).first()
            if not row:
                raise HTTPException(status_code=404, detail=f"corpus_registry id {cid} not found")
            profiles.append(resolve_profile(
                db,
                engine_type=row.engine_type,
                corpus_name=row.gcp_resource_name,
                display_name=row.name,
                corpus_id=row.id,
            ))
        return profiles

    if not req.targets:
        raise HTTPException(
            status_code=400,
            detail="Provide at least one target corpus or corpus_ids from registry",
        )

    for t in req.targets:
        if not (t.corpus_name or "").strip():
            continue
        profiles.append(resolve_profile(
            db,
            engine_type=t.engine_type,
            corpus_name=t.corpus_name.strip(),
            display_name=t.display_name,
            corpus_id=t.corpus_id,
        ))

    if not profiles:
        raise HTTPException(
            status_code=400,
            detail="At least one target must include a valid corpus_name",
        )
    return profiles


async def _run_question_batch(
    profiles: list[CorpusProfile],
    question: str,
) -> dict[str, QueryRun]:
    tasks = [
        asyncio.to_thread(run_worker, profile, question)
        for profile in profiles
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    out: dict[str, QueryRun] = {}
    for profile, res in zip(profiles, results):
        et = profile.engine_type
        if isinstance(res, Exception):
            out[et] = QueryRun(
                question=question,
                answer=f"Error: {res}",
                chunks=[],
                input_tokens=0,
                output_tokens=0,
                latency_sec=0.0,
            )
        else:
            out[et] = res
    return out


@router.get("/corpuses")
def list_registry_corpuses(db: Session = Depends(get_db)):
    rows = db.query(CorpusRegistry).order_by(CorpusRegistry.id).all()
    return [
        {
            "id": r.id,
            "name": r.name,
            "engine_type": r.engine_type,
            "gcp_resource_name": r.gcp_resource_name,
            "total_document_pages": r.total_document_pages,
            "ocr_enabled": r.ocr_enabled,
            "reranker_enabled": r.reranker_enabled,
            "prompt_cache_enabled": r.prompt_cache_enabled,
            "multimodal_active": r.multimodal_active,
        }
        for r in rows
    ]


@router.post("/benchmark")
async def run_benchmark(req: BenchmarkRequest, db: Session = Depends(get_db)):
    questions = [q.strip() for q in req.questions if q.strip()]
    if not questions:
        raise HTTPException(status_code=400, detail="At least one non-empty question required")

    try:
        profiles = _resolve_profiles(db, req)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to resolve corpus profiles: {e}",
        ) from e
    # Deduplicate by engine_type (keep first)
    by_engine: dict[str, CorpusProfile] = {}
    for p in profiles:
        by_engine.setdefault(p.engine_type, p)
    profiles = [by_engine[k] for k in sorted(by_engine.keys())]

    runs_by_engine: dict[str, list[QueryRun]] = {p.engine_type: [] for p in profiles}
    grounding_by_engine: dict[str, list[list[str]]] = {p.engine_type: [] for p in profiles}
    for question in questions:
        per_engine = await _run_question_batch(profiles, question)
        for et, run in per_engine.items():
            runs_by_engine[et].append(run)
            grounding_by_engine[et].append(run.chunks)

    judge_scores = await asyncio.to_thread(judge_benchmark_batch, runs_by_engine)
    for et, runs in runs_by_engine.items():
        per_q_scores = judge_scores.get(et, [])
        for run, pair in zip(runs, per_q_scores):
            run.accuracy_score, run.relevance_score = pair

    matrix_payload = build_benchmark_matrix(
        profiles,
        runs_by_engine,
        grounding_by_engine,
    )

    per_question = []
    for i, q in enumerate(questions):
        row = {"question": q, "engines": {}}
        for et in runs_by_engine:
            run = runs_by_engine[et][i]
            row["engines"][et] = {
                "answer": run.answer,
                "chunks": run.chunks,
                "input_tokens": run.input_tokens,
                "output_tokens": run.output_tokens,
                "latency_sec": run.latency_sec,
                "accuracy_score": run.accuracy_score,
                "relevance_score": run.relevance_score,
            }
        per_question.append(row)

    return {
        "status": "complete",
        "question_count": len(questions),
        "feature_names": FEATURE_NAMES,
        "engine_labels": {et: ENGINE_DISPLAY.get(et, et) for et in runs_by_engine},
        **matrix_payload,
        "per_question": per_question,
    }
