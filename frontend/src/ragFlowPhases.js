/** Map rag-studio FLOW_EVENT payloads → RAGFlowVisualizer step index */



const ACTION_MAP = {

  upload: "upload",

  chat: "chat",

  delete_file: "delete-file",

  delete_corpus: "delete-corpus",

};



/**

 * @returns {{ action: string, step: number, message: string, error?: string, done?: boolean } | null}

 */

export function mapRagFlowEvent(detail) {

  if (!detail || detail.engine !== "rag") return null;



  const action = ACTION_MAP[detail.action];

  if (!action) return null;



  const { phase, step, message, error } = detail;



  if (phase === "error") {

    return { action, step: -1, message: error || detail.detail || "Pipeline failed", error: true };

  }



  if (phase === "complete") {

    return {

      action,

      step: 99,

      message: "Pipeline complete ✓",

      done: true,

    };

  }



  if (action === "upload") {

    if (phase === "uploading") {

      return {

        action,

        step: 0,

        message: message || `Uploading${detail.progress != null ? `… ${detail.progress}%` : "…"}`,

      };

    }

    if (phase === "ingest") {

      return {

        action,

        step: 1,

        message: message || "Vertex RAG Corpus · ingest…",

      };

    }

    if (phase === "indexed") {

      return {

        action,

        step: 2,

        message: message || "RAG Managed DB · embed / index…",

      };

    }

    /* legacy */

    if (phase === "indexing") {

      return { action, step: 2, message: message || "Embedding and indexing…" };

    }

  }



  if (action === "chat") {

    if (phase === "retrieving") {

      return { action, step: 0, message: message || "Retrieving chunks from corpus…" };

    }

    if (phase === "retrieved") {

      return { action, step: 1, message: message || "rag.retrieval_query complete" };

    }

    if (phase === "generating") {

      return { action, step: 2, message: message || "Generating answer with Gemini…" };

    }

    if (phase === "saving") {

      return { action, step: 3, message: message || "Saving conversation to PostgreSQL…" };

    }

  }



  if (action === "delete-file") {

    if (phase === "deleting") {

      const sub =

        step === "corpus" ? 1 : step === "vectors" || step === "managed" ? 2 : 0;

      return {

        action,

        step: sub,

        message: message || `Deleting file${detail.filename ? `… ${detail.filename}` : "…"}`,

      };

    }

  }



  if (action === "delete-corpus") {

    if (phase === "deleting") {

      if (step === "files") {

        return { action, step: 0, message: message || "Deleting all files…" };

      }

      if (step === "corpus") {

        return { action, step: 1, message: message || "Deleting Vertex corpus…" };

      }

      if (step === "postgres") {

        return { action, step: 2, message: message || "Clearing conversations…" };

      }

      return { action, step: 0, message: message || "Deleting corpus…" };

    }

  }



  return null;

}

