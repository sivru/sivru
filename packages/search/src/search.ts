// SivruIndex — walker + chunker + tokenizer + BM25 + (optional) embeddings
// + reranking signals + (optional) on-disk cache wired into one object.
//
// Two retrieval modes:
//   searchBM25(query, k)     — lexical only, always available, sync
//   searchHybrid(query, k)   — BM25 ⊕ semantic-cosine merged via RRF
//                              (DESIGN.md §4.3, §4). Falls through to BM25
//                              when no embedding provider was supplied.
//
// Reranking signals (DESIGN.md §4 / W3) are applied between ranking and the
// final top-k slice — definition boost, multi-chunk file boost, path
// penalties, identifier-stem matching. On by default; turn off with
// `signals: false`.
//
// On-disk cache (DESIGN.md §4.6 / W4) is opt-in via `cache: true`. Keyed by
// (repoPath, state_id). On hit, BM25 rebuilds from cached chunks
// (sub-millisecond) and embeddings rehydrate from the cached matrix when
// the provider's `dim` still matches. The CLI passes `cache: true` so
// repeated `sivru search` calls in the same repo are sub-second.
//
// Embedding providers are pluggable via `EmbeddingProvider` — see
// `./embed/`. Three ship with this package; users with bespoke models
// just implement the two-method contract directly.

import { promises as fsp } from "node:fs";
import { resolve } from "node:path";

import { chunkFile } from "./chunker/chunk.js";
import { walk } from "./walker/walk.js";
import { createBm25Index } from "./bm25/index.js";
import { tokenize } from "./bm25/tokenizer.js";
import { cosineTopK, packMatrix } from "./vector/cosine.js";
import { reciprocalRankFusion } from "./ranking/rrf.js";
import { applySignals } from "./ranking/signals.js";
import { createWorkerPool } from "./workers/pool.js";
import { computeStateId } from "./cache/state-id.js";
import { createIndexCache } from "./cache/index.js";
import type { Bm25Index } from "./bm25/index.js";
import type { CosineMatrix } from "./vector/cosine.js";
import type { EmbeddingProvider } from "./embed/provider.js";
import type { RankedHit } from "./ranking/rrf.js";
import type { SignalConfig } from "./ranking/signals.js";
import type { CacheKey, CachedIndex, IndexCache } from "./cache/index.js";
import type { CrossEncoder } from "./rerank/provider.js";
import type { Chunk, ChunkOptions, WalkOptions } from "./types.js";

export type SearchHit = {
  chunk: Chunk;
  score: number;
  source: "bm25" | "semantic" | "hybrid";
};

export type RefreshResult = {
  /** Number of files re-chunked because their mtime advanced. */
  modified: number;
  /** Number of files removed (their chunks dropped). */
  removed: number;
  /** Number of brand-new files added (chunks + optional embeddings). */
  added: number;
  /**
   * Number of new chunks that were re-embedded. Distinct from `modified +
   * added` because content-hash dedup may let a re-chunked file reuse old
   * embeddings (small edits often leave most chunks identical).
   */
  embedsRecomputed: number;
  /** Wall-clock duration of the refresh in milliseconds. */
  durationMs: number;
};

export type SivruIndex = {
  /** Number of chunks indexed. */
  size(): number;
  /** True when an embedding provider was supplied at build time. */
  readonly hasEmbeddings: boolean;
  /** True when the build was served from the on-disk cache. */
  readonly cacheHit: boolean;
  /**
   * Re-walk the corpus, detect files modified / added / removed since the
   * last index build (or last refresh), and patch the in-memory index in
   * place. Cheap when nothing changed (single walk + stat). When changes
   * occurred, we re-chunk only the affected files and re-embed only chunks
   * whose content didn't already exist in the previous index (content-hash
   * dedup). bm25 is rebuilt from scratch — that's still microsecond-fast
   * for typical sessions.
   *
   * SAFETY: serialized via an internal Promise lock — concurrent search
   * callers all await the same in-flight refresh.
   *
   * Returns a summary so callers (e.g. the MCP server) can log "refreshed
   * 3 files in 47 ms" if they want.
   */
  refreshStale(): Promise<RefreshResult>;
  /**
   * Lexical retrieval over the BM25 index. Always available.
   * Returns a Promise so a configured cross-encoder reranker can run
   * over the BM25 candidates; without one, this resolves immediately
   * with no microtask delay.
   */
  searchBM25(query: string, k: number): Promise<SearchHit[]>;
  /**
   * Hybrid retrieval = BM25 ⊕ semantic cosine, RRF-merged. Falls back to
   * BM25 when no embedding provider was configured.
   */
  searchHybrid(query: string, k: number): Promise<SearchHit[]>;
  /**
   * Find code chunks similar to a given file region. Locates chunks that
   * overlap (filePath, startLine..endLine), uses the first overlapping chunk
   * as the source, and ranks the rest of the corpus by similarity to it.
   * Uses cosine similarity over the source chunk's embedding when available;
   * otherwise falls back to BM25 over the source chunk's tokens. The source
   * range is filtered out of the results. Returns `[]` when no chunk overlaps.
   */
  findRelated(args: {
    filePath: string;
    startLine: number;
    endLine: number;
    k: number;
  }): Promise<SearchHit[]>;
};

