// Render an ArchDelta to a human/CI surface (DESIGN-0023 Slice 1).
//
// Three pure functions over the delta: text (the CI log / terminal), JSON (the
// tooling contract), and a GitHub markdown PR-comment body (emitted to stdout;
// the CI workflow posts/updates ONE comment by the hidden marker). Impact-
// ordered: cycles > new cross-module edges > block changes > node churn, so the
// most important thing leads. A long cycle is truncated (design review).

import type { DiffContext } from "./diff-context.js";
import type { ArchDelta, CycleDelta, NodeRef } from "./diff-types.js";

const NO_CHANGE = "No architectural change — this PR is structurally inert.";

/** A compact "module N, module N" footprint line, top-6 + overflow. */
function moduleFootprint(by: { module: string; count: number }[]): string {
  const head = by.slice(0, 6).map((b) => `${b.module} ${b.count}`);
  if (by.length > 6) head.push(`+${by.length - 6} more`);
  return head.join(", ");
}

/** Short display name for a node (drop the `level:` prefix noise). */
const short = (r: NodeRef): string => r.name || r.id;

/** Truncate a long cycle render: a → b → c → … (+N) → a. */
function cycleLine(c: CycleDelta): string {
  if (c.members.length <= 6) return c.render;
  const head = c.members.slice(0, 3);
  const hidden = c.members.length - 3;
  return `${head.join(" → ")} → … (+${hidden}) → ${head[0]}`;
}

/** True when the delta has nothing structural to report. */
export function isEmptyDelta(d: ArchDelta): boolean {
  return (
    d.nodes.added.length === 0 &&
    d.nodes.removed.length === 0 &&
    d.nodes.changed.length === 0 &&
    d.edges.added.length === 0 &&
    d.edges.removed.length === 0 &&
    d.cycles.added.length === 0 &&
    d.blocks.added.length === 0 &&
    d.blocks.removed.length === 0 &&
    d.blocks.changed.length === 0
  );
}

/** Terminal / CI-log text. Impact-ordered; explicit clean signal. */
export function formatDeltaText(d: ArchDelta, ctx?: DiffContext): string {
  const out: string[] = [`Architectural delta vs ${d.baseRef}:`];
  if (isEmptyDelta(d)) {
    out.push(`  ${NO_CHANGE}`);
    return out.join("\n");
  }
  for (const c of d.cycles.added) {
    out.push(`  cycle     NEW (parsed-import, module): ${cycleLine(c)}`);
    if (c.closedBy) out.push(`            closed by new edge: ${c.closedBy.from} → ${c.closedBy.to}`);
  }
  if (d.edges.added.length || d.edges.removed.length) {
    out.push(`  edges     +${d.edges.added.length}  -${d.edges.removed.length}`);
    for (const e of d.edges.added.slice(0, 10)) out.push(`            + ${e.from} → ${e.to}`);
    if (d.edges.added.length > 10) out.push(`            … +${d.edges.added.length - 10} more`);
  }
  const b = d.blocks;
  if (b.added.length || b.removed.length || b.changed.length) {
    const parts: string[] = [];
    if (b.changed.length) parts.push(`${b.changed.length} changed (${b.changed.slice(0, 3).map(short).join(", ")})`);
    if (b.added.length) parts.push(`${b.added.length} added`);
    if (b.removed.length) parts.push(`${b.removed.length} removed`);
    out.push(`  blocks    ${parts.join(", ")}`);
  }
  const n = d.nodes;
  if (n.added.length || n.removed.length || n.changed.length) {
    out.push(`  nodes     +${n.added.length} added · -${n.removed.length} removed · ~${n.changed.length} changed`);
  }
  if (ctx) {
    const s = ctx.surface;
    if (s.addedSymbolTotal || s.addedPackages.length || s.addedModules.length) {
      out.push(
        `  surface   +${s.addedSymbolTotal} symbols · +${s.addedPackages.length} packages · +${s.addedModules.length} modules`,
      );
      if (s.addedSymbolsByModule.length) out.push(`            by module: ${moduleFootprint(s.addedSymbolsByModule)}`);
      const newAreas = [...s.addedModules, ...s.addedPackages].map(short);
      if (newAreas.length) out.push(`            new: ${newAreas.slice(0, 6).join(", ")}${newAreas.length > 6 ? ` (+${newAreas.length - 6})` : ""}`);
    }
    if (ctx.hotspots.length) {
      out.push(`  hot spots touched (churn × coupling):`);
      for (const h of ctx.hotspots) out.push(`            ${h.hotScore}  ${short(h.ref)} (${h.kind}, churn ${h.churn})`);
    }
  }
  return out.join("\n");
}

