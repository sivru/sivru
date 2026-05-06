// Render hand-crafted SVG charts from the benchmark JSON snapshots.
//
// Output goes to `benchmarks/charts/`. SVG is committed alongside data so
// GitHub renders it natively in markdown. Re-run after re-baselining:
//
//   pnpm --filter @sivru/benchmarks tsx src/render-charts.ts
//
// No deps. The two chart types are 200 lines of SVG generation, dark-mode
// styled to match observe-ui (`#0f1115` bg, `#d4a056` soft-amber accent,
// Geist where available with monospace fallback).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const OUT_DIR = resolve(ROOT, "benchmarks", "charts");

// ----- shared style tokens ------------------------------------------------

const BG = "#0f1115";
const PANEL = "#161a21";
const BORDER = "#262b35";
const TEXT = "#d6d8dd";
const MUTE = "#7a8390";
const AMBER = "#d4a056";
const AMBER_DIM = "#8a6932";
const GREY = "#3a414e";

const FONT = "ui-sans-serif, system-ui, -apple-system, 'Geist', sans-serif";
const MONO = "ui-monospace, 'Geist Mono', Menlo, monospace";

function svgHeader(width: number, height: number, title: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="${FONT}" role="img" aria-label="${escape(title)}">
<rect width="${width}" height="${height}" fill="${BG}"/>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ----- grouped bar chart --------------------------------------------------

type GroupedBar = {
  label: string;
  sivru: number;
  baseline: number;
};

function renderGroupedBar(
  title: string,
  subtitle: string,
  rows: GroupedBar[],
  width = 880,
  height = 460,
): string {
  const margin = { top: 70, right: 220, bottom: 70, left: 70 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const maxVal = Math.max(...rows.map((r) => Math.max(r.sivru, r.baseline)));
  const yMax = niceCeil(maxVal);

  const groupW = plotW / rows.length;
  const barW = Math.min(28, (groupW - 12) / 2);

  const ticks = 5;

  const parts: string[] = [];
  parts.push(svgHeader(width, height, title));

  // Title + subtitle
  parts.push(
    `<text x="${margin.left}" y="32" font-size="18" font-weight="600" fill="${TEXT}">${escape(title)}</text>`,
  );
  parts.push(
    `<text x="${margin.left}" y="52" font-size="12" fill="${MUTE}">${escape(subtitle)}</text>`,
  );

  // Y axis grid + labels
  for (let i = 0; i <= ticks; i++) {
    const v = (yMax * i) / ticks;
    const y = margin.top + plotH - (plotH * i) / ticks;
    parts.push(
      `<line x1="${margin.left}" y1="${y.toFixed(1)}" x2="${margin.left + plotW}" y2="${y.toFixed(1)}" stroke="${BORDER}" stroke-width="1" stroke-dasharray="${i === 0 ? "" : "2,3"}"/>`,
    );
    parts.push(
      `<text x="${margin.left - 8}" y="${(y + 4).toFixed(1)}" font-size="10" fill="${MUTE}" text-anchor="end" font-family="${MONO}">${formatNum(v)}</text>`,
    );
  }

  // Bars
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const cx = margin.left + groupW * (i + 0.5);
    const sivruH = (r.sivru / yMax) * plotH;
    const baseH = (r.baseline / yMax) * plotH;
    const sivruY = margin.top + plotH - sivruH;
    const baseY = margin.top + plotH - baseH;

    // sivru bar (left)
    parts.push(
      `<rect x="${(cx - barW - 1).toFixed(1)}" y="${sivruY.toFixed(1)}" width="${barW}" height="${sivruH.toFixed(1)}" fill="${AMBER}" rx="2"/>`,
    );
    // baseline bar (right)
    parts.push(
      `<rect x="${(cx + 1).toFixed(1)}" y="${baseY.toFixed(1)}" width="${barW}" height="${baseH.toFixed(1)}" fill="${GREY}" rx="2"/>`,
    );

    // x-axis label
    parts.push(
      `<text x="${cx.toFixed(1)}" y="${margin.top + plotH + 16}" font-size="10" fill="${MUTE}" text-anchor="middle" font-family="${MONO}">${escape(r.label)}</text>`,
    );
  }

  // Legend
  const legendX = margin.left + plotW + 24;
  const legendY = margin.top + 8;
  parts.push(
    `<rect x="${legendX}" y="${legendY}" width="14" height="14" fill="${AMBER}" rx="2"/>`,
    `<text x="${legendX + 22}" y="${legendY + 12}" font-size="12" fill="${TEXT}">sivru</text>`,
    `<rect x="${legendX}" y="${legendY + 28}" width="14" height="14" fill="${GREY}" rx="2"/>`,
    `<text x="${legendX + 22}" y="${legendY + 40}" font-size="12" fill="${TEXT}">grep + Read top-3</text>`,
  );

  // X axis title
  parts.push(
    `<text x="${margin.left + plotW / 2}" y="${height - 16}" font-size="11" fill="${MUTE}" text-anchor="middle">task</text>`,
  );

  parts.push("</svg>\n");
  return parts.join("");
}

// ----- single-series savings bar chart ------------------------------------

type SavingsRow = {
  label: string;
  pctSaved: number;
};

function renderSavingsBar(
  title: string,
  subtitle: string,
  rows: SavingsRow[],
  width = 880,
  height = 420,
): string {
  const margin = { top: 70, right: 60, bottom: 70, left: 64 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const yMax = 100;
  const ticks = 5;
  const groupW = plotW / rows.length;
  const barW = Math.min(40, groupW * 0.7);

  const parts: string[] = [];
  parts.push(svgHeader(width, height, title));

  parts.push(
    `<text x="${margin.left}" y="32" font-size="18" font-weight="600" fill="${TEXT}">${escape(title)}</text>`,
    `<text x="${margin.left}" y="52" font-size="12" fill="${MUTE}">${escape(subtitle)}</text>`,
  );

  for (let i = 0; i <= ticks; i++) {
    const v = (yMax * i) / ticks;
    const y = margin.top + plotH - (plotH * i) / ticks;
    parts.push(
      `<line x1="${margin.left}" y1="${y.toFixed(1)}" x2="${margin.left + plotW}" y2="${y.toFixed(1)}" stroke="${BORDER}" stroke-width="1" stroke-dasharray="${i === 0 ? "" : "2,3"}"/>`,
      `<text x="${margin.left - 8}" y="${(y + 4).toFixed(1)}" font-size="10" fill="${MUTE}" text-anchor="end" font-family="${MONO}">${v.toFixed(0)}%</text>`,
    );
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const cx = margin.left + groupW * (i + 0.5);
    const h = (Math.max(0, r.pctSaved) / yMax) * plotH;
    const y = margin.top + plotH - h;

    // Color shifts subtly from amber-dim to amber as % goes up
    const t = Math.min(1, Math.max(0, r.pctSaved / 100));
    const fill = lerpColor(AMBER_DIM, AMBER, t);

    parts.push(
      `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}" rx="2"/>`,
      `<text x="${cx.toFixed(1)}" y="${(y - 6).toFixed(1)}" font-size="10" fill="${TEXT}" text-anchor="middle" font-family="${MONO}">${r.pctSaved.toFixed(0)}%</text>`,
      `<text x="${cx.toFixed(1)}" y="${margin.top + plotH + 16}" font-size="10" fill="${MUTE}" text-anchor="middle" font-family="${MONO}">${escape(r.label)}</text>`,
    );
  }

  parts.push("</svg>\n");
  return parts.join("");
}

// ----- summary scoreboard chart -------------------------------------------

function renderScoreboard(
  title: string,
  subtitle: string,
  cards: Array<{ label: string; value: string; highlight?: boolean; sub?: string }>,
  width = 880,
  height = 280,
): string {
  const parts: string[] = [];
  parts.push(svgHeader(width, height, title));
  parts.push(
    `<text x="40" y="36" font-size="20" font-weight="600" fill="${TEXT}">${escape(title)}</text>`,
    `<text x="40" y="60" font-size="13" fill="${MUTE}">${escape(subtitle)}</text>`,
  );

  const cardW = (width - 80 - (cards.length - 1) * 16) / cards.length;
  const cardH = 150;
  const cardY = 100;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]!;
    const x = 40 + i * (cardW + 16);
    parts.push(
      `<rect x="${x}" y="${cardY}" width="${cardW.toFixed(1)}" height="${cardH}" fill="${PANEL}" stroke="${c.highlight ? AMBER : BORDER}" stroke-width="${c.highlight ? 2 : 1}" rx="6"/>`,
      `<text x="${x + cardW / 2}" y="${cardY + 36}" font-size="12" fill="${MUTE}" text-anchor="middle">${escape(c.label)}</text>`,
      `<text x="${x + cardW / 2}" y="${cardY + 90}" font-size="36" font-weight="700" fill="${c.highlight ? AMBER : TEXT}" text-anchor="middle" font-family="${MONO}">${escape(c.value)}</text>`,
    );
    if (c.sub !== undefined) {
      parts.push(
        `<text x="${x + cardW / 2}" y="${cardY + 124}" font-size="11" fill="${MUTE}" text-anchor="middle">${escape(c.sub)}</text>`,
      );
    }
  }

  parts.push("</svg>\n");
  return parts.join("");
}

