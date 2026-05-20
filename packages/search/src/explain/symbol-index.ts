// Symbol-index core (DESIGN-0004 §3a, §4 / T2).
//
// `buildSymbolIndex(repoPath, opts)` walks the repo with the engine's
// gitignore-aware `walk()`, detects each file's language, chunks it via the
// existing `chunkFile()` path, and asks the matching `Resolver` to extract
// exports + raw imports. After every file is parsed it resolves each raw
// import to a repo-relative path via the resolver's `resolveImport()`.
//
// Performance shape (D2): zero git calls happen here. `commitCount` is
// filled from an optional `commitCounts: ReadonlyMap<string, number>` that
// T7's git-log walker prepares once per `state_id`. When the map is not
// supplied (tests / first build / unsupported tree) every entry's
// `commitCount` is 0.
//
// The index is process-resident in v0.5 unless wrapped by T6's cache layer.
// `refreshSymbolIndex` produces a new index from a previous one given the
// list of changed/added/removed paths.

import { promises as fsp } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { chunkFile } from "../chunker/chunk.js";
import { detectLanguage } from "../chunker/language.js";
import type { Chunk } from "../types.js";
import { walk } from "../walker/walk.js";

import type { ParseCache } from "./parse-cache.js";
import { resolverFor } from "./resolvers/index.js";
import type { Resolver } from "./types.js";
import {
  type ImportEdge,
  SivruExplainError,
  type SymbolIndex,
  type SymbolIndexEntry,
} from "./types.js";

/**
 * Injectable hooks for `buildSymbolIndex`. All hooks have sensible defaults so
 * tests can swap in fake walkers / chunkers without binding to the filesystem,
 * while production callers pass nothing and get the real engine wiring.
 */
export type BuildSymbolIndexOptions = {
  /** state_id this index is keyed under. Used only as metadata here; the cache layer (T6) is what binds it to disk. */
  stateId?: string;
  /** Per-file commit count, populated once per state_id by T7. Missing entries get 0. */
  commitCounts?: ReadonlyMap<string, number>;
  /** Inject a language detector for tests. Defaults to the engine `detectLanguage`. */
  detectLanguage?: (filePath: string) => string | null;
  /** Inject a chunker for tests. Defaults to the engine `chunkFile`. */
  chunker?: (filePath: string, content: string) => Promise<readonly Chunk[]>;
  /** Optional file reader. Defaults to `fsp.readFile`. */
  readFile?: (absPath: string) => Promise<string>;
  /** Optional parse cache to share chunks between explain runs. */
  parseCache?: ParseCache;
  /** Maximum file bytes the walker honours. Forwarded to `walk()`. */
  maxFileBytes?: number;
  /** Skip-event callback forwarded to `walk()`. */
  onSkip?: Parameters<typeof walk>[1] extends infer T
    ? T extends { onSkip?: infer C }
      ? C
      : never
    : never;
};

class SymbolIndexImpl implements SymbolIndex {
  readonly repoPath: string;
  readonly stateId: string;
  readonly #byPath: Map<string, SymbolIndexEntry>;

  constructor(
    repoPath: string,
    stateId: string,
    byPath: Map<string, SymbolIndexEntry>,
  ) {
    this.repoPath = repoPath;
    this.stateId = stateId;
    this.#byPath = byPath;
  }

  size(): number {
    return this.#byPath.size;
  }

  get(filePath: string): SymbolIndexEntry | undefined {
    return this.#byPath.get(filePath);
  }

