// `sivru search <query> [path]` — build an index over `path` (default `.`)
// and print the top-k chunks scoring against `query`.
//
// Default output is line-oriented and grep-friendly:
//   <filePath>:<startLine>-<endLine>  <score>
//       <up to 5 indented preview lines>
//
// `--json` emits a single JSON line for machine consumption.
//
// MODE: hybrid (BM25 + semantic cosine, RRF-merged) is the DEFAULT. The
// embedder is `minishlab/potion-retrieval-32M` — a Model2Vec static embedder
// (no transformer inference, just a token→vector lookup table). On CPU it
// embeds tens of thousands of chunks per second, so the cold build is
// seconds, not minutes.
//
// `--bm25` opts out for offline / scripting use.
// `--embed=transformers` swaps to the slower-but-higher-quality
//   Xenova/all-MiniLM-L6-v2 transformer embedder; first run downloads
//   ~25 MB to ~/.cache/sivru/models/.

import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  buildIndex,
  createPotionProvider,
  createTransformersProvider,
} from "@sivrujs/search";
import type {
  BuildIndexProgress,
  EmbeddingProvider,
  SearchHit,
} from "@sivrujs/search";

import { resolveModel, resolveReranker } from "../lib/model-catalog.js";
import { loadConfig } from "../lib/config.js";

// Embedder selection accepts the catalog's full set of short names plus
// the legacy `transformers` alias (kept for backward compat with scripts
// that hardcoded it before the catalog landed). See lib/model-catalog.ts
// for the registered names; `hf:owner/model` is also accepted for any
// HF feature-extraction model not in the catalog.
type EmbedKind = string;
const LEGACY_TRANSFORMERS_ALIAS = "transformers";

const POTION_DEFAULT_MODEL = "minishlab/potion-retrieval-32M";
const TRANSFORMERS_DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

/**
 * Heuristic: does the model already live in the local cache? If so we skip
 * the "downloading..." stderr line. False negatives are harmless — at worst
 * we print an unneeded "first run downloads..." note.
 */
function isModelCached(kind: EmbedKind): boolean {
  const cacheRoot = join(homedir(), ".cache", "sivru", "models");
  if (kind === "potion") {
    return existsSync(join(cacheRoot, POTION_DEFAULT_MODEL));
  }
  if (kind === LEGACY_TRANSFORMERS_ALIAS) {
    return existsSync(join(cacheRoot, "Xenova", "all-MiniLM-L6-v2"));
  }
  // Catalog or hf:* — best-effort cache hit detection. We don't know the
  // exact path layout for every model, so just default to "not cached" and
  // print the download notice. False positives are harmless.
  return false;
}

function makeEmbedProvider(kind: EmbedKind): EmbeddingProvider {
  if (kind === "potion") return createPotionProvider();
  if (kind === LEGACY_TRANSFORMERS_ALIAS) {
    return createTransformersProvider();
  }
  // Catalog name or hf:* — go through the shared resolver.
  const entry = resolveModel(kind);
  if (entry !== null && entry.kind === "embed") {
    return entry.build();
  }
  throw new Error(
    `unknown --embed value: "${kind}". Run \`sivru bench models\` for the list of registered names.`,
  );
}

/** Heuristic CPU embedding rate (chunks/sec) used for the pre-embed ETA hint. */
const ESTIMATED_EMBED_RATE = 30;

