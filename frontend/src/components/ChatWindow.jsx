import { useState, useRef, useEffect } from "react";
import axios from "axios";
import { dispatchFlow, corpusRef } from "../notesFlowEvents";
import { runBackendFlowStream } from "../flowStream";

const API = "http://localhost:8000";

// ── Sub-components ────────────────────────────────────────────────────────────

function TypingDots() {
  return (
    <div className="typing-dots">
      <span /><span /><span />
    </div>
  );
}

function Message({ msg }) {
  // DB messages use "text"; in-session messages use "content"
  const isUser  = msg.role === "user";
  const content = msg.text ?? msg.content ?? "";
  const chunks  = msg.chunks_used ?? msg.chunks;

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
            {!isUser && chunks !== undefined && (
              <span className="chunks-badge">{chunks} chunk{chunks !== 1 ? "s" : ""} retrieved</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ChatWindow({
  selectedCorpus,
  activeConversation,   // { id, title } | null  (null = new chat)
  onNewConversation,    // called with { id, title } after first message
  onDeleteConversation, // called after user deletes from header
}) {
  const [messages, setMessages]     = useState([]);
  const [input, setInput]           = useState("");
  const [loading, setLoading]       = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [convId, setConvId]         = useState(null); // tracks current DB conversation id
  const bottomRef  = useRef();
  const textareaRef = useRef();

  // ── Scroll to bottom on new messages ───────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Reset when corpus changes ───────────────────────────────────────────────
  useEffect(() => {
    setMessages([]);
    setConvId(null);
    setInput("");
  }, [selectedCorpus?.name]);

  // ── Load or clear conversation when activeConversation changes ─────────────
  useEffect(() => {
    if (!activeConversation) {
      // "New chat" was clicked — blank slate
      setMessages([]);
      setConvId(null);
      setInput("");
      return;
    }
    if (activeConversation.id === convId) return; // already loaded
    loadConversation(activeConversation.id);
  }, [activeConversation]);

  async function loadConversation(id) {
    setLoadingHistory(true);
    setMessages([]);
    try {
      const res = await axios.get(`${API}/chat/conversations/${id}`);
      // DB messages: { role, text, chunks_used }
      setMessages(res.data.messages || []);
      setConvId(id);
    } catch {
      setMessages([{ role: "assistant", text: "Failed to load conversation history." }]);
    } finally {
      setLoadingHistory(false);
    }
  }

  // ── Send message ───────────────────────────────────────────────────────────

  async function sendMessage() {
    const question = input.trim();
    if (!question || !selectedCorpus || loading) return;

    setInput("");
    // Show optimistic messages immediately
    setMessages(prev => [
      ...prev,
      { role: "user",      text: question },
      { role: "assistant", typing: true, text: "" },
    ]);
    setLoading(true);

    const ref = corpusRef("rag", selectedCorpus);

    try {
      const result = await runBackendFlowStream({
        engine: "rag",
        action: "chat",
        url: `${API}/chat/`,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            corpus_name: selectedCorpus.name,
            corpus_display_name: selectedCorpus.display_name,
            question,
            top_k: 5,
            conversation_id: convId,
          }),
        },
        base: ref,
      });

      const { answer, chunks_used, conversation_id } = result;

      setMessages(prev => [
        ...prev.slice(0, -1),
        { role: "assistant", text: answer, chunks_used },
      ]);

      if (!convId && conversation_id) {
        setConvId(conversation_id);
        onNewConversation({ id: conversation_id, title: question.slice(0, 60) });
      }
    } catch {
      dispatchFlow({ engine: "rag", action: "chat", phase: "error", error: "Chat failed", ...ref });
      setMessages(prev => [
        ...prev.slice(0, -1),
        {
          role: "assistant",
          text: "Something went wrong. Check that the backend is running and the corpus has documents.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function autoResize(e) {
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
    setInput(el.value);
  }

  // ── Delete current conversation ───────────────────────────────────────────

  async function handleDeleteConversation() {
    if (!convId) return;
    try {
      await axios.delete(`${API}/chat/conversations/${convId}`);
      setMessages([]);
      setConvId(null);
      onDeleteConversation();
    } catch {
      // ignore
    }
  }

  const isEmpty = messages.length === 0 && !loadingHistory;

  const headerTitle = activeConversation?.title
    || (convId ? "New conversation" : selectedCorpus?.display_name || "No corpus selected");

  // ── Render ─────────────────────────────────────────────────────────────────

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
              </>
            ) : (
              <span className="muted">No corpus selected</span>
            )}
          </div>
          <span className="chat-header-sub">Vertex AI RAG · Gemini 2.5 Flash</span>
        </div>

        <div className="chat-header-right">
          {convId && (
            <button
              className="delete-conv-btn"
              onClick={handleDeleteConversation}
              title="Delete this conversation"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                <path d="M10 11v6"/><path d="M14 11v6"/>
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Messages area */}
      <div className="messages-area">

        {loadingHistory && (
          <div className="history-loading">
            <span className="spinner" />
            <span>Loading conversation…</span>
          </div>
        )}

        {isEmpty && !loadingHistory && (
          <div className="empty-chat">
            <div className="empty-chat-icon">◈</div>
            <div className="empty-chat-title">Ask anything about your documents</div>
            <div className="empty-chat-sub">
              {selectedCorpus
                ? `Chatting with "${selectedCorpus.display_name}"`
                : "Select a corpus from the sidebar to begin"}
            </div>
            {selectedCorpus && (
              <div className="starter-chips">
                {[
                  "What is this document about?",
                  "Summarize the key points",
                  "What are the main topics?",
                ].map(q => (
                  <button
                    key={q}
                    className="starter-chip"
                    onClick={() => { setInput(q); textareaRef.current?.focus(); }}
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {messages.map((msg, i) => <Message key={i} msg={msg} />)}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="input-area">
        {!selectedCorpus && (
          <div className="input-banner">Select a corpus from the sidebar to start chatting</div>
        )}
        <div className={`input-box ${!selectedCorpus ? "disabled" : ""}`}>
          <textarea
            ref={textareaRef}
            className="chat-input"
            placeholder={
              selectedCorpus
                ? "Ask a question… (Enter to send, Shift+Enter for newline)"
                : "Select a corpus first…"
            }
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
            {loading ? (
              <span className="spinner" />
            ) : (
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
