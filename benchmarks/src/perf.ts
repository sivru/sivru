// Resource-cost benchmark — DESIGN.md §8 / §13.13.
//
// Runs `buildIndex` on each pinned corpus repo with the on-disk cache
// disabled, capturing wall-clock build time, chunks emitted, and peak heap
// usage. Output is consumed by `perf-gate.ts`, which fails CI on >15%
// regression vs the snapshot in `benchmarks/perf-baseline.json`.
//
// Quality metrics (NDCG@10, agent-task token economy) live elsewhere — this
// file only tracks resource cost. Two benchmarks, complementary:
//
//   bench:perf  — resource cost (this file)
//   bench       — retrieval quality (NDCG@10)
//   bench:agent — token economy (sivru vs grep+Read)

import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildIndex } from "@sivru/search";

import type { RepoSpec } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

export type RepoPerf = {
  repo: string;
  language: string;
  chunks: number;
  buildMs: number;
  /** Peak heap delta during this repo's build, in MiB. */
  peakHeapMiB: number;
};

export type PerfReport = {
  /** ISO timestamp when this report was generated. */
  timestamp: string;
  /** Sivru version this run was measured against. */
  version: string;
  node: string;
  platform: string;
  repos: RepoPerf[];
  totals: {
    chunks: number;
    buildMs: number;
    /** Sum of per-repo peak heap deltas — coarse but stable. */
    peakHeapMiB: number;
  };
};

function loadRepos(): RepoSpec[] {
  return JSON.parse(
    readFileSync(resolve(ROOT, "benchmarks", "repos.json"), "utf8"),
  ) as RepoSpec[];
}

function loadVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(ROOT, "packages", "cli", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Sample heap usage during the awaited body. Resolution is per-tick (16 ms
 * setInterval) — coarse but enough to catch runaway allocators.
 */
async function withHeapSampler<T>(
  body: () => Promise<T>,
): Promise<{ value: T; peakHeapBytes: number }> {
  const start = process.memoryUsage().heapUsed;
  let peak = start;
  const handle = setInterval(() => {
    const heap = process.memoryUsage().heapUsed;
    if (heap > peak) peak = heap;
  }, 16);
  try {
    const value = await body();
    return { value, peakHeapBytes: peak - start };
  } finally {
    clearInterval(handle);
  }
}

export async function runPerf(): Promise<PerfReport> {
  const repos = loadRepos();
  const corpusDir = resolve(ROOT, "benchmarks", "corpus");
  const out: RepoPerf[] = [];

  for (const repo of repos) {
    const benchRoot = resolve(corpusDir, repo.name, repo.benchmark_root);
    if (!existsSync(benchRoot)) {
      process.stderr.write(
        `  ${repo.name}: corpus missing (${benchRoot}) — run \`pnpm --filter @sivru/benchmarks fetch-corpus\`\n`,
      );
      continue;
    }
    process.stderr.write(`  ${repo.name}: building index...\n`);

    // Force a fresh build (no cache) so we measure real cost.
    const t0 = performance.now();
    const { value: index, peakHeapBytes } = await withHeapSampler(() =>
      buildIndex(benchRoot, { cache: false }),
    );
    const t1 = performance.now();

    out.push({
      repo: repo.name,
      language: repo.language,
      chunks: index.size(),
      buildMs: Math.round(t1 - t0),
      peakHeapMiB: Math.round((peakHeapBytes / 1024 / 1024) * 10) / 10,
    });
  }

  const totals = out.reduce(
    (acc, r) => ({
      chunks: acc.chunks + r.chunks,
      buildMs: acc.buildMs + r.buildMs,
      peakHeapMiB:
        Math.round((acc.peakHeapMiB + r.peakHeapMiB) * 10) / 10,
    }),
    { chunks: 0, buildMs: 0, peakHeapMiB: 0 },
  );

  return {
    timestamp: new Date().toISOString(),
    version: loadVersion(),
    node: process.versions.node,
    platform: process.platform,
    repos: out,
    totals,
  };
}

export function formatPerf(report: PerfReport): string {
  const lines: string[] = [];
  lines.push(`sivru perf — v${report.version} on Node ${report.node} / ${report.platform}`);
  lines.push("");
  lines.push("  repo".padEnd(16) + "lang".padEnd(12) + "chunks".padStart(8) + "buildMs".padStart(10) + "peakHeapMiB".padStart(14));
  lines.push("  " + "─".repeat(56));
  for (const r of report.repos) {
    lines.push(
      "  " +
        r.repo.padEnd(14) +
        r.language.padEnd(12) +
        r.chunks.toString().padStart(8) +
        r.buildMs.toString().padStart(10) +
        r.peakHeapMiB.toFixed(1).padStart(14),
    );
  }
  lines.push("  " + "─".repeat(56));
  lines.push(
    "  " +
      "TOTAL".padEnd(14) +
      "".padEnd(12) +
      report.totals.chunks.toString().padStart(8) +
      report.totals.buildMs.toString().padStart(10) +
      report.totals.peakHeapMiB.toFixed(1).padStart(14),
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const report = await runPerf();
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatPerf(report) + "\n");
  }
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`perf benchmark failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
