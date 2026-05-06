// Perf-gate comparator — fails CI on >15% regression vs the stored
// baseline. Runs after `perf.ts` to compare its JSON output against
// `benchmarks/perf-baseline.json`. Exits with code 1 on any failure.
//
// Skip rules (so the gate stays useful instead of flaky):
//   - chunks: deterministic; tolerance 1% (catches accidental chunker
//     changes). 0 baseline → skip.
//   - buildMs: noisy; tolerance 50%. CI runners vary 2-3× from cold start.
//   - peakHeapMiB: tolerance 15% as long as baseline ≥ 4 MiB. Below that
//     the absolute delta is meaningless.
//
// To re-baseline (e.g. after an intentional perf change):
//
//   pnpm --filter @sivrujs/benchmarks bench:perf --json > benchmarks/perf-baseline.json
//
// and commit the result.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runPerf } from "./perf.js";
import type { PerfReport, RepoPerf } from "./perf.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

type Tolerance = {
  /** Fractional regression tolerance. 0.15 = +15% over baseline. */
  ratio: number;
  /** Don't even compare unless the baseline is at least this large (in the metric's natural unit). */
  minAbs?: number;
};

const TOLERANCES: Record<keyof RepoPerf, Tolerance | null> = {
  // identity / metadata fields — never compared
  repo: null,
  language: null,
  // perf metrics
  chunks: { ratio: 0.01, minAbs: 1 },
  buildMs: { ratio: 0.5, minAbs: 100 },
  peakHeapMiB: { ratio: 0.15, minAbs: 4 },
};

export type Failure = {
  repo: string;
  metric: keyof RepoPerf;
  baseline: number;
  current: number;
  ratio: number;
  threshold: number;
};

export function compareReports(
  baseline: PerfReport,
  current: PerfReport,
): Failure[] {
  const baselineByRepo = new Map(baseline.repos.map((r) => [r.repo, r]));
  const failures: Failure[] = [];
  for (const cur of current.repos) {
    const base = baselineByRepo.get(cur.repo);
    if (base === undefined) continue;
    for (const metric of Object.keys(TOLERANCES) as Array<keyof RepoPerf>) {
      const tol = TOLERANCES[metric];
      if (tol === null) continue;
      const baseVal = base[metric];
      const curVal = cur[metric];
      if (typeof baseVal !== "number" || typeof curVal !== "number") continue;
      if ((tol.minAbs ?? 0) > baseVal) continue;
      const ratio = (curVal - baseVal) / baseVal;
      if (ratio > tol.ratio) {
        failures.push({
          repo: cur.repo,
          metric,
          baseline: baseVal,
          current: curVal,
          ratio,
          threshold: tol.ratio,
        });
      }
    }
  }
  return failures;
}

export function formatFailures(failures: readonly Failure[]): string {
  if (failures.length === 0) return "perf gate: no regressions";
  const lines: string[] = ["perf gate: REGRESSIONS DETECTED"];
  for (const f of failures) {
    const pct = (f.ratio * 100).toFixed(1);
    const tolPct = (f.threshold * 100).toFixed(0);
    lines.push(
      `  ${f.repo}.${f.metric}: ${f.baseline} → ${f.current} (+${pct}%, threshold ±${tolPct}%)`,
    );
  }
  lines.push("");
  lines.push(
    "If the regression is intentional, re-baseline:",
  );
  lines.push(
    "  pnpm --filter @sivrujs/benchmarks bench:perf --json > benchmarks/perf-baseline.json",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const baselinePath = resolve(ROOT, "benchmarks", "perf-baseline.json");
  if (!existsSync(baselinePath)) {
    process.stderr.write(
      `perf gate: no baseline at ${baselinePath} — run \`pnpm --filter @sivrujs/benchmarks bench:perf --json > benchmarks/perf-baseline.json\` first\n`,
    );
    process.exit(0); // soft pass — no baseline to compare against yet
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as PerfReport;
  process.stderr.write(
    `perf gate: comparing against baseline from ${baseline.timestamp} (sivru v${baseline.version})\n`,
  );
  const current = await runPerf();
  const failures = compareReports(baseline, current);
  process.stdout.write(formatFailures(failures) + "\n");
  process.exit(failures.length > 0 ? 1 : 0);
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`perf gate failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
