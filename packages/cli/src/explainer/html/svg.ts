// Inline-SVG diagrams for the explainer (DESIGN-0018 Slice 2).
//
// Three diagrams, all hand-rolled (no library): a layered module dependency
// graph, a sorted churn/size bar, and a per-symbol radial collaborator graph.
// Each splits LAYOUT (a pure function → coordinates + dimensions, unit-tested
// for in-bounds + determinism) from RENDER (coordinates → SVG string). Layouts
// are deterministic: the same model always yields identical geometry, which is
// what lets a regenerated artifact be byte-stable.
//
//   layeredDag:  depends-on graph, depended-upon nodes sink to layer 0
//   barLayout:   sorted descending, bar width ∝ value
//   radialLayout: ego-graph, neighbours evenly spaced on a ring

import { escapeHtml } from "./escape.js";

export interface Point {
  x: number;
  y: number;
}
export interface Dims {
  width: number;
  height: number;
}

// ── layered DAG (module dependency graph) ────────────────────────────────────

const NODE_W = 150;
const NODE_H = 34;
const COL_GAP = 200;
const ROW_GAP = 48;
const PAD = 16;

export interface DagNodeBox extends Point {
  id: string;
  layer: number;
}
export interface DagLayout extends Dims {
  boxes: DagNodeBox[];
}

/**
 * Longest-path layering of a "depends on" graph. A node that depends on nothing
 * is layer 0; a node's layer is 1 + the max layer of the nodes it depends on.
 * Cycles are broken deterministically (a back-edge into an in-progress node
 * contributes layer 0), so the function always terminates. Within a layer,
 * nodes are ordered by id for reproducibility.
 */
export function layeredDag(
  nodeIds: readonly string[],
  edges: readonly { from: string; to: string }[],
): DagLayout {
  const ids = [...new Set(nodeIds)];
  const idSet = new Set(ids);
  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);
  for (const e of edges) {
    if (idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to) {
      out.get(e.from)!.push(e.to);
    }
  }

  const layer = new Map<string, number>();
  const inProgress = new Set<string>();
  const computeLayer = (id: string): number => {
    const memo = layer.get(id);
    if (memo !== undefined) return memo;
    if (inProgress.has(id)) return 0; // cycle: break deterministically
    inProgress.add(id);
    let best = 0;
    for (const target of out.get(id)!) {
      best = Math.max(best, computeLayer(target) + 1);
    }
    inProgress.delete(id);
    layer.set(id, best);
    return best;
  };
  for (const id of ids) computeLayer(id);

  // Group by layer, order each layer by id (deterministic).
  const byLayer = new Map<number, string[]>();
  let maxLayer = 0;
  for (const id of ids) {
    const l = layer.get(id)!;
    maxLayer = Math.max(maxLayer, l);
    (byLayer.get(l) ?? byLayer.set(l, []).get(l)!).push(id);
  }
  let maxRows = 1;
  const boxes: DagNodeBox[] = [];
  for (let l = 0; l <= maxLayer; l++) {
    const group = (byLayer.get(l) ?? []).sort();
    maxRows = Math.max(maxRows, group.length);
    group.forEach((id, row) => {
      boxes.push({
        id,
        layer: l,
        x: PAD + l * COL_GAP,
        y: PAD + row * ROW_GAP,
      });
    });
  }
  return {
    boxes,
    width: PAD * 2 + maxLayer * COL_GAP + NODE_W,
    height: PAD * 2 + (maxRows - 1) * ROW_GAP + NODE_H,
  };
}

/** Render the dependency graph. `labels` maps node id → display text; `href`
 *  maps node id → an optional link target (module page). */
export function renderDepGraph(
  nodeIds: readonly string[],
  edges: readonly { from: string; to: string }[],
  labels: (id: string) => string,
  href: (id: string) => string | null,
): string {
  const layout = layeredDag(nodeIds, edges);
  const center = new Map<string, Point>();
  for (const b of layout.boxes) {
    center.set(b.id, { x: b.x + NODE_W / 2, y: b.y + NODE_H / 2 });
  }
  const lines: string[] = [];
  // Edges first (under the boxes). Right edge of `from` → left edge of `to`.
  for (const e of edges) {
    const a = center.get(e.from);
    const b = center.get(e.to);
    if (a === undefined || b === undefined || e.from === e.to) continue;
    lines.push(
      `<line class="edge" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" marker-end="url(#arrow)" />`,
    );
  }
  for (const box of layout.boxes) {
    const label = escapeHtml(labels(box.id));
    const link = href(box.id);
    const rect =
      `<rect class="node" x="${box.x}" y="${box.y}" width="${NODE_W}" height="${NODE_H}" rx="5" />` +
      `<text class="node-label" x="${box.x + NODE_W / 2}" y="${box.y + NODE_H / 2}">${label}</text>`;
    lines.push(
      link !== null
        ? `<a href="${escapeHtml(link)}">${rect}</a>`
        : `<g>${rect}</g>`,
    );
  }
  return svgEl(layout, lines.join(""), true);
}

