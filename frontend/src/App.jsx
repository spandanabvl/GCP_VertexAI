import { useState } from "react";
import Sidebar      from "./components/Sidebar";
import ChatWindow   from "./components/ChatWindow";
import VSRSidebar   from "./components/VSRSidebar";
import VSRChatWindow from "./components/VSRChatWindow";
import FSSidebar    from "./components/FSSidebar";
import FSChatWindow from "./components/FSChatWindow";
import VSSidebar    from "./components/VSSidebar";
import VSChatWindow from "./components/VSChatWindow";
import "./index.css";

export default function App() {
  // "rag" | "vsr" | "fs" | "vs"  (left → right order in toggle)
  const [ragMode, setRagMode] = useState("rag");

  // ── RAG Managed DB ─────────────────────────────────────────────────────────
  const [selectedCorpus,     setSelectedCorpus]     = useState(null);
  const [activeConv,         setActiveConv]         = useState(null);
  const [convCount,          setConvCount]          = useState(0);
  const handleSelectCorpus   = c  => { setSelectedCorpus(c); setActiveConv(null); };
  const handleNewConv        = cv => { setActiveConv(cv); setConvCount(n => n + 1); };
  const handleSelectConv     = cv => setActiveConv(cv);
  const handleDeleteConv     = () => { setActiveConv(null); setConvCount(n => n + 1); };

  // ── Vector Search RAG ──────────────────────────────────────────────────────
  const [vsrCorpus,    setVsrCorpus]    = useState(null);
  const [vsrConv,      setVsrConv]      = useState(null);
  const [vsrCount,     setVsrCount]     = useState(0);
  const handleVsrCorpus  = c  => { setVsrCorpus(c); setVsrConv(null); };
  const handleVsrNewConv = cv => { setVsrConv(cv); setVsrCount(n => n + 1); };
  const handleVsrSelConv = cv => setVsrConv(cv);
  const handleVsrDelConv = () => { setVsrConv(null); setVsrCount(n => n + 1); };

  // ── Feature Store RAG ──────────────────────────────────────────────────────
  const [fsCorpus,     setFsCorpus]     = useState(null);
  const [fsConv,       setFsConv]       = useState(null);
  const [fsCount,      setFsCount]      = useState(0);
  const handleFsCorpus   = c  => { setFsCorpus(c); setFsConv(null); };
  const handleFsNewConv  = cv => { setFsConv(cv); setFsCount(n => n + 1); };
  const handleFsSelConv  = cv => setFsConv(cv);
  const handleFsDelConv  = () => { setFsConv(null); setFsCount(n => n + 1); };

  // ── Vertex AI Search ───────────────────────────────────────────────────────
  const [vsDatastore,  setVsDatastore]  = useState(null);
  const [vsConv,       setVsConv]       = useState(null);
  const [vsCount,      setVsCount]      = useState(0);
  const handleVsDs     = ds => { setVsDatastore(ds); setVsConv(null); };
  const handleVsNewConv = cv => { setVsConv(cv); setVsCount(n => n + 1); };
  const handleVsSelConv = cv => setVsConv(cv);
  const handleVsDelConv = () => { setVsConv(null); setVsCount(n => n + 1); };

  return (
    <div className="app-shell">

      {/* ── Mode toggle bar ── */}
      <div className="mode-toggle-bar">
        <span className="mode-toggle-label">RAG Engine</span>
        <div className="mode-toggle-wrap">

          {/* 1 — RAG Managed DB */}
          <button className={`mode-toggle-btn ${ragMode === "rag" ? "active" : ""}`} onClick={() => setRagMode("rag")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3"/>
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
            </svg>
            RAG Managed DB
          </button>

          {/* 2 — Vector Search RAG (immediately after RAG Managed DB) */}
          <button className={`mode-toggle-btn ${ragMode === "vsr" ? "active" : ""}`} onClick={() => setRagMode("vsr")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="3"/>
              <path d="M11 2a9 9 0 1 0 0 18A9 9 0 0 0 11 2z"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            Vector Search RAG
          </button>

          {/* 3 — Feature Store RAG */}
          <button className={`mode-toggle-btn ${ragMode === "fs" ? "active" : ""}`} onClick={() => setRagMode("fs")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2"/>
              <path d="M8 21h8"/><path d="M12 17v4"/>
            </svg>
            Feature Store RAG
          </button>

          {/* 4 — Vertex AI Search */}
          <button className={`mode-toggle-btn ${ragMode === "vs" ? "active" : ""}`} onClick={() => setRagMode("vs")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            Vertex AI Search
          </button>

        </div>
      </div>

      {/* ── Main body ── */}
      <div className="app-body">

        {ragMode === "rag" && (
          <>
            <Sidebar
              selectedCorpus={selectedCorpus}
              onSelectCorpus={handleSelectCorpus}
              activeConversation={activeConv}
              onSelectConversation={handleSelectConv}
              conversationCount={convCount}
            />
            <main className="main-area">
              <ChatWindow
                selectedCorpus={selectedCorpus}
                activeConversation={activeConv}
                onNewConversation={handleNewConv}
                onDeleteConversation={handleDeleteConv}
              />
            </main>
          </>
        )}

        {ragMode === "vsr" && (
          <>
            <VSRSidebar
              selectedCorpus={vsrCorpus}
              onSelectCorpus={handleVsrCorpus}
              activeConversation={vsrConv}
              onSelectConversation={handleVsrSelConv}
              conversationCount={vsrCount}
            />
            <main className="main-area">
              <VSRChatWindow
                selectedCorpus={vsrCorpus}
                activeConversation={vsrConv}
                onNewConversation={handleVsrNewConv}
                onDeleteConversation={handleVsrDelConv}
              />
            </main>
          </>
        )}

        {ragMode === "fs" && (
          <>
            <FSSidebar
              selectedCorpus={fsCorpus}
              onSelectCorpus={handleFsCorpus}
              activeConversation={fsConv}
              onSelectConversation={handleFsSelConv}
              conversationCount={fsCount}
            />
            <main className="main-area">
              <FSChatWindow
                selectedCorpus={fsCorpus}
                activeConversation={fsConv}
                onNewConversation={handleFsNewConv}
                onDeleteConversation={handleFsDelConv}
              />
            </main>
          </>
        )}

        {ragMode === "vs" && (
          <>
            <VSSidebar
              selectedDatastore={vsDatastore}
              onSelectDatastore={handleVsDs}
              activeConversation={vsConv}
              onSelectConversation={handleVsSelConv}
              conversationCount={vsCount}
            />
            <main className="main-area">
              <VSChatWindow
                selectedDatastore={vsDatastore}
                activeConversation={vsConv}
                onNewConversation={handleVsNewConv}
                onDeleteConversation={handleVsDelConv}
              />
            </main>
          </>
        )}

      </div>
    </div>
  );
}