  entries(): readonly SymbolIndexEntry[] {
    return Array.from(this.#byPath.values());
  }
}

/**
 * Parse one file end-to-end and produce a `SymbolIndexEntry`. Public for
 * `refreshSymbolIndex` (which re-uses the same single-file pipeline) and for
 * resolver conformance tests.
 *
 * `commitCount` is whatever the caller carries forward — `buildSymbolIndex`
 * substitutes from `commitCounts` once per file.
 */
export async function parseOneFile(
  filePath: string,
  absPath: string,
  mtimeMs: number,
  opts: {
    detectLanguage: (filePath: string) => string | null;
    chunker: (filePath: string, content: string) => Promise<readonly Chunk[]>;
    readFile: (absPath: string) => Promise<string>;
    repoRoot: string;
    parseCache?: ParseCache;
    commitCount: number;
  },
): Promise<SymbolIndexEntry> {
  const language = opts.detectLanguage(filePath);
  if (language === null) {
    return {
      filePath,
      language: null,
      exports: [],
      imports: [],
      commitCount: opts.commitCount,
      mtimeMs,
    };
  }
  const resolver: Resolver | null = resolverFor(language);
  if (resolver === null) {
    return {
      filePath,
      language,
      exports: [],
      imports: [],
      commitCount: opts.commitCount,
      mtimeMs,
    };
  }
  let chunks: readonly Chunk[] | undefined = opts.parseCache?.get(absPath, mtimeMs);
  let source: string | null = null;
  if (chunks === undefined) {
    try {
      source = await opts.readFile(absPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SivruExplainError(
        "SIVRU-E2010",
        `failed to read ${filePath}: ${message}`,
      );
    }
    chunks = await opts.chunker(filePath, source);
    opts.parseCache?.set(absPath, mtimeMs, chunks);
  }
  if (source === null) {
    // We pulled chunks from the cache; we still need the source for raw imports.
    try {
      source = await opts.readFile(absPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SivruExplainError(
        "SIVRU-E2010",
        `failed to re-read ${filePath} after cache hit: ${message}`,
      );
    }
  }
  const parsed = resolver.parseFile(filePath, source, chunks);
  const imports: ImportEdge[] = parsed.imports.map((edge) => ({
    raw: edge.raw,
    identifiers: edge.identifiers,
    resolved: resolver.resolveImport(edge.raw, filePath, opts.repoRoot),
  }));
  return {
    filePath,
    language,
    exports: parsed.exports,
    imports,
    commitCount: opts.commitCount,
    mtimeMs,
  };
}

/**
 * Build a symbol index for `repoPath` from scratch. One pass of the walker;
 * one parse per file. Returns the populated `SymbolIndex`.
 *
 * `opts.stateId` is metadata only — the cache layer (T6) computes/keys it.
 * When omitted, `"unknown"` is recorded so tests don't need to thread it
 * through.
 */
export async function buildSymbolIndex(
  repoPath: string,
  opts: BuildSymbolIndexOptions = {},
): Promise<SymbolIndex> {
  const absRepo = resolvePath(repoPath);
  const detect = opts.detectLanguage ?? detectLanguage;
  const chunker: (filePath: string, content: string) => Promise<readonly Chunk[]> =
    opts.chunker ?? ((p, c) => chunkFile(p, c));
  const readFile = opts.readFile ?? ((p: string) => fsp.readFile(p, "utf8"));
  const commitCounts = opts.commitCounts;
  const byPath = new Map<string, SymbolIndexEntry>();
  const walkOpts: Parameters<typeof walk>[1] = {};
  if (opts.maxFileBytes !== undefined) walkOpts.maxFileBytes = opts.maxFileBytes;
  if (opts.onSkip !== undefined) walkOpts.onSkip = opts.onSkip;
  for await (const entry of walk(absRepo, walkOpts)) {
    const commitCount = commitCounts?.get(entry.filePath) ?? 0;
    const parseOpts: Parameters<typeof parseOneFile>[3] = {
      detectLanguage: detect,
      chunker,
      readFile,
      repoRoot: absRepo,
      commitCount,
    };
    if (opts.parseCache !== undefined) parseOpts.parseCache = opts.parseCache;
    const indexEntry = await parseOneFile(
      entry.filePath,
      entry.absPath,
      entry.mtimeMs,
      parseOpts,
    );
    byPath.set(indexEntry.filePath, indexEntry);
  }
  return new SymbolIndexImpl(absRepo, opts.stateId ?? "unknown", byPath);
}

export type RefreshDelta = {
  modified: readonly string[];
  added: readonly string[];
  removed: readonly string[];
};

/**
 * Produce a new `SymbolIndex` from `prev` by re-parsing `added` + `modified`
 * files and dropping `removed` ones. All other entries are carried over
 * verbatim (their tree-sitter parse is still good — mtime didn't change).
 *
 * Same injection surface as `buildSymbolIndex` so tests can stub the IO.
 */
export async function refreshSymbolIndex(
  prev: SymbolIndex,
  delta: RefreshDelta,
  opts: BuildSymbolIndexOptions & { stateId?: string } = {},
): Promise<SymbolIndex> {
  const detect = opts.detectLanguage ?? detectLanguage;
  const chunker: (filePath: string, content: string) => Promise<readonly Chunk[]> =
    opts.chunker ?? ((p, c) => chunkFile(p, c));
  const readFile = opts.readFile ?? ((p: string) => fsp.readFile(p, "utf8"));
  const commitCounts = opts.commitCounts;
  const byPath = new Map<string, SymbolIndexEntry>();
  for (const existing of prev.entries()) {
    if (delta.removed.includes(existing.filePath)) continue;
    if (delta.modified.includes(existing.filePath)) continue;
    byPath.set(existing.filePath, existing);
  }
  const touched = [...delta.added, ...delta.modified];
  for (const relPath of touched) {
    const absPath = resolvePath(prev.repoPath, relPath);
    let stat;
    try {
      stat = await fsp.stat(absPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SivruExplainError(
        "SIVRU-E2010",
        `refresh stat failed for ${relPath}: ${message}`,
      );
    }
    const commitCount = commitCounts?.get(relPath) ?? prev.get(relPath)?.commitCount ?? 0;
    const parseOpts: Parameters<typeof parseOneFile>[3] = {
      detectLanguage: detect,
      chunker,
      readFile,
      repoRoot: prev.repoPath,
      commitCount,
    };
    if (opts.parseCache !== undefined) parseOpts.parseCache = opts.parseCache;
    const entry = await parseOneFile(relPath, absPath, stat.mtimeMs, parseOpts);
    byPath.set(entry.filePath, entry);
  }
  return new SymbolIndexImpl(prev.repoPath, opts.stateId ?? prev.stateId, byPath);
}
