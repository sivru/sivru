// Per-level section rendering for the explainer (DESIGN-0018 Slice 2).
//
// SSR: every ExplainerNode becomes one pre-rendered <section data-route="<id>">.
// Empty states are features (locked in design review): a symbol with no @sivru
// block shows its derived facts plus a paste-able stub ("add intent"); a stub
// narrative becomes an "add a narrative" card; a module with no deps says so.
//
//   system  → narrative (or stub card) + module dep-graph SVG + module table
//   module  → header + in/out deps + package churn bar + package list
//   package → symbol list
//   symbol  → derived facts + @sivru block (or add-intent affordance) + radial

import { buildReverseDeps } from "../agent-map.js";
import { topHotNodes } from "../attention.js";
import type { ExplainerModel, ExplainerNode } from "../types.js";
import { escapeHtml as esc } from "./escape.js";
import { mdToHtml } from "./markdown.js";
import { routeOf } from "./routes.js";
import { renderBars, renderRadial, renderSystemMap } from "./svg.js";

/** The narrative stub sentinel prefix from narrative.ts (kept in sync). */
const STUB_NARRATIVE_PREFIX = "No system narrative yet";

/**
 * Static health annotations (DESIGN-0023 UI surfaces) computed off the model +
 * the enforcement resolver, threaded into the views as restrained badges:
 *   cycleMembers   → `↻ in a cycle`  (a module/package in a dependency cycle)
 *   brokenLinkages → `⚠ drift`       (a symbol whose @sivru linkage no longer resolves)
 * The text carries the meaning; color only reinforces (WCAG 1.4.1).
 */
export interface StaticAnnotations {
  cycleMembers: Set<string>;
  brokenLinkages: Set<string>;
}

interface Ctx {
  byId: Map<string, ExplainerNode>;
  reverseDeps: Map<string, string[]>; // module id → ids that depend on it
  ann: StaticAnnotations;
}

export interface Section {
  id: string;
  html: string;
}

const NO_ANNOTATIONS: StaticAnnotations = { cycleMembers: new Set(), brokenLinkages: new Set() };

/** Render every node in the model into a flat list of sections. */
export function renderSections(model: ExplainerModel, ann: StaticAnnotations = NO_ANNOTATIONS): Section[] {
  const byId = new Map<string, ExplainerNode>();
  const index = (n: ExplainerNode): void => {
    byId.set(n.id, n);
    n.children.forEach(index);
  };
  index(model.root);
  // Shared 1-hop neighbour helper (DESIGN-0024 T4) — one source of truth for
  // module reverse-deps across the HTML view and the agent `map` slice.
  const reverseDeps = buildReverseDeps(model);
  const ctx: Ctx = { byId, reverseDeps, ann };

  const sections: Section[] = [];
  const walk = (node: ExplainerNode, ancestors: ExplainerNode[]): void => {
    sections.push({ id: node.id, html: renderSection(node, ancestors, model, ctx) });
    for (const c of node.children) walk(c, [...ancestors, node]);
  };
  walk(model.root, []);
  return sections;
}

function renderSection(
  node: ExplainerNode,
  ancestors: ExplainerNode[],
  model: ExplainerModel,
  ctx: Ctx,
): string {
  let body: string;
  switch (node.level) {
    case "system":
      body = renderSystem(node, model, ctx);
      break;
    case "module":
      body = renderModule(node, ctx);
      break;
    case "package":
      body = renderPackage(node, ctx);
      break;
    default:
      body = renderSymbol(node, ctx);
  }
  const hidden = node.id === "system" ? "" : " hidden";
  return (
    `<section class="view" data-route="${esc(node.id)}"${hidden}>` +
    breadcrumb(ancestors, node) +
    body +
    `</section>`
  );
}

// ── health badges (cycle / drift) ─────────────────────────────────────────────

/** `↻ in a cycle` / `⚠ drift` chips for a node id, text-first (WCAG 1.4.1). */
function healthBadges(id: string, ann: StaticAnnotations): string {
  let out = "";
  if (ann.cycleMembers.has(id)) out += `<span class="badge cycle" title="member of a dependency cycle">↻ in a cycle</span>`;
  if (ann.brokenLinkages.has(id)) out += `<span class="badge drift" title="@sivru invariant→test linkage no longer resolves">⚠ drift</span>`;
  return out;
}

