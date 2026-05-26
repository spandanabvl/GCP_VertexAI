import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import NotesSidebar, { API } from "./NotesSidebar";
import NotesGraph from "./NotesGraph";
import { FLOW_EVENT } from "../notesFlowEvents";

async function fetchCount(endpoint) {
  try {
    const res = await axios.get(`${API}${endpoint}`);
    return Array.isArray(res.data) ? res.data.length : 0;
  } catch {
    return null;
  }
}

export default function NotesView() {
  const [selectedEngine, setSelectedEngine] = useState("rag");
  const [refreshKey, setRefreshKey] = useState(0);
  const [counts, setCounts] = useState({
    rag: null,
    vsr: null,
    fs: null,
    vs: null,
  });
  const [loadingCounts, setLoadingCounts] = useState(false);

  const refreshAll = useCallback(async () => {
    setLoadingCounts(true);
    const [rag, vsr, fs, vs] = await Promise.all([
      fetchCount("/corpora/"),
      fetchCount("/vsr-corpora/"),
      fetchCount("/fs-corpora/"),
      fetchCount("/vs-datastores/"),
    ]);
    setCounts({ rag, vsr, fs, vs });
    setLoadingCounts(false);
    setRefreshKey(k => k + 1);
  }, []);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const onFlow = (e) => {
      const eng = e.detail?.engine;
      if (eng) setSelectedEngine(eng);
    };
    window.addEventListener(FLOW_EVENT, onFlow);
    return () => window.removeEventListener(FLOW_EVENT, onFlow);
  }, []);

  return (
    <>
      <NotesSidebar
        selectedEngine={selectedEngine}
        onSelectEngine={setSelectedEngine}
        counts={counts}
        loading={loadingCounts}
        onRefresh={refreshAll}
      />
      <main className="main-area notes-main">
        <NotesGraph engine={selectedEngine} refreshKey={refreshKey} />
      </main>
    </>
  );
}
