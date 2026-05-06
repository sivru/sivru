// Sivru adapter for the NDCG@10 benchmark runner.
//
// Builds one `SivruIndex` per repo (lazy, cached across queries), rooted at
// the repo's `benchmark_root` so chunk file paths line up directly with the
// labeled annotations.
//
// Two modes:
//   bm25     — lexical only, no model required (fast, runs in CI)
//   hybrid   — BM25 ⊕ semantic cosine merged via RRF; needs an embedding
//              provider passed in at construction time

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { buildIndex } from "@sivrujs/search";
import type { EmbeddingProvider, SivruIndex } from "@sivrujs/search";

import type { RepoSpec, RetrievalResult } from "./types.js";
import type { RetrievalAdapter } from "./runner.js";

export type SivruAdapterMode = "bm25" | "hybrid";

export type SivruAdapterOptions = {
  /** Directory containing one subdirectory per repo (typically `benchmarks/corpus`). */
  corpusDir: string;
  /** Default `"bm25"`. `"hybrid"` requires `embed` to be supplied. */
  mode?: SivruAdapterMode;
  /** Embedding provider used in hybrid mode. Required when `mode === "hybrid"`. */
  embed?: EmbeddingProvider;
};

export function createSivruAdapter(options: SivruAdapterOptions): RetrievalAdapter {
  const mode: SivruAdapterMode = options.mode ?? "bm25";
  if (mode === "hybrid" && options.embed === undefined) {
    throw new Error(
      "createSivruAdapter: mode='hybrid' requires an `embed` provider — pass `createTransformersProvider()` or any other EmbeddingProvider",
    );
  }
  const indexes = new Map<string, Promise<SivruIndex | null>>();

  function indexFor(repo: RepoSpec): Promise<SivruIndex | null> {
    const key = `${repo.name}@${repo.revision}@${mode}`;
    let cached = indexes.get(key);
    if (cached === undefined) {
      cached = (async (): Promise<SivruIndex | null> => {
        const repoRoot = resolve(options.corpusDir, repo.name);
        const benchRoot = resolve(repoRoot, repo.benchmark_root);
        if (!existsSync(benchRoot)) {
          process.stderr.write(
            `  ${repo.name}: corpus missing (${benchRoot}) — run \`pnpm --filter @sivrujs/benchmarks fetch-corpus\`\n`,
          );
          return null;
        }
        // Cache enabled: second `pnpm bench` run is sub-second per repo
        // because state-id matches and the corpus is checked out at a
        // pinned SHA (clean tree).
        const buildOpts: Parameters<typeof buildIndex>[1] = { cache: true };
        if (mode === "hybrid" && options.embed !== undefined) {
          buildOpts.embed = { provider: options.embed };
        }
        return buildIndex(benchRoot, buildOpts);
      })();
      indexes.set(key, cached);
    }
    return cached;
  }

  return async (repo, query, topK): Promise<RetrievalResult[]> => {
    const index = await indexFor(repo);
    if (index === null) return [];
    const hits = await (mode === "hybrid"
      ? index.searchHybrid(query, topK)
      : index.searchBM25(query, topK));
    return hits.map((hit) => ({
      filePath: joinPosix(repo.benchmark_root, hit.chunk.filePath),
      startLine: hit.chunk.startLine,
      endLine: hit.chunk.endLine,
      score: hit.score,
    }));
  };
}

function joinPosix(prefix: string, suffix: string): string {
  if (prefix === "" || prefix === ".") return suffix;
  return `${prefix.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}