// ── breadcrumb ────────────────────────────────────────────────────────────────

function breadcrumb(ancestors: ExplainerNode[], node: ExplainerNode): string {
  const crumbs = [...ancestors, node].map((n, i, arr) =>
    i === arr.length - 1
      ? `<span class="crumb current">${esc(n.name)}</span>`
      : `<a class="crumb" href="${routeOf(n.id)}">${esc(n.name)}</a>`,
  );
  return `<nav class="breadcrumb">${crumbs.join('<span class="sep">›</span>')}</nav>`;
}

// ── system ────────────────────────────────────────────────────────────────────

function renderSystem(node: ExplainerNode, model: ExplainerModel, ctx: Ctx): string {
  const modules = model.root.children;
  const symbolsOf = (m: ExplainerNode): number =>
    m.children.reduce((n, p) => n + p.children.length, 0);
  const totalSymbols = modules.reduce((n, m) => n + symbolsOf(m), 0);
  const foundation = modules
    .filter((m) => m.derived.depEdges.length === 0)
    .map((m) => m.name);
  const labelOf = (id: string): string =>
    modules.find((m) => m.id === id)?.name ?? id;

  // Architecture: a layered system map (foundation → consumers), boxes sized by
  // symbol count. Leads the page; the narrative moves below.
  const edges = modules.flatMap((m) =>
    m.derived.depEdges.map((to) => ({ from: m.id, to })),
  );
  const map = modules.length
    ? renderSystemMap(
        modules.map((m) => ({
          id: m.id,
          name: m.name,
          sub: `${symbolsOf(m)} sym · churn ${m.derived.churn}`,
          size: symbolsOf(m),
        })),
        edges,
        (id) => routeOf(id),
      )
    : "";

  // Attention: where change meets coupling. A short ranked list — the first
  // place to read in an unfamiliar repo (and the spots a PR most wants review).
  const hot = topHotNodes(model, 8);
  const attention = hot.length
    ? `<h2>Attention <span class="muted">— churn × coupling</span></h2>` +
      `<ol class="attention">` +
      hot
        .map(
          (h) =>
            `<li><a href="${routeOf(h.ref.id)}">${esc(h.ref.name)}</a>` +
            `<span class="hot-meta">${h.churn} churn · ${h.coupling} links</span>` +
            `<span class="hot-score" title="churn × coupling">${h.hotScore}</span></li>`,
        )
        .join("") +
      `</ol>`
    : "";

  const overview = modules.length
    ? `<p class="overview">${modules.length} modules · ${totalSymbols} load-bearing symbols` +
      (foundation.length
        ? ` · foundation: ${foundation.map((f) => `<code>${esc(f)}</code>`).join(" ")}`
        : "") +
      `</p>`
    : "";

  const rows = modules
    .map(
      (m) =>
        `<tr><td><a href="${routeOf(m.id)}">${esc(m.name)}</a> ${healthBadges(m.id, ctx.ann)}</td>` +
        `<td class="num">${symbolsOf(m)}</td>` +
        `<td class="num">${m.derived.churn}</td>` +
        `<td class="muted">${m.derived.depEdges.map((d) => esc(labelOf(d))).join(", ") || "—"}</td></tr>`,
    )
    .join("");

  // Narrative LAST, rendered as markdown in a collapsed disclosure — never a
  // raw-text wall above the structure.
  const narrative = node.narrative ?? "";
  const narrativeBlock = narrative.startsWith(STUB_NARRATIVE_PREFIX)
    ? emptyCard(
        "No system narrative yet",
        "Add one in <code>.sivru/explainer.md</code> (or an ARCHITECTURE.md / README.md) and regenerate.",
      )
    : `<details class="narrative"><summary>About this system</summary><div class="md">${mdToHtml(narrative)}</div></details>`;

  // Feedback mode: suggest a system narrative (lands in .sivru/explainer.md).
  const narrBtn = `<button class="fb-narrative">+ suggest system narrative</button>`;
  return (
    `<h1>${esc(node.name)}</h1>` +
    overview +
    (map ? `<h2>Architecture</h2><div class="diagram-wrap">${map}</div>` : "") +
    attention +
    `<h2>Modules</h2><table class="grid"><thead><tr><th>Module</th><th class="num">Symbols</th><th class="num">Churn</th><th>Depends on</th></tr></thead><tbody>${rows}</tbody></table>` +
    narrativeBlock +
    narrBtn
  );
}

