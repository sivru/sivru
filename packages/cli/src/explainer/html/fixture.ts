// Shared test fixture: a minimal but representative ExplainerModel.
import type { ExplainerDerived, ExplainerModel, ExplainerNode } from "../types.js";

function derived(over: Partial<ExplainerDerived> = {}): ExplainerDerived {
  return { exports: [], importsResolved: [], churn: 0, depEdges: [], collaborators: [], ...over };
}

export function fixtureModel(over: { narrative?: string } = {}): ExplainerModel {
  const symWithBlock: ExplainerNode = {
    id: "symbol:packages/a/src/x.ts#doThing",
    level: "symbol",
    name: "doThing",
    path: "packages/a/src/x.ts",
    children: [],
    derived: derived({ exports: ["doThing"], churn: 4, collaborators: ["helper", "parse"] }),
    block: {
      role: "worker",
      responsibility: "do the thing",
      maturity: "stable",
      collaborators: ["helper"],
      invariants: ["the queue is drained before exit"],
      decisions: [
        {
          chose: "a bounded queue",
          because: "unbounded growth OOMs under load",
          revisitIf: "we add backpressure upstream",
        },
      ],
    } as ExplainerNode["block"],
    blockHash: "h1deadbeef",
  };
  const symNoBlock: ExplainerNode = {
    id: "symbol:packages/a/src/x.ts#helper",
    level: "symbol",
    name: "helper",
    path: "packages/a/src/x.ts",
    children: [],
    derived: derived({ exports: ["helper"], churn: 4 }),
    block: null,
    declLine: 12,
  };
  const pkg: ExplainerNode = {
    id: "package:packages/a/src",
    level: "package",
    name: "src",
    path: "packages/a/src",
    children: [symWithBlock, symNoBlock],
    derived: derived({ churn: 4, depEdges: [] }),
    block: null,
  };
  const modA: ExplainerNode = {
    id: "module:packages/a",
    level: "module",
    name: "@scope/a",
    path: "packages/a",
    children: [pkg],
    derived: derived({ churn: 4, depEdges: ["module:packages/b"] }),
    block: null,
  };
  const modB: ExplainerNode = {
    id: "module:packages/b",
    level: "module",
    name: "@scope/b",
    path: "packages/b",
    children: [],
    derived: derived({ churn: 1, depEdges: [] }),
    block: null,
  };
  return {
    schema: 1,
    repoPath: "/repo",
    stateId: "state-1",
    head: "test",
    root: {
      id: "system",
      level: "system",
      name: "the-repo",
      path: "",
      children: [modA, modB],
      derived: derived({ churn: 5 }),
      block: null,
      narrative: over.narrative ?? "A small system that does things.",
    },
    stats: { files: 1, symbols: 2, modules: 2 },
  };
}

// A single-package repo: one synthetic root module (empty path), named after the
// repo, with packages directly under it. Used to assert nav surfaces (breadcrumb,
// tree) collapse the redundant module instead of repeating the repo name.
export function singlePackageModel(): ExplainerModel {
  const sym: ExplainerNode = {
    id: "symbol:src/auth/session.ts#validateSession",
    level: "symbol",
    name: "validateSession",
    path: "src/auth/session.ts",
    children: [],
    derived: derived({ exports: ["validateSession"] }),
    block: null,
  };
  const pkg: ExplainerNode = {
    id: "package:./auth",
    level: "package",
    name: "auth",
    path: "auth",
    children: [sym],
    derived: derived(),
    block: null,
  };
  const mod: ExplainerNode = {
    id: "module:.",
    level: "module",
    name: "acme",
    path: "",
    children: [pkg],
    derived: derived(),
    block: null,
  };
  return {
    schema: 1,
    repoPath: "/tmp/acme",
    stateId: "state-1",
    head: "test",
    root: {
      id: "system",
      level: "system",
      name: "acme",
      path: "",
      children: [mod],
      derived: derived(),
      block: null,
      narrative: "An acme service.",
    },
    stats: { files: 1, symbols: 1, modules: 1 },
  };
}
