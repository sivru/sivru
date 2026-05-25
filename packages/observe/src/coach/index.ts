// Coach loop public surface (DESIGN-0005).
//
// Library entry point — consumed by the future CLI (`sivru checkup`),
// MCP tool (`mcp__sivru__checkup`), and HTTP route
// (`GET /api/checkup`). This file is the only stable export surface;
// internal modules may move without breaking consumers.

import { homedir } from "node:os";

import { memoryClaudeAge } from "./checks/claude-age.js";
import { memoryDeadReference } from "./checks/dead-reference.js";
import { memorySkillToolsDrift } from "./checks/skill-tools-drift.js";
import { CheckupConfigError, loadCheckupConfig } from "./config.js";
import { commitsBehindHead, perFileStats, probeGit } from "./git-stats.js";
import { discoverMemoryFiles } from "./load.js";
import type {
  AuditContext,
  AuditFinding,
  CheckupReport,
  MemoryCheck,
  MemoryFile,
  ReportDiagnostic,
  RunCheckupOptions,
  Severity,
} from "./types.js";

export type {
  AuditContext,
  AuditFinding,
  CheckupConfig,
  CheckupReport,
  MemoryCheck,
  MemoryFile,
  MemoryFileKind,
  ReportDiagnostic,
  RunCheckupOptions,
  Severity,
} from "./types.js";
export { CheckupConfigError, DEFAULT_CONFIG, loadCheckupConfig } from "./config.js";
export { discoverMemoryFiles } from "./load.js";
export { BUILT_IN_CLAUDE_CODE_TOOLS, discoverAgentNames, isBuiltInTool } from "./known-tools.js";
export { runCmd, type ExecOptions, type ExecResult } from "./exec.js";
export { memoryClaudeAge } from "./checks/claude-age.js";
export { memoryDeadReference } from "./checks/dead-reference.js";
export { memorySkillToolsDrift } from "./checks/skill-tools-drift.js";

/** All built-in checks in the order they run. */
export const BUILT_IN_CHECKS: readonly MemoryCheck[] = [
  memoryClaudeAge,
  memoryDeadReference,
  memorySkillToolsDrift,
] as const;

/**
 * Run the checkup against `repoRoot` and return a structured report.
 *
 * Never throws on per-file failures (each one falls back gracefully
 * per the §3 failure modes). Throws only on config-load failure
 * (`SIVRU-E240`) — caller surfaces as a hard error.
 */
export async function runCheckup(
  repoRoot: string,
  opts: RunCheckupOptions = {},
): Promise<CheckupReport> {
  const config = await loadCheckupConfig(
    repoRoot,
    opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {},
  );
  const noGit = opts.noGit === true;

  const filter = opts.check;
  const enabledChecks = BUILT_IN_CHECKS.filter((c) => {
    if (config.disabled.includes(c.id)) return false;
    if (filter !== undefined && filter.length > 0 && !filter.includes(c.id)) return false;
    return true;
  });

  const diagnostics: ReportDiagnostic[] = [];
  const files = await discoverMemoryFiles(
    repoRoot,
    opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {},
  );

  // Probe + populate per-file git stats unless --no-git.
  let isGitRepo = false;
  if (!noGit) {
    const probe = await probeGit(repoRoot);
    if (probe.available) {
      isGitRepo = true;
      for (const f of files) {
        // Only files inside the repo benefit from git stats. User-global
        // files (`~/.claude/...`) skip the per-file git call entirely.
        if (f.displayPath.startsWith("~/")) continue;
        const stats = await perFileStats(repoRoot, f.path);
        if (stats !== null) {
          f.lastCommitTs = stats.lastCommitTs;
          f.lastCommitHash = stats.lastCommitHash;
          const behind = await commitsBehindHead(repoRoot, stats.lastCommitHash);
          if (behind !== null) f.commitsBehindHead = behind;
        }
      }
    } else {
      // §3a "Git failure modes": emit SIVRU-E244 once per run; treat
      // as `--no-git` thereafter. The message specifies which path
      // failed so the user knows where to look.
      diagnostics.push({
        code: "SIVRU-E244",
        severity: "info",
        message: probe.reason === "missing"
          ? "git binary not on PATH — running in mtime-only mode."
          : `${repoRoot} is not a git working tree — running in mtime-only mode.`,
      });
    }
  }

  const ctx: AuditContext = {
    repoRoot,
    memoryFiles: files,
    config,
    noGit,
    isGitRepo,
    homeDir: opts.homeDir ?? homedir(),
  };

  const findings: AuditFinding[] = [];
  for (const check of enabledChecks) {
    const applies = check.appliesTo;
    const scoped: MemoryFile[] = applies[0] === "*"
      ? [...files]
      : files.filter((f) => (applies as readonly string[]).includes(f.kind));
    const subCtx: AuditContext = { ...ctx, memoryFiles: scoped };
    const raw = await check.run(subCtx);
    for (const f of raw) {
      findings.push(applySeverityOverride(f, config.severityOverrides));
    }
  }

  return {
    schema: 1,
    repoRoot,
    ranAt: new Date().toISOString(),
    files,
    findings,
    config,
    diagnostics,
  };
}

function applySeverityOverride(
  f: AuditFinding,
  overrides: Record<string, Severity>,
): AuditFinding {
  const sev = overrides[f.checkId];
  if (sev === undefined) return f;
  return { ...f, severity: sev };
}