/** Throttled stderr progress writer. Updates at most once every 250 ms. */
function makeProgressWriter(
  json: boolean,
  hybrid: boolean,
): (event: BuildIndexProgress) => void {
  if (json) return () => {};
  let lastWrite = 0;
  let lastLine = "";
  let etaShown = false;
  const start = Date.now();
  return (event) => {
    const now = Date.now();
    let line = "";
    if (event.phase === "walked" && event.totalChunks !== undefined) {
      line = `  walked ${event.totalChunks} files`;
    } else if (event.phase === "chunked" && event.totalChunks !== undefined) {
      const total = event.totalChunks;
      // Pre-embed ETA hint: if the user opted into hybrid and the chunk
      // count is large, give them a chance to abort with Ctrl+C and rerun
      // with --bm25.
      if (hybrid && !etaShown && total > 1000) {
        const sec = Math.ceil(total / ESTIMATED_EMBED_RATE);
        process.stderr.write(
          `  chunked ${total} chunks\n` +
            `  hybrid mode will embed ~${total} chunks (rough ETA ${formatDuration(sec)} on CPU).\n` +
            `  Ctrl+C and rerun with --bm25 to skip embeddings entirely (default-skips docs/tests already).\n`,
        );
        etaShown = true;
        return;
      }
      line = `  chunked ${event.totalChunks} chunks`;
    } else if (event.phase === "embed_progress") {
      const done = event.embedded ?? 0;
      const total = event.totalChunks ?? 0;
      const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
      const elapsed = (now - start) / 1000;
      const rate = elapsed > 0 ? done / elapsed : 0;
      const etaSec =
        rate > 0 && total > done ? Math.ceil((total - done) / rate) : null;
      const etaPart = etaSec !== null ? ` · ETA ~${formatDuration(etaSec)}` : "";
      line = `  embedded ${done}/${total} (${pct}%, ${rate.toFixed(0)}/sec)${etaPart}`;
    } else if (event.phase === "embed_done") {
      const total = event.totalChunks ?? 0;
      line = event.fromCache
        ? `  embeddings rehydrated from cache (${total} chunks)`
        : `  embedded ${total} chunks (${formatDuration((now - start) / 1000)})`;
    } else if (event.phase === "cached") {
      line = `  loaded ${event.totalChunks ?? 0} chunks from cache`;
    }
    if (line === "" || line === lastLine) return;
    if (event.phase === "embed_progress" && now - lastWrite < 250) return;
    process.stderr.write(line + "\n");
    lastWrite = now;
    lastLine = line;
  };
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

const DEFAULT_TOP_K = 10;
const PREVIEW_LINES = 5;

type ParsedArgs = {
  query: string;
  path: string;
  top: number;
  hybrid: boolean;
  embedKind: EmbedKind;
  json: boolean;
  /** Reranker short name (`ms-marco-minilm`, `bge-reranker-base`, `hf:...`) or null to skip. */
  rerank: string | null;
  /** Top-N candidates fed into the reranker. Default 50 when `rerank` is set. */
  rerankTopN: number | null;
};

function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  // argv is the FULL `process.argv.slice(2)`; the leading element is the
  // command name (`search`). Positional args follow, interleaved with flags.
  let top = DEFAULT_TOP_K;
  // Default embedder + hybrid honor `~/.config/sivru/config.json` if set,
  // else fall back to potion + hybrid. `--bm25 / --hybrid / --embed=`
  // override per-call.
  const persisted = loadConfig().embedder;
  let hybrid = persisted === "bm25" ? false : true;
  let embedKind: EmbedKind =
    persisted !== undefined && persisted !== "bm25" ? persisted : "potion";
  let json = false;
  let rerank: string | null = null;
  let rerankTopN: number | null = null;
  const positional: string[] = [];

  // Skip argv[0] which is the command name itself.
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--hybrid") {
      hybrid = true;
    } else if (arg === "--bm25" || arg === "--no-hybrid") {
      hybrid = false;
    } else if (arg.startsWith("--embed=")) {
      const value = arg.slice("--embed=".length);
      // Accept the legacy aliases ("potion", "transformers") plus any
      // catalog short name ("minilm", "bge-small", "jina-code", …) plus
      // `hf:owner/model` for arbitrary HF feature-extraction models.
      // "bm25" is shorthand for `--bm25` — flips hybrid off.
      if (value === "bm25") {
        hybrid = false;
      } else if (value === "potion" || value === LEGACY_TRANSFORMERS_ALIAS) {
        embedKind = value;
        hybrid = true;
      } else {
        const resolved = resolveModel(value);
        if (resolved === null || resolved.kind !== "embed") {
          return {
            error: `--embed: unknown model "${value}". Run \`sivru bench models\` to list registered names, or use \`hf:owner/model-name\` for a custom HF model.`,
          };
        }
        embedKind = value;
        hybrid = true;
      }
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("--top=")) {
      const raw = arg.slice("--top=".length);
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return { error: `invalid --top value: ${raw}` };
      }
      top = n;
    } else if (arg === "--top") {
      const next = argv[i + 1];
      if (next === undefined) {
        return { error: "missing value for --top" };
      }
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return { error: `invalid --top value: ${next}` };
      }
      top = n;
      i++;
    } else if (arg.startsWith("--rerank=")) {
      // `--rerank=<short-name>` — opt in to cross-encoder reranking.
      // Use `--rerank=off` (or omit) to skip. When set, hybrid is
      // recommended (the reranker reorders the bi-encoder candidates),
      // but the reranker also works on top of pure BM25.
      const value = arg.slice("--rerank=".length);
      if (value === "off" || value === "none" || value === "false") {
        rerank = null;
      } else {
        rerank = value;
      }
    } else if (arg.startsWith("--rerank-top-n=")) {
      const raw = arg.slice("--rerank-top-n=".length);
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return { error: `invalid --rerank-top-n value: ${raw}` };
      }
      rerankTopN = n;
    } else if (arg.startsWith("--")) {
      return { error: `unknown flag: ${arg}` };
    } else {
      positional.push(arg);
    }
  }

  const query = positional[0] ?? "";
  const path = positional[1] ?? ".";

  return {
    query,
    path,
    top,
    hybrid,
    embedKind,
    json,
    rerank,
    rerankTopN,
  };
}

