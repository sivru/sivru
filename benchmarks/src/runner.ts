// W0 NDCG@10 benchmark runner.
//
// Today: scores any retrieval implementation that produces a
// `(filePath, score)` ranking per query. Used in W0 against a stub adapter
// to prove the pipeline runs end-to-end on real annotations.
//
// W2+: a sivru adapter lands here; this becomes the CI quality gate per
// DESIGN.md §13.10 (NDCG@10 ≥ baseline − 0.02).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { meanNdcgAtK, ndcgAtK } from "./metrics.js";
import type { Annotation, RepoSpec, RetrievalResult } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

/** Adapter contract: given a repo spec + a query, return a ranked file list. */
export type RetrievalAdapter = (
  repo: RepoSpec,
  query: string,
  topK: number,
) => Promise<RetrievalResult[]>;

export type QueryReport = {
  query: string;
  category: string;
  nRelevant: number;
  ranks: number[];
  ndcg10: number;
};

export type RepoReport = {
  repo: string;
  language: string;
  queries: QueryReport[];
  meanNdcg10: number;
  scored: number;
  skipped: number;
};

export type Report = {
  adapter: string;
  repos: RepoReport[];
  overallMeanNdcg10: number;
  totalScored: number;
};

function loadRepos(): RepoSpec[] {
  const raw = readFileSync(resolve(ROOT, "benchmarks", "repos.json"), "utf8");
  return JSON.parse(raw) as RepoSpec[];
}

function loadAnnotations(repoName: string): Annotation[] {
  const path = resolve(ROOT, "benchmarks", "annotations", `${repoName}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Annotation[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No annotations yet for this repo — corpus is W0 work.
      return [];
    }
    throw err;
  }
}

/**
 * Compute the 1-based ranks at which each "relevant" file appears in the
 * adapter's ranking. Multiple chunks from the same file collapse to the
 * earliest rank for that file.
 */
function computeRanks(results: readonly RetrievalResult[], relevant: readonly string[]): number[] {
  const ranks: number[] = [];
  // Stable file order; first occurrence wins.
  const fileFirstRank = new Map<string, number>();
  for (let i = 0; i < results.length; i++) {
    const path = results[i]!.filePath;
    if (!fileFirstRank.has(path)) {
      fileFirstRank.set(path, i + 1);
    }
  }
  for (const r of relevant) {
    const rank = fileFirstRank.get(r);
    if (rank !== undefined) ranks.push(rank);
  }
  return ranks;
}

export async function runBenchmark(
  adapter: RetrievalAdapter,
  adapterName: string,
  options: { k?: number; repoFilter?: (r: RepoSpec) => boolean } = {},
): Promise<Report> {
  const k = options.k ?? 10;
  const repos = loadRepos().filter(options.repoFilter ?? (() => true));

  const repoReports: RepoReport[] = [];
  for (const repo of repos) {
    const annotations = loadAnnotations(repo.name);
    const queries: QueryReport[] = [];
    for (const ann of annotations) {
      const results = await adapter(repo, ann.query, k);
      const ranks = computeRanks(results, ann.relevant);
      const ndcg = ndcgAtK(ranks, ann.relevant.length, k);
      queries.push({
        query: ann.query,
        category: ann.category,
        nRelevant: ann.relevant.length,
        ranks,
        ndcg10: ndcg,
      });
    }
    const summary = meanNdcgAtK(
      queries.map((q) => ({ relevantRanks: q.ranks, nRelevant: q.nRelevant })),
      k,
    );
    repoReports.push({
      repo: repo.name,
      language: repo.language,
      queries,
      meanNdcg10: summary.mean,
      scored: summary.scored,
      skipped: summary.skipped,
    });
  }

  const allQueries = repoReports
    .flatMap((r) => r.queries)
    .map((q) => ({ relevantRanks: q.ranks, nRelevant: q.nRelevant }));
  const overall = meanNdcgAtK(allQueries, k);

  return {
    adapter: adapterName,
    repos: repoReports,
    overallMeanNdcg10: overall.mean,
    totalScored: overall.scored,
  };
}

export function formatReport(report: Report): string {
  const lines: string[] = [];
  lines.push(`Adapter: ${report.adapter}`);
  lines.push(`Overall NDCG@10: ${report.overallMeanNdcg10.toFixed(4)} across ${report.totalScored} queries`);
  lines.push("");
  for (const r of report.repos) {
    lines.push(`  ${r.repo} (${r.language}) — NDCG@10 ${r.meanNdcg10.toFixed(4)} (${r.scored} scored, ${r.skipped} skipped)`);
  }
  return lines.join("\n");
}

// CLI entry point. Default mode is BM25 (fast, no model required); pass
// `--hybrid` to fold in semantic cosine via the default Transformers.js
// provider (downloads ~25 MB to ~/.cache/sivru/models/ on first run).
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const hybrid = argv.includes("--hybrid");

  const { createSivruAdapter } = await import("./sivru-adapter.js");
  const corpusDir = resolve(ROOT, "benchmarks", "corpus");

  const adapter = hybrid
    ? createSivruAdapter({
        corpusDir,
        mode: "hybrid",
        embed: (await import("@sivrujs/search")).createPotionProvider(),
      })
    : createSivruAdapter({ corpusDir });
  const adapterName = hybrid ? "sivru-hybrid" : "sivru-bm25";

  const report = await runBenchmark(adapter, adapterName);
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatReport(report) + "\n");
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`benchmark failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
