// Benchmark types — see annotations/<repo>.json for the on-disk shape.

export type Annotation = {
  /** Natural-language query a developer might ask. */
  query: string;
  /** File paths (repo-relative) considered fully relevant. */
  relevant: string[];
  /** File paths considered partially / contextually relevant (graded 0 in v0). */
  secondary: string[];
  /**
   * Coarse query category — "architecture" / "behavior" / "api" / etc. Used for
   * per-category breakdown reporting; not for scoring.
   */
  category: string;
};

export type RepoSpec = {
  name: string;
  language: "python" | "javascript" | "typescript" | "go" | "rust" | "java" | string;
  url: string;
  /** Pinned commit SHA. Determinism gate. */
  revision: string;
  /**
   * Subdirectory inside the repo that should be indexed. Many repos have
   * docs/tests/examples that bias retrieval; we score only against this root.
   */
  benchmark_root: string;
};

export type RetrievalResult = {
  /** Repo-relative file path. Multiple chunks per file count as one match. */
  filePath: string;
  /** Optional 1-based line range for chunk-level matches (not used in v0). */
  startLine?: number;
  endLine?: number;
  score: number;
};
