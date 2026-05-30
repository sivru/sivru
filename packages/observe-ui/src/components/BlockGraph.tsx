// DESIGN-0021 slot 1 — force-directed block graph.
//
// In-house Fruchterman-Reingold layout (no d3/cytoscape dependency — the
// project's package.json is intentionally lean). The layout is computed once,
// deterministically (index-based initial placement, no Math.random), then
// rendered as SVG. "Precomputed coordinates, settled once" is also exactly
// what `prefers-reduced-motion: reduce` calls for, so there is no animation
// loop to special-case.
//
// Two independent, colorblind-safe edge encodings (DESIGN-0021 §"The graph
// render"):
//   - reciprocity (dash pattern): solid+thick = reciprocal, dashed = asymmetric
//   - severity (color): sivru-error = broken-collaborator, sivru-warn =
//     rename-suspect, sivru-mute (no color) = asymmetric.

import { useCallback, useMemo, useRef, useState } from "react";

import type { BlockNodeDetail, GraphEdge } from "../api";

export type Point = { x: number; y: number };

const VIEW_W = 1000;
const VIEW_H = 700;
/** Inner margin the settled layout is normalized into (leaves room for labels). */
const FIT_MARGIN = 48;

/**
 * Deterministic Fruchterman-Reingold layout. Returns a name→position map.
 * Pure + side-effect-free so it can be unit-tested and reused for the
 * reduced-motion (precomputed) path.
 */
export function computeForceLayout(
  nodeNames: readonly string[],
  edges: ReadonlyArray<{ from: string; to: string }>,
  opts: { width?: number; height?: number; iterations?: number } = {},
): Map<string, Point> {
  const W = opts.width ?? VIEW_W;
  const H = opts.height ?? VIEW_H;
  const iterations = opts.iterations ?? 300;
  const n = nodeNames.length;
  const cx = W / 2;
  const cy = H / 2;
  const pos = new Map<string, Point>();

  // Deterministic initial placement around a circle.
  const r0 = Math.min(W, H) * 0.35;
  nodeNames.forEach((name, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, n);
    pos.set(name, { x: cx + r0 * Math.cos(a), y: cy + r0 * Math.sin(a) });
  });
  if (n <= 1) return pos;

  const known = new Set(nodeNames);
  const links = edges.filter((e) => known.has(e.from) && known.has(e.to));
  const k = Math.sqrt((W * H) / n); // ideal edge length
  const disp = new Map<string, Point>();
  let temp = Math.min(W, H) * 0.1;
  const cool = temp / (iterations + 1);

  for (let it = 0; it < iterations; it++) {
    for (const nm of nodeNames) disp.set(nm, { x: 0, y: 0 });

    // Repulsion between every pair.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos.get(nodeNames[i]!)!;
        const b = pos.get(nodeNames[j]!)!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const rep = (k * k) / dist;
        const ux = dx / dist;
        const uy = dy / dist;
        const da = disp.get(nodeNames[i]!)!;
        const db = disp.get(nodeNames[j]!)!;
        da.x += ux * rep;
        da.y += uy * rep;
        db.x -= ux * rep;
        db.y -= uy * rep;
      }
    }

    // Attraction along edges.
    for (const e of links) {
      const a = pos.get(e.from)!;
      const b = pos.get(e.to)!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const att = (dist * dist) / k;
      const ux = dx / dist;
      const uy = dy / dist;
      const da = disp.get(e.from)!;
      const db = disp.get(e.to)!;
      da.x -= ux * att;
      da.y -= uy * att;
      db.x += ux * att;
      db.y += uy * att;
    }

    // Apply displacement (temperature-capped) + gentle center gravity.
    // NOTE: no per-iteration edge clamp here. Clamping each step flattens
    // low-degree/leaf nodes against the canvas edge — the cause of the
    // label-crowding seen at ~27 nodes. We let the sim settle freely, then
    // separate + normalize-to-fit once at the end.
    for (const nm of nodeNames) {
      const d = disp.get(nm)!;
      const p = pos.get(nm)!;
      const dist = Math.hypot(d.x, d.y) || 0.01;
      p.x += (d.x / dist) * Math.min(dist, temp);
      p.y += (d.y / dist) * Math.min(dist, temp);
      p.x += (cx - p.x) * 0.02;
      p.y += (cy - p.y) * 0.02;
    }
    temp = Math.max(0, temp - cool);
  }

  // Spread the settled cloud to fill the canvas (no node pinned to an edge),
  // then enforce a minimum center-to-center distance so labels have room.
  normalizeToFit(pos, nodeNames, W, H, FIT_MARGIN);
  separateNodes(pos, nodeNames, W, H);
  return pos;
}

