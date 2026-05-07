// Memory audit — pluggable checks that scan CLAUDE.md, ~/.claude/skills/*,
// and .claude/agents/* against the current state of the repo and flag
// staleness / contradictions / dead references. See issue #17.
//
// Three-layer extensibility (CONTRIBUTING.md):
//   1. Built-in checks at `packages/cli/src/lib/memory-audit/checks/*`.
//   2. Declarative override at `~/.config/sivru/memory-audit.json`
//      (user-global) and `.sivru/memory-audit.json` (per-project).
//   3. Code-level checks at `.sivru/memory-audit/*.ts` — dynamically
//      loaded; full access to repo + memory files.
//
// Implementation lands in v0.2 alongside `sivru doctor memory`.

/** Severity ordering: error > warn > info. CLI uses to colour output. */
export type CheckSeverity = "info" | "warn" | "error";

/**
 * One memory file the audit considers — CLAUDE.md, a skill SKILL.md, an
 * agent file, etc. Loader pre-reads contents so checks don't redo the
 * I/O.
 */
export type MemoryFile = {
  /** Absolute path on disk. */
  path: string;
  /** Display path (relative to repo root or `~`). */
  displayPath: string;
  /** Raw contents. */
  content: string;
  /** Last mtime in ms-since-epoch. */
  mtimeMs: number;
  /**
   * What kind of memory file this is. Drives which checks apply:
   * `claude-md` checks don't run against skill files and vice versa.
   */
  kind: "claude-md" | "skill" | "agent" | "other";
};

/** One observation produced by a check. */
export type AuditFinding = {
  /** Echoes the check's id; users reference it in config to mute. */
  checkId: string;
  /** Severity (the check may promote / demote per-finding). */
  severity: CheckSeverity;
  /** The memory file the finding is about (if anchored to one). */
  file?: MemoryFile;
  /** 1-indexed line number where applicable, else undefined. */
  line?: number;
  /** One-line description. Plain text. */
  summary: string;
  /** Optional longer rationale + suggested fix. */
  detail?: string;
};

/**
 * Context passed into every check. Loader builds it once and shares
 * across checks for efficiency.
 */
export type AuditContext = {
  /** Project root the audit is running over. */
  repoRoot: string;
  /** Already-read memory files. */
  memoryFiles: readonly MemoryFile[];
  /**
   * Files in the repo that exist now. Used by the dead-reference check
   * to verify CLAUDE.md's mentions resolve. Pre-walked once.
   */
  repoFiles: readonly string[];
  /**
   * Optional package.json at the repo root, parsed. Used by the
   * contradiction check (deps mentioned in CLAUDE.md must match).
   */
  packageJson?: Record<string, unknown>;
};

/** The contract every check satisfies. */
export type MemoryCheck = {
  /** Stable id. Users reference this in their config to disable / re-severity. */
  readonly id: string;
  /** One-line description shown when listing checks. */
  readonly description: string;
  /** Default severity. */
  readonly defaultSeverity: CheckSeverity;
  /**
   * Which memory-file kinds this check applies to. Loader skips it for
   * other kinds. Use `["*"]` to run against every file regardless.
   */
  readonly appliesTo: readonly MemoryFile["kind"][] | ["*"];
  /** Run the check. Async because some may shell out (`git log` for age). */
  run(ctx: AuditContext): Promise<AuditFinding[]>;
};

/** Declarative config loaded from `*memory-audit.json`. */
export type MemoryAuditConfig = {
  /** Checks disabled at runtime. */
  disabled?: string[];
  /** Severity overrides per check id. */
  severity?: Record<string, CheckSeverity>;
  /**
   * Glob-style paths to skip when running the dead-reference check.
   * Useful for files that intentionally mention placeholder paths.
   */
  skipPaths?: string[];
  /** Per-check options. Each check documents its own shape. */
  options?: Record<string, unknown>;
};
