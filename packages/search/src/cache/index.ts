// On-disk index cache. DESIGN.md section 4.6.
//
// Layout:
//   <cacheDir>/<sha256(repoPath)>/<stateId>.json
//   <cacheDir>/<sha256(repoPath)>/<stateId>.tmp.<pid>   (transient)
//
// Atomic writes: write tmp file -> fsync -> rename to final name. Readers
// skip `*.tmp.*` files. Format mismatch / parse errors return null and
// (best-effort) delete the corrupt file.
//
// Per-repo LRU eviction and global byte budget (DESIGN.md 4.6: keep-5 per
// repo, 1 GB global) are deliberately out of scope here -- this module is
// the load/save round-trip storage layer. See `evictLruTodo` below.

import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { Chunk } from "../types.js";

/**
 * Bumped when the on-disk format changes incompatibly.
 *
 * - v1: line-fallback chunks.
 * - v2: tree-sitter chunker (DESIGN-0001) — chunk boundaries, `nodeType`,
 *   and `symbolName` all change, so v1 caches must not be reused.
 */
export const CACHE_FORMAT_VERSION = 2;

export type CacheKey = {
  /** Absolute path to the repo root. The cache is keyed by sha256(repoPath). */
  repoPath: string;
  /** Output of `computeStateId(repoPath)`. */
  stateId: string;
};

export type CachedIndex = {
  /** Always equals `CACHE_FORMAT_VERSION` for entries this build can read. */
  formatVersion: number;
  /** Same Chunk[] shape `chunkFile` produces. */
  chunks: Chunk[];
  /** Optional cosine matrix -- present iff the index was built with embeddings. */
  embeddings?: {
    /** Vector dimension. */
    dim: number;
    /** Flat row-major Float32 data, n * dim entries. Stored as base64 on disk. */
    data: Float32Array;
  };
  /**
   * Optional per-file mtime (millis since epoch). Captured at index time,
   * consumed by `refreshStale()` to detect modified files between session
   * starts. Omitted in old cache entries written before the staleness
   * tracking shipped — `refreshStale` falls back to a full re-walk in that
   * case (one-time cost; subsequent refreshes use the new map).
   */
  fileMtimes?: Record<string, number>;
  /** ISO timestamp of when this entry was written. */
  createdAt: string;
};

export type IndexCacheOptions = {
  /** Default: ~/.cache/sivru/indexes/ */
  cacheDir?: string;
};

export type IndexCache = {
  /** The directory this cache writes to. */
  readonly cacheDir: string;
  /** Try to load. Returns null on miss / corruption / format mismatch. */
  load(key: CacheKey): Promise<CachedIndex | null>;
  /** Atomic save: tmp file -> fsync -> rename. */
  save(
    key: CacheKey,
    value: Omit<CachedIndex, "formatVersion" | "createdAt">,
  ): Promise<void>;
  /** Remove entries for a repo path (e.g. force-rebuild scenarios). */
  evict(repoPath: string): Promise<void>;
};

// --- on-disk schema (private) ---------------------------------------------

type DiskEmbeddings = {
  dim: number;
  count: number;
  data_b64: string;
};

type DiskCachedIndex = {
  formatVersion: number;
  chunks: Chunk[];
  embeddings?: DiskEmbeddings;
  /** Per-file mtimeMs at the time of indexing. Optional — older entries
   *  written before the staleness work shipped won't have it; consumers
   *  should fall back to "treat as unknown / refresh everything." */
  fileMtimes?: Record<string, number>;
  createdAt: string;
};

// --- helpers --------------------------------------------------------------

function defaultCacheDir(): string {
  return join(homedir(), ".cache", "sivru", "indexes");
}

function repoSlug(repoPath: string): string {
  // Hash the *resolved* absolute path so two different cwds for the same
  // logical repo collide intentionally; different repos cannot.
  return createHash("sha256").update(resolve(repoPath)).digest("hex");
}

function repoDir(cacheDir: string, repoPath: string): string {
  return join(cacheDir, repoSlug(repoPath));
}

/**
 * Strip characters that are invalid in NTFS filenames: `: < > " / \ | ? *`
 * State-ids include `:` (between sha and diff-hash, or after `mtime:`) so
 * we replace those with `__` here. POSIX filesystems are unaffected.
 */
