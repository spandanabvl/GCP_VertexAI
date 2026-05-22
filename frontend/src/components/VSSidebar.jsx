import { useState, useEffect, useRef } from "react";
import axios from "axios";

const API = "http://localhost:8000";

/** Bare bucket id: strips gs:// and path segments (matches backend). */
function normalizeGcsBucketInput(raw) {
  let n = (raw || "").trim();
  if (n.toLowerCase().startsWith("gs://")) n = n.slice(5);
  n = n.replace(/^\/+/, "").split("/")[0] || "";
  return n;
}

function formatAxiosDetail(e) {
  const d = e?.response?.data?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map(x => x.msg || JSON.stringify(x)).join("; ");
  return null;
}

function IconRefresh() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10"/>
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg>
  );
}

export default function VSSidebar({
  selectedDatastore,
  onSelectDatastore,
  activeConversation,
  onSelectConversation,
  conversationCount,
}) {
  const [activeSection, setActiveSection] = useState("datastores");

  // Datastores
  const [datastores, setDatastores]           = useState([]);
  const [dsId, setDsId]                       = useState("");
  const [dsDisplayName, setDsDisplayName]     = useState("");
  const [gcsBucket, setGcsBucket]             = useState("");
  const [creating, setCreating]               = useState(false);
  const [loadingDs, setLoadingDs]             = useState(false);

  // Documents
  const [files, setFiles]                     = useState([]);
  const [uploading, setUploading]             = useState(false);
  const [uploadStatus, setUploadStatus]       = useState(null); // null | "uploading" | "importing" | "done" | "error"
  const [loadingFiles, setLoadingFiles]       = useState(false);
  const fileInputRef = useRef();
  const uploadPollRef = useRef(null);

  // Conversations
  const [conversations, setConversations]         = useState([]);
  const [loadingConversations, setLoadingConversations] = useState(false);

  const [error, setError] = useState(null);

  // ── Effects ──────────────────────────────────────────────────────────────────

  useEffect(() => { fetchDatastores(); }, []);

  useEffect(() => {
    if (selectedDatastore) {
      fetchFiles(selectedDatastore.datastore_id);
      fetchConversations(selectedDatastore.datastore_id);
    }
  }, [selectedDatastore]);

  useEffect(() => {
    if (selectedDatastore) fetchConversations(selectedDatastore.datastore_id);
  }, [conversationCount]);

  useEffect(() => () => {
    if (uploadPollRef.current) clearInterval(uploadPollRef.current);
  }, []);

  // ── Datastores ────────────────────────────────────────────────────────────────

  async function fetchDatastores() {
    setLoadingDs(true);
    try {
      const res = await axios.get(`${API}/vs-datastores/`);
      setDatastores(res.data);
    } catch {
      setError("Failed to load datastores");
    } finally {
      setLoadingDs(false);
    }
  }

  async function createDatastore() {
    if (!dsId.trim() || !dsDisplayName.trim() || !gcsBucket.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await axios.post(`${API}/vs-datastores/`, {
        datastore_id: dsId.trim().toLowerCase().replace(/\s+/g, "-"),
        display_name: dsDisplayName.trim(),
        gcs_bucket:   normalizeGcsBucketInput(gcsBucket),
      });
      setDatastores(prev => [res.data, ...prev]);
      onSelectDatastore(res.data);
      setDsId(""); setDsDisplayName(""); setGcsBucket("");
      setActiveSection("docs");
    } catch (e) {
      setError(formatAxiosDetail(e) || "Failed to create datastore");
    } finally {
      setCreating(false);
    }
  }

  async function deleteDatastore(ds) {
    const confirmed = window.confirm(
      `Delete datastore "${ds.display_name}"? All documents and conversations will be removed from GCP. This cannot be undone.`
    );
    if (!confirmed) return;
    try {
      await axios.delete(`${API}/vs-datastores/`, { params: { datastore_id: ds.datastore_id } });
      setDatastores(prev => prev.filter(d => d.datastore_id !== ds.datastore_id));
      if (selectedDatastore?.datastore_id === ds.datastore_id) {
        onSelectDatastore(null);
        setFiles([]);
        setConversations([]);
      }
    } catch (err) {
      const detail = err.response?.data?.detail;
      setError(
        typeof detail === "string"
          ? detail
          : "Failed to delete datastore"
      );
    }
  }

  function selectDatastore(ds) {
    onSelectDatastore(ds);
    fetchFiles(ds.datastore_id);
    fetchConversations(ds.datastore_id);
    setActiveSection("chats");
  }

  // ── Documents ─────────────────────────────────────────────────────────────────

  async function fetchFiles(datastoreId) {
    setLoadingFiles(true);
    try {
      const res = await axios.get(`${API}/vs-documents/`, { params: { datastore_id: datastoreId } });
      setFiles(res.data);
    } catch {
      setFiles([]);
    } finally {
      setLoadingFiles(false);
    }
  }

  async function uploadFile(e) {
    const file = e.target.files[0];
    if (!file || !selectedDatastore) return;
    setUploading(true);
    setUploadStatus("uploading");
    setError(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      if (uploadPollRef.current) {
        clearInterval(uploadPollRef.current);
        uploadPollRef.current = null;
      }

      const res = await axios.post(`${API}/vs-documents/upload`, formData, {
        params: {
          datastore_id: selectedDatastore.datastore_id,
          gcs_bucket:   selectedDatastore.gcs_bucket,
        },
        headers: { "Content-Type": "multipart/form-data" },
      });

      setUploadStatus("importing");

      // Add to file list immediately with "importing" status
      setFiles(prev => [...prev, {
        name:         res.data.filename,
        display_name: res.data.filename,
        status:       "importing",
        operation:    res.data.operation_name,
      }]);

      // Poll every 10s for up to 3 minutes
      let attempts = 0;
      const maxAttempts = 18;
      const opName = res.data.operation_name;
      uploadPollRef.current = setInterval(async () => {
        attempts++;
        try {
          const statusRes = await axios.get(`${API}/vs-documents/operation-status`, {
            params: { operation_name: opName },
          });
          if (statusRes.data.done || attempts >= maxAttempts) {
            if (uploadPollRef.current) clearInterval(uploadPollRef.current);
            uploadPollRef.current = null;
            setUploadStatus("done");
            setFiles(prev => prev.map(f =>
              f.operation === opName
                ? { ...f, status: "imported" }
                : f
            ));
          }
        } catch {
          if (attempts >= maxAttempts) {
            if (uploadPollRef.current) clearInterval(uploadPollRef.current);
            uploadPollRef.current = null;
            setUploadStatus("done");
          }
        }
      }, 10000);

    } catch (e) {
      setError(
        formatAxiosDetail(e)
        || "Upload failed. Check file type, billing, GCS permissions, and datastore ID.",
      );
      setUploadStatus("error");
    } finally {
      setUploading(false);
      fileInputRef.current.value = "";
    }
  }

  async function deleteFile(f) {
    const confirmed = window.confirm(`Delete "${f.display_name}" from the datastore? This cannot be undone.`);
    if (!confirmed) return;
    try {
      await axios.delete(`${API}/vs-documents/`, { params: { document_name: f.name } });
      setFiles(prev => prev.filter(file => file.name !== f.name));
    } catch {
      setError("Failed to delete document");
    }
  }

  // ── Conversations ─────────────────────────────────────────────────────────────

  async function fetchConversations(datastoreId) {
    setLoadingConversations(true);
    try {
      const res = await axios.get(`${API}/vs-chat/conversations`, {
        params: { datastore_id: datastoreId },
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
      await axios.delete(`${API}/vs-chat/conversations/${conv.id}`);
      setConversations(prev => prev.filter(c => c.id !== conv.id));
      if (activeConversation?.id === conv.id) onSelectConversation(null);
    } catch {
      setError("Failed to delete conversation");
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

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
      <div className="sidebar-logo">
        <span className="logo-icon">◈</span>
        <span className="logo-text">RAG<span className="logo-accent">Studio</span></span>
      </div>

      <div className="section-tabs">
        <button className={`section-tab ${activeSection === "datastores" ? "active" : ""}`} onClick={() => setActiveSection("datastores")}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
          Stores
        </button>
        <button className={`section-tab ${activeSection === "docs" ? "active" : ""}`} onClick={() => setActiveSection("docs")}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          Docs
        </button>
        <button className={`section-tab ${activeSection === "chats" ? "active" : ""}`} onClick={() => setActiveSection("chats")}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          Chats
        </button>
      </div>

      {error && (
        <div className="sidebar-error">
          <span>⚠ {error}</span>
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* ── DATASTORES ── */}
      {activeSection === "datastores" && (
        <div className="sidebar-section">
          <div className="section-label">New datastore</div>
          <input className="dark-input" style={{ marginBottom: 6 }} placeholder="Datastore ID (lowercase, hyphens)…" value={dsId} onChange={e => setDsId(e.target.value)} />
          <input className="dark-input" style={{ marginBottom: 6 }} placeholder="Display name…" value={dsDisplayName} onChange={e => setDsDisplayName(e.target.value)} />
          <input className="dark-input" style={{ marginBottom: 8 }} placeholder="GCS bucket name (without gs://)…" value={gcsBucket} onChange={e => setGcsBucket(e.target.value)} />
          <button
            className="btn-primary"
            style={{ width: "100%", height: 34, fontSize: 12, borderRadius: 6 }}
            onClick={createDatastore}
            disabled={creating || !dsId.trim() || !dsDisplayName.trim() || !gcsBucket.trim()}
          >
            {creating ? <span className="spinner" /> : "Create datastore"}
          </button>

          <div className="section-label" style={{ marginTop: 20 }}>
            Your datastores
            <button className="refresh-btn" onClick={fetchDatastores} title="Refresh"><IconRefresh /></button>
          </div>

          {loadingDs ? (
            <div className="loading-row"><span className="spinner" /> Loading…</div>
          ) : datastores.length === 0 ? (
            <div className="empty-state">No datastores yet. Create one above.</div>
          ) : (
            <ul className="corpus-list">
              {datastores.map(ds => (
                <li
                  key={ds.datastore_id}
                  className={`corpus-item ${selectedDatastore?.datastore_id === ds.datastore_id ? "selected" : ""}`}
                  onClick={() => selectDatastore(ds)}
                >
                  <div className="corpus-item-inner">
                    <span className={`corpus-dot ${selectedDatastore?.datastore_id === ds.datastore_id ? "active" : ""}`} />
                    <div className="corpus-info">
                      <span className="corpus-display">{ds.display_name}</span>
                      <span className="corpus-id">gs://{ds.gcs_bucket}</span>
                    </div>
                  </div>
                  <button className="delete-btn" onClick={e => { e.stopPropagation(); deleteDatastore(ds); }} title="Delete">✕</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── DOCS ── */}
      {activeSection === "docs" && (
        <div className="sidebar-section">
          {!selectedDatastore ? (
            <div className="empty-state">Select a datastore first.</div>
          ) : (
            <>
              <div className="active-corpus-badge">
                <span className="corpus-dot active" />
                <span>{selectedDatastore.display_name}</span>
              </div>
              <div className="vs-bucket-info">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                gs://{selectedDatastore.gcs_bucket}
              </div>

              <div className="section-label" style={{ marginTop: 14 }}>Upload document</div>
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
                    <span>{uploadStatus === "uploading" ? "Uploading to GCS…" : "Importing into datastore…"}</span>
                    <span className="drop-sub" style={{ marginTop: 4 }}>This takes 1–3 minutes</span>
                  </div>
                ) : (
                  <>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                    </svg>
                    <span className="drop-label">Click to upload</span>
                    <span className="drop-sub">PDF · TXT · DOCX · CSV · XLSX</span>
                    <span className="drop-sub" style={{ marginTop: 2, fontSize: 10 }}>→ uploaded to GCS, then imported</span>
                  </>
                )}
              </div>

              <div className="section-label" style={{ marginTop: 16 }}>
                Documents
                <button className="refresh-btn" onClick={() => fetchFiles(selectedDatastore.datastore_id)} title="Refresh"><IconRefresh /></button>
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
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                        {f.status === "importing" && <span className="importing-badge">importing…</span>}
                        {f.status === "imported" && <span className="imported-badge">✓</span>}
                        <button className="delete-btn" style={{ opacity: 1 }} onClick={() => deleteFile(f)} title="Delete">✕</button>
                      </div>
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
          {!selectedDatastore ? (
            <div className="empty-state">Select a datastore first.</div>
          ) : (
            <>
              <div className="active-corpus-badge" style={{ marginBottom: 10 }}>
                <span className="corpus-dot active" />
                <span>{selectedDatastore.display_name}</span>
              </div>

              <button className="new-chat-btn" onClick={() => onSelectConversation(null)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                New chat
              </button>

              <div className="section-label" style={{ marginTop: 16 }}>
                History
                <button className="refresh-btn" onClick={() => fetchConversations(selectedDatastore.datastore_id)} title="Refresh"><IconRefresh /></button>
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
