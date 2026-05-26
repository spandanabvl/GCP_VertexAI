import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { FLOW_EVENT } from "../notesFlowEvents";
import { mapRagFlowEvent } from "../ragFlowPhases";

const EDGE_MS = 700;

const ACTIONS = [
  { id: "upload", label: "Upload file" },
  { id: "chat", label: "Chat" },
  { id: "delete-file", label: "Delete file" },
  { id: "delete-corpus", label: "Delete corpus" },
];

const FLOWS = {
  upload: {
    dashed: false,
    nodes: [
      {
        badge: "Upload",
        badgeClass: "gray",
        title: "User uploads file",
        sub: "multipart → POST /documents/upload",
      },
      {
        badge: "Ingest",
        badgeClass: "teal",
        title: "Vertex RAG Corpus",
        sub: "rag.upload_file · ingest",
      },
      {
        badge: "Embed",
        badgeClass: "blue",
        title: "RAG Managed DB",
        sub: "KNN · embed / index",
      },
      {
        badge: "List",
        badgeClass: "amber",
        title: "Documents",
        sub: "GET /documents/ · list files",
      },
    ],
    edges: ["ingest", "embed / index", "list files"],
    steps: [
      "User is uploading the file to the API.",
      "Vertex RAG Corpus ingests the document.",
      "RAG Managed DB embeds and indexes vectors.",
      "Documents list is refreshed with the new file.",
    ],
  },
  chat: {
    dashed: false,
    nodes: [
      {
        badge: "Retrieve",
        badgeClass: "teal",
        title: "RAG corpus (retrieval)",
        sub: "Vertex corpus · chunk search",
      },
      {
        badge: "Query",
        badgeClass: "teal",
        title: "rag.retrieval_query",
        sub: "similarity_top_k",
      },
      {
        badge: "Generate",
        badgeClass: "blue",
        title: "Gemini 2.5 Flash",
        sub: "generate · grounded answer",
      },
      {
        badge: "Persist",
        badgeClass: "amber",
        title: "PostgreSQL",
        sub: "conversations · persist",
      },
    ],
    edges: ["retrieve", "generate", "persist"],
    steps: [
      "Retrieving relevant chunks from the RAG corpus.",
      "Running rag.retrieval_query with similarity_top_k.",
      "Gemini 2.5 Flash generates the grounded answer.",
      "Conversation is saved to PostgreSQL.",
    ],
  },
  "delete-file": {
    dashed: true,
    nodes: [
      {
        badge: "API",
        badgeClass: "gray",
        title: "Delete file",
        sub: "DELETE /documents/",
      },
      {
        badge: "Corpus",
        badgeClass: "teal",
        title: "Vertex RAG Corpus",
        sub: "rag.delete_file",
      },
      {
        badge: "Vectors",
        badgeClass: "blue",
        title: "RAG Managed DB",
        sub: "vectors removed",
      },
    ],
    edges: ["delete_file", "purge vectors"],
    steps: [
      "API receives delete file request.",
      "Vertex RAG Corpus removes the file via rag.delete_file.",
      "RAG Managed DB removes indexed vectors.",
    ],
  },
  "delete-corpus": {
    dashed: true,
    nodes: [
      {
        badge: "Files",
        badgeClass: "gray",
        title: "Delete corpus",
        sub: "all rag.delete_file",
      },
      {
        badge: "Corpus",
        badgeClass: "teal",
        title: "Vertex RAG Corpus",
        sub: "rag.delete_corpus",
      },
      {
        badge: "DB",
        badgeClass: "amber",
        title: "PostgreSQL",
        sub: "DELETE conversations",
      },
    ],
    edges: ["delete files", "delete corpus"],
    steps: [
      "Deleting all files from the corpus.",
      "Deleting the Vertex RAG Corpus resource.",
      "Clearing related conversations in PostgreSQL.",
    ],
  },
};

/** @type {import('react').MutableRefObject<{ triggerAction: (a: string) => void } | null>} */
export const ragFlowVisualizerRef = { current: null };

function nodeState(index, activeStep, done) {
  if (done) return "done";
  if (index < activeStep) return "done";
  if (index === activeStep) return "active";
  return "pending";
}

function pointOnEdge(path, t) {
  const { a, b } = path;
  const midY = Math.min(a.y, b.y) - 8;
  const u = 1 - t;
  const x = u * u * u * a.x + 3 * u * u * t * a.x + 3 * u * t * t * b.x + t * t * t * b.x;
  const y =
    u * u * u * a.y +
    3 * u * u * t * midY +
    3 * u * t * t * midY +
    t * t * t * b.y;
  return { x, y };
}