/** Deterministic min-separation passes so node labels don't stack. */
function separateNodes(pos: Map<string, Point>, nodeNames: readonly string[], W: number, H: number): void {
  const n = nodeNames.length;
  const minSep = Math.max(64, Math.min(W, H) / 9);
  for (let pass = 0; pass < 16; pass++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos.get(nodeNames[i]!)!;
        const b = pos.get(nodeNames[j]!)!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        if (dist >= minSep) continue;
        const push = (minSep - dist) / 2;
        const ux = dx / dist;
        const uy = dy / dist;
        a.x += ux * push;
        a.y += uy * push;
        b.x -= ux * push;
        b.y -= uy * push;
      }
    }
  }
  // Final clamp keeps everything in-bounds after separation.
  for (const nm of nodeNames) {
    const p = pos.get(nm)!;
    p.x = Math.max(FIT_MARGIN, Math.min(W - FIT_MARGIN, p.x));
    p.y = Math.max(FIT_MARGIN, Math.min(H - FIT_MARGIN, p.y));
  }
}

/** Map the settled bounding box uniformly into [margin, W-margin] × [margin, H-margin]. */
function normalizeToFit(
  pos: Map<string, Point>,
  nodeNames: readonly string[],
  W: number,
  H: number,
  margin: number,
): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const nm of nodeNames) {
    const p = pos.get(nm)!;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const s = Math.min((W - 2 * margin) / spanX, (H - 2 * margin) / spanY); // uniform
  const offX = margin + ((W - 2 * margin) - spanX * s) / 2;
  const offY = margin + ((H - 2 * margin) - spanY * s) / 2;
  for (const nm of nodeNames) {
    const p = pos.get(nm)!;
    p.x = offX + (p.x - minX) * s;
    p.y = offY + (p.y - minY) * s;
  }
}

export type EdgeKind = "reciprocal" | "asymmetric" | "broken" | "rename-suspect";

/**
 * Classify an edge from the graph structure + the set of rename-suspect
 * source nodes (those carrying a SIVRU-E235 diagnostic). All client-side,
 * derived from the {nodes, edges, diagnostics} the API returns.
 */
export function classifyEdge(
  edge: { from: string; to: string; reciprocal: boolean },
  nodeNames: ReadonlySet<string>,
  renameSuspectNodes: ReadonlySet<string>,
): EdgeKind {
  if (!nodeNames.has(edge.to)) {
    return renameSuspectNodes.has(edge.from) ? "rename-suspect" : "broken";
  }
  return edge.reciprocal ? "reciprocal" : "asymmetric";
}

export function nodeSeverity(
  diagnostics: BlockNodeDetail["diagnostics"],
): "error" | "warning" | null {
  let warn = false;
  for (const d of diagnostics) {
    if (d.severity === "error") return "error";
    if (d.severity === "warning") warn = true;
  }
  return warn ? "warning" : null;
}

// Stroke styling per edge kind. Two axes: color (severity) + dash (reciprocity).
const EDGE_STYLE: Record<EdgeKind, { className: string; dash: string; width: number }> = {
  reciprocal: { className: "stroke-sivru-border", dash: "0", width: 2 },
  asymmetric: { className: "stroke-sivru-mute", dash: "5 4", width: 1 },
  broken: { className: "stroke-sivru-error", dash: "0", width: 1.5 },
  "rename-suspect": { className: "stroke-sivru-warn", dash: "5 4", width: 1.5 },
};

export type BlockGraphProps = {
  nodes: BlockNodeDetail[];
  edges: GraphEdge[];
  selected: string | null;
  onSelect: (name: string | null) => void;
};

