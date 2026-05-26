import { useState, useRef, useEffect } from "react";
import axios from "axios";
import { dispatchFlow, corpusRef } from "../notesFlowEvents";

const API = "http://localhost:8000";
const delay = (ms) => new Promise(r => setTimeout(r, ms));

function formatAxiosDetail(e) {
  const d = e?.response?.data?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map(x => x.msg || JSON.stringify(x)).join("; ");
  return null;
}

function TypingDots() {
  return <div className="typing-dots"><span /><span /><span /></div>;
}

function Message({ msg }) {
  const isUser  = msg.role === "user";
  const content = msg.text ?? msg.content ?? "";
  const sources = msg.sources || [];

  return (
    <div className={`message-row ${isUser ? "user" : "assistant"}`}>
      <div className="message-avatar">
        {isUser ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
        ) : (
          <span>◈</span>
        )}
      </div>
      <div className="message-bubble">
        {msg.typing ? <TypingDots /> : (
          <>
            <p className="message-text">{content}</p>
            {!isUser && sources.length > 0 && (
              <span className="chunks-badge">
                {sources.length} source{sources.length !== 1 ? "s" : ""}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function VSChatWindow({
  selectedDatastore,
  activeConversation,
  onNewConversation,
  onDeleteConversation,
}) {
  const [messages, setMessages]         = useState([]);
  const [input, setInput]               = useState("");
  const [loading, setLoading]           = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [pageSize, setPageSize]         = useState(5);
  const [convId, setConvId]             = useState(null);
  const bottomRef   = useRef();
  const textareaRef = useRef();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    setMessages([]); setConvId(null); setInput("");
  }, [selectedDatastore?.datastore_id]);

  useEffect(() => {
    if (!activeConversation) {
      setMessages([]); setConvId(null); setInput("");
      return;
    }
    if (activeConversation.id === convId) return;
    loadConversation(activeConversation.id);
  }, [activeConversation]);

  async function loadConversation(id) {
    setLoadingHistory(true);
    setMessages([]);
    try {
      const res = await axios.get(`${API}/vs-chat/conversations/${id}`);
      setMessages(res.data.messages || []);
      setConvId(id);
    } catch {
      setMessages([{ role: "assistant", text: "Failed to load conversation history." }]);
    } finally {
      setLoadingHistory(false);
    }
  }

  async function sendMessage() {
    const question = input.trim();
    if (!question || !selectedDatastore || loading) return;

    setInput("");
    setMessages(prev => [
      ...prev,
      { role: "user", text: question },
      { role: "assistant", typing: true, text: "", sources: [] },
    ]);
    setLoading(true);

    const ref = corpusRef("vs", selectedDatastore);
    dispatchFlow({ engine: "vs", action: "chat", phase: "retrieving", message: "Vertex AI Search…", ...ref });
    const genTimer = setTimeout(() => {
      dispatchFlow({ engine: "vs", action: "chat", phase: "generating", message: "Summarizing…", ...ref });
    }, 800);

    try {
      const res = await axios.post(`${API}/vs-chat/`, {
        datastore_id:    selectedDatastore.datastore_id,
        question,
        page_size:       pageSize,
        conversation_id: convId,
      });

      clearTimeout(genTimer);
      dispatchFlow({ engine: "vs", action: "chat", phase: "saving", message: "Saving conversation…", ...ref });
      await delay(300);

      const { answer, sources, conversation_id } = res.data;

      setMessages(prev => [
        ...prev.slice(0, -1),
        { role: "assistant", text: answer, sources: sources || [] },
      ]);

      if (!convId) {
        setConvId(conversation_id);
        onNewConversation({ id: conversation_id, title: question.slice(0, 60) });
      }
      dispatchFlow({ engine: "vs", action: "chat", phase: "complete", ...ref });
    } catch (e) {
      clearTimeout(genTimer);
      dispatchFlow({ engine: "vs", action: "chat", phase: "error", error: "Chat failed", ...ref });
      const detail = formatAxiosDetail(e);
      const status = e?.response?.status;
      if (status === 404) setConvId(null);
      setMessages(prev => [
        ...prev.slice(0, -1),
        {
          role: "assistant",
          text: detail || "Something went wrong. Check that the backend is running and Vertex Search is configured.",
          sources: [],
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }

  function autoResize(e) {
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
    setInput(el.value);
  }

  async function handleDeleteConversation() {
    if (!convId) return;
    try {
      await axios.delete(`${API}/vs-chat/conversations/${convId}`);
      setMessages([]); setConvId(null);
      onDeleteConversation();
    } catch {}
  }

  const isEmpty = messages.length === 0 && !loadingHistory;
  const headerTitle = activeConversation?.title || selectedDatastore?.display_name || "No datastore selected";

  return (
    <div className="chat-shell">
      <div className="chat-header">
        <div className="chat-header-left">
          <div className="chat-header-title">
            {selectedDatastore ? (
              <>
                <span className="corpus-dot active" />
                <span className="header-conv-title">{headerTitle}</span>
                <span className="vs-engine-badge" style={{ fontSize: 10, padding: "2px 7px" }}>Vertex AI Search</span>
              </>
            ) : (
              <span className="muted">No datastore selected</span>
            )}
          </div>
          <span className="chat-header-sub">Discovery Engine · global · citations enabled</span>
        </div>
        <div className="chat-header-right">
          {convId && (
            <button className="delete-conv-btn" onClick={handleDeleteConversation} title="Delete this conversation">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                <path d="M10 11v6"/><path d="M14 11v6"/>
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
              </svg>
            </button>
          )}
          <div className="topk-control">
            <label className="topk-label">Results</label>
            <input type="number" min={1} max={10} value={pageSize} onChange={e => setPageSize(Number(e.target.value))} className="topk-input" />
          </div>
        </div>
      </div>
      <div className="messages-area">
        {loadingHistory && (
          <div className="history-loading"><span className="spinner" /><span>Loading conversation…</span></div>
        )}
        {isEmpty && !loadingHistory && (
          <div className="empty-chat">
            <div className="empty-chat-icon">◈</div>
            <div className="empty-chat-title">Ask anything about your documents</div>
            <div className="empty-chat-sub">
              {selectedDatastore
                ? `Chatting with "${selectedDatastore.display_name}" · answers include citations`
                : "Select a datastore from the sidebar to begin"}
            </div>
            {selectedDatastore && (
              <div className="starter-chips">
                {["What is this document about?", "Summarize the key points", "What are the main topics?"].map(q => (
                  <button key={q} className="starter-chip" onClick={() => { setInput(q); textareaRef.current?.focus(); }}>{q}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((msg, i) => <Message key={i} msg={msg} />)}
        <div ref={bottomRef} />
      </div>
      <div className="input-area">
        {!selectedDatastore && (
          <div className="input-banner">Select a datastore from the sidebar to start chatting</div>
        )}
        <div className={`input-box ${!selectedDatastore ? "disabled" : ""}`}>
          <textarea
            ref={textareaRef}
            className="chat-input"
            placeholder={selectedDatastore ? "Ask a question… (Enter to send, Shift+Enter for newline)" : "Select a datastore first…"}
            value={input}
            onChange={autoResize}
            onKeyDown={handleKeyDown}
            disabled={!selectedDatastore || loading}
            rows={1}
          />
          <button
            className={`send-btn ${loading || !input.trim() || !selectedDatastore ? "disabled" : ""}`}
            onClick={sendMessage}
            disabled={loading || !input.trim() || !selectedDatastore}
          >
            {loading ? <span className="spinner" /> : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
