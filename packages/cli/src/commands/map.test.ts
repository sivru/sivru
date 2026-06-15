import { describe, expect, it } from "vitest";

import { parseMapArgs, renderMap } from "./map.js";
import type { MapResult } from "../explainer/agent-map.js";
import type { FreshAsOf } from "../explainer/map-serve.js";

const fresh: FreshAsOf = { sha: "abc1234", dirty: false, stale: false, note: "current as of HEAD@abc1234" };
const freshStale: FreshAsOf = { sha: "abc1234", dirty: true, stale: true, note: "reflects HEAD@abc1234; changed since" };

describe("parseMapArgs", () => {
  it("parses a positional path", () => {
    const r = parseMapArgs(["src/foo.ts::bar"]);
    expect(r).toMatchObject({ kind: "ok", args: { path: "src/foo.ts::bar" } });
  });
  it("parses --symbol, --repo, --json", () => {
    const r = parseMapArgs(["src/foo.ts", "--symbol", "bar", "--repo=/tmp/x", "--json"]);
    expect(r).toMatchObject({ kind: "ok", args: { path: "src/foo.ts", symbol: "bar", repoRoot: "/tmp/x", json: true } });
  });
  it("parses --task", () => {
    const r = parseMapArgs(["--task", "where retry backoff lives"]);
    expect(r).toMatchObject({ kind: "ok", args: { task: "where retry backoff lives" } });
  });
  it("requires a target or --task", () => {
    expect(parseMapArgs([])).toMatchObject({ kind: "err" });
  });
  it("rejects an empty --task", () => {
    expect(parseMapArgs(["--task", "   "])).toMatchObject({ kind: "err" });
  });
  it("rejects an unknown flag", () => {
    expect(parseMapArgs(["x", "--nope"])).toMatchObject({ kind: "err" });
  });
  it("--help short-circuits", () => {
    expect(parseMapArgs(["--help"])).toEqual({ kind: "help" });
  });
});

describe("renderMap", () => {
  it("renders a slice with module, neighbours, health, and freshAsOf", () => {
    const slice: MapResult = {
      kind: "slice",
      target: { id: "symbol:a.ts#f", level: "symbol", name: "f", path: "a.ts" },
      module: { name: "alpha", role: "core", churn: 5, rank: 1, hotScore: 99 },
      dependsOn: [{ id: "module:b", level: "module", name: "beta", path: "b" }],
      dependedOnBy: [],
      collaborators: ["helper"],
      health: { hot: { score: 99, rank: 1 }, inCycle: { render: "a → b → a" }, driftBroken: [], unguardable: [] },
    };
    const out = renderMap(slice, fresh);
    expect(out).toContain("symbol: f");
    expect(out).toContain("module: alpha");
    expect(out).toContain("depends on: beta");
    expect(out).toContain("in cycle: a → b → a");
    expect(out).toContain("freshAsOf:");
  });

  it("renders the '+N more' overflow on capped neighbour and collaborator lists", () => {
    const slice: MapResult = {
      kind: "slice",
      target: { id: "symbol:a.ts#f", level: "symbol", name: "f", path: "a.ts" },
      module: { name: "alpha", churn: 1 },
      dependsOn: [{ id: "module:b", level: "module", name: "beta", path: "b" }],
      dependedOnBy: [],
      collaborators: ["helper"],
      health: { hot: null, inCycle: null, driftBroken: [], unguardable: [] },
      truncated: { dependsOn: 7, collaborators: 4 },
    };
    const out = renderMap(slice, fresh);
    expect(out).toContain("depends on: beta (+7 more)");
    expect(out).toContain("collaborators: helper (+4 more)");
  });

  it("renders did-you-mean candidates on an error", () => {
    const err: MapResult = {
      kind: "error",
      error: "no such target: a.ts::nope",
      candidates: [{ ref: { id: "symbol:a.ts#f", level: "symbol", name: "f", path: "a.ts" }, score: 0.9 }],
      hint: "closest matches",
    };
    const out = renderMap(err, fresh);
    expect(out).toContain("error: no such target");
    expect(out).toContain("did you mean:");
    expect(out).toContain("0.90");
  });

  it("flags staleness", () => {
    const slice: MapResult = {
      kind: "slice",
      target: { id: "x", level: "package", name: "p", path: "p" },
      module: null,
      dependsOn: [],
      dependedOnBy: [],
      collaborators: [],
      health: { hot: null, inCycle: null, driftBroken: [], unguardable: [] },
    };
    expect(renderMap(slice, freshStale)).toContain("[STALE]");
  });

  it("shows the authoring gap", () => {
    const slice: MapResult = {
      kind: "slice",
      target: { id: "x", level: "symbol", name: "f", path: "a.ts" },
      module: null,
      dependsOn: [],
      dependedOnBy: [],
      collaborators: [],
      health: { hot: null, inCycle: null, driftBroken: [], unguardable: [] },
      authoring: { stubHint: "No `@sivru` block here." },
    };
    expect(renderMap(slice, fresh)).toContain("authoring:");
  });
});
