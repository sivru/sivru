import { describe, expect, it } from "vitest";

import { buildBaseModel } from "./diff-worktree.js";
import type { ExplainerModel } from "./types.js";

const fakeModel = (): ExplainerModel => ({
  schema: 1,
  repoPath: "/wt",
  stateId: "s",
  head: "h",
  root: { id: "system:r", level: "system", name: "r", path: ".", children: [], derived: { exports: [], importsResolved: [], churn: 0, depEdges: [], collaborators: [] }, block: null },
  stats: { files: 0, symbols: 0, modules: 0 },
});

/** A git mock: prefix-matches the joined args; `throwOn` fails matching commands. */
function gitMock(responses: Record<string, string>, throwOn: string[] = []) {
  const calls: string[][] = [];
  const git = async (args: string[]): Promise<string> => {
    calls.push(args);
    const key = args.join(" ");
    if (throwOn.some((t) => key.startsWith(t))) throw new Error(`git failed: ${key}`);
    for (const [k, v] of Object.entries(responses)) if (key.startsWith(k)) return v;
    return "";
  };
  return { git, calls };
}

describe("buildBaseModel", () => {
  it("resolves an explicit base, (re)creates the worktree, builds the model", async () => {
    const { git, calls } = gitMock({
      "rev-parse --verify foo": "abc123def456",
      "rev-parse HEAD": "stale-sha", // worktree exists but at a different sha → remove + add
    });
    const r = await buildBaseModel("/repo", "foo", { git, build: async () => fakeModel() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.baseRef).toBe("foo");
    const joined = calls.map((c) => c.join(" "));
    expect(joined.some((c) => c.startsWith("worktree add"))).toBe(true);
    expect(joined.some((c) => c.startsWith("worktree remove"))).toBe(true);
  });

  it("REUSES the worktree when it is already at the right sha (no remove/add)", async () => {
    const { git, calls } = gitMock({
      "rev-parse --verify foo": "abc123",
      "rev-parse HEAD": "abc123", // already at the base sha → reuse
    });
    const r = await buildBaseModel("/repo", "foo", { git, build: async () => fakeModel() });
    expect(r.ok).toBe(true);
    const joined = calls.map((c) => c.join(" "));
    expect(joined.some((c) => c.startsWith("worktree add"))).toBe(false);
    expect(joined.some((c) => c.startsWith("worktree remove"))).toBe(false);
  });

  it("returns ok:false (→ exit 2) when the base can't be resolved", async () => {
    const { git } = gitMock({}, ["rev-parse --verify badref"]);
    const r = await buildBaseModel("/repo", "badref", { git, build: async () => fakeModel() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not found|fetch-depth/);
  });

  it("falls back to merge-base with the default branch when no explicit base", async () => {
    const { git, calls } = gitMock({
      "rev-parse --verify origin/HEAD": "ok",
      "merge-base HEAD origin/HEAD": "mergebasesha",
      "rev-parse HEAD": "mergebasesha",
    });
    const r = await buildBaseModel("/repo", null, { git, build: async () => fakeModel() });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.join(" ").startsWith("merge-base HEAD origin/HEAD"))).toBe(true);
  });
});