export function formatDeltaJson(d: ArchDelta): string {
  return JSON.stringify(d);
}

/** Escape a name for safe inline-markdown (it goes inside a code span). */
const md = (s: string): string => "`" + s.replace(/`/g, "​`") + "`";

/**
 * A GitHub markdown PR-comment body. Leads with a hidden marker so the CI
 * workflow can find + replace ONE comment (no per-push spam). Emitted to stdout;
 * sivru never posts it (no GitHub token).
 */
export function formatDeltaGithub(d: ArchDelta, ctx?: DiffContext): string {
  const out: string[] = [
    "<!-- sivru-arch-delta -->",
    `### sivru · architectural delta vs ${md(d.baseRef)}`,
    "",
  ];
  if (isEmptyDelta(d)) {
    out.push("✅ **No architectural change** — this PR is structurally inert.");
    return out.join("\n");
  }
  if (d.cycles.added.length) {
    out.push("**⟳ New dependency cycle**");
    for (const c of d.cycles.added) {
      out.push(`- ${md(cycleLine(c))}${c.closedBy ? ` — closed by ${md(`${c.closedBy.from} → ${c.closedBy.to}`)}` : ""}`);
    }
    out.push("");
  }
  if (d.edges.added.length || d.edges.removed.length) {
    out.push(`**New coupling** — +${d.edges.added.length} edge(s), -${d.edges.removed.length} removed`);
    for (const e of d.edges.added.slice(0, 10)) out.push(`- ${md(`${e.from} → ${e.to}`)}`);
    if (d.edges.added.length > 10) out.push(`- … +${d.edges.added.length - 10} more`);
    out.push("");
  }
  const b = d.blocks;
  if (b.added.length || b.removed.length || b.changed.length) {
    out.push(`**@sivru blocks** — ${b.changed.length} changed, ${b.added.length} added, ${b.removed.length} removed`);
    for (const r of b.changed.slice(0, 8)) out.push(`- changed: ${md(short(r))}`);
    out.push("");
  }
  if (ctx) {
    const s = ctx.surface;
    if (s.addedSymbolTotal || s.addedPackages.length || s.addedModules.length) {
      out.push(`**New surface area** — +${s.addedSymbolTotal} symbols, +${s.addedPackages.length} packages, +${s.addedModules.length} modules`);
      if (s.addedSymbolsByModule.length) out.push(`- by module: ${moduleFootprint(s.addedSymbolsByModule)}`);
      const newAreas = [...s.addedModules, ...s.addedPackages].map((r) => md(short(r)));
      if (newAreas.length) out.push(`- new: ${newAreas.slice(0, 8).join(", ")}${newAreas.length > 8 ? ` (+${newAreas.length - 8})` : ""}`);
      out.push("");
    }
    if (ctx.hotspots.length) {
      out.push("**Touched hot spots** _(churn × coupling)_");
      for (const h of ctx.hotspots) out.push(`- ${md(short(h.ref))} — **${h.hotScore}** (${h.kind}, churn ${h.churn})`);
      out.push("");
    }
  }
  const n = d.nodes;
  out.push(`_${n.added.length} node(s) added · ${n.removed.length} removed · ${n.changed.length} changed (structural)._`);
  out.push("");
  out.push("_Informational — sivru does not gate on this signal yet (see DESIGN-0023)._");
  return out.join("\n");
}

export type DeltaFormat = "text" | "json" | "github";

export function formatDelta(d: ArchDelta, format: DeltaFormat, ctx?: DiffContext): string {
  if (format === "json") return formatDeltaJson(d);
  if (format === "github") return formatDeltaGithub(d, ctx);
  return formatDeltaText(d, ctx);
}
