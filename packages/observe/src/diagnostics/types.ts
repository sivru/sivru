// Diagnostic rules — pluggable session-level pattern matchers that
// surface known failure modes (looped grep, redundant reads, etc.) on
// the user's actual sessions. See issue #16.
//
// Three-layer extensibility (CONTRIBUTING.md):
//   1. Built-in rules at `packages/observe/src/diagnostics/rules/*`.
//   2. Declarative override at `~/.config/sivru/diagnostics.json`
//      (user-global) and `.sivru/diagnostics.json` (per-project).
//   3. Code-level rules at `.sivru/diagnostics/*.ts` — dynamically
//      loaded; full access to the same Session and SivruEvent shapes
//      the built-ins use.
//
// Implementation lands in v0.2; the types are committed now so
// contributors can extend without guessing the contract.

import type { Session, SivruEvent } from "../types.js";

/** How loud a finding is. UI surfaces all three; severity drives styling. */
export type DiagnosticSeverity = "info" | "warn" | "error";

/**
 * One match produced by a rule. Anchored to a specific event range so
 * the UI can highlight where in the session the pattern occurred.
 */
export type DiagnosticMatch = {
  /**
   * The rule that produced this match. Echoed back so the UI can group
   * matches and let the user mute a noisy rule.
   */
  ruleId: string;
  /** Severity from the producing rule (rules can promote/demote per-match). */
  severity: DiagnosticSeverity;
  /** One-line summary shown in the timeline. Plain text, no markdown. */
  summary: string;
  /** Optional longer explanation. Renders below the summary on click. */
  detail?: string;
  /** Inclusive event-index range the rule observed (matches a Session's `events[i]`). */
  range: { startIndex: number; endIndex: number };
  /**
   * Optional URL for the user to read the underlying pattern's
   * documentation. Built-in rules link to the failure-modes guide; user
   * rules can link to their internal wiki or omit.
   */
  helpUrl?: string;
};

/**
 * The contract every diagnostic rule satisfies. Rules are pure
 * functions of the session they observe — no I/O, no network, no global
 * state. Side-effect-free makes the loader testable and the rule
 * cache-friendly.
 */
export type DiagnosticRule = {
  /** Stable id; users reference this in their config to disable / re-severity. */
  readonly id: string;
  /** One-line description shown in the rule index. */
  readonly description: string;
  /** Default severity. User config can override per rule id. */
  readonly defaultSeverity: DiagnosticSeverity;
  /**
   * Run the rule against a session's events. Pure — no I/O. Returning
   * an empty array means "no problem detected." Async because some
   * rules may want to consult derived data; today most won't.
   */
  detect(events: readonly SivruEvent[], session: Session): Promise<DiagnosticMatch[]>;
};

/**
 * Declarative config shape. Loaded from
 * `~/.config/sivru/diagnostics.json` and overridden per-project at
 * `.sivru/diagnostics.json`. Project-local takes precedence.
 */
export type DiagnosticsConfig = {
  /** Rules disabled at runtime. Built-in or user. */
  disabled?: string[];
  /** Severity overrides per rule id. */
  severity?: Record<string, DiagnosticSeverity>;
  /**
   * Per-rule options forwarded to the rule. Built-in rules document
   * their own option shape; user rules accept whatever they want.
   */
  options?: Record<string, unknown>;
};

/**
 * Loader contract — composes built-in rules + user JSON config + user
 * TS files into the final rule list. Implementation lands in v0.2;
 * contributors can target this signature.
 */
export type DiagnosticRuleLoader = {
  load(opts?: {
    /** Project root; loader looks for `.sivru/diagnostics{.json,/*.ts}`. */
    repoRoot?: string;
    /** Globally override the user-config path (for tests). */
    userConfigPath?: string;
  }): Promise<DiagnosticRule[]>;
};
