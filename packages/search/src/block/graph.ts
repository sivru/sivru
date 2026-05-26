// Cross-block consistency graph (DESIGN-0019 §3). Builds the directed
// graph of `collaborators` references across every @sivru block in the
// repo, then emits:
//   - SIVRU-E234 collaborator-asymmetric — A → B but B → A absent.
//     Often intentional (A drives B; B is a leaf utility) — warning.
//   - SIVRU-E235 collaborator-rename-suspect — A → "OldName" doesn't
//     resolve, but "NewName" includes A as a collaborator. Heuristic.
//   - SIVRU-E236 collaborator-order-contradiction — textual A-after-B
//     vs B-after-A conflict. Opt-in via
//     `.sivru/block.json` `graph.orderingChecks: true`.
//
// `broken-collaborator` (DESIGN-0017 E220-range) stays on the single-
// block side; §3 is the cross-block sibling.

import { extractBlocksFromFiles } from "./extract.js";
import { loadBlockConfig } from "./config.js";
import { walk } from "../walker/walk.js";
import type { BlockDiagnostic, SourceRange } from "./types.js";

export type GraphNode = {
  /** Symbol name (or "(module)" for module-level blocks). */
  name: string;
  /** Absolute file path the block lives in. */
  filePath: string;
  /** Source range of the @sivru fence. */
  range: SourceRange;
  /** Collaborator list as declared in the block. */
  collaborators: string[];
};

export type GraphEdge = {
  from: string;
  to: string;
  /** True when an edge B → A also exists; false when A → B is one-sided. */
  reciprocal: boolean;
};

export type BlockGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: BlockDiagnostic[];
};

const SKIP_PATH_SEGMENTS = [
  "/dist/",
  "/node_modules/",
  "/__fixtures__/",
  "/.git/",
];

function isSkippablePath(absPath: string): boolean {
  const normalized = absPath.replace(/\\/g, "/");
  for (const seg of SKIP_PATH_SEGMENTS) {
    if (normalized.includes(seg)) return true;
  }
  return false;
}

/**
 * Build the block-collaborator graph and surface cross-block diagnostics.
 *
 * @sivru
 * schema: 1
 * role: block-graph
 * responsibility: walk every @sivru block, build the collaborator graph, and emit SIVRU-E234/E235/E236
 * collaborators: [extractBlocksFromFiles, loadBlockConfig]
 * invariants:
 *   - rule: graph build is O(N × M) where N = blocked symbols, M = avg collaborators length — fine at repo scale
 *     enforced-by: null
 *   - rule: SIVRU-E236 is opt-in via graph.orderingChecks
 *     enforced-by: null
 * decisions:
 *   - chose: in-memory graph per invocation rather than indexed graph storage
 *     because: graph is small (10s-100s of edges); persistence cost outweighs build cost
 *     valid-while: blocked-symbol count stays under ~1000 per repo
 *     revisit-if: a customer hits a multi-thousand-block repo and graph build dominates CLI runtime
 * maturity: experimental
 * @end
 */
