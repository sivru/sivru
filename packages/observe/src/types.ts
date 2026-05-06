// Sivru observe — normalized event + session types.
// See DESIGN.md §5.3 (event model). Source-agnostic shape so the HTTP/WS
// server (W6) and savings counter (W7) can consume any SessionSource impl
// uniformly.

export type SivruEventKind =
  | "user_message"
  | "assistant_message"
  | "tool_use"
  | "tool_result"
  | "system"
  | "unknown";

export type SivruEvent = {
  /** Stable normalized type tag. */
  kind: SivruEventKind;
  /** Session id from the source line. */
  sessionId: string;
  /** 0-based monotonic index within the session. */
  index: number;
  /** ISO timestamp from the source line if available. */
  ts?: string;
  /** Plain text content for user/assistant messages. Concatenated when content was an array of text blocks. */
  text?: string;
  /** Tool name for tool_use / tool_result. */
  tool?: string;
  /** Raw input args for tool_use. */
  input?: unknown;
  /** Result payload for tool_result. */
  output?: unknown;
  /** True for tool_result entries that the source flagged as an error. */
  isError?: boolean;
  /** Original raw object as parsed from the jsonl line. */
  raw: unknown;
};

export type Session = {
  /** Session UUID matching the jsonl filename without extension. */
  id: string;
  /** Absolute path to the .jsonl file. */
  path: string;
  /**
   * Project directory the session ran in. Decoded from the parent directory
   * name (Claude Code encodes the cwd by replacing `/` with `-` and prefixing
   * with `-`; we decode by replacing `-` with `/` and trimming the leading
   * `/`. Best-effort — display only).
   */
  project: string;
  /**
   * Canonical project root, resolved via `git rev-parse --git-common-dir`
   * when the cwd is inside a git repo. All worktrees of the same repo share
   * this string, so the UI can group them under a single project entry.
   * Falls back to `project` when not in a git repo or `git` isn't available.
   */
  projectRoot: string;
  /** True when this cwd is a linked git worktree (vs. the main checkout). */
  isWorktree: boolean;
  /** Current branch checked out in this cwd; null when detached or unknown. */
  branch: string | null;
  /**
   * How `projectRoot` was determined. UI can render "inferred" with subtle
   * lower-confidence styling.
   *   "git"             — resolved by `git rev-parse --git-common-dir`. Reliable.
   *   "inferred-prefix" — cwd is gone but matched a verified root via path-prefix.
   *                       Likely a deleted worktree; not provable.
   *   "fallback-cwd"    — neither — projectRoot just equals cwd (unique).
   */
  projectRootSource: "git" | "inferred-prefix" | "fallback-cwd";
  /** ISO timestamp of the FIRST event in the file (or `null` if not yet read). */
  startedAt: string | null;
  /** ISO timestamp of the LAST event encountered. */
  updatedAt: string | null;
  /** Total events. Computed by reading the file end-to-end (cheap; jsonl is one line per event). */
  eventCount: number;
};
