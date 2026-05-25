/**
 * Consume backend NDJSON pipeline streams and dispatch FLOW_EVENT phases.
 */

import { dispatchFlow } from "./notesFlowEvents";

const yieldFrame = () =>
  new Promise(resolve => requestAnimationFrame(() => resolve()));

/**
 * @param {ReadableStream<Uint8Array>} body
 * @param {(obj: Record<string, unknown>) => void | Promise<void>} onLine
 */
export async function readNdjsonStream(body, onLine) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatchLine = async raw => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    try {
      await onLine(JSON.parse(trimmed));
      await yieldFrame();
    } catch (err) {
      if (err?.flowPayload) throw err;
      /* ignore malformed lines */
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      await dispatchLine(line);
    }
  }
  if (buffer.trim()) {
    await dispatchLine(buffer);
  }
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<Record<string, unknown>>} final payload (complete or error)
 */
export async function fetchFlowStream(url, init = {}) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.detail || text;
    } catch {
      /* plain text */
    }
    throw new Error(typeof detail === "string" ? detail : "Request failed");
  }

  if (!res.body) {
    throw new Error("No response body");
  }

  let finalPayload = null;

  await readNdjsonStream(res.body, obj => {
    if (obj.phase === "error") {
      const err = new Error(obj.detail || "Request failed");
      err.flowPayload = obj;
      throw err;
    }
    finalPayload = obj;
  });

  return finalPayload || {};
}

/**
 * @param {{
 *   engine: string,
 *   action: string,
 *   url: string,
 *   init?: RequestInit,
 *   base?: Record<string, unknown>,
 * }} opts
 */
export async function runBackendFlowStream({ engine, action, url, init, base = {} }) {
  let lastPhase = null;

  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.detail || text;
    } catch {
      /* */
    }
    dispatchFlow({
      engine,
      action,
      phase: "error",
      error: typeof detail === "string" ? detail : "Request failed",
      ...base,
    });
    throw new Error(typeof detail === "string" ? detail : "Request failed");
  }

  if (!res.body) {
    throw new Error("No response body");
  }

  let finalPayload = null;

  try {
    await readNdjsonStream(res.body, async obj => {
      if (obj.phase === "error") {
        dispatchFlow({
          engine,
          action,
          phase: "error",
          error: obj.detail || "Request failed",
          ...base,
        });
        const err = new Error(obj.detail || "Request failed");
        err.flowPayload = obj;
        throw err;
      }

      const { phase, message, step, file, ...rest } = obj;
      lastPhase = phase;

      dispatchFlow({
        engine,
        action,
        phase,
        message,
        step,
        file,
        ...rest,
        ...base,
      });

      if (phase === "complete") {
        finalPayload = obj;
      }
    });
  } catch (err) {
    if (err.flowPayload || lastPhase === "error") throw err;
    dispatchFlow({
      engine,
      action,
      phase: "error",
      error: err.message || "Request failed",
      ...base,
    });
    throw err;
  }

  return finalPayload || {};
}

/**
 * Multipart upload with real upload progress + NDJSON response phases from backend.
 */
export function uploadWithFlowStream({
  url,
  formData,
  engine,
  action,
  base = {},
  onUploadProgress,
}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    let parsedLen = 0;
    let settled = false;

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };

    const dispatchLine = obj => {
      if (obj.phase === "error") {
        dispatchFlow({
          engine,
          action,
          phase: "error",
          error: obj.detail || "Upload failed",
          ...base,
        });
        finish(reject, new Error(obj.detail || "Upload failed"));
        return;
      }
      const file = obj.file;
      dispatchFlow({
        engine,
        action,
        phase: obj.phase,
        message: obj.message,
        file,
        highlightDoc: file?.display_name,
        ...obj,
        ...base,
      });
      if (obj.phase === "complete") {
        finish(resolve, obj);
      }
    };

    const drainNewLines = text => {
      const chunk = text.slice(parsedLen);
      if (!chunk) return;
      parsedLen = text.length;
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          dispatchLine(JSON.parse(trimmed));
        } catch {
          /* partial line */
        }
      }
    };

    xhr.upload.addEventListener("progress", ev => {
      const progress = ev.lengthComputable
        ? Math.round((ev.loaded * 100) / ev.total)
        : 0;
      onUploadProgress?.(progress);
      dispatchFlow({
        engine,
        action,
        phase: "uploading",
        progress,
        ...base,
      });
    });

    xhr.addEventListener("progress", () => {
      if (xhr.responseText) drainNewLines(xhr.responseText);
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        drainNewLines(xhr.responseText);
        if (!settled) finish(resolve, {});
      } else {
        let detail = xhr.responseText || "Upload failed";
        try {
          const j = JSON.parse(xhr.responseText);
          detail = j.detail || detail;
        } catch {
          /* */
        }
        dispatchFlow({
          engine,
          action,
          phase: "error",
          error: typeof detail === "string" ? detail : "Upload failed",
          ...base,
        });
        finish(reject, new Error(typeof detail === "string" ? detail : "Upload failed"));
      }
    });

    xhr.addEventListener("error", () => {
      dispatchFlow({
        engine,
        action,
        phase: "error",
        error: "Upload failed",
        ...base,
      });
      finish(reject, new Error("Upload failed"));
    });

    xhr.send(formData);
  });
}
