// The gate (DESIGN-0023 Slice 3). `sivru explain --project --diff --gate` exits
// non-zero when the delta contains a regression worth blocking a PR on:
//
//   (a) a new dependency cycle, OR
//   (b) a broken `@sivru` invariant→test linkage (the moat).
//
// It ships WITH an escape hatch — `.sivru/gate-allowlist`, one finding key per
// line — so a known-accepted finding is suppressible without disabling the gate
// (a gate with no escape hatch gets deleted from CI on the first false fail). A
// suppressed finding is still REPORTED, never silently dropped.
//
// Exit contract: 0 = clean / all suppressed · 1 = gate fired · 2 = could-not-
// evaluate (the base, handled upstream in buildBaseModel). Never a silent 0.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArchDelta } from "./diff-types.js";
import type { DriftReport } from "./drift.js";

export interface GateFinding {
  kind: "cycle" | "linkage";
  /** Stable suppression key (canonical — rotation/order independent). */
  key: string;
  summary: string;
}
export interface GateResult {
  active: GateFinding[];
  suppressed: GateFinding[];
  fired: boolean;
}

/** Canonical key for a cycle — sorted members, so a rotated render maps to one key. */
const cycleKey = (members: string[]): string => `cycle:${[...members].sort().join(">")}`;
const linkageKey = (nodeId: string, enforcedBy: string): string => `linkage:${nodeId}:${enforcedBy}`;

/** Read `.sivru/gate-allowlist`: one key per line; `#` comments + blanks ignored. */
export async function loadAllowlist(repoRoot: string): Promise<Set<string>> {
  try {
    const text = await readFile(join(repoRoot, ".sivru", "gate-allowlist"), "utf8");
    const keys = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    return new Set(keys);
  } catch {
    return new Set(); // absent allowlist = nothing suppressed (the common case)
  }
}

/** Partition the gateable findings (new cycle, broken linkage) by the allowlist. */
export function evaluateGate(delta: ArchDelta, drift: DriftReport, allowlist: Set<string>): GateResult {
  const findings: GateFinding[] = [];
  for (const c of delta.cycles.added) {
    findings.push({ kind: "cycle", key: cycleKey(c.members), summary: `new dependency cycle: ${c.render}` });
  }
  for (const b of drift.broken) {
    findings.push({
      kind: "linkage",
      key: linkageKey(b.ref.id, b.enforcedBy),
      summary: `broken linkage: ${b.ref.name} — ${b.reason} (enforced-by ${b.enforcedBy})`,
    });
  }
  const active: GateFinding[] = [];
  const suppressed: GateFinding[] = [];
  for (const f of findings) (allowlist.has(f.key) ? suppressed : active).push(f);
  return { active, suppressed, fired: active.length > 0 };
}

/** Human/CI text for a gate run. Unguardable invariants are surfaced (never gated). */
export function formatGateText(result: GateResult, drift: DriftReport, baseRef: string): string {
  const out: string[] = [`Architectural gate vs ${baseRef}:`];
  if (!result.fired) {
    out.push(result.active.length === 0 && result.suppressed.length === 0
      ? `  PASS — no gateable regression.`
      : `  PASS — ${result.suppressed.length} finding(s) suppressed by allowlist.`);
  } else {
    out.push(`  FAIL — ${result.active.length} gateable regression(s):`);
    for (const f of result.active) out.push(`    ${f.kind === "cycle" ? "cycle  " : "linkage"}  ${f.summary}`);
    out.push(`  Suppress an accepted finding by adding its key to .sivru/gate-allowlist:`);
    for (const f of result.active) out.push(`    ${f.key}`);
  }
  for (const f of result.suppressed) out.push(`  suppressed  ${f.key}`);
  if (drift.unguardable.length) {
    out.push(`  unguardable — ${drift.unguardable.length} invariant(s) with enforced-by: null (review, not gated):`);
    for (const u of drift.unguardable.slice(0, 8)) out.push(`    ${u.ref.name}: ${u.rule}`);
  }
  return out.join("\n");
}
