// Sivru coach loop — type surface (DESIGN-0005 §6).
//
// Public types consumed by the library entry (runCheckup), the future
// CLI command (`sivru checkup`), MCP tool, HTTP route, and observe-ui
// Checkup tab. The library output `CheckupReport` carries `schema: 1`
// — same evolution rules as DESIGN-0016 §5.

export type Severity = "info" | "warning" | "error";

export type MemoryFileKind = "claude-md" | "skill" | "agent";

export interface MemoryFile {
  /** Absolute path on disk. */
  path: string;
  /** Display path — `./foo` for repo-relative, `~/foo` for homedir-relative. */
  displayPath: string;
  kind: MemoryFileKind;
  /** Last-modified time in milliseconds since the epoch. */
  mtimeMs: number;
  /** Unix seconds of the file's last commit. Absent when --no-git or git unavailable. */
  lastCommitTs?: number;
  /** `git rev-list --count <last-commit>..HEAD`. Absent when --no-git or git unavailable. */
  commitsBehindHead?: number;
  /**
   * True when the file exists but EACCES prevented reading its content.
   * The file still appears in `files[]` so the user sees the skip; no
   * findings are emitted against it.
   */
  unreadable?: boolean;
}

export interface AuditFinding {
  /** Stable check id (e.g. "memory-claude-age"). Users reference it in config. */
  checkId: string;
  severity: Severity;
  /** Absolute path of the file the finding is about. */
  filePath: string;
  /** 1-indexed line number. Absent for whole-file findings. */
  line?: number;
  /** Plain-text one-liner. */
  summary: string;
  /** Longer rationale and / or suggested fix. */
  detail?: string;
  /** Structured payload (e.g. `{ ageDays: 130, commitsBehindHead: 487 }`). */
  data?: Record<string, unknown>;
}

export interface RunCheckupOptions {
  /**
   * When true, skip git shell-outs entirely. CLI `--no-git`. Falls back
   * to mtime + null commit count for every file.
   */
  noGit?: boolean;
  /**
   * When set, run only checks whose id appears in this list. CLI
   * `--check <id>` (repeatable). Unknown ids are silently ignored.
   */
  check?: readonly string[];
}

/**
 * Echoed back in the report so the user sees the precedence-resolved
 * config that actually ran.
 */
export interface CheckupConfig {
  ageDays: number;
  ageCommits: number;
  disabled: string[];
  severityOverrides: Record<string, Severity>;
  /** Globs of paths whose missing-target findings should be suppressed in dead-reference. */
  skipPaths: string[];
  pathExtensions: string[];
}

export interface CheckupReport {
  schema: 1;
  /** Absolute project root the run targeted. */
  repoRoot: string;
  /** ISO timestamp the run finished. */
  ranAt: string;
  /** Every file considered, even those that produced no findings. */
  files: MemoryFile[];
  findings: AuditFinding[];
  config: CheckupConfig;
  /** Non-blocking diagnostics surfaced alongside findings (e.g. SIVRU-E244). */
  diagnostics: ReportDiagnostic[];
}

/**
 * Infrastructure-level diagnostic — not a finding. Examples: git binary
 * missing, the run fell back to mtime-only, a file exceeded the
 * 200KB scan ceiling. Codes follow the v0.9 partition: SIVRU-E240–E249.
 */
export interface ReportDiagnostic {
  code: string;
  severity: Severity;
  message: string;
}

/**
 * Context passed into every check. Loader builds it once, shares it
 * across checks for efficiency. The repoFiles list is not pre-walked
 * here — the dead-reference check resolves paths against the filesystem
 * directly, which is cheaper than walking the whole repo upfront.
 */
export interface AuditContext {
  repoRoot: string;
  memoryFiles: readonly MemoryFile[];
  config: CheckupConfig;
  /** When true, checks must not shell out to git. */
  noGit: boolean;
  /**
   * When set, all repo-relative paths inside the checks resolve against
   * this root. Equals `repoRoot` when running against a git working
   * tree; null for runs against a non-repo path (user-global only).
   */
  isGitRepo: boolean;
}

/**
 * The contract every built-in check satisfies. v0.10 will surface this
 * to user-supplied `.sivru/checkup/*.ts` files; v0.9 ships the
 * interface without the dynamic loader (per §8 customization shape).
 */
export interface MemoryCheck {
  /** Stable id (e.g. "memory-claude-age"). */
  readonly id: string;
  /** One-line description shown when listing checks. */
  readonly description: string;
  /** Default severity; users override via `severityOverrides`. */
  readonly defaultSeverity: Severity;
  /**
   * Which memory-file kinds this check applies to. The orchestrator
   * filters `ctx.memoryFiles` before invoking the check. Use `["*"]`
   * to run against every file regardless of kind.
   */
  readonly appliesTo: readonly MemoryFileKind[] | ["*"];
  /** Run the check. Async because some checks shell out to git. */
  run(ctx: AuditContext): Promise<AuditFinding[]>;
}
