import { useState } from "react";
import axios from "axios";

const API = import.meta.env.VITE_API_URL ?? "";
import Sidebar      from "./components/Sidebar";
import ChatWindow   from "./components/ChatWindow";
import VSRSidebar   from "./components/VSRSidebar";
import VSRChatWindow from "./components/VSRChatWindow";
import FSSidebar    from "./components/FSSidebar";
import FSChatWindow from "./components/FSChatWindow";
import VSSidebar    from "./components/VSSidebar";
import VSChatWindow from "./components/VSChatWindow";
import MonitoringSidebar from "./components/MonitoringSidebar";
import MonitoringPanel   from "./components/MonitoringPanel";
import VSR2Sidebar    from "./components/VSR2Sidebar";
import VSR2ChatWindow from "./components/VSR2ChatWindow";
import "./index.css";

export default function App() {
  // "rag" | "vsr" | "fs" | "vs" | "monitoring"
  const [ragMode, setRagMode] = useState("rag");

  // ── Monitoring ─────────────────────────────────────────────────────────────
  const [monPhase, setMonPhase] = useState("setup");
  const [monConfig, setMonConfig] = useState(null);
  const [monQuestions, setMonQuestions] = useState([]);
  const [monQuestionIndex, setMonQuestionIndex] = useState(0);
  const [monSessionKey, setMonSessionKey] = useState(0);
  const [monRun, setMonRun] = useState(null);
  const [monBenchmark, setMonBenchmark] = useState(null);
  const [monBenchmarkError, setMonBenchmarkError] = useState(null);

  function handleMonitoringStart({ ragCorpus, vsrCorpus, fsCorpus, questionCount }) {
    setMonConfig({ ragCorpus, vsrCorpus, fsCorpus, questionCount });
    setMonQuestions(Array(questionCount).fill(""));
    setMonQuestionIndex(0);
    setMonPhase("questions");
  }

  function handleMonitoringAdvance() {
    setMonQuestionIndex(i => Math.min(i + 1, (monConfig?.questionCount ?? 1) - 1));
  }

  async function handleMonitoringSubmit(finalQuestions) {
    const run = {
      ragCorpus: monConfig?.ragCorpus,
      vsrCorpus: monConfig?.vsrCorpus,
      fsCorpus: monConfig?.fsCorpus,
      questions: finalQuestions,
    };
    setMonQuestions(finalQuestions);
    setMonRun(run);
    setMonBenchmark(null);
    setMonBenchmarkError(null);
    setMonPhase("processing");

    const targets = [];
    if (run.ragCorpus?.name) {
      targets.push({
        engine_type: "ragmanageddb",
        corpus_name: run.ragCorpus.name,
        display_name: run.ragCorpus.display_name ?? "",
      });
    }
    if (run.vsrCorpus?.corpus_name) {
      targets.push({
        engine_type: "vector_search_rag",
        corpus_name: run.vsrCorpus.corpus_name,
        display_name: run.vsrCorpus.display_name ?? "",
      });
    }
    if (run.fsCorpus?.corpus_name) {
      targets.push({
        engine_type: "feature_store_rag",
        corpus_name: run.fsCorpus.corpus_name,
        display_name: run.fsCorpus.display_name ?? "",
      });
    }

    if (targets.length === 0) {
      setMonBenchmarkError("Select at least one corpus in the sidebar before submitting.");
      setMonPhase("results");
      return;
    }

    try {
      const res = await axios.post(`${API}/api/benchmark`, {
        questions: finalQuestions.filter(q => q.trim()),
        targets,
      });
      setMonBenchmark(res.data);
      setMonPhase("results");
    } catch (e) {
      const detail = e?.response?.data?.detail;
      let msg = "Benchmark failed";
      if (typeof detail === "string") msg = detail;
      else if (Array.isArray(detail)) {
        msg = detail.map(d => d.msg || d.message || JSON.stringify(d)).join(". ");
      } else if (detail) msg = JSON.stringify(detail);
      else if (e?.message) msg = `${msg}: ${e.message}`;
      console.error("Benchmark error", e?.response?.data ?? e);
      setMonBenchmarkError(msg);
      setMonPhase("results");
    }
  }

  function handleMonitoringReset() {
    setMonPhase("setup");
    setMonConfig(null);
    setMonQuestions([]);
    setMonQuestionIndex(0);
    setMonRun(null);
    setMonBenchmark(null);
    setMonBenchmarkError(null);
    setMonSessionKey(k => k + 1);
  }

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

   // ── Vector Search RAG 2.0 (Serverless) ────────────────────────────────────
   const [vsr2Corpus,    setVsr2Corpus]    = useState(null);
   const [vsr2Conv,      setVsr2Conv]      = useState(null);
   const [vsr2Count,     setVsr2Count]     = useState(0);
   const handleVsr2Corpus  = c  => { setVsr2Corpus(c);  setVsr2Conv(null); };
   const handleVsr2NewConv = cv => { setVsr2Conv(cv);   setVsr2Count(n => n + 1); };
   const handleVsr2SelConv = cv => setVsr2Conv(cv);
   const handleVsr2DelConv = () => { setVsr2Conv(null); setVsr2Count(n => n + 1); };

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

          {/* 3 — Vector Search RAG 2.0 — immediately after VS1 */}
          <button className={`mode-toggle-btn ${ragMode === "vsr2" ? "active" : ""}`} onClick={() => setRagMode("vsr2")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
            Vector Search 2.0
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

          {/* 5 — Monitoring */}
          <button className={`mode-toggle-btn monitoring-toggle ${ragMode === "monitoring" ? "active" : ""}`} onClick={() => setRagMode("monitoring")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
            </svg>
            Monitoring
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

        {/* 4 — Vector Search RAG 2.0 (Serverless) */}
        {ragMode === "vsr2" && (
          <>
            <VSR2Sidebar
              selectedCorpus={vsr2Corpus}
              onSelectCorpus={handleVsr2Corpus}
              activeConversation={vsr2Conv}
              onSelectConversation={handleVsr2SelConv}
              conversationCount={vsr2Count}
            />
            <main className="main-area">
              <VSR2ChatWindow
                selectedCorpus={vsr2Corpus}
                activeConversation={vsr2Conv}
                onNewConversation={handleVsr2NewConv}
                onDeleteConversation={handleVsr2DelConv}
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

        {ragMode === "monitoring" && (
          <>
            <MonitoringSidebar
              key={monSessionKey}
              phase={monPhase}
              onStart={handleMonitoringStart}
              onReset={handleMonitoringReset}
            />
            <MonitoringPanel
              phase={monPhase}
              config={monConfig}
              questions={monQuestions}
              currentIndex={monQuestionIndex}
              onUpdateQuestions={setMonQuestions}
              onAdvance={handleMonitoringAdvance}
              onSubmit={handleMonitoringSubmit}
              benchmarkResult={monBenchmark}
              benchmarkError={monBenchmarkError}
              onReset={handleMonitoringReset}
            />
          </>
        )}

      </div>
    </div>
  );
}