// ── module ────────────────────────────────────────────────────────────────────

function renderModule(node: ExplainerNode, ctx: Ctx): string {
  const out = node.derived.depEdges;
  const incoming = ctx.reverseDeps.get(node.id) ?? [];
  const nameOf = (id: string): string => ctx.byId.get(id)?.name ?? id;
  const linkList = (ids: string[]): string =>
    ids.length
      ? ids.map((id) => `<a href="${routeOf(id)}">${esc(nameOf(id))}</a>`).join(", ")
      : '<span class="muted">no internal dependencies</span>';

  const bar = node.children.length
    ? renderBars(
        node.children.map((p) => ({ label: p.name, value: p.derived.churn })),
      )
    : "";
  const pkgRows = node.children
    .map(
      (p) =>
        `<tr><td><a href="${routeOf(p.id)}">${esc(p.name)}</a></td>` +
        `<td class="num">${p.children.length}</td><td class="num">${p.derived.churn}</td></tr>`,
    )
    .join("");

  return (
    `<h1>${esc(node.name)} ${healthBadges(node.id, ctx.ann)}</h1>` +
    `<p class="meta">churn ${node.derived.churn} · ${node.children.length} packages</p>` +
    `<p class="deps"><strong>Depends on:</strong> ${linkList(out)}</p>` +
    `<p class="deps"><strong>Depended on by:</strong> ${linkList(incoming)}</p>` +
    (bar ? `<h2>Churn by package</h2><div class="diagram-wrap">${bar}</div>` : "") +
    `<h2>Packages</h2><table class="grid"><thead><tr><th>Package</th><th class="num">Symbols</th><th class="num">Churn</th></tr></thead><tbody>${pkgRows}</tbody></table>`
  );
}

// ── package ───────────────────────────────────────────────────────────────────

function renderPackage(node: ExplainerNode, ctx: Ctx): string {
  const rows = node.children
    .map(
      (s) =>
        `<tr><td><a href="${routeOf(s.id)}">${esc(s.name)}</a> ${healthBadges(s.id, ctx.ann)}</td>` +
        `<td>${s.block !== null ? '<span class="badge">@sivru</span>' : ""}</td>` +
        `<td class="num">${s.derived.churn}</td></tr>`,
    )
    .join("");
  return (
    `<h1>${esc(node.name)} ${healthBadges(node.id, ctx.ann)}</h1>` +
    `<p class="meta">${node.children.length} symbols · churn ${node.derived.churn}</p>` +
    `<table class="grid"><thead><tr><th>Symbol</th><th>Authored</th><th class="num">Churn</th></tr></thead><tbody>${rows}</tbody></table>`
  );
}

// ── symbol ────────────────────────────────────────────────────────────────────

