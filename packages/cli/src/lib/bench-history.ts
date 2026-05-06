// Persistent storage for `sivru bench personal` runs. Each invocation
// writes a JSON file at ~/.cache/sivru/bench-history/<iso-timestamp>.json.
// The observe server exposes these to observe-ui's Bench tab (see
// packages/observe/src/server/app.ts /api/bench-history).
//
// We deliberately keep this disk-only — no in-memory ordering, no DB.
// Anyone can `cat` a result file and run their own analysis.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Schema version. Bumped on incompatible JSON shape changes. */
export const BENCH_HISTORY_FORMAT_VERSION = 1;

export type BenchHistoryEntry = {
  formatVersion: number;
  /** ISO timestamp when the run started. Doubles as the on-disk filename stem. */
  startedAt: string;
  /** Sivru CLI version that produced the run. */
  sivruVersion: string;
  /** Node + platform, for reproducing on a similar setup. */
  node: string;
  platform: string;
  /** Command line that triggered the run (post-shell-parse). */
  argv: string[];
  /**
   * When set, the run used a cross-encoder reranker on top of the
   * primary retriever — applied uniformly to every model in the sweep.
   * Older runs (before rerank shipped) leave this undefined.
   */
  rerank?: {
    shortName: string;
    label: string;
  };
  /** Per-repo result blocks. Same shape as `sivru bench personal --json`. */
  repos: Array<{
    project: string;
    basename: string;
    sessionCount: number;
    queries: string[];
    /**
     * Optional — added 2026-05. Each entry pairs a query with the file
     * paths the agent actually edited / read after asking it. Powers
     * recall@5 / MRR computations and the Bench-tab "ground truth"
     * column. Older runs (formatVersion=1, queryDetails undefined)
     * still load fine; the UI hides recall columns when absent.
     */
    queryDetails?: Array<{
      query: string;
      source: "search_call" | "user_message";
      relevantFiles: string[];
    }>;
    models: Array<{
      model: string;
      label: string;
      perQuerySaved: number[];
      meanSavedPct: number;
      ci: { p05: number; p50: number; p95: number };
      buildMs: number;
      searchMs: number;
      // NEW (optional). Older runs lack these; UI guards with `?? null`.
      perQueryRecallAt5?: number[];
      perQueryMRR?: number[];
      scoreableQueryIndices?: number[];
      medianSavedPct?: number;
      meanRecallAt5?: number;
      medianRecallAt5?: number;
      meanMRR?: number;
      medianMRR?: number;
      recallCI?: { p05: number; p50: number; p95: number };
      mrrCI?: { p05: number; p50: number; p95: number };
      queriesScoredForRecall?: number;
    }>;
  }>;
};

function historyDir(): string {
  return join(homedir(), ".cache", "sivru", "bench-history");
}

/**
 * Sanitize an ISO timestamp into a safe filename. We replace `:` (illegal
 * on NTFS) with `-`. `T` and `Z` are kept so timestamps remain readable
 * via `ls`.
 */
function fileNameFor(startedAt: string): string {
  const cleaned = startedAt.replace(/:/g, "-").replace(/\..*$/, "");
  return `${cleaned}.json`;
}

export function saveBenchHistory(entry: Omit<BenchHistoryEntry, "formatVersion">): string {
  const dir = historyDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const full: BenchHistoryEntry = {
    formatVersion: BENCH_HISTORY_FORMAT_VERSION,
    ...entry,
  };
  const path = join(dir, fileNameFor(entry.startedAt));
  writeFileSync(path, JSON.stringify(full, null, 2) + "\n", "utf8");
  return path;
}

/** List entries newest-first. */
export function listBenchHistory(): Array<{ id: string; path: string; startedAt: string }> {
  const dir = historyDir();
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  files.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return files.map((f) => ({
    id: f.replace(/\.json$/, ""),
    path: join(dir, f),
    // Parse ISO date from filename. We replaced ":" with "-", undo that.
    startedAt: f.replace(/\.json$/, "").replace(/(\d{2})-(\d{2})-(\d{2})$/, "$1:$2:$3"),
  }));
}

export function readBenchHistory(id: string): BenchHistoryEntry | null {
  const dir = historyDir();
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as BenchHistoryEntry;
    if (parsed.formatVersion !== BENCH_HISTORY_FORMAT_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export const _internal = { historyDir, fileNameFor };
