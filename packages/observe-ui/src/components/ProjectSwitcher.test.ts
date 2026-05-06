import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectsFromSessions } from "./ProjectSwitcher";
import type { Session } from "../types";

function s(
  id: string,
  project: string,
  updatedAt: string | null = null,
  projectRoot: string = project,
  source: "git" | "inferred-prefix" | "fallback-cwd" = projectRoot === project
    ? "fallback-cwd"
    : "git",
): Session {
  return {
    id,
    path: `/tmp/${id}.jsonl`,
    project,
    projectRoot,
    isWorktree: project !== projectRoot,
    branch: null,
    projectRootSource: source,
    startedAt: null,
    updatedAt,
    eventCount: 0,
  };
}

describe("projectsFromSessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns [] for an empty input", () => {
    expect(projectsFromSessions([])).toEqual([]);
  });

  it("dedupes by project string and counts sessions", () => {
    const out = projectsFromSessions([
      s("a", "/p1"),
      s("b", "/p2"),
      s("c", "/p1"),
    ]);
    expect(out).toHaveLength(2);
    const p1 = out.find((p) => p.project === "/p1");
    expect(p1?.sessionCount).toBe(2);
    expect(p1?.basename).toBe("p1");
    expect(p1?.worktreeCount).toBe(1);
  });

  // The motivating bug: two worktrees of the same git repo had been
  // showing up as two unrelated projects. They share a `projectRoot`,
  // so they collapse to a single project entry — but worktreeCount=2.
  it("collapses worktrees of the same project root into one entry", () => {
    const out = projectsFromSessions([
      s("a", "/dev/sivru", null, "/dev/sivru"),               // main
      s("b", "/dev/sivru-feature-x", null, "/dev/sivru"),     // worktree
      s("c", "/dev/sivru-bug-fix", null, "/dev/sivru"),       // worktree
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.basename).toBe("sivru");
    expect(out[0]?.sessionCount).toBe(3);
    expect(out[0]?.worktreeCount).toBe(3);
  });

  it("does NOT collapse genuinely unrelated projects with the same basename", () => {
    const out = projectsFromSessions([
      s("a", "/work/sivru", null, "/work/sivru"),
      s("b", "/personal/sivru", null, "/personal/sivru"),
    ]);
    // Different projectRoot strings → separate entries.
    expect(out).toHaveLength(2);
  });

  it("flags projects with at least one live session", () => {
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const out = projectsFromSessions([
      s("a", "/p1", tenMinutesAgo),
      s("b", "/p1", oneMinuteAgo),
    ]);
    expect(out[0]?.hasLive).toBe(true);
  });

  it("does NOT flag projects whose sessions are all stale", () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const out = projectsFromSessions([s("a", "/p1", tenMinutesAgo)]);
    expect(out[0]?.hasLive).toBe(false);
  });

  it("sorts: live first, then by session count desc, then basename asc", () => {
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const out = projectsFromSessions([
      // Stale, 5 sessions — should be after live ones, but ahead of low-count stale
      s("a", "/zinc", stale),
      s("b", "/zinc", stale),
      s("c", "/zinc", stale),
      s("d", "/zinc", stale),
      s("e", "/zinc", stale),
      // Live, 1 session — should be first
      s("f", "/alpha", recent),
      // Stale, 1 session — last (basename starts with 'b')
      s("g", "/beta", stale),
    ]);
    expect(out.map((p) => p.basename)).toEqual(["alpha", "zinc", "beta"]);
  });

  it("two live projects sort by session count desc", () => {
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    const out = projectsFromSessions([
      s("a", "/small", recent),
      s("b", "/big", recent),
      s("c", "/big", recent),
      s("d", "/big", recent),
    ]);
    expect(out.map((p) => p.basename)).toEqual(["big", "small"]);
  });

  it("counts inferred-prefix sessions for the dropdown's '+N?' badge", () => {
    const out = projectsFromSessions([
      s("a", "/dev/proj", null, "/dev/proj", "git"),
      // Two sessions whose worktree dir is gone but whose path matched
      // /dev/proj via the server-side prefix inference.
      s("b", "/dev/proj-feat-x", null, "/dev/proj", "inferred-prefix"),
      s("c", "/dev/proj-feat-y", null, "/dev/proj", "inferred-prefix"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.sessionCount).toBe(3);
    expect(out[0]?.inferredCount).toBe(2);
  });

  it("does not flag inferredCount when sessions resolved via git", () => {
    const out = projectsFromSessions([
      s("a", "/dev/proj", null, "/dev/proj", "git"),
      s("b", "/dev/proj-feat-x", null, "/dev/proj", "git"),
    ]);
    expect(out[0]?.inferredCount).toBe(0);
  });

  // The toggle: when groupInferred=false, inferred-prefix sessions
  // should split back into their own entries — and inferredCount on the
  // verified parent drops to 0 since no inference was applied.
  it("disables collapse when groupInferred=false", () => {
    const sessions = [
      s("a", "/dev/proj", null, "/dev/proj", "git"),
      s("b", "/dev/proj-feat-x", null, "/dev/proj", "inferred-prefix"),
      s("c", "/dev/proj-feat-y", null, "/dev/proj", "inferred-prefix"),
    ];
    const grouped = projectsFromSessions(sessions, true);
    const split = projectsFromSessions(sessions, false);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.sessionCount).toBe(3);
    expect(grouped[0]?.inferredCount).toBe(2);

    expect(split).toHaveLength(3);
    // No session is grouped via inference now → inferredCount should be 0.
    for (const p of split) {
      expect(p.inferredCount).toBe(0);
    }
  });

  it("git-resolved worktrees keep collapsing regardless of the toggle", () => {
    const sessions = [
      s("a", "/dev/proj", null, "/dev/proj", "git"),
      // Verified worktree (its dir still exists, git resolved it).
      s("b", "/dev/proj-wt", null, "/dev/proj", "git"),
    ];
    expect(projectsFromSessions(sessions, true)).toHaveLength(1);
    expect(projectsFromSessions(sessions, false)).toHaveLength(1);
  });
});
