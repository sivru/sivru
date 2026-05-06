// Worker entry script for the search engine's chunking pool.
//
// Spawned by `packages/search/src/workers/pool.ts` via
// `new Worker(new URL("./worker.js", import.meta.url))`. By construction this
// file is only ever loaded as a worker entry, so we skip the `isMainThread`
// guard and assume `parentPort` is non-null.
//
// Protocol (request → response):
//   { taskId, op: "chunk", filePath, content, options? }
//   → { taskId, ok: true, chunks } | { taskId, ok: false, error }
//
// The worker stays alive on `chunkFile` errors — they're reported back via the
// `ok: false` path so one bad file doesn't kill an otherwise reusable worker.

import { parentPort } from "node:worker_threads";

import type { Chunk, ChunkOptions } from "../types.js";
import { chunkFile } from "../chunker/chunk.js";

export type WorkerRequest = {
  taskId: number;
  op: "chunk";
  filePath: string;
  content: string;
  options?: ChunkOptions;
};

export type WorkerResponse =
  | { taskId: number; ok: true; chunks: Chunk[] }
  | { taskId: number; ok: false; error: string };

if (parentPort === null) {
  // Defensive — should be unreachable when loaded as a Worker entry.
  throw new Error("worker.ts must be loaded via worker_threads, parentPort is null");
}

const port = parentPort;

port.on("message", (msg: WorkerRequest) => {
  const { taskId, op } = msg;
  if (op !== "chunk") {
    const response: WorkerResponse = {
      taskId,
      ok: false,
      error: `unknown op: ${String(op)}`,
    };
    port.postMessage(response);
    return;
  }

  try {
    const chunks =
      msg.options !== undefined
        ? chunkFile(msg.filePath, msg.content, msg.options)
        : chunkFile(msg.filePath, msg.content);
    const response: WorkerResponse = { taskId, ok: true, chunks };
    port.postMessage(response);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const response: WorkerResponse = { taskId, ok: false, error };
    port.postMessage(response);
  }
});
