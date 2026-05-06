// Duplicated from @sivru/observe's types.ts for runtime decoupling.
// The UI consumes JSON over /api and intentionally does not take a
// workspace dep on the server package. Keep these in sync by hand.

export type Session = {
  id: string;
  path: string;
  /** Raw cwd as recorded by Claude Code. */
  project: string;
  /**
   * Canonical git project root (server-resolved). Equal across worktrees of
   * the same repo. Falls back to `project` when the cwd isn't in a git repo.
   * Use this — not `project` — to group sessions by logical project.
   */
  projectRoot: string;
  /** True when this cwd is a linked git worktree (not the main checkout). */
  isWorktree: boolean;
  /** Branch checked out in the cwd; null on detached HEAD or non-git cwd. */
  branch: string | null;
  /**
   * How `projectRoot` was determined.
   *   "git"             — resolved by git rev-parse. Reliable.
   *   "inferred-prefix" — cwd is gone but matched a verified root via
   *                       path-prefix; UI should show "inferred" tag.
   *   "fallback-cwd"    — projectRoot just equals cwd (unique entry).
   */
  projectRootSource: "git" | "inferred-prefix" | "fallback-cwd";
  startedAt: string | null;
  updatedAt: string | null;
  eventCount: number;
};

export type SivruEventKind =
  | "user_message"
  | "assistant_message"
  | "tool_use"
  | "tool_result"
  | "system"
  | "unknown";

export type SivruEvent = {
  kind: SivruEventKind;
  sessionId: string;
  index: number;
  ts?: string;
  text?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  raw: unknown;
};

export type TurnCost = {
  index: number;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  usd: number | null;
};

/** Subset of @sivru/observe's SavingsEstimate the UI needs. */
export type SessionSavings = {
  sessionId: string;
  tokensSaved: number;
  tokensConsumed: number;
  percentSaved: number;
  searchCallCount: number;
  chunksReturnedTotal: number;
  dollarsConsumed: number;
  dollarsSaved: number | null;
  percentDollars: number | null;
  turns: TurnCost[];
};

export type AggregateSessionRow = {
  id: string;
  actualTokens: number;
  counterfactualTokens: number;
  tokensSaved: number;
  replaceableCallCount: number;
};

export type AggregateSavings = {
  sessionsCount: number;
  totals: {
    sessionCount: number;
    actualTokens: number;
    counterfactualTokens: number;
    tokensSaved: number;
    percentSaved: number;
    replaceableCallCount: number;
  };
  sessions: AggregateSessionRow[];
};

// Per-event counterfactual replay (DESIGN.md §6.5 / §20.3). Mirrors
// `@sivru/observe`'s ReplayedEvent / ReplayTotals — duplicated here for
// runtime decoupling (the UI consumes JSON over /api).
export type ReplayedEvent = {
  index: number;
  kind: "user_message" | "assistant_message" | "tool_use" | "tool_result" | "system" | "unknown";
  tool?: string;
  replaceableBySivru: boolean;
  actualTokens: number;
  counterfactualTokens: number;
  ts?: string;
  textSnippet?: string;
};

export type ReplayTotals = {
  actualTokens: number;
  counterfactualTokens: number;
  tokensSaved: number;
  /** Fraction in [0, 1]. */
  percentSaved: number;
  /** Number of tool_use calls flagged as search-replaceable. */
  replaceableCallCount: number;
};

export type SessionReplay = {
  sessionId: string;
  events: ReplayedEvent[];
  totals: ReplayTotals;
};
