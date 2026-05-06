// Persistent `worker_threads` pool for parallelizing the parse+chunk loop in
// `buildIndex`. DESIGN.md §4 caps the pool at `min(8, os.cpus().length)` —
// even on a 32-core box we don't burn more threads than the chunker can keep
// fed without contending for the GIL-equivalent in the parser.
//
// Lifecycle:
//   const pool = createWorkerPool();
//   const chunks = await pool.chunk(path, content);
//   await pool.close();              // drains in-flight, terminates workers
//
// Each task carries an opaque numeric `taskId`; workers send back
// `{ taskId, ok, … }` and the pool resolves the matching pending Promise.
// Errors thrown inside the worker (e.g. `chunkFile` on bad options) are
// reported via the `ok: false` channel — the worker stays alive.
//
// Spawning the worker entry is mildly tricky because the file Node spawns is
// `worker.js` (compiled output) but vitest runs the `.ts` source directly.
// We resolve `./worker.js` against `import.meta.url`, then if the source URL
// ends in `.ts` we know we're in vitest and rewrite the worker URL the same
// way. The Worker constructor accepts a file URL pointing at a `.ts` file as
// long as the loader (vitest's transform pipeline) knows how to handle it.

import { Worker } from "node:worker_threads";
import { cpus } from "node:os";

import type { Chunk, ChunkOptions } from "../types.js";
import type { WorkerRequest, WorkerResponse } from "./worker.js";

export type WorkerPoolOptions = {
  /** Pool size. Default: `Math.min(8, os.cpus().length)`. */
  size?: number;
};

export type WorkerPool = {
  /** How many workers are running. */
  readonly size: number;
  /** Chunk a file in a worker thread. Equivalent to `chunkFile(filePath, content, options)`. */
  chunk(filePath: string, content: string, options?: ChunkOptions): Promise<Chunk[]>;
  /** Wait for all in-flight tasks to drain, then terminate all workers. */
  close(): Promise<void>;
};

const MAX_POOL_SIZE = 8;

type Pending = {
  resolve: (chunks: Chunk[]) => void;
  reject: (err: Error) => void;
};

type WorkerSlot = {
  worker: Worker;
  /** Number of in-flight tasks assigned to this worker. */
  busy: number;
};

type QueuedTask = {
  request: Omit<WorkerRequest, "taskId">;
  resolve: (chunks: Chunk[]) => void;
  reject: (err: Error) => void;
};

function resolveWorkerEntry(): URL {
  // `import.meta.url` is the URL of *this* module. In production builds it's
  // `…/dist/workers/pool.js` and `./worker.js` next to it is the compiled
  // worker entry — Node's Worker constructor loads it directly.
  //
  // Under vitest, `pool.ts` runs through vitest's TypeScript transform but
  // any worker we spawn does NOT inherit that transform pipeline — Node
  // would refuse `.ts` with `Unknown file extension ".ts"`. We always
  // rewrite the URL so the spawn target is `dist/workers/worker.js` regardless
  // of whether this module loaded from `src/` (vitest) or `dist/` (production).
  // Tests must `pnpm build` first; CI builds before testing.
  const distHref = import.meta.url
    .replace("/src/", "/dist/")
    .replace(/\.ts(\?.*)?$/, ".js$1");
  return new URL("./worker.js", distHref);
}

export function createWorkerPool(options: WorkerPoolOptions = {}): WorkerPool {
  const requested = options.size ?? Math.min(MAX_POOL_SIZE, cpus().length);
  const size = Math.max(1, Math.min(MAX_POOL_SIZE, requested));

  const workerEntry = resolveWorkerEntry();
  const pending = new Map<number, Pending>();
  const queue: QueuedTask[] = [];
  const slots: WorkerSlot[] = [];
  let nextTaskId = 0;
  let closed = false;
  let closing: Promise<void> | null = null;

  for (let i = 0; i < size; i++) {
    const worker = new Worker(workerEntry);
    const slot: WorkerSlot = { worker, busy: 0 };

    worker.on("message", (msg: WorkerResponse) => {
      const p = pending.get(msg.taskId);
      if (p === undefined) return;
      pending.delete(msg.taskId);
      slot.busy = Math.max(0, slot.busy - 1);
      if (msg.ok) {
        p.resolve(msg.chunks);
      } else {
        p.reject(new Error(`worker chunk failed: ${msg.error}`));
      }
      drainQueue();
    });

    worker.on("error", (err) => {
      // A worker-level error (uncaught throw, etc.) fails any task we had
      // assigned to it. Flush *all* pending entries that point at this slot.
      // We don't track per-slot ownership, so as a coarse guard we fail
      // everything in flight and rely on `chunkFile`-thrown errors going
      // through the message channel instead.
      slot.busy = 0;
      const failure = err instanceof Error ? err : new Error(String(err));
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(failure);
      }
    });

    slots.push(slot);
  }

  function pickSlot(): WorkerSlot | null {
    let best: WorkerSlot | null = null;
    for (const s of slots) {
      if (best === null || s.busy < best.busy) best = s;
    }
    return best;
  }

  function dispatch(slot: WorkerSlot, task: QueuedTask): void {
    const taskId = nextTaskId++;
    pending.set(taskId, { resolve: task.resolve, reject: task.reject });
    slot.busy += 1;
    const message: WorkerRequest = {
      taskId,
      op: "chunk",
      filePath: task.request.filePath,
      content: task.request.content,
      ...(task.request.options !== undefined ? { options: task.request.options } : {}),
    };
    slot.worker.postMessage(message);
  }

  function drainQueue(): void {
    while (queue.length > 0) {
      const slot = pickSlot();
      if (slot === null) return;
      // Always dispatch — having "least busy" doesn't mean idle. With a
      // bounded queue we accept some queuing on each worker; this matches
      // the "FIFO queue with idle-worker pickup" spec.
      const task = queue.shift();
      if (task === undefined) return;
      dispatch(slot, task);
    }
  }

  function chunk(
    filePath: string,
    content: string,
    options?: ChunkOptions,
  ): Promise<Chunk[]> {
    if (closed) {
      return Promise.reject(new Error("worker pool is closed"));
    }
    return new Promise<Chunk[]>((resolve, reject) => {
      const request: Omit<WorkerRequest, "taskId"> = {
        op: "chunk",
        filePath,
        content,
        ...(options !== undefined ? { options } : {}),
      };
      // Fast path: pick an idle slot (busy === 0) and dispatch immediately.
      // Otherwise enqueue and let `drainQueue` pick it up when a worker frees.
      const idle = slots.find((s) => s.busy === 0);
      if (idle !== undefined) {
        dispatch(idle, { request, resolve, reject });
      } else {
        queue.push({ request, resolve, reject });
      }
    });
  }

  function close(): Promise<void> {
    if (closing !== null) return closing;
    closed = true;
    closing = (async () => {
      // Wait for all in-flight + queued work to finish. New `chunk()` calls
      // already reject because `closed` is set.
      while (pending.size > 0 || queue.length > 0) {
        // Listen for the next message/error on any worker, then re-check.
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = (): void => {
            if (done) return;
            done = true;
            for (const s of slots) {
              s.worker.off("message", finish);
              s.worker.off("error", finish);
            }
            resolve();
          };
          for (const s of slots) {
            s.worker.once("message", finish);
            s.worker.once("error", finish);
          }
          // Safety net: tick periodically in case all messages already fired.
          setTimeout(finish, 25).unref();
        });
      }
      await Promise.all(slots.map((s) => s.worker.terminate()));
    })();
    return closing;
  }

  return {
    get size() {
      return size;
    },
    chunk,
    close,
  };
}
