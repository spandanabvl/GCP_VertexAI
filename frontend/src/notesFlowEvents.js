/** Global live-flow events: sidebars/chat → Notes graph + auto-open Notes tab */

export const FLOW_EVENT = "rag-studio:flow";

/** @typedef {"rag"|"vsr"|"fs"|"vs"} FlowEngine */
/** @typedef {"upload"|"delete_file"|"delete_corpus"|"delete_datastore"|"chat"} FlowAction */

/**
 * @param {{
 *   engine: FlowEngine,
 *   action: FlowAction,
 *   phase: "start"|"uploading"|"processing"|"indexing"|"syncing"|"importing"|"retrieving"|"generating"|"saving"|"deleting"|"complete"|"error"|"idle",
 *   corpusName?: string,
 *   datastoreId?: string,
 *   filename?: string,
 *   progress?: number,
 *   step?: string,
 *   message?: string,
 *   file?: { name?: string, display_name?: string },
 *   error?: string,
 *   highlightDoc?: string,
 *   removeDoc?: string,
 * }} detail
 */
export function dispatchFlow(detail) {
  window.dispatchEvent(
    new CustomEvent(FLOW_EVENT, { detail: { ...detail, ts: Date.now() } })
  );
}

export function corpusRef(engine, corpus) {
  if (engine === "rag") return { corpusName: corpus.name };
  if (engine === "vs") return { datastoreId: corpus.datastore_id };
  return { corpusName: corpus.corpus_name };
}

const ACTIVE_PHASES = new Set([
  "start",
  "uploading",
  "ingest",
  "indexed",
  "processing",
  "indexing",
  "syncing",
  "importing",
  "retrieving",
  "retrieved",
  "generating",
  "saving",
  "deleting",
]);

export function isActivePhase(phase) {
  return ACTIVE_PHASES.has(phase);
}

/** Stagger visual sub-steps while a single API call runs */
export async function runFlowAnimation(engine, action, resource, steps, apiFn) {
  const base = { engine, action, ...resource };
  dispatchFlow({ ...base, phase: "start" });

  const timers = steps.map((s, i) =>
    setTimeout(() => {
      dispatchFlow({
        ...base,
        phase: "deleting",
        step: s.step,
        message: s.message,
      });
    }, i * 480)
  );

  try {
    const result = await apiFn();
    timers.forEach(clearTimeout);
    dispatchFlow({ ...base, phase: "complete" });
    return result;
  } catch (err) {
    timers.forEach(clearTimeout);
    dispatchFlow({
      ...base,
      phase: "error",
      error: err?.response?.data?.detail || err?.message || "Request failed",
    });
    throw err;
  }
}