export type BuildIndexEmbedOptions = {
  /** Pluggable embedding provider — see `./embed/`. */
  provider: EmbeddingProvider;
  /**
   * How many chunks to embed per batch when calling `provider.embedBatch`.
   * Default 128. Higher uses more memory but is faster on GPU/server backends
   * and on CPU Transformers.js where larger batches amortize the per-call cost.
   */
  batchSize?: number;
  /**
   * Predicate that decides whether a chunk gets embedded. Returns `true`
   * to embed, `false` to skip (BM25 still indexes skipped chunks; only
   * semantic cosine retrieval excludes them). **Default embeds everything**
   * — silently dropping files would let an MCP-connected agent miss real
   * code and fall back to Read/Grep, defeating the whole point of plugging
   * sivru in. Provide a custom filter only when you accept that trade-off
   * in exchange for cold-start speed.
   */
  filter?: (chunk: Chunk) => boolean;
};

export type BuildIndexProgress = {
  /** Phase the build is currently in. */
  phase: "walked" | "chunked" | "embed_progress" | "embed_done" | "cached";
  /** Total chunks discovered (set after chunking completes). */
  totalChunks?: number;
  /** Chunks embedded so far (during `embed_progress`). */
  embedded?: number;
  /** Whether the index was loaded from cache. */
  fromCache?: boolean;
};

/**
 * Cross-encoder reranker options. When configured, every search call
 * (`searchBM25` or `searchHybrid`) takes the top-N candidates from the
 * primary retriever, scores each (query, chunk.content) pair via the
 * cross-encoder, and re-orders by score before slicing to top-K.
 *
 * Cost: roughly `topN / batchSize` transformer forward passes per
 * query. With `Xenova/ms-marco-MiniLM-L-6-v2` and topN=50 this is
 * ~100 ms on CPU; with `Xenova/bge-reranker-base` it's ~500 ms.
 * Reserve for use cases that can spend the latency — agent-driven
 * lookups during a turn-step, not fast-path UI autocomplete.
 *
 * Quality: typically +10–20% NDCG@10 vs. bi-encoder-only retrieval on
 * standard benchmarks. The actual lift on YOUR corpus is what
 * `sivru bench personal --rerank=...` is for.
 */
export type RerankOptions = {
  /** Cross-encoder used to score (query, document) pairs. */
  provider: CrossEncoder;
  /**
   * How many candidates to take from the primary retriever before
   * reranking. Default 50. Larger = more recall headroom for the
   * reranker but more transformer passes per query. Bounded above by
   * the number of candidates the primary retriever produces.
   */
  topN?: number;
};

export type BuildIndexOptions = {
  /** Walker overrides (gitignore, max file size, etc.). */
  walker?: WalkOptions;
  /** Chunker overrides (line window / overlap). */
  chunker?: ChunkOptions;
  /** Opt in to semantic embeddings. Omit to keep the build BM25-only. */
  embed?: BuildIndexEmbedOptions;
  /**
   * Opt in to cross-encoder reranking. Applied AFTER BM25⊕embedding
   * fusion (and after rerank-signals when those are on). Substantial
   * latency cost — see `RerankOptions` for details.
   */
  rerank?: RerankOptions;
  /**
   * Parallelize chunking via the `worker_threads` pool. Default `true` once
   * the file count exceeds `WORKER_FILE_THRESHOLD`. Set to `false` to force
   * single-threaded chunking (useful for small in-process tests).
   */
  workers?: boolean;
  /**
   * Apply standard reranking signals — definition boost, multi-chunk file
   * boost, path penalties, identifier-stem matching. Defaults: ON for
   * `searchBM25`, OFF for `searchHybrid` (RRF already merges two rankers
   * and the signals over-double-count when stacked on top — verified
   * empirically against the W2 hybrid baseline). Pass `false` / `true` /
   * `SignalConfig` to override; explicit settings apply to both modes.
   */
  signals?: boolean | SignalConfig;
  /**
   * On-disk index cache keyed by (repoPath, state_id). Off by default. Pass
   * `true` for the default cache directory (`~/.cache/sivru/indexes/`), or
   * `{ dir: "..." }` to relocate.
   */
  cache?: boolean | { dir?: string };
  /**
   * Optional progress callback. Fires at major build-phase transitions and
   * periodically during embedding. Synchronous, best-effort; throw inside
   * to abort the build.
   */
  onProgress?: (event: BuildIndexProgress) => void;
};