// ── sorted bars (churn / size) ───────────────────────────────────────────────

const BAR_LABEL_W = 130;
const BAR_MAX_W = 220;
const BAR_H = 18;
const BAR_GAP = 26;

export interface Bar extends Point {
  label: string;
  value: number;
  width: number;
}
export interface BarLayout extends Dims {
  bars: Bar[];
}

/** Sort items descending by value; bar width is proportional to value/max. */
export function barLayout(
  items: readonly { label: string; value: number }[],
): BarLayout {
  const sorted = [...items].sort(
    (a, b) => b.value - a.value || a.label.localeCompare(b.label),
  );
  const max = Math.max(1, ...sorted.map((i) => i.value));
  const bars: Bar[] = sorted.map((item, i) => ({
    label: item.label,
    value: item.value,
    x: PAD + BAR_LABEL_W,
    y: PAD + i * BAR_GAP,
    width: max === 0 ? 0 : (item.value / max) * BAR_MAX_W,
  }));
  return {
    bars,
    width: PAD * 2 + BAR_LABEL_W + BAR_MAX_W,
    height: PAD * 2 + Math.max(1, sorted.length) * BAR_GAP,
  };
}

export function renderBars(
  items: readonly { label: string; value: number }[],
): string {
  const layout = barLayout(items);
  const parts = layout.bars.map((bar) => {
    const label = escapeHtml(bar.label);
    return (
      `<text class="bar-label" x="${PAD + BAR_LABEL_W - 8}" y="${bar.y + BAR_H / 2}">${label}</text>` +
      `<rect class="bar" x="${bar.x}" y="${bar.y}" width="${bar.width.toFixed(1)}" height="${BAR_H}" rx="2" />` +
      `<text class="bar-value" x="${bar.x + bar.width + 6}" y="${bar.y + BAR_H / 2}">${bar.value}</text>`
    );
  });
  return svgEl(layout, parts.join(""), false);
}

// ── radial ego graph (per-symbol collaborators) ──────────────────────────────

const RADIUS = 90;
const RADIAL_MARGIN = 60;

export interface RadialLayout extends Dims {
  center: Point;
  neighbors: (Point & { label: string })[];
}

/** Place neighbours evenly on a ring around a centred node (first at top). */
export function radialLayout(neighborLabels: readonly string[]): RadialLayout {
  const size = (RADIUS + RADIAL_MARGIN) * 2;
  const c: Point = { x: size / 2, y: size / 2 };
  const n = neighborLabels.length;
  const neighbors = neighborLabels.map((label, i) => {
    const angle = -Math.PI / 2 + (i / Math.max(1, n)) * Math.PI * 2;
    return {
      label,
      x: c.x + RADIUS * Math.cos(angle),
      y: c.y + RADIUS * Math.sin(angle),
    };
  });
  return { center: c, neighbors, width: size, height: size };
}

export function renderRadial(centerLabel: string, neighborLabels: readonly string[]): string {
  const layout = radialLayout(neighborLabels);
  const c = layout.center;
  const spokes = layout.neighbors
    .map((nb) => `<line class="edge" x1="${c.x}" y1="${c.y}" x2="${nb.x.toFixed(1)}" y2="${nb.y.toFixed(1)}" />`)
    .join("");
  const dots = layout.neighbors
    .map(
      (nb) =>
        `<circle class="collab" cx="${nb.x.toFixed(1)}" cy="${nb.y.toFixed(1)}" r="5" />` +
        `<text class="collab-label" x="${nb.x.toFixed(1)}" y="${(nb.y - 10).toFixed(1)}">${escapeHtml(nb.label)}</text>`,
    )
    .join("");
  const hub =
    `<circle class="hub" cx="${c.x}" cy="${c.y}" r="7" />` +
    `<text class="hub-label" x="${c.x}" y="${c.y - 12}">${escapeHtml(centerLabel)}</text>`;
  return svgEl(layout, spokes + dots + hub, false);
}

// ── shared <svg> wrapper ─────────────────────────────────────────────────────

function svgEl(dims: Dims, body: string, withArrowMarker: boolean): string {
  const defs = withArrowMarker
    ? `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="arrow-head" /></marker></defs>`
    : "";
  return (
    `<svg class="diagram" viewBox="0 0 ${dims.width} ${dims.height}" ` +
    `width="${dims.width}" height="${dims.height}" role="img" xmlns="http://www.w3.org/2000/svg">` +
    defs +
    body +
    `</svg>`
  );
}