function renderSymbol(node: ExplainerNode, ctx: Ctx): string {
  const d = node.derived;
  const facts =
    `<dl class="facts">` +
    `<dt>Path</dt><dd><code>${esc(node.path)}</code></dd>` +
    `<dt>Exports</dt><dd>${d.exports.map((e) => `<code>${esc(e)}</code>`).join(" ") || "—"}</dd>` +
    `<dt>Imports</dt><dd>${d.importsResolved.length}</dd>` +
    `<dt>Churn</dt><dd>${d.churn}</dd>` +
    `<dt>Collaborators</dt><dd>${d.collaborators.map((c) => `<code>${esc(c)}</code>`).join(" ") || "—"}</dd>` +
    `</dl>`;

  const block =
    node.block !== null
      ? renderBlock(node.block, {
          nodeId: node.id,
          path: node.path,
          symbol: node.id.split("#").pop() ?? node.name,
          hash: node.blockHash ?? "",
        })
      : addIntentAffordance(node);

  const radial = d.collaborators.length
    ? `<h2>Collaborators</h2><div class="diagram-wrap">${renderRadial(node.name, d.collaborators)}</div>`
    : "";

  // Feedback mode: leave a freeform note (recorded to .sivru/feedback-notes.md,
  // never auto-applied) for anything the structured fields can't capture.
  const noteBtn = `<button class="fb-note" data-node-id="${esc(node.id)}" data-path="${esc(node.path)}">+ note</button>`;

  return `<h1><code>${esc(node.name)}</code> ${healthBadges(node.id, ctx.ann)}</h1>` + facts + block + radial + noteBtn;
}

interface BlockMeta {
  nodeId: string;
  path: string;
  symbol: string;
  hash: string;
}

function renderBlock(
  block: NonNullable<ExplainerNode["block"]>,
  meta: BlockMeta,
): string {
  const b = block as Record<string, unknown>;
  // `data-editable` marks the fields the feedback mode (Slice 3) can edit:
  // scalars (set the value) and collaborators (set the array). Multi-line
  // invariants/decisions are not editable in v1 (the apply engine defers them).
  const ed = (key: string): string => ` data-editable data-edit-field="${key}"`;
  const scalar = (key: string, val: unknown, editable: boolean): string =>
    typeof val === "string" && val.length > 0
      ? `<dt>${esc(key)}</dt><dd${editable ? ed(key) : ""}>${esc(val)}</dd>`
      : "";
  const list = (key: string, val: unknown, editable: boolean): string => {
    if (!Array.isArray(val) || val.length === 0) return "";
    const items = val
      .map((v) => `<li>${esc(typeof v === "string" ? v : JSON.stringify(v))}</li>`)
      .join("");
    return `<dt>${esc(key)}</dt><dd${editable ? ed(key) : ""}><ul>${items}</ul></dd>`;
  };
  const attrs =
    ` data-node-id="${esc(meta.nodeId)}" data-path="${esc(meta.path)}"` +
    ` data-symbol="${esc(meta.symbol)}" data-hash="${esc(meta.hash)}"`;
  return (
    `<div class="block"${attrs}><div class="block-head">@sivru block</div><dl>` +
    scalar("role", b.role, true) +
    scalar("responsibility", b.responsibility, true) +
    scalar("maturity", b.maturity, true) +
    list("invariants", b.invariants, false) +
    list("decisions", b.decisions, false) +
    list("collaborators", b.collaborators, true) +
    `</dl></div>`
  );
}

function addIntentAffordance(node: ExplainerNode): string {
  const stub = esc(
    [
      "/**",
      " * @sivru",
      " * schema: 1",
      ` * role: ${node.name}`,
      " * responsibility: <one line — what this does and why>",
      " * maturity: experimental",
      " * @end",
      " */",
    ].join("\n"),
  );
  // In feedback mode, an un-annotated symbol with a known declaration line can
  // be authored straight from the explainer (a `create` in the exported patch).
  const symbol = node.id.split("#").pop() ?? node.name;
  const createBtn =
    node.declLine !== undefined
      ? `<button class="fb-create" data-node-id="${esc(node.id)}" data-path="${esc(node.path)}"` +
        ` data-symbol="${esc(symbol)}" data-decl="${node.declLine}">+ author @sivru block</button>`
      : "";
  return (
    `<div class="empty"><div class="empty-head">No @sivru block yet · add intent</div>` +
    `<p class="muted">Document this symbol where the truth lives — paste above its declaration in <code>${esc(node.path)}</code>:</p>` +
    `<pre class="stub">${stub}</pre>${createBtn}</div>`
  );
}

// ── shared ────────────────────────────────────────────────────────────────────

function emptyCard(head: string, bodyHtml: string): string {
  return `<div class="empty"><div class="empty-head">${esc(head)}</div><p class="muted">${bodyHtml}</p></div>`;
}