const DEFAULT_BATCH_SIZE = 128;

/** Below this file count, sync chunking is faster than spinning up workers. */
const WORKER_FILE_THRESHOLD = 16;

/**
 * Default embed filter — embed EVERYTHING. We deliberately don't skip
 * docs / configs / tests by default: an exclusion that's invisible to the
 * caller would mean Claude Code (or any MCP client) silently fails to
 * find files that DO exist in the repo, falling back to Read/Grep and
 * defeating the purpose of plugging sivru in.
 *
 * Override via `embed.filter` in `BuildIndexOptions` to opt into your
 * own predicate (e.g. for very large repos where you want to trade
 * coverage for cold-start speed).
 */
export function defaultEmbedFilter(_chunk: Chunk): boolean {
  return true;
}

/** RRF top-N to merge in hybrid mode. Always merge a deeper window than `k`. */
const HYBRID_MERGE_DEPTH_FACTOR = 4;

/** When signals are on, fetch `signalDepth(k)` candidates and rerank to top-k. */
function signalDepth(k: number): number {
  return Math.max(k * 4, k + 10);
}

async function embedAll(
  provider: EmbeddingProvider,
  texts: readonly string[],
  batchSize: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Float32Array[]> {
  const out: Float32Array[] = new Array(texts.length);
  const batch = provider.embedBatch?.bind(provider);
  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize);
    const vecs = batch ? await batch(slice) : await Promise.all(slice.map((t) => provider.embed(t)));
    for (let j = 0; j < vecs.length; j++) {
      out[i + j] = vecs[j]!;
    }
    onProgress?.(Math.min(i + slice.length, texts.length), texts.length);
  }
  return out;
}

function resolveCache(option: BuildIndexOptions["cache"]): IndexCache | null {
  if (option === undefined || option === false) return null;
  if (option === true) return createIndexCache();
  return createIndexCache(option.dir !== undefined ? { cacheDir: option.dir } : {});
}

function resolveSignalConfig(option: BuildIndexOptions["signals"]): SignalConfig | null {
  if (option === false) return null;
  if (option === undefined || option === true) return {};
  return option;
}

async function chunkFiles(
  files: readonly { filePath: string; content: string }[],
  chunkerOpts: ChunkOptions | undefined,
  workersFlag: boolean | undefined,
): Promise<Chunk[]> {
  const wantWorkers = workersFlag === undefined
    ? files.length >= WORKER_FILE_THRESHOLD
    : workersFlag;
  const chunks: Chunk[] = [];
  if (wantWorkers && files.length > 0) {
    const pool = createWorkerPool();
    try {
      const arrays = await Promise.all(
        files.map((f) => pool.chunk(f.filePath, f.content, chunkerOpts)),
      );
      for (const arr of arrays) chunks.push(...arr);
    } finally {
      await pool.close();
    }
  } else {
    for (const f of files) {
      for (const c of chunkFile(f.filePath, f.content, chunkerOpts)) {
        chunks.push(c);
      }
    }
  }
  return chunks;
}

/**
 * Build a SivruIndex by walking `rootDir`, chunking each text file, indexing
 * the chunks under BM25, and (optionally) embedding them via the supplied
 * provider for cosine-based hybrid retrieval. With `cache: true`, the
 * resulting index is persisted to `~/.cache/sivru/indexes/` so the next
 * call against the same repo state is sub-second.
 */
