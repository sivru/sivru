// Public types for `@sivru/search`'s explain module. DESIGN-0004 §1, §3b, §6.
//
// The canonical artifact JSON shape is the contract; the CLI markdown render
// is one cut over the same JSON the MCP tool returns. Truncation markers
// (`callers_truncated`, `callees_truncated`) and the `callers_skipped_reason`
// field are the visible-degradation pattern — `null` means "no degradation",
// a number / string means "we degraded, here is how".

import type { Chunk } from "../types.js";

export type ExplainErrorCode =
  | "SIVRU-E2001" // malformed path (absolute or `..` escape or empty)
  | "SIVRU-E2002" // symlink escape (realpath outside repoRoot)
  | "SIVRU-E2003" // unknown / unsupported language
  | "SIVRU-E2004" // symbol-not-found (region-level explain target missing)
  | "SIVRU-E2005" // cache load failure
  | "SIVRU-E2006" // git command failure
  | "SIVRU-E2007" // diff parse failure
  | "SIVRU-E2008" // invalid mcpCap config value
  | "SIVRU-E2009" // file not in repo (relative path resolves outside)
  | "SIVRU-E2010"; // index build failure

export class SivruExplainError extends Error {
  readonly code: ExplainErrorCode;
  constructor(code: ExplainErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SivruExplainError";
    this.code = code;
  }
}

/** Kind of exported symbol. */
export type ExportKind = "function" | "class" | "type" | "const" | "method" | "other";

export type Export = {
  /** Identifier name as exported. */
  name: string;
  kind: ExportKind;
  /** 1-based inclusive line where the export's source range begins. */
  startLine: number;
  /** 1-based inclusive line where the export's source range ends. */
  endLine: number;
  /** Best-effort signature string (one or a few lines). Empty when unknown. */
  signature: string;
};

export type ImportEdge = {
  /** Raw import statement text. */
  raw: string;
  /**
   * Resolved on-disk repo-relative path the import targets, or `null` when
   * the import is unresolvable (external package, type-only, etc.).
   */
  resolved: string | null;
  /** Specific identifiers imported (`{ foo, bar as baz }` → ["foo", "baz"]),
   *  best-effort. Empty when not extractable (`import "./x.css"`). */
  identifiers: string[];
};

/**
 * Per-file `@sivru` block cache entry. Populated at index-build time so
 * later staleness / graph checks don't have to re-parse the file
 * (DESIGN-0019 §2 / D3). `contentHash` is a sha256 prefix of the
 * canonical-JSON-stringified parsed block — stable across formatting-
 * only changes (which preserve the parsed shape) but sensitive to any
 * change that alters the YAML body.
 */
export type BlockCacheEntry = {
  /** 1-indexed source range of the @sivru/@end fence in the file. */
  startLine: number;
  endLine: number;
  /** Short sha256 of the canonical block JSON, or null on parse failure. */
  contentHash: string | null;
  /** Symbol name the block attaches to (`(module)` for module-level). */
  symbolName: string;
};

export type SymbolIndexEntry = {
  /** Repo-relative POSIX-style path. */
  filePath: string;
  /** Detected language id, or null. */
  language: string | null;
  exports: Export[];
  imports: ImportEdge[];
  /** Total commits touching this file in committed history. */
  commitCount: number;
  /** mtime in millis since epoch at index time. */
  mtimeMs: number;
  /**
   * DESIGN-0019 slot 2 (D3): per-file `@sivru` block cache. Empty array
   * when the file contains no blocks. Populated lazily by callers that
   * opt into block-aware indexing — `buildSymbolIndex` does NOT extract
   * blocks by default to keep the cost off the explain hot path.
   */
  blocks: BlockCacheEntry[];
};

export type SymbolIndex = {
  /** Absolute path to the repo root. */
  readonly repoPath: string;
  /** state_id under which this index was built. */
  readonly stateId: string;
  /** Number of files indexed. */
  size(): number;
  /** Lookup one file's entry, or `undefined` when absent. */
  get(filePath: string): SymbolIndexEntry | undefined;
  /** Every entry. Caller treats as readonly. */
  entries(): readonly SymbolIndexEntry[];
};