export async function computeBlockGraph(rootPath: string): Promise<BlockGraph> {
  const cfg = loadBlockConfig(rootPath);
  const files: string[] = [];
  for await (const entry of walk(rootPath)) {
    if (isSkippablePath(entry.absPath)) continue;
    files.push(entry.absPath);
  }
  const extracted = await extractBlocksFromFiles(files);

  const nodes: GraphNode[] = [];
  for (const eb of extracted) {
    if (eb.block === null) continue;
    const name = eb.symbolName ?? "(module)";
    nodes.push({
      name,
      filePath: eb.filePath,
      range: eb.range,
      collaborators: eb.block.collaborators ?? [],
    });
  }

  const byName = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const arr = byName.get(n.name);
    if (arr === undefined) byName.set(n.name, [n]);
    else arr.push(n);
  }

  const edges: GraphEdge[] = [];
  for (const node of nodes) {
    for (const coll of node.collaborators) {
      const reciprocal = (byName.get(coll) ?? []).some((n) =>
        n.collaborators.includes(node.name),
      );
      edges.push({ from: node.name, to: coll, reciprocal });
    }
  }

  const diagnostics: BlockDiagnostic[] = [];
  const allowedAsymmetric = new Set(cfg.graph?.allowedAsymmetric ?? []);

  // E235 needs back-reference candidates indexed once per graph build:
  // for each node, which nodes list it as a collaborator?
  const backRefsByTarget = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    for (const coll of node.collaborators) {
      const arr = backRefsByTarget.get(coll);
      if (arr === undefined) backRefsByTarget.set(coll, [node]);
      else arr.push(node);
    }
  }

  // SIVRU-E234 / SIVRU-E235.
  for (const edge of edges) {
    const edgeKey = `${edge.from}->${edge.to}`;
    if (allowedAsymmetric.has(edgeKey)) continue;
    if (edge.reciprocal) continue;

    const source = nodes.find((n) => n.name === edge.from);

    // E235 rename-suspect requires real evidence, not just "any node
    // lists A". The signal is:
    //   1. edge.to doesn't resolve (no node with that name)
    //   2. EXACTLY ONE other node Y back-references edge.from
    //      (multiple candidates → can't pick a winner; skip)
    //   3. Y is not edge.from itself and not edge.to
    // Without uniqueness we'd false-positive on every fan-in (e.g.,
    // `Logger` collaborates with many services; missing one wouldn't
    // mean "rename to Logger" just because Logger references back).
    const resolved = byName.has(edge.to);
    if (!resolved) {
      const candidates = (backRefsByTarget.get(edge.from) ?? []).filter(
        (n) => n.name !== edge.from && n.name !== edge.to,
      );
      if (candidates.length === 1) {
        const candidate = candidates[0]!;
        diagnostics.push({
          code: "SIVRU-E235",
          severity: "warning",
          message: `collaborator-rename-suspect: ${edge.from} → "${edge.to}" does not resolve; the only symbol that back-references ${edge.from} is ${candidate.name} — possible rename`,
          ...(source?.range !== undefined ? { location: source.range } : {}),
        });
        continue;
      }
    }

    diagnostics.push({
      code: "SIVRU-E234",
      severity: "warning",
      message: `collaborator-asymmetric: ${edge.from} → ${edge.to} but ${edge.to} does not reciprocate`,
      ...(source?.range !== undefined ? { location: source.range } : {}),
    });
  }

  // SIVRU-E236 (opt-in). Textual A-after-B vs B-after-A.
  if (cfg.graph?.orderingChecks === true) {
    const afterRefs = new Map<string, Set<string>>(); // name → {names declared "runs after"}
    for (const eb of extracted) {
      if (eb.block === null) continue;
      const me = eb.symbolName ?? "(module)";
      const sources: string[] = [];
      for (const inv of eb.block.invariants ?? []) {
        sources.push(typeof inv === "string" ? inv : inv.rule);
      }
      for (const dec of eb.block.decisions ?? []) {
        sources.push(dec.chose);
      }
      const set = new Set<string>();
      for (const text of sources) {
        for (const m of text.matchAll(/runs after\s+(\w+)/gi)) {
          set.add(m[1]!);
        }
      }
      afterRefs.set(me, set);
    }
    for (const [a, others] of afterRefs.entries()) {
      for (const b of others) {
        const bAfters = afterRefs.get(b);
        if (bAfters?.has(a) === true) {
          const sourceNode = nodes.find((n) => n.name === a);
          diagnostics.push({
            code: "SIVRU-E236",
            severity: "warning",
            message: `collaborator-order-contradiction: ${a} says "runs after ${b}" while ${b} says "runs after ${a}"`,
            ...(sourceNode?.range !== undefined ? { location: sourceNode.range } : {}),
          });
        }
      }
    }
  }

  return { nodes, edges, diagnostics };
}
