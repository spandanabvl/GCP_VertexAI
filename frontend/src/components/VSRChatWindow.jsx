import { useState, useRef, useEffect } from "react";
import axios from "axios";
import { dispatchFlow, corpusRef } from "../notesFlowEvents";

const API = "http://localhost:8000";
const delay = (ms) => new Promise(r => setTimeout(r, ms));

function TypingDots() {
  return <div className="typing-dots"><span /><span /><span /></div>;
}

function Message({ msg }) {
  const isUser    = msg.role === "user";
  const content   = msg.text ?? msg.content ?? "";
  const topK      = msg.similarity_top_k;
  const threshold = msg.vector_distance_threshold;

  return (
    <div className={`message-row ${isUser ? "user" : "assistant"}`}>
      <div className="message-avatar">
        {isUser ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
        ) : <span>◈</span>}
      </div>
      <div className="message-bubble">
        {msg.typing ? <TypingDots /> : (
          <>
            <p className="message-text">{content}</p>
            {!isUser && topK !== undefined && (
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                <span className="chunks-badge">top-k {topK}</span>
                <span className="vsr-threshold-badge">threshold {threshold}</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function VSRChatWindow({
  selectedCorpus,
  activeConversation,
  onNewConversation,
  onDeleteConversation,
}) {
  const [messages,       setMessages]       = useState([]);
  const [input,          setInput]          = useState("");
  const [loading,        setLoading]        = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [topK,           setTopK]           = useState(10);
  const [threshold,      setThreshold]      = useState(0.4);
  const [convId,         setConvId]         = useState(null);
  const bottomRef   = useRef();
  const textareaRef = useRef();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    setMessages([]); setConvId(null); setInput("");
  }, [selectedCorpus?.corpus_name]);

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
      const res = await axios.get(`${API}/vsr-chat/conversations/${id}`);
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
    if (!question || !selectedCorpus || loading) return;

    setInput("");
    setMessages(prev => [
      ...prev,
      { role: "user",      text: question },
      { role: "assistant", typing: true, text: "" },
    ]);
    setLoading(true);

    const ref = corpusRef("vsr", selectedCorpus);
    dispatchFlow({ engine: "vsr", action: "chat", phase: "retrieving", message: "Vector RAG retrieval…", ...ref });

    try {
      const res = await axios.post(`${API}/vsr-chat/`, {
        corpus_name:               selectedCorpus.corpus_name,
        question,
        similarity_top_k:          topK,
        vector_distance_threshold: threshold,
        conversation_id:           convId,
      });

      dispatchFlow({ engine: "vsr", action: "chat", phase: "saving", message: "Saving conversation…", ...ref });
      await delay(300);

      const { answer, conversation_id } = res.data;

      setMessages(prev => [
        ...prev.slice(0, -1),
        {
          role:                      "assistant",
          text:                      answer,
          similarity_top_k:          topK,
          vector_distance_threshold: threshold,
        },
      ]);

      if (!convId) {
        setConvId(conversation_id);
        onNewConversation({ id: conversation_id, title: question.slice(0, 60) });
      }
      dispatchFlow({ engine: "vsr", action: "chat", phase: "complete", ...ref });
    } catch {
      dispatchFlow({ engine: "vsr", action: "chat", phase: "error", error: "Chat failed", ...ref });
      setMessages(prev => [
        ...prev.slice(0, -1),
        { role: "assistant", text: "Something went wrong. Check that the backend is running." },
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
      await axios.delete(`${API}/vsr-chat/conversations/${convId}`);
      setMessages([]); setConvId(null);
      onDeleteConversation();
    } catch {}
  }

  const isEmpty     = messages.length === 0 && !loadingHistory;
  const headerTitle = activeConversation?.title || selectedCorpus?.display_name || "No corpus selected";

  return (
    <div className="chat-shell">

      {/* Header */}
      <div className="chat-header">
        <div className="chat-header-left">
          <div className="chat-header-title">
            {selectedCorpus ? (
              <>
                <span className="corpus-dot active" />
                <span className="header-conv-title">{headerTitle}</span>
                <span className="vsr-engine-badge" style={{ fontSize: 10, padding: "2px 7px" }}>Vector Search</span>
              </>
            ) : (
              <span className="muted">No corpus selected</span>
            )}
          </div>
          <span className="chat-header-sub">
            Vertex AI Vector Search · DOT_PRODUCT · STREAM_UPDATE · gemini-2.5-flash
          </span>
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

          {/* Distance threshold control */}
          <div className="topk-control">
            <label className="topk-label">Threshold</label>
            <input
              type="number"
              min={0} max={1} step={0.05}
              value={threshold}
              onChange={e => setThreshold(parseFloat(e.target.value))}
              className="topk-input"
              style={{ width: 52 }}
              title="vector_distance_threshold: lower = stricter (0.0–1.0)"
            />
          </div>

          {/* Top-K control */}
          <div className="topk-control">
            <label className="topk-label">Top-K</label>
            <input
              type="number"
              min={1} max={50}
              value={topK}
              onChange={e => setTopK(Number(e.target.value))}
              className="topk-input"
            />
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="messages-area">
        {loadingHistory && (
          <div className="history-loading"><span className="spinner" /><span>Loading conversation…</span></div>
        )}

        {isEmpty && !loadingHistory && (
          <div className="empty-chat">
            <div className="empty-chat-icon">◈</div>
            <div className="empty-chat-title">Ask anything about your documents</div>
            <div className="empty-chat-sub">
              {selectedCorpus
                ? `Chatting with "${selectedCorpus.display_name}" · Vector Search index`
                : "Select a corpus from the sidebar to begin"}
            </div>
            {selectedCorpus && (
              <div className="starter-chips">
                {[
                  "What is this document about?",
                  "Summarize the key points",
                  "What are the main topics?",
                ].map(q => (
                  <button key={q} className="starter-chip" onClick={() => { setInput(q); textareaRef.current?.focus(); }}>{q}</button>
                ))}
              </div>
            )}
          </div>
        )}

        {messages.map((msg, i) => <Message key={i} msg={msg} />)}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="input-area">
        {!selectedCorpus && (
          <div className="input-banner">Select a corpus from the sidebar to start chatting</div>
        )}
        <div className={`input-box ${!selectedCorpus ? "disabled" : ""}`}>
          <textarea
            ref={textareaRef}
            className="chat-input"
            placeholder={selectedCorpus ? "Ask a question… (Enter to send, Shift+Enter for newline)" : "Select a corpus first…"}
            value={input}
            onChange={autoResize}
            onKeyDown={handleKeyDown}
            disabled={!selectedCorpus || loading}
            rows={1}
          />
          <button
            className={`send-btn ${loading || !input.trim() || !selectedCorpus ? "disabled" : ""}`}
            onClick={sendMessage}
            disabled={loading || !input.trim() || !selectedCorpus}
          >
            {loading ? <span className="spinner" /> : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"/>
                <polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