export function BlockGraph({ nodes, edges, selected, onSelect }: BlockGraphProps): JSX.Element {
  const nodeNames = useMemo(() => nodes.map((n) => n.name), [nodes]);
  const renameSuspect = useMemo(() => {
    const s = new Set<string>();
    for (const n of nodes) {
      if (n.diagnostics.some((d) => d.code === "SIVRU-E235")) s.add(n.name);
    }
    return s;
  }, [nodes]);
  const nameSet = useMemo(() => new Set(nodeNames), [nodeNames]);

  // Settled layout, recomputed only when the node/edge set changes.
  const baseLayout = useMemo(
    () => computeForceLayout(nodeNames, edges),
    [nodeNames, edges],
  );
  // User drag overrides on top of the settled layout.
  const [overrides, setOverrides] = useState<Map<string, Point>>(new Map());
  const posOf = (name: string): Point =>
    overrides.get(name) ?? baseLayout.get(name) ?? { x: VIEW_W / 2, y: VIEW_H / 2 };

  const [scale, setScale] = useState(1);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Callback ref: attach the wheel listener as NON-passive so preventDefault
  // works (React's onWheel is passive, so it would warn + no-op and the page
  // would scroll while zooming). Re-fires on mount/unmount/remount.
  const wheelCleanup = useRef<(() => void) | null>(null);
  const setSvgRef = useCallback((el: SVGSVGElement | null): void => {
    if (wheelCleanup.current !== null) {
      wheelCleanup.current();
      wheelCleanup.current = null;
    }
    svgRef.current = el;
    if (el !== null) {
      const onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        setScale((s) => clamp(s * (e.deltaY < 0 ? 1.1 : 0.9), 0.4, 3));
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      wheelCleanup.current = () => el.removeEventListener("wheel", onWheel);
    }
  }, []);
  const dragRef = useRef<{ name: string; moved: boolean } | null>(null);
  // Set when a drag actually moved the node, so the trailing synthetic click
  // doesn't toggle selection on a pure reposition.
  const suppressClickRef = useRef(false);

  const toViewBox = (clientX: number, clientY: number): Point => {
    const svg = svgRef.current;
    if (svg === null) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    // preserveAspectRatio="xMidYMid meet": the viewBox is uniformly scaled to
    // fit and centered (letterboxed). Invert that transform, then undo the
    // inner <g scale={scale}>. A naive rect-ratio map is only right when the
    // container is exactly VIEW_W:VIEW_H, which it almost never is.
    const s = Math.min(rect.width / VIEW_W, rect.height / VIEW_H);
    const ox = (rect.width - VIEW_W * s) / 2;
    const oy = (rect.height - VIEW_H * s) / 2;
    const vbx = (clientX - rect.left - ox) / s;
    const vby = (clientY - rect.top - oy) / s;
    return { x: vbx / scale, y: vby / scale };
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current;
    if (d === null) return;
    d.moved = true;
    const p = toViewBox(e.clientX, e.clientY);
    setOverrides((prev) => {
      const next = new Map(prev);
      next.set(d.name, { x: clamp(p.x, 28, VIEW_W - 28), y: clamp(p.y, 28, VIEW_H - 28) });
      return next;
    });
  };

  const endDrag = (): void => {
    if (dragRef.current?.moved === true) suppressClickRef.current = true;
    dragRef.current = null;
  };

  if (nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-sivru-mute">
        <div className="max-w-md space-y-2">
          <div className="text-base text-sivru-text">No @sivru blocks in this project yet.</div>
          <div className="text-[12px]">
            Run{" "}
            <code className="rounded bg-sivru-panel px-1 text-sivru-amber">
              sivru block init &lt;file&gt;
            </code>{" "}
            to scaffold one, or see DESIGN-0016.
          </div>
        </div>
      </div>
    );
  }

  return (
    <svg
      ref={setSvgRef}
      role="main"
      aria-label="Block collaborator graph"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full bg-sivru-bg"
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
    >
      <g transform={`scale(${scale})`}>
        {/* Edges first (under nodes). Decorative — same info is in the inbox. */}
        {edges.map((edge, i) => {
          const kind = classifyEdge(edge, nameSet, renameSuspect);
          const style = EDGE_STYLE[kind];
          const a = posOf(edge.from);
          // Broken/rename edges point at an absent node — anchor the far end on
          // the source so the dangling stub still reads as "points nowhere".
          const b = nameSet.has(edge.to) ? posOf(edge.to) : { x: a.x + 36, y: a.y - 36 };
          return (
            <line
              key={`${edge.from}->${edge.to}-${i}`}
              role="presentation"
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              strokeWidth={style.width}
              strokeDasharray={style.dash}
              className={style.className}
            />
          );
        })}

        {/* Nodes */}
        {nodes.map((n) => {
          const p = posOf(n.name);
          const sev = nodeSeverity(n.diagnostics);
          const isSel = selected === n.name;
          const fill =
            sev === "error"
              ? "fill-sivru-error"
              : sev === "warning"
                ? "fill-sivru-warn"
                : "fill-sivru-panel";
          return (
            <g
              key={`${n.filePath}::${n.range.startLine}`}
              role="button"
              tabIndex={-1}
              aria-label={`block ${n.name} in ${n.filePath}; ${n.diagnostics.length} diagnostics`}
              transform={`translate(${p.x}, ${p.y})`}
              className="cursor-pointer"
              onPointerDown={(e) => {
                (e.target as Element).setPointerCapture?.(e.pointerId);
                dragRef.current = { name: n.name, moved: false };
              }}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return; // this "click" was the tail of a drag
                }
                onSelect(isSel ? null : n.name);
              }}
            >
              <circle
                r={9}
                className={`${fill} ${isSel ? "stroke-sivru-amber" : "stroke-sivru-border"}`}
                strokeWidth={isSel ? 3 : 1.5}
              />
              <text
                x={12}
                y={4}
                className="fill-sivru-text font-mono"
                // paint-order:stroke draws a bg-colored halo behind the glyphs so
                // a label stays readable where it overlaps an edge or another label.
                style={{
                  fontSize: 11,
                  paintOrder: "stroke",
                  stroke: "#0f1115",
                  strokeWidth: 3,
                  strokeLinejoin: "round",
                }}
              >
                {n.name}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
