import { useState, useEffect, useRef } from "react";
import axios from "axios";
import { Trash2 } from "lucide-react";
import { dispatchFlow, corpusRef } from "../notesFlowEvents";
import { runBackendFlowStream, uploadWithFlowStream } from "../flowStream";

const API = "http://localhost:8000";

function IconDb() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3"/>
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
    </svg>
  );
}

function IconFile() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>
  );
}

function IconChat() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10"/>
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg>
  );
}

export default function Sidebar({
  selectedCorpus,
  onSelectCorpus,
  activeConversation,
  onSelectConversation,
  conversationCount,
}) {
  const [activeSection, setActiveSection] = useState("corpora");

  // Corpora
  const [corpora, setCorpora]               = useState([]);
  const [corpusName, setCorpusName]         = useState("");
  const [creating, setCreating]             = useState(false);
  const [loadingCorpora, setLoadingCorpora] = useState(false);

  // Documents
  const [files, setFiles]                   = useState([]);
  const [uploading, setUploading]           = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [loadingFiles, setLoadingFiles]     = useState(false);
  const fileInputRef = useRef();

  // Conversations
  const [conversations, setConversations]               = useState([]);
  const [loadingConversations, setLoadingConversations] = useState(false);

  const [error, setError] = useState(null);

  // ── Effects ──────────────────────────────────────────────────────────────────

  useEffect(() => { fetchCorpora(); }, []);

  useEffect(() => {
    if (selectedCorpus) {
      fetchFiles(selectedCorpus.name);
      fetchConversations(selectedCorpus.name);
    }
  }, [selectedCorpus]);

  useEffect(() => {
    if (selectedCorpus) fetchConversations(selectedCorpus.name);
  }, [conversationCount]);

  // ── Corpora ───────────────────────────────────────────────────────────────────

  async function fetchCorpora() {
    setLoadingCorpora(true);
    setError(null);
    try {
      const res = await axios.get(`${API}/corpora/`);
      setCorpora(res.data);
    } catch {
      setError("Failed to load corpora");
    } finally {
      setLoadingCorpora(false);
    }
  }

  async function createCorpus() {
    if (!corpusName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await axios.post(`${API}/corpora/`, null, {
        params: { display_name: corpusName.trim() },
      });
      const newCorpus = res.data;
      setCorpora(prev => [...prev, newCorpus]);
      setCorpusName("");
      onSelectCorpus(newCorpus);
      setActiveSection("docs");
    } catch {
      setError("Failed to create corpus");
    } finally {
      setCreating(false);
    }
  }

  async function deleteCorpus(corpus) {
    const confirmed = window.confirm(
      `Delete corpus "${corpus.display_name}"? All documents in it will be permanently removed from GCP. This cannot be undone.`
    );
    if (!confirmed) return;

    const ref = corpusRef("rag", corpus);
    try {
      await runBackendFlowStream({
        engine: "rag",
        action: "delete_corpus",
        url: `${API}/corpora/?corpus_name=${encodeURIComponent(corpus.name)}`,
        init: { method: "DELETE" },
        base: ref,
      });
      setCorpora(prev => prev.filter(c => c.name !== corpus.name));
      if (selectedCorpus?.name === corpus.name) {
        onSelectCorpus(null);
        setFiles([]);
        setConversations([]);
      }
    } catch {
      setError("Failed to delete corpus");
    }
  }

  // ── Documents ─────────────────────────────────────────────────────────────────

  async function fetchFiles(corpusName) {
    setLoadingFiles(true);
    try {
      const res = await axios.get(`${API}/documents/`, { params: { corpus_name: corpusName } });
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
    setUploadProgress(0);
    setError(null);
    const corpusName = selectedCorpus.name;
    const ref = { corpusName };
    dispatchFlow({
      engine: "rag",
      action: "upload",
      phase: "uploading",
      filename: file.name,
      progress: 0,
      ...ref,
    });
    const formData = new FormData();
    formData.append("file", file);
    try {
      const result = await uploadWithFlowStream({
        url: `${API}/documents/upload?corpus_name=${encodeURIComponent(corpusName)}`,
        formData,
        engine: "rag",
        action: "upload",
        base: { filename: file.name, highlightDoc: file.name, ...ref },
        onUploadProgress: progress => setUploadProgress(progress),
      });
      const uploaded = result.file || {
        name: result.name,
        display_name: file.name,
      };
      setFiles(prev => [...prev, uploaded]);
      setUploadProgress(null);
    } catch {
      setError("Upload failed. Check file type and size.");
      dispatchFlow({
        engine: "rag",
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
    const confirmed = window.confirm(
      `Delete "${f.display_name}" from the corpus? This cannot be undone.`
    );
    if (!confirmed) return;
    const ref = corpusRef("rag", selectedCorpus);
    dispatchFlow({
      engine: "rag",
      action: "delete_file",
      phase: "deleting",
      filename: f.display_name,
      removeDoc: f.display_name,
      ...ref,
    });
    try {
      await runBackendFlowStream({
        engine: "rag",
        action: "delete_file",
        url: `${API}/documents/?corpus_name=${encodeURIComponent(selectedCorpus.name)}&file_name=${encodeURIComponent(f.name)}`,
        init: { method: "DELETE" },
        base: { filename: f.display_name, removeDoc: f.display_name, ...ref },
      });
      setFiles(prev => prev.filter(file => file.name !== f.name));
    } catch {
      setError("Failed to delete file.");
      dispatchFlow({
        engine: "rag",
        action: "delete_file",
        phase: "error",
        filename: f.display_name,
        error: "Delete failed",
        ...ref,
      });
    }
  }
  // ── Conversations ─────────────────────────────────────────────────────────────

  async function fetchConversations(corpusName) {
    setLoadingConversations(true);
    try {
      const res = await axios.get(`${API}/chat/conversations`, {
        params: { corpus_name: corpusName },
      });
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
      await axios.delete(`${API}/chat/conversations/${conv.id}`);
      setConversations(prev => prev.filter(c => c.id !== conv.id));
      if (activeConversation?.id === conv.id) onSelectConversation(null);
    } catch {
      setError("Failed to delete conversation");
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function shortName(fullName) {
    return fullName.split("/").pop();
  }

  function fileExt(name) {
    return name?.split(".").pop()?.toUpperCase() || "FILE";
  }

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

      {/* Logo */}
      <div className="sidebar-logo">
        <span className="logo-icon">◈</span>
        <span className="logo-text">RAG<span className="logo-accent">Studio</span></span>
      </div>

      {/* Tabs — now three */}
      <div className="section-tabs">
        <button
          className={`section-tab ${activeSection === "corpora" ? "active" : ""}`}
          onClick={() => setActiveSection("corpora")}
        >
          <IconDb /> Corpora
        </button>
        <button
          className={`section-tab ${activeSection === "docs" ? "active" : ""}`}
          onClick={() => setActiveSection("docs")}
        >
          <IconFile /> Docs
        </button>
        <button
          className={`section-tab ${activeSection === "chats" ? "active" : ""}`}
          onClick={() => setActiveSection("chats")}
        >
          <IconChat /> Chats
        </button>
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
          <div className="create-row">
            <input
              className="dark-input"
              placeholder="Corpus display name…"
              value={corpusName}
              onChange={e => setCorpusName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && createCorpus()}
            />
            <button className="btn-primary" onClick={createCorpus} disabled={creating || !corpusName.trim()}>
              {creating ? <span className="spinner" /> : "+"}
            </button>
          </div>

          <div className="section-label" style={{ marginTop: "20px" }}>
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
                  key={c.name}
                  className={`corpus-item ${selectedCorpus?.name === c.name ? "selected" : ""}`}
                  onClick={() => onSelectCorpus(c)}
                >
                  <div className="corpus-item-inner">
                    <span className={`corpus-dot ${selectedCorpus?.name === c.name ? "active" : ""}`} />
                    <div className="corpus-info">
                      <span className="corpus-display">{c.display_name}</span>
                      <span className="corpus-id">{shortName(c.name)}</span>
                    </div>
                  </div>
                  <button
                    className="delete-btn"
                    type="button"
                    onClick={ev => { ev.stopPropagation(); deleteCorpus(c); }}
                    title="Delete corpus"
                  >
                    <Trash2 size={14} strokeWidth={2} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── DOCUMENTS ── */}
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

              <div className="section-label" style={{ marginTop: "16px" }}>Upload document</div>
              <div
                className={`drop-zone ${uploading ? "uploading" : ""}`}
                onClick={() => !uploading && fileInputRef.current.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.txt,.docx,.csv"
                  style={{ display: "none" }}
                  onChange={uploadFile}
                />
                {uploading ? (
                  <div className="upload-progress">
                    <span className="spinner" />
                    <span>Uploading{uploadProgress !== null ? ` ${uploadProgress}%` : "…"}</span>
                    {uploadProgress !== null && (
                      <div className="progress-bar-track">
                        <div className="progress-bar-fill" style={{ width: `${uploadProgress}%` }} />
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="17 8 12 3 7 8"/>
                      <line x1="12" y1="3" x2="12" y2="15"/>
                    </svg>
                    <span className="drop-label">Click to upload</span>
                    <span className="drop-sub">PDF · TXT · DOCX · CSV</span>
                  </>
                )}
              </div>

              <div className="section-label" style={{ marginTop: "20px" }}>
                Files
                <button className="refresh-btn" onClick={() => fetchFiles(selectedCorpus.name)} title="Refresh"><IconRefresh /></button>
              </div>

              {loadingFiles ? (
                <div className="loading-row"><span className="spinner" /> Loading…</div>
              ) : files.length === 0 ? (
                <div className="empty-state">No documents uploaded yet.</div>
              ) : (
                <ul className="file-list">
                  {files.map(f => (
                    <li key={f.name} className="file-item">
                      <span className="file-ext">{fileExt(f.display_name)}</span>
                      <span className="file-name">{f.display_name}</span>
                      <button
                        className="delete-btn"
                        title="Delete file"
                        onClick={() => deleteFile(f)}
                        type="button"
                      >
                        <Trash2 size={14} strokeWidth={2} aria-hidden />
                      </button>
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
            <div className="empty-state">Select a corpus first to see its chats.</div>
          ) : (
            <>
              <div className="active-corpus-badge" style={{ marginBottom: "10px" }}>
                <span className="corpus-dot active" />
                <span>{selectedCorpus.display_name}</span>
              </div>

              <button className="new-chat-btn" onClick={() => onSelectConversation(null)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"/>
                  <line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                New chat
              </button>

              <div className="section-label" style={{ marginTop: "16px" }}>
                History
                <button className="refresh-btn" onClick={() => fetchConversations(selectedCorpus.name)} title="Refresh"><IconRefresh /></button>
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
                      <button
                        className="delete-btn"
                        onClick={e => deleteConversation(e, conv)}
                        title="Delete chat"
                        type="button"
                      >
                        <Trash2 size={14} strokeWidth={2} aria-hidden />
                      </button>
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