export type Resolver = {
  language: "typescript" | "javascript" | "python" | "go" | "java";
  /**
   * Resolve one import statement's target inside the repo. Returns a
   * repo-relative path (file or directory, per language) or `null` when
   * unresolvable.
   *
   * `repoRoot` is the absolute repo root; `fromFile` is the repo-relative
   * path of the importing file. `source` is the importing file's full text —
   * provided by `buildSymbolIndex` to spare resolvers a second disk read.
   * The Java resolver in particular needs it to parse `package x.y.z;` and
   * find the compilation source root; other resolvers ignore it.
   */
  resolveImport(
    importStmt: string,
    fromFile: string,
    repoRoot: string,
    source?: string,
  ): string | null;
  /**
   * Extract exports + raw imports from this file's tree-sitter chunks. The
   * chunker already produces `Chunk[]` with `symbolName` + `nodeType`; the
   * resolver narrows that down to language-specific export semantics.
   *
   * `source` is the full file text (needed for import parsing). The
   * resolver should NOT shell out, should NOT touch disk.
   */
  parseFile(filePath: string, source: string, chunks: readonly Chunk[]): {
    exports: Export[];
    imports: Omit<ImportEdge, "resolved">[];
  };
};

// ---------- artifact shape (DESIGN-0004 §1) -----------------------------

export type CallerRef = {
  /** Repo-relative path of the caller. */
  filePath: string;
  /** 1-based line where the relevant import statement appears. */
  line: number;
  /** Names imported from the target. */
  symbols: string[];
};

export type CalleeRef = {
  /** Repo-relative path of the callee target. For Go this is a directory. */
  filePath: string;
  /** Names referenced from the target. */
  symbols: string[];
};

export type ChurnInfo = {
  commitCount: number;
  /** ISO timestamp of last commit touching the path/region, or null. */
  lastCommitAt: string | null;
  /** The `--since` window in days that was applied. */
  sinceDays: number;
};

export type OwnershipEntry = {
  author: string;
  /** Integer percentage of file/region lines or commits attributed. */
  percent: number;
  /** Raw count (commits for file-level, lines for region-level). */
  count: number;
};

export type TestHit = {
  filePath: string;
  /** Approx test count (grepped) — informational. */
  cases: number;
};

export type AuthoredEntry = {
  /** Symbol name for kind:"symbol" entries; absent for kind:"module". */
  symbol?: string;
  /** "symbol" (per-symbol block) or "module" (top-of-file/package). */
  kind?: "symbol" | "module";
  /** 1-indexed inclusive line span of the @sivru .. @end fence. */
  startLine?: number;
  endLine?: number;
  /** Canonical block JSON; absent on v0.5 placeholder entries. */
  block?: import("../block/types.js").SivruBlockJSON;
  /**
   * v0.5 free-form body retained for backwards-compat across pre-v0.6
   * consumers; v0.6+ leaves this undefined and uses `block` instead.
   */
  body?: string;
};

export type ExplainArtifact = {
  /** Path or `path::symbol` of the explanation target. */
  path: string;
  public_api: Export[];
  callers: CallerRef[] | null;
  callees: CalleeRef[];
  churn: ChurnInfo;
  ownership: OwnershipEntry[];
  tests: TestHit[];
  /** Always empty in v0.5; v0.6 (DESIGN-0016) fills. */
  authored: AuthoredEntry[];
  /** `null` when not truncated; number of dropped entries otherwise. */
  callers_truncated: number | null;
  callees_truncated: number | null;
  /** `null` or `"precision-floor"` (D16 + D4). */
  callers_skipped_reason: string | null;
  /** Honest-scope footer string. */
  footer: string;
  /** Set only by --diff mode. Empty / absent in regular calls. */
  diff_mode?: true;
  removed_symbols?: RemovedSymbolReport[];
};

export type RemovedSymbolReport = {
  symbol: string;
  callers: CallerRef[];
  callers_truncated: number | null;
  callers_skipped_reason: string | null;
};

export type ExplainOptions = {
  /** Absolute path to the repo root. */
  repoRoot: string;
  /** Repo-relative file path (or `<path>::<symbol>` form for region). */
  target: string;
  /** Optional symbol filter — overrides parsing `::` in `target`. */
  symbol?: string;
  /** Churn window in days. Default 90. */
  sinceDays?: number;
  /** Call-graph depth. Default 1; v0.5 only supports 1. */
  depth?: number;
  /** When true, apply MCP cap to `callers`/`callees`. CLI passes false. */
  mcpCap?: number | null;
  /** When true, run --diff mode. */
  diff?: boolean;
};

// ---------- MCP envelope (DESIGN-0004 §1) -------------------------------

export type ExplainEnvelope = {
  tool: "sivru.explain";
  path: string;
  latencyMs: number;
  refreshMs: number;
  refreshDelta: {
    modified: number;
    added: number;
    removed: number;
    embedsRecomputed: number;
  };
  artifact: ExplainArtifact;
};
