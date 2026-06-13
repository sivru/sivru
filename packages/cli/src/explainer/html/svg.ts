// Inline-SVG diagrams for the explainer (DESIGN-0018 Slice 2).
//
// Three diagrams, all hand-rolled (no library), layout (pure fn → coordinates)
// split from render (coords → SVG string) so geometry is unit-testable:
//
//   systemMap:   modules in dependency-LAYER columns (foundation → top), boxes
//                SIZED by symbol count — a real architecture view, not a flat
//                box-and-arrows list.
//   barLayout:   sorted descending, bar width ∝ value.
//   radialLayout: ego-graph; radius grows with neighbour count and labels are
//                anchored by angle so they don't collide.
//
// All layouts are deterministic: same model → identical geometry.

import { escapeHtml } from "./escape.js";

export interface Point {
  x: number;
  y: number;
}
export interface Dims {
  width: number;
  height: number;
}

const PAD = 16;

// ── dependency layering (shared) ─────────────────────────────────────────────

/**
 * Longest-path layer per node in a "depends on" graph: a node that depends on
 * nothing is layer 0 (the foundation); a node's layer is 1 + the max layer of
 * what it depends on. Cycles break deterministically (a back-edge into an
 * in-progress node contributes layer 0), so it always terminates.
 */
export function computeLayers(
  nodeIds: readonly string[],
  edges: readonly { from: string; to: string }[],
): Map<string, number> {
  const ids = [...new Set(nodeIds)];
  const idSet = new Set(ids);
  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);
  for (const e of edges) {
    if (idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to) out.get(e.from)!.push(e.to);
  }
  const layer = new Map<string, number>();
  const inProgress = new Set<string>();
  const visit = (id: string): number => {
    const memo = layer.get(id);
    if (memo !== undefined) return memo;
    if (inProgress.has(id)) return 0;
    inProgress.add(id);
    let best = 0;
    for (const t of out.get(id)!) best = Math.max(best, visit(t) + 1);
    inProgress.delete(id);
    layer.set(id, best);
    return best;
  };
  for (const id of ids) visit(id);
  return layer;
}

// ── layered system map (the architecture view) ───────────────────────────────

export interface MapNodeInput {
  id: string;
  name: string;
  sub: string;
  size: number; // symbol count → box width
}
export interface MapBox extends Point {
  id: string;
  w: number;
  h: number;
  name: string;
  sub: string;
}
export interface SystemMapLayout extends Dims {
  boxes: MapBox[];
  edges: { from: string; to: string }[];
}

const MAP_COL_GAP = 72;
const MAP_ROW_GAP = 22;
const MAP_MIN_W = 124;
const MAP_MAX_W = 232;
const MAP_H = 54;

/**
 * Lay variable-width module boxes into dependency-layer columns — layer 0 (the
 * foundation everything builds on) on the LEFT, consumers to the right. Box
 * width scales with symbol count (sqrt, so the biggest module doesn't dwarf the
 * rest). Each column is centred vertically. Deterministic.
 */
