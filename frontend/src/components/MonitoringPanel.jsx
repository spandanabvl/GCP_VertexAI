import { useState, useEffect } from "react";
import BenchmarkMatrix from "./BenchmarkMatrix";

const API = import.meta.env.VITE_API_URL ?? "";

export default function MonitoringPanel({
  phase,
  config,
  questions,
  currentIndex,
  onUpdateQuestions,
  onAdvance,
  onSubmit,
  benchmarkResult,
  benchmarkError,
  onReset,
}) {
  const [draft, setDraft] = useState("");

  const total = config?.questionCount ?? 0;
  const isLast = total > 0 && currentIndex === total - 1;

  useEffect(() => {
    setDraft(questions[currentIndex] ?? "");
  }, [currentIndex, questions]);

  function saveDraft(value) {
    const next = [...questions];
    next[currentIndex] = value;
    onUpdateQuestions(next);
  }

  function handleDraftChange(value) {
    setDraft(value);
    saveDraft(value);
  }

  function handleNext() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    saveDraft(trimmed);
    setDraft("");
    onAdvance();
  }

  function handleSubmit() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    const next = [...questions];
    next[currentIndex] = trimmed;
    onSubmit(next);
  }

  if (phase === "setup") {
    return (
      <main className="main-area monitoring-main">
        <div className="monitoring-empty">
          <div className="monitoring-empty-icon">◎</div>
          <h2>Monitoring</h2>
          <p>
            Select one or more corpora (any combination of engines), set the number of questions,
            then click <strong>Start questions</strong> in the sidebar.
          </p>
        </div>
      </main>
    );
  }

  if (phase === "processing") {
    return (
      <main className="main-area monitoring-main">
        <div className="monitoring-processing">
          <div className="monitoring-processing-spinner" />
          <h2>Background is processing</h2>
          <p>
            Running {questions.filter(q => q.trim()).length} question
            {questions.filter(q => q.trim()).length !== 1 ? "s" : ""} across selected RAG engine
            {[
              config?.ragCorpus,
              config?.vsrCorpus,
              config?.fsCorpus,
            ].filter(Boolean).length !== 1 ? "s" : ""} in parallel.
            Calculating telemetry and quality scores…
          </p>
          <div className="monitoring-processing-meta">
            {config?.ragCorpus && (
              <span>RAG Managed DB: {config.ragCorpus.display_name}</span>
            )}
            {config?.vsrCorpus && (
              <span>Vector Search: {config.vsrCorpus.display_name}</span>
            )}
            {config?.fsCorpus && (
              <span>Feature Store: {config.fsCorpus.display_name}</span>
            )}
          </div>
        </div>
      </main>
    );
  }

  if (phase === "results") {
    return (
      <main className="main-area monitoring-main bm-main">
        {benchmarkError && (
          <div className="sidebar-error" style={{ margin: "16px 24px 0" }}>
            <span>⚠ {benchmarkError}</span>
          </div>
        )}
        {benchmarkResult ? (
          <BenchmarkMatrix data={benchmarkResult} onReset={onReset} />
        ) : (
          <div className="monitoring-empty">
            <p>Benchmark finished with no results.</p>
            <button type="button" className="monitoring-reset-btn" onClick={onReset}>
              New configuration
            </button>
          </div>
        )}
      </main>
    );
  }

  return (
    <main className="main-area monitoring-main">
      <header className="monitoring-header">
        <div>
          <h2 className="monitoring-header-title">Evaluation questions</h2>
          <p className="monitoring-header-sub">
            Question {currentIndex + 1} of {total}
          </p>
        </div>
        <div className="monitoring-progress-dots">
          {Array.from({ length: total }).map((_, i) => (
            <span
              key={i}
              className={`monitoring-dot ${i < currentIndex ? "done" : ""} ${i === currentIndex ? "active" : ""}`}
            />
          ))}
        </div>
      </header>

      <div className="monitoring-question-card">
        <label className="monitoring-question-label" htmlFor="monitoring-question-input">
          Question {currentIndex + 1}
        </label>
        <textarea
          id="monitoring-question-input"
          className="monitoring-textarea"
          placeholder="Type your evaluation question…"
          value={draft}
          rows={5}
          onChange={e => handleDraftChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && e.ctrlKey) {
              if (isLast) handleSubmit();
              else handleNext();
            }
          }}
        />
        <p className="monitoring-hint">Ctrl+Enter to {isLast ? "submit" : "continue"}</p>
      </div>

      <div className="monitoring-actions">
        {isLast ? (
          <button
            type="button"
            className="monitoring-submit-btn"
            disabled={!draft.trim()}
            onClick={handleSubmit}
          >
            Submit all questions
          </button>
        ) : (
          <button
            type="button"
            className="monitoring-next-btn"
            disabled={!draft.trim()}
            onClick={handleNext}
          >
            Next question
          </button>
        )}
      </div>

      {currentIndex > 0 && (
        <div className="monitoring-answered">
          <div className="section-label">Answered</div>
          <ul className="monitoring-answered-list">
            {questions.slice(0, currentIndex).map((q, i) => (
              <li key={i}>
                <span className="monitoring-answered-num">{i + 1}</span>
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
