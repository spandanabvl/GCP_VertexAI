import { isActivePhase } from "./notesFlowEvents";

/** Resolve activation for live flow overlay on the graph */
function lookup(engine, flow) {
  const { action, phase, step } = flow;
  const table = ACTIVATIONS[engine];
  if (!table) return null;

  if (step && table[action]?.[`${phase}:${step}`]) {
    return table[action][`${phase}:${step}`];
  }
  if (table[action]?.[phase]) return table[action][phase];
  if (phase === "start" && table[action]?.processing) return table[action].processing;
  return null;
}

const ACTIVATIONS = {
  rag: {
    upload: {
      uploading: {
        track: "ingest",
        nodes: ["ing-upload", "ing-corpus"],
        edges: ["i-ing-upload-ing-corpus"],
        subs: { "ing-upload": (f) => `Uploading… ${f.progress ?? 0}%` },
      },
      ingest: {
        track: "ingest",
        nodes: ["ing-corpus"],
        edges: ["i-ing-upload-ing-corpus"],
        subs: { "ing-corpus": (f) => f.message || "rag.upload_file · ingest…" },
      },
      indexed: {
        track: "ingest",
        nodes: ["ing-corpus", "ing-managed", "ing-docs"],
        edges: ["i-ing-corpus-ing-managed", "i-ing-managed-ing-docs"],
        subs: {
          "ing-managed": (f) => f.message || "KNN embed / index…",
          "ing-docs": () => "Indexing…",
        },
      },
      indexing: {
        track: "ingest",
        nodes: ["ing-corpus", "ing-managed", "ing-docs"],
        edges: ["i-ing-corpus-ing-managed", "i-ing-managed-ing-docs"],
        subs: {
          "ing-corpus": () => "rag.upload_file…",
          "ing-managed": () => "KNN embed / index…",
        },
      },
      complete: { track: "ingest", nodes: ["ing-docs"], edges: [] },
    },
    delete_file: {
      deleting: {
        track: "delete_file",
        nodes: ["df-file", "df-corpus", "df-managed"],
        edges: ["df-df-file-df-corpus", "df-df-corpus-df-managed"],
        subs: { "df-file": (f) => truncSub(f.filename, "Deleting…") },
      },
      "deleting:file": {
        track: "delete_file",
        nodes: ["df-file"],
        edges: [],
        message: "DELETE /documents/…",
      },
      "deleting:corpus": {
        track: "delete_file",
        nodes: ["df-file", "df-corpus"],
        edges: ["df-df-file-df-corpus"],
        message: "rag.delete_file…",
      },
      "deleting:vectors": {
        track: "delete_file",
        nodes: ["df-file", "df-corpus", "df-managed"],
        edges: ["df-df-file-df-corpus", "df-df-corpus-df-managed"],
        message: "Vectors removed",
      },
      complete: { track: "delete_file", nodes: ["df-managed"], edges: [] },
    },
    delete_corpus: {
      "deleting:files": {
        track: "delete_corpus",
        nodes: ["dc-files"],
        edges: [],
        message: "Deleting all files…",
      },
      "deleting:corpus": {
        track: "delete_corpus",
        nodes: ["dc-files", "dc-corpus"],
        edges: ["dc-dc-files-dc-corpus"],
        message: "Deleting corpus…",
      },
      "deleting:postgres": {
        track: "delete_corpus",
        nodes: ["dc-files", "dc-corpus", "dc-pg"],
        edges: ["dc-dc-files-dc-corpus", "dc-dc-corpus-dc-pg"],
        message: "Clearing conversations…",
      },
      complete: { track: "delete_corpus", nodes: ["dc-pg"], edges: [] },
    },
    chat: {
      retrieving: {
        track: "chat",
        nodes: ["chat-corpus", "chat-retrieval"],
        edges: ["c-chat-corpus-chat-retrieval"],
        message: "Retrieving chunks…",
      },
      retrieved: {
        track: "chat",
        nodes: ["chat-corpus", "chat-retrieval"],
        edges: ["c-chat-corpus-chat-retrieval"],
        message: "Retrieval complete",
      },
      generating: {
        track: "chat",
        nodes: ["chat-gemini"],
        edges: ["c-chat-retrieval-chat-gemini"],
        message: "Generating answer…",
      },
      saving: {
        track: "chat",
        nodes: ["chat-pg"],
        edges: ["c-chat-gemini-chat-pg"],
        message: "Saving conversation…",
      },
      complete: { track: "chat", nodes: ["chat-pg"], edges: [] },
    },
  },

  vsr: {
    upload: {
      uploading: {
        track: "ingest",
        nodes: ["ing-upload", "ing-corpus"],
        edges: ["i-ing-upload-ing-corpus"],
        subs: { "ing-upload": (f) => `Uploading… ${f.progress ?? 0}%` },
      },
      indexing: {
        track: "ingest",
        nodes: ["ing-corpus", "ing-index", "ing-docs"],
        edges: ["i-ing-corpus-ing-index", "i-ing-endpoint-ing-docs"],
        subs: {
          "ing-corpus": () => "rag.upload_file…",
          "ing-index": () => "STREAM_UPDATE…",
        },
      },
      complete: { track: "ingest", nodes: ["ing-docs"], edges: [] },
    },
    delete_file: {
      deleting: {
        track: "delete_file",
        nodes: ["df-file", "df-corpus", "df-index"],
        edges: ["df-df-file-df-corpus", "df-df-corpus-df-index"],
      },
      complete: { track: "delete_file", nodes: ["df-index"], edges: [] },
    },
    delete_corpus: {
      "deleting:files": { track: "delete_corpus", nodes: ["dc-files"], message: "Deleting files…" },
      "deleting:corpus": {
        track: "delete_corpus",
        nodes: ["dc-files", "dc-corpus"],
        edges: ["dc-dc-files-dc-corpus"],
      },
      "deleting:index": {
        track: "delete_corpus",
        nodes: ["dc-files", "dc-corpus", "dc-index", "dc-endpoint"],
        edges: ["dc-dc-files-dc-corpus", "dc-dc-corpus-dc-index", "dc-dc-index-dc-endpoint"],
        message: "Tearing down Vector Search…",
      },
      "deleting:postgres": {
        track: "delete_corpus",
        nodes: ["dc-pg"],
        edges: [],
        message: "Removing metadata…",
      },
      complete: { track: "delete_corpus", nodes: ["dc-pg"], edges: [] },
    },
    chat: {
      retrieving: {
        track: "chat",
        nodes: ["chat-corpus", "chat-genai"],
        edges: ["c-chat-corpus-chat-genai"],
        message: "RAG retrieval…",
      },
      saving: {
        track: "chat",
        nodes: ["chat-pg"],
        edges: ["c-chat-genai-chat-pg"],
        message: "Saving…",
      },
      complete: { track: "chat", nodes: ["chat-pg"], edges: [] },
    },
  },

  fs: {
    upload: {
      uploading: {
        track: "ingest",
        nodes: ["ing-upload", "ing-corpus"],
        edges: ["i-ing-upload-ing-corpus"],
        subs: { "ing-upload": (f) => `Uploading… ${f.progress ?? 0}%` },
      },
      syncing: {
        track: "ingest",
        nodes: ["ing-corpus", "ing-bq", "ing-sync", "ing-fos", "ing-docs"],
        edges: [
          "i-ing-corpus-ing-bq",
          "i-ing-bq-ing-sync",
          "i-ing-sync-ing-fos",
          "i-ing-fos-ing-docs",
        ],
        subs: {
          "ing-sync": () => "fv.sync()…",
          "ing-bq": () => "BQ embeddings…",
        },
      },
      complete: { track: "ingest", nodes: ["ing-docs"], edges: [] },
    },
    delete_file: {
      deleting: {
        track: "delete_file",
        nodes: ["df-file", "df-corpus", "df-bq", "df-sync"],
        edges: ["df-df-file-df-corpus", "df-df-corpus-df-bq", "df-df-bq-df-sync"],
      },
      complete: { track: "delete_file", nodes: ["df-sync"], edges: [] },
    },
    delete_corpus: {
      "deleting:files": { track: "delete_corpus", nodes: ["dc-files"], message: "Deleting files…" },
      "deleting:corpus": {
        track: "delete_corpus",
        nodes: ["dc-files", "dc-corpus"],
        edges: ["dc-dc-files-dc-corpus"],
      },
      "deleting:infra": {
        track: "delete_corpus",
        nodes: ["dc-bq", "dc-fv", "dc-pg"],
        edges: ["dc-dc-bq-dc-fv", "dc-dc-fv-dc-pg"],
        message: "BQ / Feature Store teardown…",
      },
      "deleting:postgres": { track: "delete_corpus", nodes: ["dc-pg"], message: "Removing rows…" },
      complete: { track: "delete_corpus", nodes: ["dc-pg"], edges: [] },
    },
    chat: {
      retrieving: {
        track: "chat",
        nodes: ["chat-corpus", "chat-gemini"],
        edges: ["c-chat-corpus-chat-gemini"],
        message: "Hybrid retrieval…",
      },
      saving: {
        track: "chat",
        nodes: ["chat-pg"],
        edges: ["c-chat-gemini-chat-pg"],
      },
      complete: { track: "chat", nodes: ["chat-pg"], edges: [] },
    },
  },

  vs: {
    upload: {
      uploading: {
        track: "ingest",
        nodes: ["ing-upload", "ing-gcs"],
        edges: ["i-ing-upload-ing-gcs"],
        subs: { "ing-upload": (f) => `Uploading… ${f.progress ?? 0}%` },
      },
      importing: {
        track: "ingest",
        nodes: ["ing-gcs", "ing-registry", "ing-import", "ing-datastore", "ing-docs"],
        edges: [
          "i-ing-gcs-ing-registry",
          "i-ing-registry-ing-import",
          "i-ing-import-ing-datastore",
          "i-ing-datastore-ing-docs",
        ],
        subs: {
          "ing-import": () => "async import (1–3 min)…",
          "ing-registry": () => "Recording filename…",
        },
      },
      complete: { track: "ingest", nodes: ["ing-docs"], edges: [] },
    },
    delete_file: {
      deleting: {
        track: "delete_file",
        nodes: ["df-file", "df-de", "df-reg"],
        edges: ["df-df-file-df-de", "df-df-de-df-reg"],
      },
      complete: { track: "delete_file", nodes: ["df-reg"], edges: [] },
    },
    delete_datastore: {
      "deleting:engine": { track: "delete_corpus", nodes: ["dc-engine"], message: "Deleting Search Engine…" },
      "deleting:datastore": {
        track: "delete_corpus",
        nodes: ["dc-engine", "dc-ds"],
        edges: ["dc-dc-engine-dc-ds"],
      },
      "deleting:postgres": { track: "delete_corpus", nodes: ["dc-pg"], message: "Clearing Postgres…" },
      complete: { track: "delete_corpus", nodes: ["dc-pg"], edges: [] },
    },
    chat: {
      retrieving: {
        track: "chat",
        nodes: ["chat-engine", "chat-search"],
        edges: ["c-chat-engine-chat-search"],
        message: "Vertex AI Search…",
      },
      generating: {
        track: "chat",
        nodes: ["chat-search"],
        message: "Summarizing / Gemini fallback…",
      },
      saving: {
        track: "chat",
        nodes: ["chat-pg"],
        edges: ["c-chat-search-chat-pg"],
      },
      complete: { track: "chat", nodes: ["chat-pg"], edges: [] },
    },
  },
};