export function systemMapLayout(
  nodes: readonly MapNodeInput[],
  edges: readonly { from: string; to: string }[],
): SystemMapLayout {
  const layer = computeLayers(nodes.map((n) => n.id), edges);
  const maxSize = Math.max(1, ...nodes.map((n) => n.size));
  const widthOf = (size: number): number =>
    Math.round(MAP_MIN_W + (MAP_MAX_W - MAP_MIN_W) * Math.sqrt(size / maxSize));

  const maxLayer = Math.max(0, ...[...layer.values()]);
  const cols: MapNodeInput[][] = [];
  for (let l = 0; l <= maxLayer; l++) {
    cols.push(
      nodes
        .filter((n) => (layer.get(n.id) ?? 0) === l)
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  }
  const colW = cols.map((c) => Math.max(MAP_MIN_W, ...c.map((n) => widthOf(n.size))));
  const colX: number[] = [];
  let x = PAD;
  for (let i = 0; i < cols.length; i++) {
    colX.push(x);
    x += colW[i]! + MAP_COL_GAP;
  }
  const colH = cols.map(
    (c) => c.length * MAP_H + Math.max(0, c.length - 1) * MAP_ROW_GAP,
  );
  const maxColH = Math.max(MAP_H, ...colH);

  const boxes: MapBox[] = [];
  cols.forEach((c, ci) => {
    let y = PAD + (maxColH - colH[ci]!) / 2;
    for (const n of c) {
      const w = widthOf(n.size);
      boxes.push({
        id: n.id,
        x: colX[ci]! + (colW[ci]! - w) / 2,
        y,
        w,
        h: MAP_H,
        name: n.name,
        sub: n.sub,
      });
      y += MAP_H + MAP_ROW_GAP;
    }
  });
  return {
    boxes,
    edges: edges.map((e) => ({ ...e })),
    width: x - MAP_COL_GAP + PAD,
    height: maxColH + PAD * 2,
  };
}

/**
 * Optional delta overlay (DESIGN-0023 Slice 2). Returns an extra CSS class for a
 * box (a changed/added module) or an edge (a newly-introduced dependency / a
 * cycle's closing edge). Color is never the only signal — the classes pair with
 * text tags in the legend + distinct stroke styles (WCAG 1.4.1).
 */
export interface MapDecorate {
  box?: (id: string) => string | null;
  edge?: (from: string, to: string) => string | null;
}

export function renderSystemMap(
  nodes: readonly MapNodeInput[],
  edges: readonly { from: string; to: string }[],
  href: (id: string) => string,
  decorate?: MapDecorate,
): string {
  const layout = systemMapLayout(nodes, edges);
  const byId = new Map(layout.boxes.map((b) => [b.id, b]));
  const parts: string[] = [];
  // Edges: a smooth connector from the dependent's left edge into the
  // dependency's right edge (arrow points at the dependency). Boxes are drawn
  // after, with an opaque fill, so a skip-layer edge passes cleanly BEHIND any
  // intermediate box rather than cutting a visible line through it.
  for (const e of layout.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (a === undefined || b === undefined) continue;
    const x1 = a.x;
    const y1 = a.y + a.h / 2;
    const x2 = b.x + b.w;
    const y2 = b.y + b.h / 2;
    const mx = ((x1 + x2) / 2).toFixed(1);
    const eClass = decorate?.edge?.(e.from, e.to);
    parts.push(
      `<path class="edge${eClass ? ` ${eClass}` : ""}" d="M${x1.toFixed(1)} ${y1.toFixed(1)} ` +
        `C ${mx} ${y1.toFixed(1)} ${mx} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}" ` +
        `marker-end="url(#arrow)" />`,
    );
  }
  for (const b of layout.boxes) {
    const cx = (b.x + b.w / 2).toFixed(1);
    const bClass = decorate?.box?.(b.id);
    parts.push(
      `<a href="${escapeHtml(href(b.id))}"><g>` +
        `<rect class="map-box${bClass ? ` ${bClass}` : ""}" x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w}" height="${b.h}" rx="6" />` +
        `<text class="map-name" x="${cx}" y="${b.y + 22}">${escapeHtml(b.name)}</text>` +
        `<text class="map-sub" x="${cx}" y="${b.y + 39}">${escapeHtml(b.sub)}</text>` +
        `</g></a>`,
    );
  }
  return svgEl(layout, parts.join(""), true);
}

// ── sorted bars (churn / size) ───────────────────────────────────────────────

const BAR_LABEL_W = 130;
const BAR_MAX_W = 220;
const BAR_VALUE_W = 46; // room for the value label so it never clips
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
    width: (item.value / max) * BAR_MAX_W,
  }));
  return {
    bars,
    width: PAD * 2 + BAR_LABEL_W + BAR_MAX_W + BAR_VALUE_W,
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
      `<text class="bar-value" x="${(bar.x + bar.width + 6).toFixed(1)}" y="${bar.y + BAR_H / 2}">${bar.value}</text>`
    );
  });
  return svgEl(layout, parts.join(""), false);
}

// ── radial ego graph (per-symbol collaborators) ──────────────────────────────

const RADIAL_MAX = 16; // cap rendered neighbours; the rest collapse to "+N"
const RADIAL_MARGIN = 80;

export interface RadialNeighbor extends Point {
  label: string;
  angle: number;
}
export interface RadialLayout extends Dims {
  center: Point;
  radius: number;
  neighbors: RadialNeighbor[];
}

/** Neighbours on a ring; radius grows with count so labels have room. */
export function radialLayout(neighborLabels: readonly string[]): RadialLayout {
  const shown = neighborLabels.slice(0, RADIAL_MAX);
  const n = shown.length;
  const radius = Math.round(Math.max(80, Math.min(170, 56 + n * 9)));
  const size = (radius + RADIAL_MARGIN) * 2;
  const c: Point = { x: size / 2, y: size / 2 };
  const neighbors = shown.map((label, i) => {
    const angle = -Math.PI / 2 + (i / Math.max(1, n)) * Math.PI * 2;
    return {
      label,
      angle,
      x: c.x + radius * Math.cos(angle),
      y: c.y + radius * Math.sin(angle),
    };
  });
  return { center: c, radius, neighbors, width: size, height: size };
}

export function renderRadial(
  centerLabel: string,
  neighborLabels: readonly string[],
): string {
  const layout = radialLayout(neighborLabels);
  const c = layout.center;
  const spokes = layout.neighbors
    .map(
      (nb) =>
        `<line class="edge" x1="${c.x}" y1="${c.y}" x2="${nb.x.toFixed(1)}" y2="${nb.y.toFixed(1)}" />`,
    )
    .join("");
  const dots = layout.neighbors
    .map((nb) => {
      // Anchor the label by angle so it reads outward and rarely collides.
      const cos = Math.cos(nb.angle);
      const anchor = cos > 0.3 ? "start" : cos < -0.3 ? "end" : "middle";
      const lx = nb.x + Math.cos(nb.angle) * 10;
      const ly = nb.y + Math.sin(nb.angle) * 10 + 3;
      return (
        `<circle class="collab" cx="${nb.x.toFixed(1)}" cy="${nb.y.toFixed(1)}" r="4.5" />` +
        `<text class="collab-label" text-anchor="${anchor}" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}">${escapeHtml(nb.label)}</text>`
      );
    })
    .join("");
  const extra = neighborLabels.length - layout.neighbors.length;
  const more =
    extra > 0
      ? `<text class="collab-label" text-anchor="middle" x="${c.x}" y="${(c.y + layout.radius + 24).toFixed(1)}">+${extra} more</text>`
      : "";
  const hub =
    `<circle class="hub" cx="${c.x}" cy="${c.y}" r="7" />` +
    `<text class="hub-label" text-anchor="middle" x="${c.x}" y="${c.y - 12}">${escapeHtml(centerLabel)}</text>`;
  return svgEl(layout, spokes + dots + more + hub, false);
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
