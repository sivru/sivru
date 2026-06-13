import { describe, expect, it } from "vitest";

import { evaluateGate, formatGateText } from "./gate.js";
import type { ArchDelta, CycleDelta, NodeRef } from "./diff-types.js";
import type { DriftReport, BrokenLinkage } from "./drift.js";

const baseDelta = (): ArchDelta => ({
  baseRef: "main",
  nodes: { added: [], removed: [], changed: [] },
  edges: { added: [], removed: [] },
  cycles: { added: [] },
  blocks: { added: [], removed: [], changed: [] },
  churn: [],
});

const cycle = (members: string[]): CycleDelta => ({
  members,
  render: `${members.join(" → ")} → ${members[0]}`,
  closedBy: { from: members[members.length - 1]!, to: members[0]! },
});

const ref = (id: string, name: string): NodeRef => ({ id, level: "symbol", name, path: `${name}.ts` });
const broken = (id: string, name: string, enforcedBy: string): BrokenLinkage => ({
  ref: ref(id, name),
  rule: "must hold",
  enforcedBy,
  reason: "deleted",
});
const noDrift: DriftReport = { broken: [], unguardable: [] };

describe("evaluateGate", () => {
  it("PASSES (no fire) when there is no cycle and no broken linkage", () => {
    const r = evaluateGate(baseDelta(), noDrift, new Set());
    expect(r.fired).toBe(false);
    expect(r.active).toHaveLength(0);
  });

  it("FIRES on a new cycle", () => {
    const d = baseDelta();
    d.cycles.added.push(cycle(["a", "b"]));
    const r = evaluateGate(d, noDrift, new Set());
    expect(r.fired).toBe(true);
    expect(r.active[0]?.kind).toBe("cycle");
  });

  it("FIRES on a broken linkage (the moat)", () => {
    const drift: DriftReport = { broken: [broken("symbol:x", "ChurnAgg", "churn.test.ts::it")], unguardable: [] };
    const r = evaluateGate(baseDelta(), drift, new Set());
    expect(r.fired).toBe(true);
    expect(r.active[0]?.kind).toBe("linkage");
  });

  it("suppresses an allowlisted finding without disabling the gate", () => {
    const d = baseDelta();
    d.cycles.added.push(cycle(["a", "b"]));
    const drift: DriftReport = { broken: [broken("symbol:x", "ChurnAgg", "churn.test.ts::it")], unguardable: [] };
    // allowlist the cycle only → the linkage still fires.
    const allow = new Set(["cycle:a>b"]);
    const r = evaluateGate(d, drift, allow);
    expect(r.suppressed.map((f) => f.kind)).toEqual(["cycle"]);
    expect(r.active.map((f) => f.kind)).toEqual(["linkage"]);
    expect(r.fired).toBe(true);
  });

  it("does not fire when every finding is allowlisted", () => {
    const d = baseDelta();
    d.cycles.added.push(cycle(["a", "b"]));
    const r = evaluateGate(d, noDrift, new Set(["cycle:a>b"]));
    expect(r.fired).toBe(false);
    expect(r.suppressed).toHaveLength(1);
  });

  it("the cycle key is rotation-independent (canonical)", () => {
    const a = evaluateGate({ ...baseDelta(), cycles: { added: [cycle(["a", "b", "c"])] } }, noDrift, new Set());
    const b = evaluateGate({ ...baseDelta(), cycles: { added: [cycle(["b", "c", "a"])] } }, noDrift, new Set());
    expect(a.active[0]?.key).toBe(b.active[0]?.key);
  });
});

describe("formatGateText", () => {
  it("names the suppression key so a maintainer can copy it into the allowlist", () => {
    const d = baseDelta();
    d.cycles.added.push(cycle(["a", "b"]));
    const r = evaluateGate(d, noDrift, new Set());
    const text = formatGateText(r, noDrift, "main");
    expect(text).toContain("FAIL");
    expect(text).toContain("cycle:a>b");
    expect(text).toContain(".sivru/gate-allowlist");
  });

  it("surfaces unguardable invariants without gating on them", () => {
    const drift: DriftReport = { broken: [], unguardable: [{ ref: ref("symbol:y", "Thing"), rule: "best effort" }] };
    const r = evaluateGate(baseDelta(), drift, new Set());
    const text = formatGateText(r, drift, "main");
    expect(r.fired).toBe(false);
    expect(text).toContain("PASS");
    expect(text).toContain("unguardable");
    expect(text).toContain("Thing");
  });
});
