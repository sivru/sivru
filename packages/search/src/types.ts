// Public types for @sivru/search.
//
// Engine architecture lives in DESIGN.md §4. This file is the type contract;
// implementations land progressively across W1–W4.

export type ChunkKind = "tree-sitter" | "line";

export type Chunk = {
  /** Repo-relative POSIX-style path (e.g. `src/foo.ts`). */
  filePath: string;
  /** 1-based inclusive line at which this chunk starts in the source file. */
  startLine: number;
  /** 1-based inclusive line at which this chunk ends. */
  endLine: number;
  /** Detected language id (e.g. `typescript`, `python`), or null when unknown. */
  language: string | null;
  /** Raw source text of this chunk, including the trailing newline of `endLine` if any. */
  content: string;
  /**
   * Origin of the chunk boundaries. `tree-sitter` for syntactic boundaries,
   * `line` for the fixed-window fallback chunker.
   */
  kind: ChunkKind;
  /**
   * AST node type that produced this chunk (e.g. `function_declaration`,
   * `class_definition`). Set by the tree-sitter chunker; `undefined` for
   * line-fallback and gap-fill chunks. See DESIGN-0001.
   */
  nodeType?: string;
  /**
   * Symbol name extracted from the node's identifier child (e.g.
   * `processPayment`). `undefined` for line/gap chunks and anonymous
   * nodes. Captured so the v0.6 `@sivru`-block layer binds to symbols
   * without re-parsing; also usable by ranking signals.
   */
  symbolName?: string;
};

export type SearchResult = {
  chunk: Chunk;
  score: number;
  source: "hybrid" | "semantic" | "bm25";
};

/** A file emitted by `walk()` along with metadata the cache layer needs. */
export type WalkEntry = {
  /** Repo-relative POSIX-style path, e.g. `src/foo.ts`. */
  filePath: string;
  /** Native absolute path on disk. */
  absPath: string;
  /** mtime in milliseconds since epoch. */
  mtimeMs: number;
  /** File size in bytes. */
  sizeBytes: number;
};

export type SkipReason =
  | "gitignore"
  | "binary"
  | "too-large"
  | "permission-denied"
  | "symlink-loop"
  | "not-a-regular-file";

export type WalkOptions = {
  /** Default: true. Honor `.gitignore` files (root + nested). `.git/` always skipped. */
  respectGitignore?: boolean;
  /** Default: false. Follow symlinks. Loops are bounded regardless. */
  followSymlinks?: boolean;
  /** Default: 1_048_576 (1 MiB). Files larger than this are skipped. */
  maxFileBytes?: number;
  /** Optional callback invoked once per skipped path. */
  onSkip?: (relPath: string, reason: SkipReason) => void;
};

export type ChunkOptions = {
  /** Default: 50. Maximum lines per chunk in the line-fallback path. */
  maxLines?: number;
  /** Default: 5. Lines of overlap between adjacent line-fallback chunks. */
  overlapLines?: number;
};
