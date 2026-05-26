import { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import ReactFlow, {
  Background,
  Controls,
  MarkerType,
  Position,
  Handle,
} from "reactflow";
import "reactflow/dist/style.css";
import { API } from "./NotesSidebar";
import { FLOW_EVENT, isActivePhase } from "../notesFlowEvents";
import {
  applyLiveToGraph,
  flowMatches,
  getFlowBadge,
} from "../notesGraphLive";

const NODE_W = 168;
const GAP_X = 64;
const Y_INGEST = 72;
const Y_CHAT = 228;
const Y_DEL_FILE = 368;
const Y_DEL_CORPUS = 488;
const Y_DOC_START = 168;

function trunc(str, max = 30) {
  if (!str) return "—";
  const s = String(str);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function FlowNode({ data }) {
  const targetPos = data.targetPos ?? Position.Left;
  const sourcePos = data.sourcePos ?? Position.Right;
  return (
    <div
      className={`flow-node flow-node--${data.kind}${data.live ? " flow-node--live" : ""}${data.dim ? " flow-node--dim" : ""}`}
    >
      <Handle type="target" position={targetPos} className="flow-handle" />
      <div className="flow-node-label">{data.label}</div>
      {data.sub && <div className="flow-node-sub">{data.sub}</div>}
      <Handle type="source" position={sourcePos} className="flow-handle" />
    </div>
  );
}

function DocNode({ data }) {
  return (
    <div className={`flow-node flow-node--doc${data.live ? " flow-node--live-new" : ""}`}>
      <Handle type="target" position={Position.Top} className="flow-handle" />
      <div className="flow-node-label">{data.label}</div>
    </div>
  );
}

const nodeTypes = { flow: FlowNode, doc: DocNode };

function makeNode(id, kind, label, sub, x, y, type = "flow", extra = {}) {
  return {
    id,
    type,
    position: { x, y },
    data: { kind, label, sub, ...extra },
    sourcePosition: extra.sourcePos ?? Position.Right,
    targetPosition: extra.targetPos ?? (type === "doc" ? Position.Top : Position.Left),
  };
}

function edgeTrack(nodes, edge) {
  const src = nodes.find(n => n.id === edge.source);
  if (!src) return "ingest";
  const y = src.position.y;
  if (y >= Y_DEL_CORPUS - 24) return "delete_corpus";
  if (y >= Y_DEL_FILE - 24) return "delete_file";
  if (y >= Y_CHAT - 24) return "chat";
  return "ingest";
}

function edge(id, source, target, label, dashed = false) {
  return {
    id,
    source,
    target,
    label: label ?? undefined,
    animated: false,
    style: dashed ? { stroke: "#4a4a4a", strokeDasharray: "6 4" } : { stroke: "#5a5a5a" },
    labelStyle: { fill: "#f0ede8", fontSize: 10, fontFamily: "'DM Mono', monospace" },
    labelBgStyle: { fill: "#0f0f0f", fillOpacity: 0.92 },
    labelBgPadding: [4, 6],
    labelBgBorderRadius: 4,
    markerEnd: { type: MarkerType.ArrowClosed, color: dashed ? "#4a4a4a" : "#6e6a64" },
    data: { dashed },
  };
}

function branchEdge(id, source, target) {
  return {
    id,
    source,
    target,
    animated: false,
    style: { stroke: "#3a3a3a" },
    markerEnd: { type: MarkerType.ArrowClosed, color: "#4a4a4a" },
    data: { dashed: false },
  };
}

function attachDocuments(nodes, edges, hubId, documents, hubX, highlightDoc) {
  const docX = hubX + NODE_W + 36;
  documents.forEach((f, i) => {
    const id = `doc-${i}`;
    const display = f.display_name || f.original_filename || f.name;
    const label = trunc(display, 22);
    const isNew = highlightDoc && (display === highlightDoc || f.display_name === highlightDoc);
    nodes.push(
      makeNode(id, "doc", label, "", docX, Y_DOC_START + i * 42, "doc", { live: isNew })
    );
    edges.push(branchEdge(`e-doc-${i}`, hubId, id));
  });
}

function buildRagGraph(corpus, documents, highlightDoc) {
  const nodes = [];
  const edges = [];
  let x = 20;

  const add = (id, kind, label, sub, eLabel) => {
    const prev = lastIngest;
    nodes.push(makeNode(id, kind, label, sub, x, Y_INGEST));
    if (prev) edges.push(edge(`i-${prev}-${id}`, prev, id, eLabel));
    lastIngest = id;
    x += NODE_W + GAP_X;
    return id;
  };

  let lastIngest = null;
  add("ing-upload", "user", "User uploads file", "", null);
  const c = add("ing-corpus", "vertex", "Vertex RAG Corpus", trunc(corpus.display_name), "ingest");
  add("ing-managed", "infra", "RAG Managed DB", "KNN · RagManagedDb", "embed / index");
  const d = add("ing-docs", "vertex", "Documents", `${documents.length} file(s)`, "list files");
  attachDocuments(nodes, edges, d, documents, x - NODE_W - GAP_X, highlightDoc);

  // Chat track (Postgres only on chat, not ingest)
  let cx = 20;
  const chatAdd = (id, kind, label, sub, eLabel) => {
    const prev = lastChat;
    nodes.push(makeNode(id, kind, label, sub, cx, Y_CHAT));
    if (prev) edges.push(edge(`c-${prev}-${id}`, prev, id, eLabel));
    lastChat = id;
    cx += NODE_W + GAP_X;
    return id;
  };
  let lastChat = null;
  nodes.push(makeNode("chat-corpus", "vertex", "RAG corpus (retrieval)", trunc(corpus.display_name), 20, Y_CHAT));
  lastChat = "chat-corpus";
  cx = 20 + NODE_W + GAP_X;
  chatAdd("chat-retrieval", "infra", "rag.retrieval_query", "similarity_top_k", "retrieve");
  chatAdd("chat-gemini", "vertex", "Gemini 2.5 Flash", "", "generate");
  chatAdd("chat-pg", "storage", "PostgreSQL", "conversations", "persist");

  edges.push({
    ...edge("link-ing-chat", c, "chat-corpus", "on chat", false),
    style: { stroke: "#3a3a3a", strokeDasharray: "4 3" },
  });

  // File delete — no Postgres
  let dx = 20;
  const del = (id, kind, label, sub) => {
    const prev = lastDel;
    nodes.push(makeNode(id, kind, label, sub, dx, Y_DEL_FILE));
    if (prev) edges.push(edge(`df-${prev}-${id}`, prev, id, null, true));
    lastDel = id;
    dx += NODE_W + GAP_X;
    return id;
  };
  let lastDel = null;
  del("df-file", "user", "Delete file", "DELETE /documents/", null);
  del("df-corpus", "vertex", "Vertex RAG Corpus", "rag.delete_file", null);
  del("df-managed", "infra", "RAG Managed DB", "vectors removed", null);

  // Corpus delete
  dx = 20;
  lastDel = null;
  const cdel = (id, kind, label, sub) => {
    const prev = lastDel;
    nodes.push(makeNode(id, kind, label, sub, dx, Y_DEL_CORPUS));
    if (prev) edges.push(edge(`dc-${prev}-${id}`, prev, id, null, true));
    lastDel = id;
    dx += NODE_W + GAP_X;
    return id;
  };
  cdel("dc-files", "user", "Delete corpus", "all rag.delete_file", null);
  cdel("dc-corpus", "vertex", "Vertex RAG Corpus", "rag.delete_corpus", null);
  cdel("dc-pg", "storage", "PostgreSQL", "DELETE conversations", null);

  return { nodes, edges };
}

function buildVsrGraph(corpus, documents) {
  const nodes = [];
  const edges = [];
  let x = 20;
  let lastIngest = null;

  const add = (id, kind, label, sub, eLabel) => {
    const prev = lastIngest;
    nodes.push(makeNode(id, kind, label, sub, x, Y_INGEST));
    if (prev) edges.push(edge(`i-${prev}-${id}`, prev, id, eLabel));
    lastIngest = id;
    x += NODE_W + GAP_X;
    return id;
  };

  add("ing-upload", "user", "User uploads file", "", null);
  const c = add("ing-corpus", "vertex", "Vertex RAG Corpus", trunc(corpus.display_name), "rag.upload_file");
  const idx = add("ing-index", "infra", "Vector Index", trunc(corpus.index_resource_name, 26), "STREAM_UPDATE");
  add("ing-endpoint", "infra", "Index Endpoint", trunc(corpus.endpoint_resource_name, 26), false);
  edges.push(edge("i-idx-ep", idx, "ing-endpoint", "deployed", false));
  const d = add("ing-docs", "vertex", "Documents", `${documents.length} file(s)`, "list");
  attachDocuments(nodes, edges, d, documents, x - NODE_W - GAP_X);

  // Provision metadata (Postgres, not in upload path)
  nodes.push(
    makeNode(
      "meta-pg",
      "storage",
      "PostgreSQL",
      "vsr_corpora metadata",
      x,
      Y_INGEST + 88,
      "flow",
      { targetPos: Position.Top, sourcePos: Position.Bottom }
    )
  );
  edges.push({
    ...edge("meta-idx-pg", idx, "meta-pg", "at corpus create", false),
    style: { stroke: "#3a3a3a", strokeDasharray: "4 3" },
  });

  let cx = 20;
  let lastChat = null;
  const chatAdd = (id, kind, label, sub, eLabel) => {
    const prev = lastChat;
    nodes.push(makeNode(id, kind, label, sub, cx, Y_CHAT));
    if (prev) edges.push(edge(`c-${prev}-${id}`, prev, id, eLabel));
    lastChat = id;
    cx += NODE_W + GAP_X;
    return id;
  };
  chatAdd("chat-corpus", "vertex", "VertexRagStore", trunc(corpus.display_name), null);
  chatAdd("chat-genai", "vertex", "Gemini 2.5 Flash", "similarity_top_k · threshold", "generate");
  chatAdd("chat-pg", "storage", "PostgreSQL", "vsr_conversations", "persist");
  edges.push({
    ...edge("link-ing-chat", c, "chat-corpus", "on chat", false),
    style: { stroke: "#3a3a3a", strokeDasharray: "4 3" },
  });

  let dx = 20;
  let lastDel = null;
  const del = (id, kind, label, sub) => {
    const prev = lastDel;
    nodes.push(makeNode(id, kind, label, sub, dx, Y_DEL_FILE));
    if (prev) edges.push(edge(`df-${prev}-${id}`, prev, id, null, true));
    lastDel = id;
    dx += NODE_W + GAP_X;
    return id;
  };
  del("df-file", "user", "Delete file", "DELETE /vsr-documents/", null);
  del("df-corpus", "vertex", "Vertex RAG Corpus", "rag.delete_file", null);
  del("df-index", "infra", "Vector Index", "STREAM_UPDATE", null);

  dx = 20;
  lastDel = null;
  const cdel = (id, kind, label, sub) => {
    const prev = lastDel;
    nodes.push(makeNode(id, kind, label, sub, dx, Y_DEL_CORPUS));
    if (prev) edges.push(edge(`dc-${prev}-${id}`, prev, id, null, true));
    lastDel = id;
    dx += NODE_W + GAP_X;
    return id;
  };
  cdel("dc-files", "user", "Delete corpus", "all files + corpus", null);
  cdel("dc-index", "infra", "Vector Index", "teardown index", null);
  cdel("dc-endpoint", "infra", "Index Endpoint", "undeploy + delete", null);
  cdel("dc-pg", "storage", "PostgreSQL", "vsr_corpora · vsr_conversations", null);

  return { nodes, edges };
}

function buildFsGraph(corpus, documents) {
  const nodes = [];
  const edges = [];
  let x = 20;
  let lastIngest = null;
  const bqLabel = `${corpus.bq_dataset_id}.${corpus.bq_table_id}`;

  const add = (id, kind, label, sub, eLabel) => {
    const prev = lastIngest;
    nodes.push(makeNode(id, kind, label, sub, x, Y_INGEST));
    if (prev) edges.push(edge(`i-${prev}-${id}`, prev, id, eLabel));
    lastIngest = id;
    x += NODE_W + GAP_X;
    return id;
  };

  add("ing-upload", "user", "User uploads file", "", null);
  const c = add("ing-corpus", "vertex", "Vertex RAG Corpus", trunc(corpus.display_name), "rag.upload_file");
  add("ing-bq", "infra", "BigQuery Table", trunc(bqLabel, 26), "embeddings → BQ");
  add("ing-sync", "infra", "Feature View sync", trunc(corpus.feature_view_id, 22), "auto-sync");
  add("ing-fos", "infra", "Feature Online Store", trunc(corpus.feature_online_store_id, 22), "online index");
  const d = add("ing-docs", "vertex", "Documents", `${documents.length} file(s)`, "list");
  attachDocuments(nodes, edges, d, documents, x - NODE_W - GAP_X);

  nodes.push(
    makeNode("meta-pg", "storage", "fs_corpora", "metadata row", x - 80, Y_INGEST + 88, "flow", {
      targetPos: Position.Top,
    })
  );
  edges.push({
    ...edge("meta-c-pg", c, "meta-pg", "at create", false),
    style: { stroke: "#3a3a3a", strokeDasharray: "4 3" },
  });

  let cx = 20;
  let lastChat = null;
  const chatAdd = (id, kind, label, sub, eLabel) => {
    const prev = lastChat;
    nodes.push(makeNode(id, kind, label, sub, cx, Y_CHAT));
    if (prev) edges.push(edge(`c-${prev}-${id}`, prev, id, eLabel));
    lastChat = id;
    cx += NODE_W + GAP_X;
    return id;
  };
  chatAdd("chat-corpus", "vertex", "Hybrid RAG retrieval", trunc(corpus.display_name), null);
  chatAdd("chat-gemini", "vertex", "Gemini 2.5 Flash", "top_k · alpha", "generate");
  chatAdd("chat-pg", "storage", "PostgreSQL", "fs_conversations", "persist");
  edges.push({
    ...edge("link-ing-chat", c, "chat-corpus", "on chat", false),
    style: { stroke: "#3a3a3a", strokeDasharray: "4 3" },
  });

  let dx = 20;
  let lastDel = null;
  const del = (id, kind, label, sub) => {
    const prev = lastDel;
    nodes.push(makeNode(id, kind, label, sub, dx, Y_DEL_FILE));
    if (prev) edges.push(edge(`df-${prev}-${id}`, prev, id, null, true));
    lastDel = id;
    dx += NODE_W + 52;
    return id;
  };
  del("df-file", "user", "Delete file", "DELETE /fs-documents/", null);
  del("df-corpus", "vertex", "Vertex RAG Corpus", "rag.delete_file", null);
  del("df-bq", "infra", "BigQuery", "DELETE rows by corpus_id", null);
  del("df-sync", "infra", "Feature View", "fv.sync()", null);

  dx = 20;
  lastDel = null;
  const cdel = (id, kind, label, sub) => {
    const prev = lastDel;
    nodes.push(makeNode(id, kind, label, sub, dx, Y_DEL_CORPUS));
    if (prev) edges.push(edge(`dc-${prev}-${id}`, prev, id, null, true));
    lastDel = id;
    dx += NODE_W + 48;
    return id;
  };
  cdel("dc-files", "user", "Delete corpus", "all files + corpus", null);
  cdel("dc-bq", "infra", "BigQuery", "rows or table/dataset", null);
  cdel("dc-fv", "infra", "Feature View / FOS", "teardown if unshared", null);
  cdel("dc-pg", "storage", "PostgreSQL", "fs_corpora · fs_conversations", null);

  return { nodes, edges };
}

function buildVsGraph(datastore, documents) {
  const nodes = [];
  const edges = [];
  let x = 20;
  let lastIngest = null;

  const bucket = datastore.gcs_bucket?.startsWith("gs://")
    ? datastore.gcs_bucket
    : `gs://${datastore.gcs_bucket}`;

  const add = (id, kind, label, sub, eLabel) => {
    const prev = lastIngest;
    nodes.push(makeNode(id, kind, label, sub, x, Y_INGEST));
    if (prev) edges.push(edge(`i-${prev}-${id}`, prev, id, eLabel));
    lastIngest = id;
    x += NODE_W + GAP_X;
    return id;
  };

  add("ing-upload", "user", "User uploads file", "", null);
  const gcs = add("ing-gcs", "storage", "GCS Bucket", trunc(bucket, 28), "blob upload");
  const reg = add("ing-registry", "storage", "vs_document_files", "original_filename map", "record");
  add("ing-import", "vertex", "Import operation", "async LRO · 1–3 min", "async import");
  const ds = add("ing-datastore", "vertex", "Discovery Datastore", trunc(datastore.datastore_id), "indexed");
  const d = add("ing-docs", "vertex", "Documents", `${documents.length} file(s)`, "list");
  attachDocuments(nodes, edges, d, documents, x - NODE_W - GAP_X);

  nodes.push(makeNode("meta-pg", "storage", "vs_datastores", trunc(datastore.display_name, 22), x - 60, Y_INGEST + 88, "flow", { targetPos: Position.Top }));
  edges.push({
    ...edge("meta-gcs-pg", gcs, "meta-pg", "at create", false),
    style: { stroke: "#3a3a3a", strokeDasharray: "4 3" },
  });

  let cx = 20;
  let lastChat = null;
  const chatAdd = (id, kind, label, sub, eLabel) => {
    const prev = lastChat;
    nodes.push(makeNode(id, kind, label, sub, cx, Y_CHAT));
    if (prev) edges.push(edge(`c-${prev}-${id}`, prev, id, eLabel));
    lastChat = id;
    cx += NODE_W + GAP_X;
    return id;
  };
  const eng = chatAdd("chat-engine", "vertex", "Search Engine", trunc(datastore.datastore_id), null);
  chatAdd("chat-search", "infra", "SearchServiceClient", "page_size · serving config", "search");
  chatAdd("chat-pg", "storage", "PostgreSQL", "vs_conversations", "persist");
  edges.push({
    ...edge("link-ing-chat", ds, eng, "on chat", false),
    style: { stroke: "#3a3a3a", strokeDasharray: "4 3" },
  });

  let dx = 20;
  let lastDel = null;
  const del = (id, kind, label, sub) => {
    const prev = lastDel;
    nodes.push(makeNode(id, kind, label, sub, dx, Y_DEL_FILE));
    if (prev) edges.push(edge(`df-${prev}-${id}`, prev, id, null, true));
    lastDel = id;
    dx += NODE_W + GAP_X;
    return id;
  };
  del("df-file", "user", "Delete file", "DELETE /vs-documents/", null);
  del("df-de", "vertex", "Discovery document", "delete_document", null);
  del("df-reg", "storage", "vs_document_files", "row removed", null);
  nodes.push(makeNode("df-gcs-note", "storage", "GCS blob", "not deleted", dx, Y_DEL_FILE));
  edges.push(edge("df-reg-gcs", lastDel, "df-gcs-note", null, true));

  dx = 20;
  lastDel = null;
  const cdel = (id, kind, label, sub) => {
    const prev = lastDel;
    nodes.push(makeNode(id, kind, label, sub, dx, Y_DEL_CORPUS));
    if (prev) edges.push(edge(`dc-${prev}-${id}`, prev, id, null, true));
    lastDel = id;
    dx += NODE_W + GAP_X;
    return id;
  };
  cdel("dc-engine", "vertex", "Search Engine", "delete_engine", null);
  cdel("dc-ds", "vertex", "Discovery Datastore", "delete_data_store", null);
  cdel("dc-pg", "storage", "PostgreSQL", "vs_* tables", null);
  nodes.push(makeNode("dc-gcs-note", "storage", "GCS bucket", "not deleted", dx, Y_DEL_CORPUS));
  edges.push(edge("dc-pg-gcs", lastDel, "dc-gcs-note", null, true));

  return { nodes, edges };
}

/** Stub resource used when no corpus/datastore exists — still renders the full architecture graph. */
const TEMPLATE_ITEM = {
  rag: { name: "", display_name: "—" },
  vsr: {
    corpus_name: "",
    display_name: "—",
    index_resource_name: "—",
    endpoint_resource_name: "—",
  },
  fs: {
    corpus_name: "",
    display_name: "—",
    bq_dataset_id: "—",
    bq_table_id: "—",
    feature_view_id: "—",
    feature_online_store_id: "—",
  },
  vs: { datastore_id: "—", display_name: "—", gcs_bucket: "—" },
};

const LIST_ENDPOINTS = {
  rag: "/corpora/",
  vsr: "/vsr-corpora/",
  fs: "/fs-corpora/",
  vs: "/vs-datastores/",
};

const DOC_ENDPOINTS = {
  rag: (item) => ({ url: "/documents/", params: { corpus_name: item.name } }),
  vsr: (item) => ({ url: "/vsr-documents/", params: { corpus_name: item.corpus_name } }),
  fs: (item) => ({ url: "/fs-documents/", params: { corpus_name: item.corpus_name } }),
  vs: (item) => ({ url: "/vs-documents/", params: { datastore_id: item.datastore_id } }),
};

function itemKey(engine, item) {
  if (engine === "rag") return item.name;
  if (engine === "vs") return item.datastore_id;
  return item.corpus_name;
}

function itemLabel(engine, item) {
  if (engine === "rag") return item.display_name;
  if (engine === "vs") return item.display_name || item.datastore_id;
  return item.display_name;
}

const IDLE_FLOW = { phase: "idle" };

export default function NotesGraph({ engine, refreshKey }) {
  const [items, setItems] = useState([]);
  const [selectedKey, setSelectedKey] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [error, setError] = useState(null);
  const [liveFlow, setLiveFlow] = useState(IDLE_FLOW);

  const selectedItem = useMemo(
    () => items.find(i => itemKey(engine, i) === selectedKey) ?? null,
    [items, selectedKey, engine]
  );

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await axios.get(`${API}${LIST_ENDPOINTS[engine]}`);
      const list = res.data || [];
      setItems(list);
      setSelectedKey(prev => {
        if (prev && list.some(i => itemKey(engine, i) === prev)) return prev;
        return list.length ? itemKey(engine, list[0]) : null;
      });
    } catch {
      setItems([]);
      setSelectedKey(null);
      setError("Failed to load resources");
    } finally {
      setLoading(false);
    }
  }, [engine]);

  const fetchDocuments = useCallback(async (item, quiet = false) => {
    if (!item) {
      setDocuments([]);
      return;
    }
    if (!quiet) setLoadingDocs(true);
    try {
      const { url, params } = DOC_ENDPOINTS[engine](item);
      const res = await axios.get(`${API}${url}`, { params });
      setDocuments(res.data || []);
    } catch {
      setDocuments([]);
    } finally {
      if (!quiet) setLoadingDocs(false);
    }
  }, [engine]);

  useEffect(() => {
    fetchItems();
  }, [engine, refreshKey, fetchItems]);

  useEffect(() => {
    fetchDocuments(selectedItem);
  }, [selectedItem, refreshKey, fetchDocuments]);

  const pollPhases = ["ingest", "indexed", "indexing", "syncing", "importing"];
  useEffect(() => {
    if (!selectedItem || !pollPhases.includes(liveFlow.phase)) return undefined;
    if (!flowMatches(engine, liveFlow, selectedItem)) return undefined;
    const interval = setInterval(() => fetchDocuments(selectedItem, true), 1500);
    return () => clearInterval(interval);
  }, [engine, liveFlow.phase, liveFlow.engine, selectedItem, fetchDocuments]);

  useEffect(() => {
    if (liveFlow.phase !== "complete" && liveFlow.phase !== "error") return undefined;
    const ms = liveFlow.phase === "error" ? 6000 : 3500;
    const t = setTimeout(() => setLiveFlow(IDLE_FLOW), ms);
    return () => clearTimeout(t);
  }, [liveFlow.phase]);

  useEffect(() => {
    const onFlow = (e) => {
      const d = e.detail;
      if (!d?.engine) return;

      const key =
        d.engine === "vs" ? d.datastoreId : d.corpusName;
      if (key && d.engine === engine) {
        setSelectedKey(key);
      }

      setLiveFlow(d);

      if (d.phase === "complete" || d.phase === "error") {
        if (d.action === "delete_corpus" || d.action === "delete_datastore") {
          fetchItems();
          setDocuments([]);
          return;
        }
        const item =
          d.engine === "vs"
            ? items.find(i => i.datastore_id === d.datastoreId)
            : d.engine === "rag"
              ? items.find(i => i.name === d.corpusName)
              : items.find(i => i.corpus_name === d.corpusName);
        if (item) fetchDocuments(item, true);
      }

      if (
        isActivePhase(d.phase) &&
        (d.phase === "ingest" ||
          d.phase === "indexed" ||
          d.phase === "indexing" ||
          d.phase === "syncing" ||
          d.phase === "importing")
      ) {
        const item =
          d.engine === "vs"
            ? items.find(i => i.datastore_id === d.datastoreId)
            : d.engine === "rag"
              ? items.find(i => i.name === d.corpusName)
              : items.find(i => i.corpus_name === d.corpusName);
        if (item) fetchDocuments(item, true);
      }
    };

    window.addEventListener(FLOW_EVENT, onFlow);
    return () => window.removeEventListener(FLOW_EVENT, onFlow);
  }, [engine, items, fetchDocuments, fetchItems]);

  const flowActive = flowMatches(engine, liveFlow, selectedItem);
  const highlightDoc =
    liveFlow?.highlightDoc ||
    liveFlow?.file?.display_name ||
    (liveFlow?.phase === "complete" ? liveFlow?.filename : null);

  const graphItem = selectedItem ?? TEMPLATE_ITEM[engine];

  const graphResult = useMemo(() => {
    if (!graphItem) {
      return { nodes: [], edges: [], activeEdges: new Set(), track: null };
    }

    const docs = selectedItem ? documents : [];

    let base;
    if (engine === "rag") base = buildRagGraph(graphItem, docs, highlightDoc);
    else if (engine === "vsr") base = buildVsrGraph(graphItem, docs);
    else if (engine === "fs") base = buildFsGraph(graphItem, docs);
    else if (engine === "vs") base = buildVsGraph(graphItem, docs);
    else return { nodes: [], edges: [], activeEdges: new Set(), track: null };

    if (!flowActive) {
      return { ...base, activeEdges: new Set(), track: null };
    }

    return applyLiveToGraph(base.nodes, base.edges, engine, liveFlow, {
      highlightDoc,
      highlightDisplayName: highlightDoc,
    });
  }, [engine, graphItem, selectedItem, documents, liveFlow, flowActive, highlightDoc]);

  const nodes = graphResult.nodes;
  const edges = useMemo(() => {
    const activeIds = graphResult.activeEdges;
    const live = flowActive && activeIds.size > 0;

    return graphResult.edges.map(ed => {
      const track = edgeTrack(nodes, ed);
      const isDashed = !!ed.style?.strokeDasharray || ed.data?.dashed;
      const isActive = live && activeIds.has(ed.id);

      const classes = [
        "notes-edge",
        `notes-edge--${track}`,
        isDashed ? "notes-edge--dashed" : "notes-edge--solid",
        isActive ? "notes-edge--active" : "",
        live && !isActive ? "notes-edge--idle" : "",
      ]
        .filter(Boolean)
        .join(" ");

      return {
        ...ed,
        animated: false,
        className: classes,
        style: {
          ...ed.style,
          stroke: isActive ? "#e8e0d4" : isDashed ? "#4a4a4a" : "#5a5a5a",
          strokeWidth: isActive ? 2 : 1,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isActive ? "#e8e0d4" : isDashed ? "#4a4a4a" : "#6e6a64",
        },
      };
    });
  }, [graphResult.edges, graphResult.activeEdges, graphResult.nodes, nodes, flowActive]);

  const onInit = useCallback((instance) => {
    setTimeout(() => instance.fitView({ padding: 0.15, maxZoom: 0.95 }), 80);
  }, []);

  const selectLabel = engine === "vs" ? "Datastore" : "Corpus";

  if (loading && items.length === 0) {
    return (
      <div className="notes-graph-wrap">
        <div className="loading-row" style={{ padding: 48 }}>
          <span className="spinner" /> Loading architecture…
        </div>
      </div>
    );
  }

  const isTemplate = !selectedItem;

  return (
    <div className="notes-graph-wrap">
      <div className="notes-graph-header">
        <span className="notes-graph-title">Live architecture flow</span>
        {isTemplate && (
          <span className="notes-graph-template-hint muted">
            {engine === "vs" ? "No datastore yet — template view" : "No corpus yet — template view"}
          </span>
        )}
        {items.length > 1 && (
          <label className="notes-corpus-select-wrap">
            <span className="notes-corpus-select-label">{selectLabel}</span>
            <select
              className="notes-corpus-select dark-input"
              value={selectedKey || ""}
              onChange={e => setSelectedKey(e.target.value)}
            >
              {items.map(item => (
                <option key={itemKey(engine, item)} value={itemKey(engine, item)}>
                  {itemLabel(engine, item)}
                </option>
              ))}
            </select>
          </label>
        )}
        {items.length === 1 && selectedItem && (
          <span className="notes-graph-single-corpus muted">{itemLabel(engine, selectedItem)}</span>
        )}
        {loadingDocs && <span className="muted" style={{ fontSize: 11 }}>Refreshing documents…</span>}
        {flowActive && getFlowBadge(liveFlow) && (
          <span
            className={`notes-live-badge notes-live-badge--${
              liveFlow.phase === "error"
                ? "error"
                : liveFlow.phase === "complete"
                  ? "done"
                  : liveFlow.phase === "uploading"
                    ? "upload"
                    : "index"
            }`}
          >
            Live · {getFlowBadge(liveFlow)}
          </span>
        )}
      </div>

      {error && <div className="notes-graph-error">⚠ {error}</div>}

      <div
        className={[
          "notes-flow-container",
          flowActive && graphResult.track ? "notes-flow-live" : "",
          flowActive && graphResult.track ? `notes-flow-live--${graphResult.track}` : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={onInit}
          fitView
          minZoom={0.25}
          maxZoom={1.1}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnScroll
        >
          <Background color="#2a2a2a" gap={20} />
          <Controls showInteractive={false} className="notes-flow-controls" />
        </ReactFlow>
        <div className="notes-delete-legend">
          <span className="notes-delete-legend-label">Tracks</span>
          <span className="muted">solid — ingest · gray dash — chat · lower dash — delete file · bottom dash — delete corpus/datastore</span>
        </div>
      </div>
    </div>
  );
}