function truncSub(str, prefix, max = 22) {
  const s = str ? String(str) : "";
  const t = s.length > max ? `${s.slice(0, max)}…` : s;
  return t ? `${prefix} ${t}` : prefix;
}

const TRACK_Y = {
  ingest: 72,
  chat: 228,
  delete_file: 368,
  delete_corpus: 488,
};

export function flowResourceKey(engine, item) {
  if (engine === "rag") return item?.name;
  if (engine === "vs") return item?.datastore_id;
  return item?.corpus_name;
}

export function flowMatches(engine, flow, item) {
  if (!flow || flow.phase === "idle") return false;
  if (flow.engine !== engine || !item) return false;
  const key = flowResourceKey(engine, item);
  if (engine === "vs") return flow.datastoreId === key;
  return flow.corpusName === key;
}

export function getFlowBadge(flow) {
  if (!flow || flow.phase === "idle") return null;
  if (flow.message) return flow.message;
  const map = {
    start: "Starting…",
    uploading: `Uploading… ${flow.progress ?? 0}%`,
    indexing: "Indexing in Vertex…",
    syncing: "Feature Store sync…",
    importing: "Importing to datastore…",
    retrieving: "Retrieving context…",
    generating: "Generating answer…",
    saving: "Saving conversation…",
    deleting: flow.step ? `Deleting (${flow.step})…` : "Deleting…",
    processing: "Processing…",
    complete: "Done ✓",
    error: flow.error || "Failed",
  };
  return map[flow.phase] || "Live";
}