function sanitizeForFilename(s: string): string {
  return s.replace(/[<>:"/\\|?*]/g, "__");
}

function entryPath(cacheDir: string, key: CacheKey): string {
  return join(repoDir(cacheDir, key.repoPath), `${sanitizeForFilename(key.stateId)}.json`);
}

function tmpPath(cacheDir: string, key: CacheKey): string {
  return join(
    repoDir(cacheDir, key.repoPath),
    `${sanitizeForFilename(key.stateId)}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`,
  );
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

function encodeFloat32(arr: Float32Array): string {
  // Base64-encode the underlying byte view of the Float32Array. Use
  // `byteOffset`/`byteLength` because the array may be a view onto a
  // larger buffer.
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString(
    "base64",
  );
}

function decodeFloat32(b64: string, expectedCount: number): Float32Array | null {
  const buf = Buffer.from(b64, "base64");
  if (buf.byteLength !== expectedCount * 4) return null;
  // Copy into a freshly-aligned ArrayBuffer so the Float32 view is safe
  // regardless of the Buffer pool's alignment.
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Float32Array(ab);
}

async function bestEffortUnlink(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch {
    /* ignore */
  }
}

// --- factory --------------------------------------------------------------

export function createIndexCache(options?: IndexCacheOptions): IndexCache {
  const cacheDir = options?.cacheDir ?? defaultCacheDir();

  async function load(key: CacheKey): Promise<CachedIndex | null> {
    const target = entryPath(cacheDir, key);
    let raw: string;
    try {
      raw = await fsp.readFile(target, "utf8");
    } catch (err) {
      if (isMissing(err)) return null;
      // Permission or other I/O issue: treat as miss rather than crashing.
      return null;
    }

    let parsed: DiskCachedIndex;
    try {
      parsed = JSON.parse(raw) as DiskCachedIndex;
    } catch {
      // Corrupt JSON: best-effort delete and miss.
      await bestEffortUnlink(target);
      return null;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.formatVersion !== "number"
    ) {
      await bestEffortUnlink(target);
      return null;
    }

    if (parsed.formatVersion !== CACHE_FORMAT_VERSION) {
      // Schema mismatch: cold rebuild. Don't delete -- a future build with
      // a matching version may still want it.
      return null;
    }

    if (!Array.isArray(parsed.chunks) || typeof parsed.createdAt !== "string") {
      await bestEffortUnlink(target);
      return null;
    }

    const result: CachedIndex = {
      formatVersion: parsed.formatVersion,
      chunks: parsed.chunks,
      createdAt: parsed.createdAt,
    };

    if (parsed.embeddings !== undefined) {
      const e = parsed.embeddings;
      if (
        typeof e.dim !== "number" ||
        typeof e.count !== "number" ||
        typeof e.data_b64 !== "string"
      ) {
        await bestEffortUnlink(target);
        return null;
      }
      const data = decodeFloat32(e.data_b64, e.count);
      if (data === null) {
        await bestEffortUnlink(target);
        return null;
      }
      result.embeddings = { dim: e.dim, data };
    }

    if (parsed.fileMtimes !== undefined && typeof parsed.fileMtimes === "object" && parsed.fileMtimes !== null) {
      // Best-effort validation. Older caches without this field get an
      // empty map at the call site, which forces refreshStale to do a
      // full re-stat on first call.
      result.fileMtimes = parsed.fileMtimes;
    }

    return result;
  }

  async function save(
    key: CacheKey,
    value: Omit<CachedIndex, "formatVersion" | "createdAt">,
  ): Promise<void> {
    const dir = repoDir(cacheDir, key.repoPath);
    await fsp.mkdir(dir, { recursive: true });

    const target = entryPath(cacheDir, key);
    const tmp = tmpPath(cacheDir, key);

    const disk: DiskCachedIndex = {
      formatVersion: CACHE_FORMAT_VERSION,
      chunks: value.chunks,
      createdAt: new Date().toISOString(),
    };
    if (value.embeddings !== undefined) {
      const { dim, data } = value.embeddings;
      disk.embeddings = {
        dim,
        count: data.length,
        data_b64: encodeFloat32(data),
      };
    }
    if (value.fileMtimes !== undefined) {
      disk.fileMtimes = value.fileMtimes;
    }

    const payload = JSON.stringify(disk);

    // Open, write, fsync, close, then rename. The whole sequence is wrapped
    // in try/finally so a partial tmp file never leaks on error.
    let renamed = false;
    let handle: fsp.FileHandle | null = null;
    try {
      handle = await fsp.open(tmp, "wx");
      await handle.writeFile(payload);
      await handle.sync();
      await handle.close();
      handle = null;
      await renameWithRetry(tmp, target);
      renamed = true;
    } finally {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          /* ignore */
        }
      }
      if (!renamed) {
        await bestEffortUnlink(tmp);
      }
    }
  }

  /**
   * Rename with retry-on-EPERM/EEXIST for Windows. POSIX `rename` is atomic
   * even when the target exists; Windows can briefly fail with EPERM if the
   * target was just renamed-into and is held open by AV scanners or the
   * indexer. A short backoff loop (~150 ms total) is enough to outlast it.
   * If the target already contains a valid recent write (race with another
   * process), accept that as success and clean up our tmp.
   */
  async function renameWithRetry(src: string, dst: string): Promise<void> {
    const delays = [10, 30, 100];
    let lastErr: unknown = null;
    for (let i = 0; i <= delays.length; i++) {
      try {
        await fsp.rename(src, dst);
        return;
      } catch (err: unknown) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EEXIST") throw err;
        // Another writer beat us to the target — if it succeeded, we're
        // done; their file is valid. Drop our tmp.
        try {
          await fsp.access(dst);
          await bestEffortUnlink(src);
          return;
        } catch {
          /* target not present yet — fall through to retry */
        }
        if (i < delays.length) {
          await new Promise<void>((resolve) => setTimeout(resolve, delays[i]));
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async function evict(repoPath: string): Promise<void> {
    const dir = repoDir(cacheDir, repoPath);
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  return {
    cacheDir,
    load,
    save,
    evict,
  };
}

// TODO(post-W1): per-repo LRU keep-5 + global ~/.cache/sivru 1 GB budget
// per DESIGN.md 4.6. Eviction needs `proper-lockfile`-style flock around
// scan + delete; deferred so the load/save round-trip can land first.