function previewOf(content: string): string {
  const lines = content.split("\n").slice(0, PREVIEW_LINES);
  return lines.map((line) => "    " + line).join("\n");
}

function formatTextHit(hit: SearchHit): string {
  const { chunk, score } = hit;
  const header = `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}  ${score.toFixed(4)}`;
  return header + "\n" + previewOf(chunk.content);
}

export async function runSearch(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`sivru search: ${parsed.error}\n`);
    return 1;
  }

  const { query, path, top, hybrid, embedKind, json, rerank, rerankTopN } =
    parsed;

  if (query.trim().length === 0) {
    process.stderr.write("sivru search: missing query\n");
    return 1;
  }

  try {
    const st = await stat(path);
    if (!st.isDirectory() && !st.isFile()) {
      process.stderr.write(`sivru search: not a file or directory: ${path}\n`);
      return 1;
    }
  } catch {
    process.stderr.write(`sivru search: path does not exist: ${path}\n`);
    return 1;
  }

  // `cache: true` makes the second `sivru search` against the same repo
  // sub-second — keyed by (repoPath, state_id), invalidated automatically
  // when files change.
  const buildOpts: Parameters<typeof buildIndex>[1] = {
    cache: true,
    onProgress: makeProgressWriter(json, hybrid),
  };
  if (hybrid) {
    // Loud one-time hint when a fresh-machine model download is about to
    // happen. We don't print a generic "indexing..." line — the progress
    // events themselves announce walked/chunked/embedded or cache rehydrate,
    // which is more honest than claiming we're indexing when in fact we're
    // about to rehydrate from cache.
    if (!json && !isModelCached(embedKind)) {
      const size = embedKind === "potion" ? "~150 MB" : "~25 MB";
      process.stderr.write(
        `sivru search: downloading ${embedKind} embedder model (${size}, one-time)...\n`,
      );
    }
    buildOpts.embed = { provider: makeEmbedProvider(embedKind) };
  }

  // Optional cross-encoder rerank stage. Adds ~100–500 ms per query
  // depending on the model — see `sivru bench models` for the cost
  // breakdown. Most useful when retrieval quality (recall@5 / MRR)
  // matters more than latency.
  if (rerank !== null) {
    const rerankerEntry = resolveReranker(rerank);
    if (rerankerEntry === null) {
      process.stderr.write(
        `sivru search: unknown reranker "${rerank}". Run \`sivru bench models\` to list registered names, or use \`hf:owner/model-name\`.\n`,
      );
      return 1;
    }
    if (!json) {
      process.stderr.write(
        `sivru search: rerank=${rerankerEntry.shortName} (~${rerankerEntry.metadata.approxMsPerQueryAt50} ms / 50 pairs CPU)\n`,
      );
    }
    buildOpts.rerank = {
      provider: rerankerEntry.build(),
      ...(rerankTopN !== null ? { topN: rerankTopN } : {}),
    };
  }

  const index = await buildIndex(path, buildOpts);
  const hits = await (hybrid
    ? index.searchHybrid(query, top)
    : index.searchBM25(query, top));

  if (json) {
    const payload = {
      query,
      mode: hybrid ? "hybrid" : "bm25",
      hits: hits.map((h) => ({
        filePath: h.chunk.filePath,
        startLine: h.chunk.startLine,
        endLine: h.chunk.endLine,
        score: h.score,
        content: h.chunk.content,
      })),
    };
    process.stdout.write(JSON.stringify(payload) + "\n");
    return 0;
  }

  if (hits.length === 0) {
    process.stdout.write("no matches\n");
    return 0;
  }

  process.stdout.write(hits.map(formatTextHit).join("\n\n") + "\n");
  return 0;
}