const RAGFlowVisualizer = forwardRef(function RAGFlowVisualizer(
  { className = "" },
  ref
) {
  const [selectedAction, setSelectedAction] = useState("upload");
  const [activeStep, setActiveStep] = useState(-1);
  const [done, setDone] = useState(false);
  const [stepMessage, setStepMessage] = useState(
    "Select an action or perform upload, chat, or delete in RAG Managed DB."
  );
  const [edgeProgress, setEdgeProgress] = useState(null);
  const [geom, setGeom] = useState({ paths: [], dot: null });
  const [liveAction, setLiveAction] = useState(null);

  const canvasRef = useRef(null);
  const nodeRefs = useRef([]);
  const prevStepRef = useRef(-1);
  const animRef = useRef(null);
  /** Bumped on reset / error / complete — cancels in-flight edge animations */
  const flowEpochRef = useRef(0);
  const pipelineQueueRef = useRef(Promise.resolve());

  const flow = FLOWS[selectedAction];
  const nodeCount = flow?.nodes.length ?? 0;
  const edgeCount = flow?.edges.length ?? 0;

  const cancelEdgeAnim = useCallback(() => {
    cancelAnimationFrame(animRef.current);
    animRef.current = null;
    setEdgeProgress(null);
  }, []);

  const applyBackendStepAsync = useCallback(
    ({ action, step, message, isDone, isError }) => {
      const flowDef = FLOWS[action];
      const count = flowDef?.nodes.length ?? 0;
      const edges = flowDef?.edges.length ?? 0;

      return new Promise(resolve => {
        if (action) {
          setSelectedAction(action);
          setLiveAction(action);
        }

        if (isError) {
          flowEpochRef.current += 1;
          cancelEdgeAnim();
          setActiveStep(-1);
          setDone(false);
          setStepMessage(message || "Pipeline failed");
          prevStepRef.current = -1;
          setLiveAction(null);
          resolve();
          return;
        }

        if (isDone) {
          flowEpochRef.current += 1;
          cancelEdgeAnim();
          setActiveStep(count);
          setDone(true);
          setStepMessage(message || "Pipeline complete ✓");
          prevStepRef.current = count;
          setLiveAction(null);
          resolve();
          return;
        }

        const clamped = Math.max(0, Math.min(step, count - 1));
        const prev = prevStepRef.current;

        if (prev >= 0 && clamped < prev) {
          resolve();
          return;
        }

        const animGeneration = flowEpochRef.current;

        const runEdgeAnim = (edgeIdx, onDone) => {
          const start = performance.now();
          cancelAnimationFrame(animRef.current);
          const tick = now => {
            if (animGeneration !== flowEpochRef.current) {
              setEdgeProgress(null);
              onDone();
              return;
            }
            const t = Math.min(1, (now - start) / EDGE_MS);
            setEdgeProgress({ edgeIndex: edgeIdx, t });
            if (t < 1) {
              animRef.current = requestAnimationFrame(tick);
            } else {
              setEdgeProgress(null);
              onDone();
            }
          };
          animRef.current = requestAnimationFrame(tick);
        };

        const commitStep = () => {
          setActiveStep(clamped);
          setDone(false);
          setStepMessage(message || flowDef?.steps[clamped] || "Processing…");
          prevStepRef.current = clamped;
          resolve();
        };

        if (prev >= 0 && clamped > prev) {
          const startEdge = Math.max(0, prev);
          const endEdge = clamped - 1;
          let edgeIdx = startEdge;

          const advanceEdge = () => {
            if (animGeneration !== flowEpochRef.current) {
              commitStep();
              return;
            }
            if (edgeIdx <= endEdge && edgeIdx < edges) {
              runEdgeAnim(edgeIdx, () => {
                edgeIdx += 1;
                if (edgeIdx <= endEdge) advanceEdge();
                else commitStep();
              });
            } else {
              commitStep();
            }
          };

          advanceEdge();
          return;
        }

        cancelEdgeAnim();
        setActiveStep(clamped);
        setDone(false);
        setStepMessage(message || flowDef?.steps[clamped] || "Processing…");
        prevStepRef.current = clamped;
        resolve();
      });
    },
    [cancelEdgeAnim]
  );

  const resetIdle = useCallback((actionId) => {
    flowEpochRef.current += 1;
    pipelineQueueRef.current = Promise.resolve();
    cancelEdgeAnim();
    setSelectedAction(actionId);
    setActiveStep(-1);
    setDone(false);
    setEdgeProgress(null);
    prevStepRef.current = -1;
    setLiveAction(null);
    setStepMessage("Waiting for a real action from RAG Managed DB…");
  }, []);

  const handleFlowEvent = useCallback(
    (e) => {
      const mapped = mapRagFlowEvent(e.detail);
      if (!mapped) return;
      const count = FLOWS[mapped.action]?.nodes.length ?? 0;

      pipelineQueueRef.current = pipelineQueueRef.current.then(() =>
        applyBackendStepAsync({
          action: mapped.action,
          step: mapped.done ? count : mapped.step,
          message: mapped.message,
          isDone: mapped.done,
          isError: mapped.error,
        })
      );
    },
    [applyBackendStepAsync]
  );

  useEffect(() => {
    window.addEventListener(FLOW_EVENT, handleFlowEvent);
    return () => window.removeEventListener(FLOW_EVENT, handleFlowEvent);
  }, [handleFlowEvent]);

  useImperativeHandle(ref, () => ({
    triggerAction(actionName) {
      const id =
        actionName === "delete_file"
          ? "delete-file"
          : actionName === "delete_corpus"
            ? "delete-corpus"
            : actionName;
      if (!FLOWS[id]) return;
      resetIdle(id);
      setStepMessage(
        "Preview only — perform the action in RAG Managed DB to animate."
      );
    },
  }));

  useEffect(() => {
    ragFlowVisualizerRef.current = {
      triggerAction: (a) => {
        const id =
          a === "delete_file" ? "delete-file" : a === "delete_corpus" ? "delete-corpus" : a;
        resetIdle(id);
      },
    };
    return () => {
      ragFlowVisualizerRef.current = null;
    };
  }, [resetIdle]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !flow) return;

    const measure = () => {
      const cRect = canvas.getBoundingClientRect();
      const centers = nodeRefs.current
        .filter(Boolean)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            x: r.left - cRect.left + r.width / 2,
            y: r.top - cRect.top + r.height / 2,
          };
        });

      if (centers.length < 2) {
        setGeom({ paths: [], dot: null });
        return;
      }

      const paths = [];
      for (let i = 0; i < centers.length - 1; i++) {
        const a = centers[i];
        const b = centers[i + 1];
        const midY = Math.min(a.y, b.y) - 8;
        const d = `M ${a.x} ${a.y} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y}`;
        paths.push({ d, a, b, label: flow.edges[i] });
      }
      setGeom({ paths, dot: null });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [selectedAction, flow]);

  const travelDot =
    edgeProgress != null && geom.paths[edgeProgress.edgeIndex]
      ? pointOnEdge(geom.paths[edgeProgress.edgeIndex], edgeProgress.t)
      : null;

  const progressPct =
    done && nodeCount > 0
      ? 100
      : activeStep < 0
        ? 0
        : Math.round(((activeStep + (edgeProgress ? edgeProgress.t * 0.5 : 0)) / nodeCount) * 100);

  return (
    <section className={`rag-flow-viz ${className}`.trim()} aria-label="RAG pipeline flow">
      <div className="rag-flow-action-bar">
        {ACTIONS.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`rag-flow-pill ${selectedAction === a.id ? "rag-flow-pill--active" : ""}`}
            onClick={() => resetIdle(a.id)}
          >
            {a.label}
          </button>
        ))}
        {liveAction && (
          <span className="rag-flow-live-tag">Live · {liveAction}</span>
        )}
      </div>

      <div className="rag-flow-canvas" ref={canvasRef}>
        <svg className="rag-flow-svg" aria-hidden>
          {geom.paths.map((p, i) => (
            <g key={`edge-${i}`}>
              <path
                d={p.d}
                className={`rag-flow-edge-path ${flow.dashed ? "rag-flow-edge-path--dashed" : ""} ${
                  edgeProgress?.edgeIndex === i ? "rag-flow-edge-path--live" : ""
                }`}
                fill="none"
              />
              {p.label && (
                <text
                  x={(p.a.x + p.b.x) / 2}
                  y={Math.min(p.a.y, p.b.y) - 14}
                  className="rag-flow-edge-label"
                  textAnchor="middle"
                >
                  {p.label}
                </text>
              )}
            </g>
          ))}
          {travelDot && (
            <circle
              cx={travelDot.x}
              cy={travelDot.y}
              r={5}
              className="rag-flow-travel-dot"
            />
          )}
        </svg>

        <div className="rag-flow-nodes">
          {flow.nodes.map((n, i) => {
            const state = nodeState(i, activeStep, done);
            return (
              <div
                key={`${selectedAction}-${i}`}
                ref={(el) => {
                  nodeRefs.current[i] = el;
                }}
                className={`rag-flow-node rag-flow-node--${state} rag-flow-node--enter`}
              >
                <span className={`rag-flow-badge rag-flow-badge--${n.badgeClass}`}>
                  {n.badge}
                </span>
                <div className="rag-flow-node-title">{n.title}</div>
                <div className="rag-flow-node-sub">{n.sub}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rag-flow-progress-track">
        <div className="rag-flow-progress-fill" style={{ width: `${progressPct}%` }} />
      </div>

      <p className="rag-flow-step-info">{stepMessage}</p>

      <div className="rag-flow-legend">
        <span className="rag-flow-legend-item">
          <span className="rag-flow-legend-dot rag-flow-legend-dot--current" />
          Current step
        </span>
        <span className="rag-flow-legend-item">
          <span className="rag-flow-legend-dot rag-flow-legend-dot--done" />
          Completed
        </span>
        <span className="rag-flow-legend-item">
          <span className="rag-flow-legend-dot rag-flow-legend-dot--pending" />
          Pending
        </span>
      </div>
    </section>
  );
});

export default RAGFlowVisualizer;