// ----- helpers ------------------------------------------------------------

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / exp;
  if (n <= 1) return exp;
  if (n <= 2) return 2 * exp;
  if (n <= 5) return 5 * exp;
  return 10 * exp;
}

function formatNum(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  return v.toFixed(0);
}

function lerpColor(a: string, b: string, t: number): string {
  const ai = hexToRgb(a);
  const bi = hexToRgb(b);
  const out = {
    r: Math.round(ai.r + (bi.r - ai.r) * t),
    g: Math.round(ai.g + (bi.g - ai.g) * t),
    b: Math.round(ai.b + (bi.b - ai.b) * t),
  };
  return `#${out.r.toString(16).padStart(2, "0")}${out.g.toString(16).padStart(2, "0")}${out.b.toString(16).padStart(2, "0")}`;
}

function hexToRgb(h: string): { r: number; g: number; b: number } {
  const s = h.replace("#", "");
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

// ----- main ---------------------------------------------------------------

type AgentSnapshot = {
  summary: {
    totalTasks: number;
    sivruTokensTotal: number;
    baselineTokensTotal: number;
    pctTokensSavedMean: number;
    pctTokensSavedMedian: number;
    sivruRecallAt3: number;
    baselineRecallAt3: number;
    avgSivruTurns: number;
    avgBaselineTurns: number;
  };
  tasks: Array<{
    taskId: string;
    sivru: { tokens: number };
    baseline: { tokens: number };
    pctTokensSaved: number;
  }>;
};

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  // ---- labeled corpus (20 tasks) ----
  const labeled = loadJson<AgentSnapshot>(
    resolve(ROOT, "benchmarks", "agent-tasks-baseline.json"),
  );
  const top10 = [...labeled.tasks]
    .sort((a, b) => b.baseline.tokens - b.sivru.tokens - (a.baseline.tokens - a.sivru.tokens))
    .slice(0, 10);

  writeFileSync(
    resolve(OUT_DIR, "agent-tasks-top10.svg"),
    renderGroupedBar(
      "Tokens per task — top 10 by absolute savings",
      "Labeled corpus (zod / requests / gson) · 20 tasks total · BM25",
      top10.map((t) => ({
        label: t.taskId.replace("requests-", "req-"),
        sivru: t.sivru.tokens,
        baseline: t.baseline.tokens,
      })),
    ),
  );

  writeFileSync(
    resolve(OUT_DIR, "agent-tasks-summary.svg"),
    renderScoreboard(
      "Agent-task suite — labeled corpus",
      "20 tasks · 3 OSS repos · sivru BM25 vs grep + Read top-3",
      [
        { label: "Tokens used (sivru)", value: labeled.summary.sivruTokensTotal.toLocaleString() },
        { label: "Tokens used (baseline)", value: labeled.summary.baselineTokensTotal.toLocaleString() },
        { label: "Mean tokens saved", value: `${labeled.summary.pctTokensSavedMean.toFixed(1)}%`, highlight: true },
        { label: "Recall@3", value: `${(labeled.summary.sivruRecallAt3 * 100).toFixed(0)}%`, sub: `vs ${(labeled.summary.baselineRecallAt3 * 100).toFixed(0)}% baseline` },
      ],
    ),
  );

  // ---- vitest real-world (10 tasks) ----
  const vitest = loadJson<AgentSnapshot>(
    resolve(ROOT, "benchmarks", "realworld-vitest.json"),
  );

  writeFileSync(
    resolve(OUT_DIR, "realworld-vitest-savings.svg"),
    renderSavingsBar(
      "Tokens saved per task — vitest (178k LOC TypeScript)",
      "10 hand-written queries · sivru BM25 vs grep + Read top-3",
      vitest.tasks.map((t) => ({
        label: t.taskId.replace("vitest-", "v-"),
        pctSaved: t.pctTokensSaved,
      })),
    ),
  );

  writeFileSync(
    resolve(OUT_DIR, "realworld-vitest-summary.svg"),
    renderScoreboard(
      "Real-world demo — vitest",
      "vitest-dev/vitest · 178,665 LOC · 10 representative agent tasks",
      [
        { label: "Tokens used (sivru)", value: vitest.summary.sivruTokensTotal.toLocaleString() },
        { label: "Tokens used (baseline)", value: vitest.summary.baselineTokensTotal.toLocaleString() },
        { label: "Mean tokens saved", value: `${vitest.summary.pctTokensSavedMean.toFixed(1)}%`, highlight: true },
        { label: "Median saved", value: `${vitest.summary.pctTokensSavedMedian.toFixed(1)}%`, sub: "all 10 net positive" },
      ],
    ),
  );

  // ---- corpus comparison ----
  writeFileSync(
    resolve(OUT_DIR, "corpus-comparison.svg"),
    renderScoreboard(
      "Token economy across corpora",
      "Labeled (3 small/medium repos) vs vitest (~30× larger) · same methodology",
      [
        {
          label: "Labeled corpus · mean saved",
          value: `${labeled.summary.pctTokensSavedMean.toFixed(1)}%`,
          sub: "20 tasks · zod / req / gson",
        },
        {
          label: "Labeled corpus · median",
          value: `${labeled.summary.pctTokensSavedMedian.toFixed(1)}%`,
        },
        {
          label: "vitest · mean saved",
          value: `${vitest.summary.pctTokensSavedMean.toFixed(1)}%`,
          highlight: true,
          sub: "10 tasks · 178k LOC TS",
        },
        {
          label: "vitest · median",
          value: `${vitest.summary.pctTokensSavedMedian.toFixed(1)}%`,
          highlight: true,
        },
      ],
    ),
  );

  process.stdout.write(`charts written to ${OUT_DIR}\n`);
  for (const f of [
    "agent-tasks-summary.svg",
    "agent-tasks-top10.svg",
    "realworld-vitest-summary.svg",
    "realworld-vitest-savings.svg",
    "corpus-comparison.svg",
  ]) {
    process.stdout.write(`  - ${f}\n`);
  }
}

main();