export async function buildIndex(
  rootDir: string,
  options: BuildIndexOptions = {},
): Promise<SivruIndex> {
  const root = resolve(rootDir);
  const cache = resolveCache(options.cache);
  const signalsExplicit = options.signals !== undefined;
  const signalConfig = resolveSignalConfig(options.signals);

  let chunks: Chunk[] | null = null;
  let cachedEmbeddings: CachedIndex["embeddings"] | undefined;
  let cacheHit = false;
  let cacheKey: CacheKey | null = null;
  // Per-file mtime in milliseconds. Populated either from cache (when
  // present) or from the walker on cold path. Read by `refreshStale` to
  // diff against on-disk state and identify modified files.
  let fileMtimes: Map<string, number> = new Map();

  // Cache lookup. Even on miss the state_id is reused as the save key below.
  if (cache !== null) {
    const stateId = await computeStateId(root);
    cacheKey = { repoPath: root, stateId };
    const loaded = await cache.load(cacheKey);
    if (loaded !== null) {
      chunks = loaded.chunks;
      cachedEmbeddings = loaded.embeddings;
      cacheHit = true;
      if (loaded.fileMtimes !== undefined) {
        fileMtimes = new Map(Object.entries(loaded.fileMtimes));
      }
      // Older cache entries don't have fileMtimes — fileMtimes stays empty.
      // refreshStale's first call after such a load will treat every file
      // as either "unknown" (force refresh) — which it handles correctly
      // because an empty map yields a list of "added" files for everything
      // already on disk. To avoid that one-time stampede, populate from
      // the walker before refresh ever runs.
    }
  }

  // Cold path: walk + read + chunk.
  if (chunks === null) {
    const files: Array<{ filePath: string; content: string }> = [];
    for await (const entry of walk(root, options.walker)) {
      try {
        const content = await fsp.readFile(entry.absPath, "utf8");
        files.push({ filePath: entry.filePath, content });
        fileMtimes.set(entry.filePath, entry.mtimeMs);
      } catch {
        continue;
      }
    }
    options.onProgress?.({ phase: "walked", totalChunks: files.length });
    // When embeddings are enabled, force single-threaded chunking. Reason:
    // onnxruntime-node (used by Transformers.js) has a known crash on
    // Node < 22.11 when libuv has just terminated worker_threads —
    // "mutex lock failed: Invalid argument" from libc++abi. Skipping the
    // worker pool here costs maybe 1–3 seconds of chunking on a large
    // repo and is paid once because the cache covers subsequent runs.
    // Caller can still force workers explicitly with `workers: true`.
    const workersFlag =
      options.workers !== undefined
        ? options.workers
        : options.embed !== undefined
          ? false
          : undefined;
    chunks = await chunkFiles(files, options.chunker, workersFlag);
    options.onProgress?.({ phase: "chunked", totalChunks: chunks.length });
  } else {
    options.onProgress?.({
      phase: "cached",
      totalChunks: chunks.length,
      fromCache: true,
    });
  }

  const bm25: Bm25Index = createBm25Index();
  bm25.addDocuments(
    chunks.map((chunk, id) => ({
      id,
      tokens: tokenize(chunk.content, { preserveDotted: true }),
    })),
  );

  let matrix: CosineMatrix | null = null;
  let provider: EmbeddingProvider | null = null;
  /** Maps cosine-matrix row index back to chunks[id]. */
  let embeddedChunkIds: number[] | null = null;
  /**
   * True when this run produced fresh embeddings (either no cached embeddings
   * existed OR they didn't match the current provider's dim/count). Drives
   * the save-back-to-cache decision at the bottom of this function.
   */
  let embeddingsBuiltFresh = false;

  if (options.embed !== undefined && chunks.length > 0) {
    provider = options.embed.provider;
    const batchSize = options.embed.batchSize ?? DEFAULT_BATCH_SIZE;
    const filter = options.embed.filter ?? defaultEmbedFilter;

    // Apply the filter to determine which chunks get embedded. The filter
    // is deterministic given the same chunks → same chunkIds, so cached
    // embeddings remain reusable as long as state_id + filter are unchanged.
    const includedIds: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      if (filter(chunks[i]!)) includedIds.push(i);
    }
    embeddedChunkIds = includedIds;

    // Lazy providers (potion, transformers) report `dim === 0` until their
    // first embed() call triggers model load. The cache-rehydration check
    // below compares cachedEmbeddings.dim to provider.dim — without this
    // priming call, the comparison is always 0-vs-real-dim and the fast
    // path never fires. Cost: ~10–50 ms of model init paid once per run;
    // no cost when the provider was already warm or doesn't need init
    // (mock provider returns its dim immediately).
    if (cachedEmbeddings !== undefined && provider.dim === 0) {
      await provider.embed("");
    }

    if (
      cachedEmbeddings !== undefined &&
      cachedEmbeddings.dim === provider.dim &&
      cachedEmbeddings.data.length === includedIds.length * provider.dim
    ) {
      matrix = {
        data: cachedEmbeddings.data,
        n: includedIds.length,
        d: provider.dim,
      };
      options.onProgress?.({
        phase: "embed_done",
        totalChunks: chunks.length,
        embedded: includedIds.length,
        fromCache: true,
      });
    } else if (includedIds.length === 0) {
      matrix = { data: new Float32Array(0), n: 0, d: provider.dim };
      embeddingsBuiltFresh = true;
      options.onProgress?.({
        phase: "embed_done",
        totalChunks: chunks.length,
        embedded: 0,
      });
    } else {
      const vectors = await embedAll(
        provider,
        includedIds.map((id) => chunks[id]!.content),
        batchSize,
        (done, total) => {
          options.onProgress?.({
            phase: "embed_progress",
            totalChunks: total,
            embedded: done,
          });
        },
      );
      matrix = packMatrix(vectors);
      embeddingsBuiltFresh = true;
      options.onProgress?.({
        phase: "embed_done",
        totalChunks: chunks.length,
        embedded: includedIds.length,
      });
    }
  }

  // Save back to cache when either:
  //   1. cold path — fresh chunks needed persisting; OR
  //   2. we computed fresh embeddings this run — covers both the
  //      partial-cache-hit upgrade (chunks cached, embeddings absent) AND
  //      the dim-mismatch case where cached embeddings exist but came from
  //      a different provider (e.g. transformer run yesterday, potion now).
  //      Without this branch users see "embeds every run" forever.
  // Atomic-rename makes the overwrite safe.
  if (
    cache !== null &&
    cacheKey !== null &&
    (!cacheHit || embeddingsBuiltFresh)
  ) {
    const payload: Omit<CachedIndex, "formatVersion" | "createdAt"> = matrix !== null
      ? { chunks, embeddings: { dim: matrix.d, data: matrix.data } }
      : { chunks };
    if (fileMtimes.size > 0) {
      payload.fileMtimes = Object.fromEntries(fileMtimes);
    }
    await cache.save(cacheKey, payload);
  }

  // Mutable index state. The search closures read through this object so
  // `refreshStale` can swap chunks / bm25 / matrix in place without
  // re-creating the whole SivruIndex.
  type IndexState = {
    chunks: Chunk[];
    bm25: Bm25Index;
    matrix: CosineMatrix | null;
    embeddedChunkIds: number[] | null;
    fileMtimes: Map<string, number>;
  };
  const state: IndexState = {
    chunks,
    bm25,
    matrix,
    embeddedChunkIds,
    fileMtimes,
  };

  function rerank(
    hits: readonly RankedHit[],
    query: string,
    k: number,
    config: SignalConfig | null,
  ): RankedHit[] {
    if (config === null) return hits.slice(0, k);
    return applySignals(hits, state.chunks, query, config).slice(0, k);
  }

  // Cross-encoder rerank stage. Runs AFTER BM25⊕embedding fusion (and
  // after rerank-signals when those are on). Pulls topN candidates,
  // scores each (query, chunk.content) via the configured CrossEncoder,
  // returns top-K reordered. Pass-through when no reranker is configured.
  const rerankOptions = options.rerank ?? null;
  const RERANK_DEFAULT_TOP_N = 50;
  async function applyCrossEncoder(
    hits: readonly RankedHit[],
    query: string,
    k: number,
  ): Promise<RankedHit[]> {
    if (rerankOptions === null) return hits.slice(0, k);
    const topN = rerankOptions.topN ?? RERANK_DEFAULT_TOP_N;
    const candidates = hits.slice(0, Math.min(topN, hits.length));
    if (candidates.length === 0) return [];
    const docs = candidates.map((h) => state.chunks[h.id]?.content ?? "");
    const scores = await rerankOptions.provider.score(query, docs);
    const scored = candidates.map((h, i) => ({
      id: h.id,
      score: scores[i] ?? 0,
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  // Per-mode signal config. BM25 always gets signals (default-on). Hybrid
  // skips them unless the caller explicitly opts in — empirically, stacking
  // signals on top of RRF over-double-counts on the corpus (NDCG@10 drops
  // from 0.6601 to 0.6269). The signals stay available; they're just not
  // the default in the mode where RRF already plays the reranker role.
  const bm25Signals = signalConfig;
  const hybridSignals = signalsExplicit ? signalConfig : null;

  const searchBM25 = async (
    query: string,
    k: number,
  ): Promise<SearchHit[]> => {
    const queryTokens = tokenize(query, { preserveDotted: query.includes(".") });
    // When a reranker is configured, fetch a wider candidate set so the
    // cross-encoder has headroom to reorder. Otherwise keep the existing
    // depth that signal-rerank uses.
    const depth =
      rerankOptions !== null
        ? Math.max(rerankOptions.topN ?? RERANK_DEFAULT_TOP_N, k)
        : bm25Signals === null
          ? k
          : signalDepth(k);
    const raw = state.bm25.search(queryTokens, depth);
    const signalReranked = rerank(raw, query, depth, bm25Signals);
    const finalHits = await applyCrossEncoder(signalReranked, query, k);
    return finalHits.map((hit) => {
      const chunk = state.chunks[hit.id];
      if (chunk === undefined) {
        throw new Error(`bm25 returned unknown id ${hit.id}`);
      }
      return { chunk, score: hit.score, source: "bm25" };
    });
  };

  const searchHybrid = async (query: string, k: number): Promise<SearchHit[]> => {
    if (provider === null || state.matrix === null) {
      return searchBM25(query, k);
    }
    const fuseDepth = Math.max(k * HYBRID_MERGE_DEPTH_FACTOR, k);
    const queryTokens = tokenize(query, { preserveDotted: query.includes(".") });
    // Use the asymmetric query encoder when the provider exposes one
    // (BGE / Nomic / E5 — see embed/instructions.ts). Falling back to
    // `embed` is correct for symmetric encoders where the two paths
    // are equivalent.
    const encodeQuery = (
      provider.embedQuery ?? provider.embed
    ).bind(provider);
    const [bm25Hits, queryVec] = await Promise.all([
      Promise.resolve(state.bm25.search(queryTokens, fuseDepth)),
      encodeQuery(query),
    ]);
    // Cosine returns matrix row indices; map back to chunk ids when the
    // matrix only covers a filtered subset of chunks.
    const ids = state.embeddedChunkIds;
    const semanticHits = cosineTopK(state.matrix, queryVec, fuseDepth).map((h) => ({
      id: ids !== null ? ids[h.index] ?? h.index : h.index,
      score: h.score,
    }));
    const fused = reciprocalRankFusion([bm25Hits, semanticHits], { topN: fuseDepth });
    const signalReranked = rerank(fused, query, fuseDepth, hybridSignals);
    const finalHits = await applyCrossEncoder(signalReranked, query, k);
    return finalHits.map((hit) => {
      const chunk = state.chunks[hit.id];
      if (chunk === undefined) {
        throw new Error(`hybrid returned unknown id ${hit.id}`);
      }
      return { chunk, score: hit.score, source: "hybrid" };
    });
  };

  const findRelated = async (args: {
    filePath: string;
    startLine: number;
    endLine: number;
    k: number;
  }): Promise<SearchHit[]> => {
    const { filePath, startLine, endLine, k } = args;
    if (k <= 0) return [];

    // Collect all chunks that overlap (filePath, startLine..endLine). Exact
    // path equality only — no glob/relative-path coercion at this layer.
    const overlapIds: number[] = [];
    for (let i = 0; i < state.chunks.length; i++) {
      const chunk = state.chunks[i]!;
      if (
        chunk.filePath === filePath &&
        chunk.endLine >= startLine &&
        chunk.startLine <= endLine
      ) {
        overlapIds.push(i);
      }
    }
    if (overlapIds.length === 0) return [];

    // The first overlapping chunk is the "source" — its embedding (or its
    // token bag) drives the similarity ranking.
    const sourceId = overlapIds[0]!;
    const sourceChunk = state.chunks[sourceId]!;
    const overlapSet = new Set(overlapIds);

    // Fast path: if we have a cosine matrix AND the source chunk was
    // embedded (i.e. it has a row in the matrix), use that row as the query
    // vector and rank by cosine. We pull the row directly out of `data`
    // rather than re-embedding to avoid an extra provider call.
    if (state.matrix !== null && state.embeddedChunkIds !== null) {
      const sourceRow = state.embeddedChunkIds.indexOf(sourceId);
      if (sourceRow !== -1) {
        const d = state.matrix.d;
        const queryVec = state.matrix.data.slice(sourceRow * d, (sourceRow + 1) * d);
        // Pull k + overlap-count extra so we can drop the overlapping
        // chunks (including the source itself) and still have k left.
        const raw = cosineTopK(state.matrix, queryVec, k + overlapIds.length);
        const out: SearchHit[] = [];
        for (const hit of raw) {
          const chunkId = state.embeddedChunkIds[hit.index] ?? hit.index;
          if (overlapSet.has(chunkId)) continue;
          const chunk = state.chunks[chunkId];
          if (chunk === undefined) continue;
          out.push({ chunk, score: hit.score, source: "hybrid" });
          if (out.length >= k) break;
        }
        return out;
      }
    }

    // Slow path: BM25 over the source chunk's content. Used when no
    // embeddings were built OR when the source chunk was filtered out of
    // the embedded set.
    const queryTokens = tokenize(sourceChunk.content, { preserveDotted: true });
    if (queryTokens.length === 0) return [];
    const raw = state.bm25.search(queryTokens, k + overlapIds.length);
    const out: SearchHit[] = [];
    for (const hit of raw) {
      if (overlapSet.has(hit.id)) continue;
      const chunk = state.chunks[hit.id];
      if (chunk === undefined) continue;
      out.push({ chunk, score: hit.score, source: "bm25" });
      if (out.length >= k) break;
    }
    return out;
  };

  // ----- refreshStale ----------------------------------------------------
  //
  // Detect modified / added / removed files since the last build (or last
  // refresh) and patch the index in place. Sequenced via a Promise lock so
  // concurrent search callers all await the same in-flight refresh.

  let refreshInFlight: Promise<RefreshResult> | null = null;

  const refreshStale = (): Promise<RefreshResult> => {
    if (refreshInFlight !== null) return refreshInFlight;
    refreshInFlight = (async (): Promise<RefreshResult> => {
      try {
        return await doRefresh();
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  };

  /**
   * Cheap content hash for chunk-level dedup during refresh. Two chunks
   * with the same `filePath + startLine + endLine + content` are
   * interchangeable — reuse the prior embedding instead of re-embedding.
   * FNV-1a over the four fields; collisions are vanishingly rare for
   * code chunks at this scale and we'd just embed an extra chunk if one
   * happened.
   */
  function chunkSignature(c: Chunk): string {
    return `${c.filePath} ${c.startLine} ${c.endLine} ${c.content}`;
  }

  async function doRefresh(): Promise<RefreshResult> {
    const t0 = performance.now();

    // 1. Walk + stat the corpus.
    const onDisk: Map<string, { absPath: string; mtimeMs: number }> = new Map();
    for await (const entry of walk(root, options.walker)) {
      onDisk.set(entry.filePath, {
        absPath: entry.absPath,
        mtimeMs: entry.mtimeMs,
      });
    }

    // 2. Diff against previous fileMtimes.
    const modified: string[] = [];
    const added: string[] = [];
    const removed: string[] = [];
    for (const [filePath, info] of onDisk) {
      const prev = state.fileMtimes.get(filePath);
      if (prev === undefined) {
        added.push(filePath);
      } else if (info.mtimeMs > prev) {
        modified.push(filePath);
      }
    }
    for (const filePath of state.fileMtimes.keys()) {
      if (!onDisk.has(filePath)) removed.push(filePath);
    }
    // Edge case: empty fileMtimes (older cache without the field) treats
    // every on-disk file as "added" but the search still works — bm25 and
    // matrix already have those chunks. Bail out fast in that one case
    // and just back-fill the mtime map without re-chunking.
    const haveFileMtimes = state.fileMtimes.size > 0;
    if (!haveFileMtimes && modified.length === 0 && removed.length === 0) {
      // Cache rehydration path: populate the mtime map from the walk
      // without doing any re-chunking work. Future refreshes use real
      // diffs.
      for (const [filePath, info] of onDisk) {
        state.fileMtimes.set(filePath, info.mtimeMs);
      }
      return {
        modified: 0,
        removed: 0,
        added: 0,
        embedsRecomputed: 0,
        durationMs: performance.now() - t0,
      };
    }

    if (modified.length === 0 && removed.length === 0 && added.length === 0) {
      return {
        modified: 0,
        removed: 0,
        added: 0,
        embedsRecomputed: 0,
        durationMs: performance.now() - t0,
      };
    }

    // 3. Read + chunk modified and added files.
    const dirtyFiles: string[] = [...modified, ...added];
    const dirtyContents: Array<{ filePath: string; content: string }> = [];
    for (const filePath of dirtyFiles) {
      const info = onDisk.get(filePath);
      if (info === undefined) continue;
      try {
        const content = await fsp.readFile(info.absPath, "utf8");
        dirtyContents.push({ filePath, content });
      } catch {
        continue;
      }
    }
    const dirtyFileSet = new Set(dirtyFiles);
    const removedSet = new Set(removed);

    // 4. Build the new chunk list.
    //    - Keep chunks from files that are unchanged (not in dirtyFileSet
    //      and not in removedSet).
    //    - Append fresh chunks from dirtyContents.
    const keptChunks: Chunk[] = [];
    // Track each kept chunk's prior embedding by signature so reuse below
    // is O(1).
    const oldEmbeddingBySignature = new Map<string, Float32Array>();
    if (state.matrix !== null && state.embeddedChunkIds !== null) {
      const d = state.matrix.d;
      for (let row = 0; row < state.embeddedChunkIds.length; row++) {
        const chunkId = state.embeddedChunkIds[row]!;
        const chunk = state.chunks[chunkId];
        if (chunk === undefined) continue;
        oldEmbeddingBySignature.set(
          chunkSignature(chunk),
          state.matrix.data.slice(row * d, (row + 1) * d),
        );
      }
    }
    for (const chunk of state.chunks) {
      if (dirtyFileSet.has(chunk.filePath)) continue;
      if (removedSet.has(chunk.filePath)) continue;
      keptChunks.push(chunk);
    }
    const freshChunks = await chunkFiles(
      dirtyContents,
      options.chunker,
      // Force single-threaded for refresh — small file counts (typical:
      // 1–5 files), worker pool spinup costs more than serial chunking.
      false,
    );
    const nextChunks: Chunk[] = [...keptChunks, ...freshChunks];

    // 5. Rebuild bm25 from scratch over the new chunk list. In-memory,
    //    cheap.
    const nextBm25 = createBm25Index();
    nextBm25.addDocuments(
      nextChunks.map((chunk, id) => ({
        id,
        tokens: tokenize(chunk.content, { preserveDotted: true }),
      })),
    );

    // 6. Rebuild the cosine matrix if embeddings are configured. Reuse
    //    cached embeddings when chunk signatures match — small edits
    //    typically leave most chunks of a file intact.
    let nextMatrix: CosineMatrix | null = state.matrix;
    let nextEmbeddedChunkIds: number[] | null = state.embeddedChunkIds;
    let embedsRecomputed = 0;
    if (provider !== null && state.matrix !== null) {
      const filter = options.embed?.filter ?? defaultEmbedFilter;
      const includedIds: number[] = [];
      for (let i = 0; i < nextChunks.length; i++) {
        if (filter(nextChunks[i]!)) includedIds.push(i);
      }
      const vectors: Float32Array[] = new Array(includedIds.length);
      const toEmbedTexts: string[] = [];
      const toEmbedTargets: number[] = [];
      for (let i = 0; i < includedIds.length; i++) {
        const chunk = nextChunks[includedIds[i]!]!;
        const cached = oldEmbeddingBySignature.get(chunkSignature(chunk));
        if (cached !== undefined) {
          vectors[i] = cached;
        } else {
          toEmbedTargets.push(i);
          toEmbedTexts.push(chunk.content);
        }
      }
      if (toEmbedTexts.length > 0) {
        const newVecs = await embedAll(
          provider,
          toEmbedTexts,
          options.embed?.batchSize ?? DEFAULT_BATCH_SIZE,
        );
        for (let j = 0; j < toEmbedTargets.length; j++) {
          vectors[toEmbedTargets[j]!] = newVecs[j]!;
        }
        embedsRecomputed = toEmbedTexts.length;
      }
      nextMatrix = packMatrix(vectors);
      nextEmbeddedChunkIds = includedIds;
    }

    // 7. Commit the new state atomically (single object property writes).
    state.chunks = nextChunks;
    state.bm25 = nextBm25;
    state.matrix = nextMatrix;
    state.embeddedChunkIds = nextEmbeddedChunkIds;
    state.fileMtimes = new Map();
    for (const [filePath, info] of onDisk) {
      state.fileMtimes.set(filePath, info.mtimeMs);
    }

    return {
      modified: modified.length,
      removed: removed.length,
      added: added.length,
      embedsRecomputed,
      durationMs: performance.now() - t0,
    };
  }

  return {
    size: () => state.chunks.length,
    hasEmbeddings: state.matrix !== null,
    cacheHit,
    refreshStale,
    searchBM25,
    searchHybrid,
    findRelated,
  };
}
