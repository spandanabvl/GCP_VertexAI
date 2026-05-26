import axios from "axios";

const API = "http://localhost:8000";

const ENGINES = [
  {
    id: "rag",
    name: "RAG Managed DB",
    description: "Vertex RAG corpus with KNN managed vector store",
    countEndpoint: "/corpora/",
    countLabel: "corpus",
  },
  {
    id: "vsr",
    name: "Vector Search RAG",
    description: "Custom Vector Search index with stream embedding updates",
    countEndpoint: "/vsr-corpora/",
    countLabel: "corpus",
  },
  {
    id: "fs",
    name: "Feature Store RAG",
    description: "BigQuery embeddings synced to Feature Online Store",
    countEndpoint: "/fs-corpora/",
    countLabel: "corpus",
  },
  {
    id: "vs",
    name: "Vertex AI Search",
    description: "GCS documents imported into Discovery Engine",
    countEndpoint: "/vs-datastores/",
    countLabel: "datastore",
  },
];

function IconRefresh() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10"/>
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg>
  );
}

export default function NotesSidebar({
  selectedEngine,
  onSelectEngine,
  counts,
  loading,
  onRefresh,
}) {
  return (
    <aside className="sidebar notes-sidebar">
      <div className="sidebar-logo">
        <span className="logo-icon">◈</span>
        <span className="logo-text">RAG<span className="logo-accent">Studio</span></span>
      </div>

      <div className="notes-sidebar-header">
        <span className="section-label" style={{ marginBottom: 0 }}>Architecture</span>
        <button className="refresh-btn" onClick={onRefresh} title="Refresh all engines" disabled={loading}>
          <IconRefresh />
        </button>
      </div>

      <div className="sidebar-section notes-engine-list">
        {ENGINES.map(eng => {
          const count = counts[eng.id];
          const countText =
            count === null || count === undefined
              ? "…"
              : `${count} ${eng.countLabel}${count === 1 ? "" : "es"}`;

          return (
            <button
              key={eng.id}
              type="button"
              className={`notes-engine-card ${selectedEngine === eng.id ? "selected" : ""}`}
              onClick={() => onSelectEngine(eng.id)}
            >
              <span className="notes-engine-card-name">{eng.name}</span>
              <span className="notes-engine-card-desc">{eng.description}</span>
              <span className="notes-engine-card-count">{countText}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

export { ENGINES, API };
