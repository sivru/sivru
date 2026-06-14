import { describe, expect, it } from "vitest";

import { checkDrift, staticBrokenLinkages, staticDriftDetail } from "./drift.js";
import type { ResolveFn } from "./drift.js";
import type { ArchDelta } from "./diff-types.js";
import type { ExplainerModel, ExplainerNode, ExplainerDerived } from "./types.js";
import type { SivruBlockJSON, SivruInvariantJSON } from "@sivru/search";

const derived = (): ExplainerDerived => ({ exports: [], importsResolved: [], churn: 1, depEdges: [], collaborators: [] });

const block = (invariantsV2: SivruInvariantJSON[]): SivruBlockJSON => ({
  schema: 1,
  role: "x",
  responsibility: "y",
  maturity: null,
  collaborators: [],
  invariants: invariantsV2.map((i) => i.rule),
  invariantsV2,
  decisions: [],
});

const sym = (id: string, b: SivruBlockJSON | null): ExplainerNode => ({
  id,
  level: "symbol",
  name: id,
  path: `${id}.ts`,
  children: [],
  derived: derived(),
  block: b,
});

const model = (symbols: ExplainerNode[]): ExplainerModel => ({
  schema: 1,
  repoPath: "/repo",
  stateId: "s",
  head: "h",
  root: {
    id: "system",
    level: "system",
    name: "r",
    path: "",
    children: [
      { id: "module:m", level: "module", name: "m", path: "m", children: symbols, derived: derived(), block: null },
    ],
    derived: derived(),
    block: null,
  },
  stats: { files: 0, symbols: symbols.length, modules: 1 },
});

const delta = (touchedChanged: string[]): ArchDelta => ({
  baseRef: "main",
  nodes: { added: [], removed: [], changed: touchedChanged.map((id) => ({ ref: { id, level: "symbol", name: id, path: `${id}.ts` }, fields: ["block"] })) },
  edges: { added: [], removed: [] },
  cycles: { added: [] },
  blocks: { added: [], removed: [], changed: [] },
  churn: [],
});

const found: ResolveFn = async () => ({ kind: "found", skipped: false });
const missing: ResolveFn = async () => ({ kind: "missing", reason: "no declaration `gone`" });

describe("checkDrift", () => {
  it("reports a broken linkage when a touched symbol's enforced-by no longer resolves", async () => {
    const m = model([sym("symbol:m/a", block([{ rule: "must hold", enforcedBy: "a.test.ts::it" }]))]);
    const r = await checkDrift(m, delta(["symbol:m/a"]), missing);
    expect(r.broken).toHaveLength(1);
    expect(r.broken[0]?.reason).toContain("no declaration");
    expect(r.unguardable).toHaveLength(0);
  });

  it("does NOT re-check an untouched symbol (scope is the diff)", async () => {
    const m = model([
      sym("symbol:m/a", block([{ rule: "x", enforcedBy: "a.test.ts::it" }])),
      sym("symbol:m/untouched", block([{ rule: "y", enforcedBy: "gone.test.ts::it" }])),
    ]);
    const r = await checkDrift(m, delta(["symbol:m/a"]), missing);
    // only symbol:m/a was touched; the untouched broken one is invisible.
    expect(r.broken.map((b) => b.ref.id)).toEqual(["symbol:m/a"]);
  });

  it("counts enforced-by: null as unguardable, never broken", async () => {
    const m = model([sym("symbol:m/a", block([{ rule: "best effort", enforcedBy: null }]))]);
    const r = await checkDrift(m, delta(["symbol:m/a"]), found);
    expect(r.broken).toHaveLength(0);
    expect(r.unguardable).toEqual([{ ref: expect.objectContaining({ id: "symbol:m/a" }), rule: "best effort" }]);
  });

  it("treats a skipped test as a broken linkage (no longer enforces)", async () => {
    const m = model([sym("symbol:m/a", block([{ rule: "x", enforcedBy: "a.test.ts::it" }]))]);
    const skipped: ResolveFn = async () => ({ kind: "found", skipped: true });
    const r = await checkDrift(m, delta(["symbol:m/a"]), skipped);
    expect(r.broken).toHaveLength(1);
    expect(r.broken[0]?.reason).toContain("skipped");
  });

  it("flags a malformed enforced-by reference as broken without resolving", async () => {
    const m = model([sym("symbol:m/a", block([{ rule: "x", enforcedBy: "   " }]))]);
    let called = false;
    const r = await checkDrift(m, delta(["symbol:m/a"]), async () => {
      called = true;
      return { kind: "found", skipped: false };
    });
    expect(called).toBe(false);
    expect(r.broken[0]?.reason).toContain("malformed");
  });
});

describe("staticBrokenLinkages (System-page drift badge source)", () => {
  it("returns ids of all block symbols with a broken linkage, repo-wide (not diff-scoped)", async () => {
    const m = model([
      sym("symbol:m/a", block([{ rule: "x", enforcedBy: "a.test.ts::it" }])), // broken (missing)
      sym("symbol:m/b", block([{ rule: "y", enforcedBy: "b.test.ts::it" }])), // ok (found)
      sym("symbol:m/c", block([{ rule: "z", enforcedBy: null }])), // unguardable → not "broken"
    ]);
    const resolve: ResolveFn = async (ref) =>
      ref.kind === "file-anchored" && ref.path === "a.test.ts"
        ? { kind: "missing", reason: "gone" }
        : { kind: "found", skipped: false };
    const broken = await staticBrokenLinkages(m, resolve);
    expect([...broken]).toEqual(["symbol:m/a"]);
  });
});

describe("staticDriftDetail (DESIGN-0024 — per-node detail for the map slice)", () => {
  it("keeps the broken + unguardable detail per node, only for nodes with a signal", async () => {
    const m = model([
      sym("symbol:m/a", block([{ rule: "x", enforcedBy: "a.test.ts::it" }])), // broken (missing)
      sym("symbol:m/b", block([{ rule: "y", enforcedBy: "b.test.ts::it" }])), // ok → no entry
      sym("symbol:m/c", block([{ rule: "z", enforcedBy: null }])), // unguardable
    ]);
    const resolve: ResolveFn = async (ref) =>
      ref.kind === "file-anchored" && ref.path === "a.test.ts"
        ? { kind: "missing", reason: "gone" }
        : { kind: "found", skipped: false };
    const detail = await staticDriftDetail(m, resolve);
    expect([...detail.keys()].sort()).toEqual(["symbol:m/a", "symbol:m/c"]); // b is clear → absent
    expect(detail.get("symbol:m/a")!.broken[0]).toMatchObject({ rule: "x", enforcedBy: "a.test.ts::it" });
    expect(detail.get("symbol:m/c")!.unguardable).toEqual([{ ref: expect.anything(), rule: "z" }]);
  });

  it("staticBrokenLinkages and staticDriftDetail agree", async () => {
    const m = model([sym("symbol:m/a", block([{ rule: "x", enforcedBy: "a.test.ts::it" }]))]);
    const detail = await staticDriftDetail(m, missing);
    const broken = await staticBrokenLinkages(m, missing);
    expect([...broken]).toEqual([...detail.keys()].filter((id) => detail.get(id)!.broken.length > 0));
  });
});
