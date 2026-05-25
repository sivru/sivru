// memory-claude-age (DESIGN-0005 §3a).
//
// A file is "aged" when BOTH floors hold:
//   1. daysSinceLastEdit(file) ≥ ageDays  (default 90)
//   2. commitsSinceLastEdit(file) ≥ ageCommits  (default 50)
//
// In mtime-only mode (--no-git, git unavailable, or file outside the
// repo tree) only the day floor applies — otherwise no user-global
// file would ever flag, which would defeat the check's purpose.

import type { AuditContext, AuditFinding, MemoryCheck, MemoryFile } from "../types.js";
import { diffBucketsByFirstSegment } from "../git-stats.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const memoryClaudeAge: MemoryCheck = {
  id: "memory-claude-age",
  description:
    "Memory files (CLAUDE.md, SKILL.md, agent files) that are old enough on both calendar and commit-count axes to likely be drifting from current repo conventions.",
  defaultSeverity: "info",
  appliesTo: ["*"],

  async run(ctx: AuditContext): Promise<AuditFinding[]> {
    const now = Date.now();
    const out: AuditFinding[] = [];

    for (const file of ctx.memoryFiles) {
      if (file.unreadable === true) continue;
      const ageDays = daysSinceMs(now, pickEditTimeMs(file));
      const hasCommitData = file.commitsBehindHead !== undefined;
      const commitsBehind = file.commitsBehindHead ?? 0;

      const ageMet = ageDays >= ctx.config.ageDays;
      // In mtime mode the commit floor collapses to "satisfied" (§3a).
      const commitMet = hasCommitData ? commitsBehind >= ctx.config.ageCommits : true;

      if (!ageMet || !commitMet) continue;

      const data: Record<string, unknown> = {
        ageDays,
        ageDaysThreshold: ctx.config.ageDays,
      };
      if (hasCommitData) {
        data["commitsBehindHead"] = commitsBehind;
        data["commitsThreshold"] = ctx.config.ageCommits;
      } else {
        data["mode"] = "mtime";
      }

      // D6a "what changed since" delight — bucket the diff between the
      // file's last commit and HEAD by first path segment, top-3 by
      // count. Delight, not correctness — finding emits without the
      // preview when git is unavailable or the diff fails.
      let preview = "";
      if (!ctx.noGit && ctx.isGitRepo && file.lastCommitHash !== undefined) {
        const buckets = await diffBucketsByFirstSegment(ctx.repoRoot, file.lastCommitHash);
        if (buckets !== null && buckets.length > 0) {
          const parts = buckets.map((b) => `\`${b.segment}\` (${b.count} ${b.count === 1 ? "file" : "files"})`);
          preview = ` Biggest changes since: ${parts.join(", ")}.`;
          data["diffBuckets"] = buckets;
        }
      }

      const baseSummary = hasCommitData
        ? `${file.displayPath} last edited ${ageDays} days ago, ${commitsBehind} commits behind HEAD.`
        : `${file.displayPath} last touched ${ageDays} days ago (mtime mode; commit count unavailable).`;

      out.push({
        checkId: memoryClaudeAge.id,
        severity: memoryClaudeAge.defaultSeverity,
        filePath: file.path,
        summary: baseSummary + preview,
        detail:
          "File age is descriptive only — sivru does not know whether the content has drifted. Open the file and decide whether anything has gone stale since the last edit.",
        data,
      });
    }
    return out;
  },
};

function pickEditTimeMs(file: MemoryFile): number {
  // Prefer the git-recorded commit time when present — survives clones,
  // checkouts, and editor touches. Falls back to mtime when git is
  // unavailable.
  if (file.lastCommitTs !== undefined) return file.lastCommitTs * 1000;
  return file.mtimeMs;
}

function daysSinceMs(nowMs: number, thenMs: number): number {
  return Math.max(0, Math.floor((nowMs - thenMs) / MS_PER_DAY));
}
