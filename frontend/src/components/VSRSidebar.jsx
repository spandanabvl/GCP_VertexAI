import { useState, useEffect, useRef } from "react";
import axios from "axios";
import { dispatchFlow, runFlowAnimation, corpusRef } from "../notesFlowEvents";

const API = "http://localhost:8000";

function IconRefresh() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10"/>
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg>
  );
}

export default function VSRSidebar({
  selectedCorpus,
  onSelectCorpus,
  activeConversation,
  onSelectConversation,
  conversationCount,
}) {
  const [activeSection, setActiveSection] = useState("corpora");

  // Corpora form fields
  const [displayName,        setDisplayName]        = useState("");
  const [indexDisplayName,   setIndexDisplayName]   = useState("");
  const [endpointDisplayName, setEndpointDisplayName] = useState("");
  const [creating,           setCreating]           = useState(false);

  const [corpora,        setCorpora]        = useState([]);
  const [loadingCorpora, setLoadingCorpora] = useState(false);

  // Documents
  const [files,        setFiles]        = useState([]);
  const [uploading,    setUploading]    = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const fileInputRef = useRef();

  // Conversations
  const [conversations,        setConversations]        = useState([]);
  const [loadingConversations, setLoadingConversations] = useState(false);

  const [error, setError] = useState(null);

  // ── Effects ───────────────────────────────────────────────────────────────────

  useEffect(() => { fetchCorpora(); }, []);

  useEffect(() => {
    if (selectedCorpus) {
      fetchFiles(selectedCorpus.corpus_name);
      fetchConversations(selectedCorpus.corpus_name);
    }
  }, [selectedCorpus]);

  useEffect(() => {
    if (selectedCorpus) fetchConversations(selectedCorpus.corpus_name);
  }, [conversationCount]);

  // ── Corpora ───────────────────────────────────────────────────────────────────

  async function fetchCorpora() {
    setLoadingCorpora(true);
    try {
      const res = await axios.get(`${API}/vsr-corpora/`);
      setCorpora(res.data);
    } catch {
      setError("Failed to load corpora");
    } finally {
      setLoadingCorpora(false);
    }
  }

  async function createCorpus() {
    if (!displayName.trim() || !indexDisplayName.trim() || !endpointDisplayName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await axios.post(`${API}/vsr-corpora/`, {
        display_name:          displayName.trim(),
        index_display_name:    indexDisplayName.trim(),
        endpoint_display_name: endpointDisplayName.trim(),
      }, { timeout: 600000 });
      setCorpora(prev => [res.data, ...prev]);
      onSelectCorpus(res.data);
      setDisplayName(""); setIndexDisplayName(""); setEndpointDisplayName("");
      setActiveSection("docs");
    } catch (e) {
      setError(e?.response?.data?.detail || "Failed to create corpus");
    } finally {
      setCreating(false);
    }
  }

  async function deleteCorpus(corpus) {
    const ok = window.confirm(`Delete corpus "${corpus.display_name}"? All documents will be removed. This cannot be undone.`);
    if (!ok) return;
    const ref = corpusRef("vsr", corpus);
    try {
      await runFlowAnimation(
        "vsr",
        "delete_corpus",
        ref,
        [
          { step: "files", message: "Deleting files…" },
          { step: "corpus", message: "Deleting corpus…" },
          { step: "index", message: "Tearing down Vector Search…" },
          { step: "postgres", message: "Removing metadata…" },
        ],
        () => axios.delete(`${API}/vsr-corpora/`, { params: { corpus_name: corpus.corpus_name } })
      );
      setCorpora(prev => prev.filter(c => c.corpus_name !== corpus.corpus_name));
      if (selectedCorpus?.corpus_name === corpus.corpus_name) {
        onSelectCorpus(null);
        setFiles([]);
        setConversations([]);
      }
    } catch {
      setError("Failed to delete corpus");
    }
  }

  function selectCorpus(c) {
    onSelectCorpus(c);
    fetchFiles(c.corpus_name);
    fetchConversations(c.corpus_name);
    setActiveSection("chats");
  }

  // ── Documents ─────────────────────────────────────────────────────────────────

  async function fetchFiles(corpusName) {
    setLoadingFiles(true);
    try {
      const res = await axios.get(`${API}/vsr-documents/`, { params: { corpus_name: corpusName } });
      setFiles(res.data);
    } catch {
      setFiles([]);
    } finally {
      setLoadingFiles(false);
    }
  }

  async function uploadFile(e) {
    const file = e.target.files[0];
    if (!file || !selectedCorpus) return;
    setUploading(true);
    setError(null);
    const ref = corpusRef("vsr", selectedCorpus);
    dispatchFlow({
      engine: "vsr",
      action: "upload",
      phase: "uploading",
      filename: file.name,
      progress: 0,
      ...ref,
    });
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await axios.post(`${API}/vsr-documents/upload`, formData, {
        params: { corpus_name: selectedCorpus.corpus_name },
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: ev => {
          const progress = ev.total ? Math.round((ev.loaded * 100) / ev.total) : 0;
          dispatchFlow({
            engine: "vsr",
            action: "upload",
            phase: "uploading",
            filename: file.name,
            progress,
            ...ref,
          });
        },
      });
      dispatchFlow({
        engine: "vsr",
        action: "upload",
        phase: "indexing",
        filename: file.name,
        file: res.data,
        highlightDoc: res.data.display_name || file.name,
        ...ref,
      });
      setFiles(prev => [...prev, { name: res.data.name, display_name: res.data.display_name }]);
      dispatchFlow({
        engine: "vsr",
        action: "upload",
        phase: "complete",
        highlightDoc: res.data.display_name || file.name,
        ...ref,
      });
    } catch {
      setError("Upload failed. Check file type and corpus.");
      dispatchFlow({
        engine: "vsr",
        action: "upload",
        phase: "error",
        filename: file.name,
        error: "Upload failed",
        ...ref,
      });
    } finally {
      setUploading(false);
      fileInputRef.current.value = "";
    }
  }

  async function deleteFile(f) {
    const ok = window.confirm(`Delete "${f.display_name}"? This cannot be undone.`);
    if (!ok) return;
    const ref = corpusRef("vsr", selectedCorpus);
    dispatchFlow({
      engine: "vsr",
      action: "delete_file",
      phase: "deleting",
      filename: f.display_name,
      removeDoc: f.display_name,
      ...ref,
    });
    try {
      await axios.delete(`${API}/vsr-documents/`, { params: { file_name: f.name } });
      setFiles(prev => prev.filter(file => file.name !== f.name));
      dispatchFlow({ engine: "vsr", action: "delete_file", phase: "complete", ...ref });
    } catch {
      setError("Failed to delete file");
      dispatchFlow({ engine: "vsr", action: "delete_file", phase: "error", error: "Delete failed", ...ref });
    }
  }

  // ── Conversations ─────────────────────────────────────────────────────────────

  async function fetchConversations(corpusName) {
    setLoadingConversations(true);
    try {
      const res = await axios.get(`${API}/vsr-chat/conversations`, { params: { corpus_name: corpusName } });
      setConversations(res.data);
    } catch {
      setConversations([]);
    } finally {
      setLoadingConversations(false);
    }
  }

  async function deleteConversation(e, conv) {
    e.stopPropagation();
    try {
      await axios.delete(`${API}/vsr-chat/conversations/${conv.id}`);
      setConversations(prev => prev.filter(c => c.id !== conv.id));
      if (activeConversation?.id === conv.id) onSelectConversation(null);
    } catch {
      setError("Failed to delete conversation");
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function fileExt(name) { return name?.split(".").pop()?.toUpperCase() || "FILE"; }

  function timeAgo(iso) {
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1)  return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <span className="logo-icon">◈</span>
        <span className="logo-text">RAG<span className="logo-accent">Studio</span></span>
      </div>

      <div className="section-tabs">
        {["corpora", "docs", "chats"].map(sec => (
          <button
            key={sec}
            className={`section-tab ${activeSection === sec ? "active" : ""}`}
            onClick={() => setActiveSection(sec)}
          >
            {sec === "corpora" && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>}
            {sec === "docs"    && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>}
            {sec === "chats"   && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>}
            {sec.charAt(0).toUpperCase() + sec.slice(1)}
          </button>
        ))}
      </div>

      {error && (
        <div className="sidebar-error">
          <span>⚠ {error}</span>
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* ── CORPORA ── */}
      {activeSection === "corpora" && (
        <div className="sidebar-section">
          <div className="section-label">New corpus</div>

          <div className="fs-field-label">Corpus Display Name</div>
          <input className="dark-input" style={{ marginBottom: 6 }} placeholder="e.g. my-vector-corpus" value={displayName} onChange={e => setDisplayName(e.target.value)} />

          <div className="fs-field-label">Vector Index Display Name</div>
          <input className="dark-input" style={{ marginBottom: 6 }} placeholder="e.g. my-rag-vector-index" value={indexDisplayName} onChange={e => setIndexDisplayName(e.target.value)} />

          <div className="fs-field-label">Index Endpoint Display Name</div>
          <input
            className="dark-input"
            style={{ marginBottom: 8 }}
            placeholder="e.g. my-rag-vector-endpoint"
            value={endpointDisplayName}
            onChange={e => setEndpointDisplayName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && createCorpus()}
          />

          <button
            className="btn-primary"
            style={{ width: "100%", height: 34, fontSize: 12, borderRadius: 6 }}
            onClick={createCorpus}
            disabled={creating || !displayName.trim() || !indexDisplayName.trim() || !endpointDisplayName.trim()}
          >
            {creating ? <span className="spinner" /> : "Create corpus"}
          </button>

          <div className="fs-infra-note" style={{ borderColor: "#2a1f08", background: "#1a1600", color: "#a08040" }}>
            Creates vector index, endpoint, and deployment in GCP, then the RAG corpus. First deployment may take 20–30 minutes.
          </div>

          <div className="section-label" style={{ marginTop: 16 }}>
            Your corpora
            <button className="refresh-btn" onClick={fetchCorpora} title="Refresh"><IconRefresh /></button>
          </div>

          {loadingCorpora ? (
            <div className="loading-row"><span className="spinner" /> Loading…</div>
          ) : corpora.length === 0 ? (
            <div className="empty-state">No corpora yet. Create one above.</div>
          ) : (
            <ul className="corpus-list">
              {corpora.map(c => (
                <li
                  key={c.corpus_name}
                  className={`corpus-item ${selectedCorpus?.corpus_name === c.corpus_name ? "selected" : ""}`}
                  onClick={() => selectCorpus(c)}
                >
                  <div className="corpus-item-inner">
                    <span className={`corpus-dot ${selectedCorpus?.corpus_name === c.corpus_name ? "active" : ""}`} />
                    <div className="corpus-info">
                      <span className="corpus-display">{c.display_name}</span>
                      <span className="corpus-id">{c.deployed_index_id}</span>
                    </div>
                  </div>
                  <button className="delete-btn" onClick={ev => { ev.stopPropagation(); deleteCorpus(c); }} title="Delete">✕</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── DOCS ── */}
      {activeSection === "docs" && (
        <div className="sidebar-section">
          {!selectedCorpus ? (
            <div className="empty-state">Select a corpus first from the Corpora tab.</div>
          ) : (
            <>
              <div className="active-corpus-badge">
                <span className="corpus-dot active" />
                <span>{selectedCorpus.display_name}</span>
              </div>

              <div className="vsr-stream-note">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                STREAM_UPDATE index — no manual sync needed after upload
              </div>

              <div className="section-label" style={{ marginTop: 12 }}>Upload document</div>
              <div
                className={`drop-zone ${uploading ? "uploading" : ""}`}
                onClick={() => !uploading && fileInputRef.current.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.txt,.docx,.csv,.xlsx,.xls"
                  style={{ display: "none" }}
                  onChange={uploadFile}
                />
                {uploading ? (
                  <div className="upload-progress">
                    <span className="spinner" />
                    <span>Uploading + indexing…</span>
                  </div>
                ) : (
                  <>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                    </svg>
                    <span className="drop-label">Click to upload</span>
                    <span className="drop-sub">PDF · TXT · DOCX · CSV · XLSX</span>
                    <span className="drop-sub" style={{ fontSize: 10, marginTop: 2 }}>→ streamed into vector index immediately</span>
                  </>
                )}
              </div>

              <div className="section-label" style={{ marginTop: 14 }}>
                Files
                <button className="refresh-btn" onClick={() => fetchFiles(selectedCorpus.corpus_name)} title="Refresh"><IconRefresh /></button>
              </div>

              {loadingFiles ? (
                <div className="loading-row"><span className="spinner" /> Loading…</div>
              ) : files.length === 0 ? (
                <div className="empty-state">No documents yet.</div>
              ) : (
                <ul className="file-list">
                  {files.map((f, i) => (
                    <li key={f.name || i} className="file-item" style={{ justifyContent: "space-between" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
                        <span className="file-ext">{fileExt(f.display_name)}</span>
                        <span className="file-name" title={f.display_name}>{f.display_name}</span>
                      </div>
                      <button className="delete-btn" style={{ opacity: 1 }} onClick={() => deleteFile(f)} title="Delete">✕</button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {/* ── CHATS ── */}
      {activeSection === "chats" && (
        <div className="sidebar-section chats-section">
          {!selectedCorpus ? (
            <div className="empty-state">Select a corpus first.</div>
          ) : (
            <>
              <div className="active-corpus-badge" style={{ marginBottom: 10 }}>
                <span className="corpus-dot active" />
                <span>{selectedCorpus.display_name}</span>
              </div>

              <button className="new-chat-btn" onClick={() => onSelectConversation(null)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                New chat
              </button>

              <div className="section-label" style={{ marginTop: 16 }}>
                History
                <button className="refresh-btn" onClick={() => fetchConversations(selectedCorpus.corpus_name)} title="Refresh"><IconRefresh /></button>
              </div>

              {loadingConversations ? (
                <div className="loading-row"><span className="spinner" /> Loading…</div>
              ) : conversations.length === 0 ? (
                <div className="empty-state">No chats yet. Start one!</div>
              ) : (
                <ul className="conv-list">
                  {conversations.map(conv => (
                    <li
                      key={conv.id}
                      className={`conv-item ${activeConversation?.id === conv.id ? "selected" : ""}`}
                      onClick={() => onSelectConversation(conv)}
                    >
                      <div className="conv-item-inner">
                        <span className="conv-title">{conv.title}</span>
                        <span className="conv-time">{timeAgo(conv.updated_at)}</span>
                      </div>
                      <button className="delete-btn" onClick={e => deleteConversation(e, conv)} title="Delete">✕</button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
