// Authored-intent drift (DESIGN-0023 Slice 3 — the moat). For each symbol a PR
// TOUCHES that carries an `@sivru` block, re-check the DESIGN-0019 invariant→test
// linkage at HEAD: did this change delete/rename the `enforced-by` test, or does
// the reference no longer resolve? That broken linkage is the one signal worth
// gating a PR on — nobody else gates on authored-intent drift.
//
// Scope is the DIFF, not the whole repo: only symbols in the delta's
// added/changed nodes + added/changed blocks. Invariants with `enforced-by: null`
// are UNGUARDABLE — reported (never silently passing), never gated. The check
// does NOT run tests or judge semantics; it verifies the linkage resolves.

import { createEnforcementResolver, parseEnforcedBy } from "@sivru/search";
import type { ParsedReference } from "@sivru/search";

import type { ArchDelta, NodeRef } from "./diff-types.js";
import type { ExplainerModel, ExplainerNode } from "./types.js";

export interface BrokenLinkage {
  ref: NodeRef;
  rule: string;
  enforcedBy: string;
  reason: string;
}
export interface Unguardable {
  ref: NodeRef;
  rule: string;
}
export interface DriftReport {
  broken: BrokenLinkage[];
  unguardable: Unguardable[];
}

/** Injectable for tests; defaults to the real repo-walking resolver. */
export type ResolveFn = (
  ref: ParsedReference,
  repoRoot: string,
) => Promise<{ kind: "found"; skipped: boolean; reason?: string } | { kind: "missing"; reason: string }>;

const refOf = (n: ExplainerNode): NodeRef => ({ id: n.id, level: n.level, name: n.name, path: n.path });

/** Node ids the diff touched and could carry a (re-checkable) block at HEAD. */
function touchedIds(delta: ArchDelta): Set<string> {
  const ids = new Set<string>();
  for (const r of delta.nodes.added) ids.add(r.id);
  for (const c of delta.nodes.changed) ids.add(c.ref.id);
  for (const r of delta.blocks.added) ids.add(r.id);
  for (const r of delta.blocks.changed) ids.add(r.id);
  return ids; // removed nodes/blocks are gone from HEAD — nothing to re-check
}

export async function checkDrift(
  head: ExplainerModel,
  delta: ArchDelta,
  resolve?: ResolveFn,
): Promise<DriftReport> {
  // Default to a resolver that builds the whole-repo symbol map ONCE and reuses
  // it for every touched ref — resolveEnforcement rebuilds it per call, so a loop
  // would be O(refs) full-repo walks on the gate's CI hot path. An injected
  // `resolve` (tests) is honored verbatim.
  const resolveRef: (ref: ParsedReference) => ReturnType<ResolveFn> = resolve
    ? (ref) => resolve(ref, head.repoPath)
    : createEnforcementResolver(head.repoPath);
  const touched = touchedIds(delta);
  const byId = new Map<string, ExplainerNode>();
  const index = (n: ExplainerNode): void => {
    byId.set(n.id, n);
    n.children.forEach(index);
  };
  index(head.root);

  const broken: BrokenLinkage[] = [];
  const unguardable: Unguardable[] = [];
  for (const id of touched) {
    const node = byId.get(id);
    if (node === undefined || node.block === null) continue;
    for (const inv of node.block.invariantsV2 ?? []) {
      if (inv.enforcedBy === null) {
        unguardable.push({ ref: refOf(node), rule: inv.rule });
        continue;
      }
      const parsed = parseEnforcedBy(inv.enforcedBy);
      if (parsed === null) {
        broken.push({
          ref: refOf(node),
          rule: inv.rule,
          enforcedBy: inv.enforcedBy,
          reason: `malformed reference (expected \`Class.method\` or \`path::name\`)`,
        });
        continue;
      }
      const result = await resolveRef(parsed);
      if (result.kind === "missing") {
        broken.push({ ref: refOf(node), rule: inv.rule, enforcedBy: inv.enforcedBy, reason: result.reason });
      } else if (result.skipped) {
        broken.push({
          ref: refOf(node),
          rule: inv.rule,
          enforcedBy: inv.enforcedBy,
          reason: `resolves to a skipped/disabled test — no longer enforces`,
        });
      }
    }
  }
  // Stable order: by node id then rule, so output + allowlist keys don't churn.
  const k = (x: { ref: NodeRef; rule: string }): string => `${x.ref.id}\0${x.rule}`;
  broken.sort((a, b) => k(a).localeCompare(k(b)));
  unguardable.sort((a, b) => k(a).localeCompare(k(b)));
  return { broken, unguardable };
}

/**
 * Node ids carrying an `@sivru` block with at least one BROKEN invariant→test
 * linkage, across the WHOLE model (not diff-scoped). Drives the `⚠ drift` badge
 * on the static System page — drift you can see without a PR. One shared symbol
 * map amortises the resolution (createEnforcementResolver).
 */
export async function staticBrokenLinkages(model: ExplainerModel, resolve?: ResolveFn): Promise<Set<string>> {
  const resolveRef: (ref: ParsedReference) => ReturnType<ResolveFn> = resolve
    ? (ref) => resolve(ref, model.repoPath)
    : createEnforcementResolver(model.repoPath);
  const nodes: ExplainerNode[] = [];
  const walk = (n: ExplainerNode): void => {
    nodes.push(n);
    n.children.forEach(walk);
  };
  walk(model.root);

  const broken = new Set<string>();
  for (const node of nodes) {
    if (node.block === null) continue;
    for (const inv of node.block.invariantsV2 ?? []) {
      if (inv.enforcedBy === null) continue;
      const parsed = parseEnforcedBy(inv.enforcedBy);
      if (parsed === null) {
        broken.add(node.id);
        continue;
      }
      const r = await resolveRef(parsed);
      if (r.kind === "missing" || (r.kind === "found" && r.skipped)) broken.add(node.id);
    }
  }
  return broken;
}
