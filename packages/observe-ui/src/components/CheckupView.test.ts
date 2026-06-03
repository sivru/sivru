// Smoke tests for CheckupView's pure helpers.
//
// NOTE: a full React-mount smoke test is deferred — observe-ui doesn't
// declare @testing-library/react, and CLAUDE.md forbids adding deps
// without explicit approval. Manual browser verification documented in
// the PR body's verification checklist.

import { describe, expect, it } from "vitest";

import { countBlockDrift, groupFindings } from "./CheckupView";
import type { BlockDiagnostic, CheckupReport } from "../api";

describe("countBlockDrift (DESIGN-0021)", () => {
  it("counts only the cross-block drift codes E233-E236", () => {
    const diags: BlockDiagnostic[] = [
      { code: "SIVRU-E233", severity: "warning", message: "stale" },
      { code: "SIVRU-E234", severity: "warning", message: "asym" },
      { code: "SIVRU-E234", severity: "warning", message: "asym2" },
      { code: "SIVRU-E235", severity: "warning", message: "rename" },
      { code: "SIVRU-E236", severity: "warning", message: "order" },
      { code: "SIVRU-E217", severity: "error", message: "unrelated" },
    ];
    const c = countBlockDrift(diags);
    expect(c).toEqual({
      stale: 1,
      asymmetric: 2,
      renameSuspect: 1,
      orderContradiction: 1,
      total: 5,
    });
  });

  it("is all-zero when there are no drift codes", () => {
    expect(countBlockDrift([]).total).toBe(0);
  });
});

function fakeReport(): CheckupReport {
  return {
    schema: 1,
    repoRoot: "/repo",
    ranAt: "2026-05-24T00:00:00Z",
    files: [
      {
        path: "/repo/CLAUDE.md",
        displayPath: "./CLAUDE.md",
        kind: "claude-md",
        mtimeMs: 1,
      },
      {
        path: "/repo/.claude/skills/foo/SKILL.md",
        displayPath: "./.claude/skills/foo/SKILL.md",
        kind: "skill",
        mtimeMs: 1,
      },
      {
        path: "/repo/.claude/agents/bar.md",
        displayPath: "./.claude/agents/bar.md",
        kind: "agent",
        mtimeMs: 1,
        unreadable: true,
      },
    ],
    findings: [
      {
        checkId: "memory-claude-age",
        severity: "info",
        filePath: "/repo/CLAUDE.md",
        summary: "old",
      },
      {
        checkId: "memory-dead-reference",
        severity: "warning",
        filePath: "/repo/CLAUDE.md",
        line: 12,
        summary: "broken ref",
      },
      {
        checkId: "memory-skill-tools-drift",
        severity: "error",
        filePath: "/repo/CLAUDE.md",
        summary: "tool drift",
      },
    ],
    diagnostics: [],
  };
}

describe("CheckupView — groupFindings", () => {
  it("buckets findings under their file in the report's file order", () => {
    const g = groupFindings(fakeReport());
    expect(g.withFindings).toHaveLength(1);
    expect(g.withFindings[0]?.file.displayPath).toBe("./CLAUDE.md");
  });

  it("sorts findings within a file: error → warning → info (design-D1)", () => {
    const g = groupFindings(fakeReport());
    const order = g.withFindings[0]?.findings.map((f) => f.severity);
    expect(order).toEqual(["error", "warning", "info"]);
  });

  it("moves unreadable files into their own bucket", () => {
    const g = groupFindings(fakeReport());
    expect(g.unreadable).toHaveLength(1);
    expect(g.unreadable[0]?.displayPath).toBe("./.claude/agents/bar.md");
  });

  it("moves files with no findings (and no unreadable flag) into noFindings", () => {
    const g = groupFindings(fakeReport());
    expect(g.noFindings).toHaveLength(1);
    expect(g.noFindings[0]?.displayPath).toBe("./.claude/skills/foo/SKILL.md");
  });
});
