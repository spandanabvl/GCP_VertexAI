import { useState, useEffect } from "react";
import axios from "axios";

const API = import.meta.env.VITE_API_URL ?? "";

function shortId(resource) {
  const name = resource?.corpus_name ?? resource?.name ?? "";
  return name.split("/").pop() || "—";
}

export default function MonitoringSidebar({ phase, onStart, onReset }) {
  const [ragCorpora, setRagCorpora] = useState([]);
  const [vsrCorpora, setVsrCorpora] = useState([]);
  const [fsCorpora, setFsCorpora] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [ragId, setRagId] = useState("");
  const [vsrId, setVsrId] = useState("");
  const [fsId, setFsId] = useState("");
  const [questionCount, setQuestionCount] = useState(3);

  const locked = phase !== "setup";

  useEffect(() => {
    fetchAll();
  }, []);

  async function fetchAll() {
    setLoading(true);
    setError(null);
    try {
      const [ragRes, vsrRes, fsRes] = await Promise.all([
        axios.get(`${API}/corpora/`),
        axios.get(`${API}/vsr-corpora/`),
        axios.get(`${API}/fs-corpora/`),
      ]);
      setRagCorpora(ragRes.data ?? []);
      setVsrCorpora(vsrRes.data ?? []);
      setFsCorpora(fsRes.data ?? []);
    } catch {
      setError("Failed to load corpora. Is the API running?");
    } finally {
      setLoading(false);
    }
  }

  function handleStart() {
    const rag = ragCorpora.find(c => c.name === ragId);
    const vsr = vsrCorpora.find(c => c.corpus_name === vsrId);
    const fs = fsCorpora.find(c => c.corpus_name === fsId);
    const count = Math.max(1, Math.min(50, Number(questionCount) || 0));

    if (!rag && !vsr && !fs) {
      setError("Select at least one corpus (any engine).");
      return;
    }
    setError(null);
    onStart({
      ragCorpus: rag,
      vsrCorpus: vsr,
      fsCorpus: fs,
      questionCount: count,
    });
  }

  const ragSelected = ragCorpora.find(c => c.name === ragId);
  const vsrSelected = vsrCorpora.find(c => c.corpus_name === vsrId);
  const fsSelected = fsCorpora.find(c => c.corpus_name === fsId);

  return (
    <aside className="sidebar monitoring-sidebar">
      <div className="sidebar-logo">
        <span className="logo-icon">◈</span>
        <span className="logo-text">
          Monitor<span className="logo-accent">ing</span>
        </span>
      </div>

      <div className="monitoring-engine-badge">Cross-engine evaluation</div>

      {error && (
        <div className="sidebar-error">
          <span>⚠ {error}</span>
          <button type="button" onClick={() => setError(null)}>✕</button>
        </div>
      )}

      <div className="sidebar-section">
        <div className="section-label">
          Configuration
          {!locked && (
            <button type="button" className="refresh-btn" onClick={fetchAll} title="Refresh corpora">
              ↻
            </button>
          )}
        </div>

        {loading ? (
          <div className="loading-row"><span className="spinner" /> Loading corpora…</div>
        ) : (
          <>
            <label className="monitoring-field">
              <span className="monitoring-field-label">RAG Managed DB</span>
              <select
                className="dark-input monitoring-select"
                value={ragId}
                disabled={locked}
                onChange={e => setRagId(e.target.value)}
              >
                <option value="">Select corpus…</option>
                {ragCorpora.map(c => (
                  <option key={c.name} value={c.name}>
                    {c.display_name} ({shortId(c)})
                  </option>
                ))}
              </select>
            </label>

            <label className="monitoring-field">
              <span className="monitoring-field-label">Vector Search RAG </span>
              <select
                className="dark-input monitoring-select"
                value={vsrId}
                disabled={locked}
                onChange={e => setVsrId(e.target.value)}
              >
                <option value="">Select corpus…</option>
                {vsrCorpora.map(c => (
                  <option key={c.corpus_name} value={c.corpus_name}>
                    {c.display_name} ({shortId(c)})
                  </option>
                ))}
              </select>
            </label>

            <label className="monitoring-field">
              <span className="monitoring-field-label">Feature Store RAG</span>
              <select
                className="dark-input monitoring-select"
                value={fsId}
                disabled={locked}
                onChange={e => setFsId(e.target.value)}
              >
                <option value="">Select corpus…</option>
                {fsCorpora.map(c => (
                  <option key={c.corpus_name} value={c.corpus_name}>
                    {c.display_name} ({shortId(c)})
                  </option>
                ))}
              </select>
            </label>

            <label className="monitoring-field">
              <span className="monitoring-field-label">No. of questions</span>
              <input
                type="number"
                className="dark-input"
                min={1}
                max={50}
                value={questionCount}
                disabled={locked}
                onChange={e => setQuestionCount(e.target.value)}
              />
            </label>

            {!locked ? (
              <button
                type="button"
                className="monitoring-start-btn"
                onClick={handleStart}
                disabled={!ragId && !vsrId && !fsId}
              >
                Start questions
              </button>
            ) : (
              <button type="button" className="monitoring-reset-btn" onClick={onReset}>
                New configuration
              </button>
            )}
          </>
        )}

        {(ragSelected || vsrSelected || fsSelected) && locked && (
          <div className="monitoring-summary">
            <div className="section-label" style={{ marginTop: 16 }}>Selected engines</div>
            {ragSelected && (
              <div className="monitoring-summary-row">
                <span className="monitoring-summary-tag rag">RAG</span>
                <span>{ragSelected.display_name}</span>
              </div>
            )}
            {vsrSelected && (
              <div className="monitoring-summary-row">
                <span className="monitoring-summary-tag vsr">VSR</span>
                <span>{vsrSelected.display_name}</span>
              </div>
            )}
            {fsSelected && (
              <div className="monitoring-summary-row">
                <span className="monitoring-summary-tag fs">FS</span>
                <span>{fsSelected.display_name}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