export function applyLiveToGraph(nodes, edges, engine, flow, docOptions = {}) {
  const activeEdges = new Set();
  if (!flow || flow.phase === "idle") {
    return { nodes, edges, activeEdges, track: null };
  }

  const act = lookup(engine, flow);
  if (!act) {
    return { nodes, edges, activeEdges, track: null };
  }

  const liveIds = new Set(act.nodes || []);
  const dimTrack = act.track;

  const highlightDoc = flow.highlightDoc || docOptions.highlightDoc;
  const removeDoc = flow.removeDoc;

  const updatedNodes = nodes.map(n => {
    const isLive = liveIds.has(n.id);
    const nodeTrack = n.position.y >= TRACK_Y.delete_corpus - 20
      ? "delete_corpus"
      : n.position.y >= TRACK_Y.delete_file - 20
        ? "delete_file"
        : n.position.y >= TRACK_Y.chat - 20
          ? "chat"
          : "ingest";

    const dim = dimTrack && nodeTrack !== dimTrack && flow.phase !== "complete";

    let sub = n.data.sub;
    if (isLive && act.subs?.[n.id]) {
      const fn = act.subs[n.id];
      sub = typeof fn === "function" ? fn(flow) : fn;
    }

    if (n.type === "doc" && highlightDoc) {
      const label = n.data.label || "";
      const match =
        label.includes(highlightDoc.slice(0, 18)) ||
        docOptions.highlightDisplayName === highlightDoc;
      if (match) {
        return { ...n, data: { ...n.data, sub, live: true, dim: false } };
      }
    }
    if (n.type === "doc" && removeDoc && n.data.label?.includes(removeDoc.slice(0, 12))) {
      return { ...n, data: { ...n.data, sub: "Removing…", live: true, dim: false } };
    }

    return {
      ...n,
      data: {
        ...n.data,
        sub: isLive ? sub : n.data.sub,
        live: isLive || n.data.live,
        dim,
      },
    };
  });

  (act.edges || []).forEach(eid => activeEdges.add(eid));

  return {
    nodes: updatedNodes,
    edges,
    activeEdges,
    track: act.track,
    message: act.message,
  };
}
