import { useState } from "react";
import StarRating from "./StarRating";

const ENGINE_ORDER = ["ragmanageddb", "vector_search_rag", "feature_store_rag"];
const RESPONSES_ROW = "Generated Engine Responses";

function estimateTokens(text) {
  const t = (text || "").trim();
  if (!t) return 0;
  return Math.max(1, Math.floor(t.length / 4));
}

function normalizeChunk(chunk) {
  if (typeof chunk === "string") {
    return { text: chunk, tokens: estimateTokens(chunk) };
  }
  return {
    text: chunk?.text ?? "",
    tokens: Number.isFinite(chunk?.tokens) ? chunk.tokens : estimateTokens(chunk?.text),
  };
}

function TogglePills({ badges }) {
  const list = Array.isArray(badges) ? badges : [];
  return (
    <div className="bm-pills">
      {list.map(b => (
        <span key={b} className="bm-pill">{b}</span>
      ))}
    </div>
  );
}

function QualityCell({ scores }) {
  if (!scores || typeof scores !== "object") return <span className="bm-muted">—</span>;
  return (
    <div className="bm-quality">
      <div className="bm-quality-row">
        <span className="bm-quality-label">Accuracy</span>
        <StarRating score={scores.accuracy} />
        <span className="bm-score-num">{scores.accuracy}</span>
      </div>
      <div className="bm-quality-row">
        <span className="bm-quality-label">Relevance</span>
        <StarRating score={scores.relevance} />
        <span className="bm-score-num">{scores.relevance}</span>
      </div>
    </div>
  );
}

function ModalShell({ title, onClose, children }) {
  return (
    <div className="bm-modal-backdrop" onClick={onClose}>
      <div className="bm-modal" onClick={e => e.stopPropagation()}>
        <header className="bm-modal-head">
          <h3>{title}</h3>
          <button type="button" className="bm-modal-close" onClick={onClose}>✕</button>
        </header>
        <div className="bm-modal-body">{children}</div>
      </div>
    </div>
  );
}

export default function BenchmarkMatrix({ data, onReset }) {
  const [groundingEngine, setGroundingEngine] = useState(null);
  const [answersEngine, setAnswersEngine] = useState(null);

  if (!data?.matrix || !data?.feature_names) {
    return (
      <div className="bm-empty">
        <p>No benchmark data.</p>
        {onReset && (
          <button type="button" className="monitoring-reset-btn" onClick={onReset}>
            New run
          </button>
        )}
      </div>
    );
  }

  const engines = ENGINE_ORDER.filter(et => data.engines?.includes(et)).length
    ? ENGINE_ORDER.filter(et => data.engines?.includes(et))
    : (data.engines ?? []);
  const labels = data.engine_labels || {};

  return (
    <div className="bm-wrap">
      <header className="bm-header">
        <h2 className="bm-title">RAG Benchmark Matrix</h2>
        {onReset && (
          <button type="button" className="monitoring-reset-btn bm-new-run-btn" onClick={onReset}>
            New run
          </button>
        )}
      </header>

      <div className="bm-table-scroll">
        <table className="bm-table">
          <thead>
            <tr>
              <th className="bm-th-feature">Characteristic</th>
              {engines.map(et => (
                <th key={et} className="bm-th-engine">
                  <span className={`bm-engine-tag bm-engine-${et.split("_")[0]}`}>
                    {labels[et] || et}
                  </span>
                  <button
                    type="button"
                    className="bm-grounding-btn"
                    onClick={() => setGroundingEngine(et)}
                  >
                    Grounding Context Source
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.feature_names.map(feat => (
              <tr key={feat} className={feat === RESPONSES_ROW ? "bm-row-responses" : ""}>
                <td className="bm-td-feature">{feat}</td>
                {engines.map(et => {
                  const cell = data.matrix[feat]?.[et];
                  return (
                    <td key={et} className="bm-td-cell">
                      {feat === "Active Configuration Toggles" ? (
                        <TogglePills badges={cell} />
                      ) : feat === "System Quality Scores" ? (
                        <QualityCell scores={cell} />
                      ) : feat === RESPONSES_ROW ? (
                        <button
                          type="button"
                          className="bm-grounding-btn bm-answers-btn"
                          onClick={() => setAnswersEngine(et)}
                        >
                          View Engine Answers
                        </button>
                      ) : (
                        <span className="bm-cell-text">{cell ?? "—"}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {groundingEngine && (
        <ModalShell
          title={`Grounding Context — ${labels[groundingEngine] || groundingEngine}`}
          onClose={() => setGroundingEngine(null)}
        >
          {(data.grounding?.[groundingEngine] || []).map((rawChunks, qi) => {
            const chunks = (rawChunks || []).map(normalizeChunk);
            const questionTokens = chunks.reduce((sum, c) => sum + c.tokens, 0);
            return (
              <div key={qi} className="bm-chunk-group">
                <div className="bm-chunk-q">
                  Question {qi + 1}
                  {chunks.length > 0 && (
                    <span className="bm-chunk-q-tokens">
                      {questionTokens.toLocaleString()} tokens total
                    </span>
                  )}
                </div>
                {chunks.length ? chunks.map((c, ci) => (
                  <div key={ci} className="bm-chunk-wrap">
                    <div className="bm-chunk-head">
                      <span className="bm-chunk-label">Chunk {ci + 1}</span>
                      <span className="bm-chunk-tokens">
                        {c.tokens.toLocaleString()} tokens
                      </span>
                    </div>
                    <pre className="bm-chunk">{c.text}</pre>
                  </div>
                )) : (
                  <p className="bm-muted">No chunks retrieved.</p>
                )}
              </div>
            );
          })}
        </ModalShell>
      )}

      {answersEngine && (
        <ModalShell
          title={`Engine Answers — ${labels[answersEngine] || answersEngine}`}
          onClose={() => setAnswersEngine(null)}
        >
          {(data.answers?.[answersEngine] || []).map((item, qi) => (
            <div key={qi} className="bm-qa-block">
              <div className="bm-qa-label">Question {qi + 1}</div>
              <p className="bm-qa-question">{item.question}</p>
              <div className="bm-qa-label">Answer</div>
              <p className="bm-qa-answer">{item.answer || "(no answer)"}</p>
            </div>
          ))}
          {!(data.answers?.[answersEngine] || []).length && (
            <p className="bm-muted">No answers recorded for this engine.</p>
          )}
        </ModalShell>
      )}
    </div>
  );
}
