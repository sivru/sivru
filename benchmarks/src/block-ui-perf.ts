// DESIGN-0021 slot 1 perf benchmark — the cost behind `GET /api/blocks`.
//
// The route is a thin wrapper over the @sivru/search engine path:
//   computeBlockGraph(root)  +  extractBlocksFromFiles(nodeFiles)
// (the targeted re-extract that enriches nodes with parsed content). This
// benchmark measures exactly that path against a generated 500-block fixture,
// plus the per-file re-extract latency.
//
// Targets (DESIGN-0021 §"Test plan / Perf benchmark", M-series baseline):
//   - /api/blocks cold   < 2000 ms
//   - /api/blocks warm   <  300 ms
//   - per-file re-extract <   50 ms (median of 20)
//
// Report-first by default so it doesn't false-fail off the baseline hardware;
// pass `--gate` to exit non-zero when a metric exceeds its target. (60fps@200
// nodes graph-render is a browser-side target, verified manually.)

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeBlockGraph, extractBlocksFromFiles } from "@sivru/search";

const N = 500;
const TARGET_COLD_MS = 2000;
const TARGET_WARM_MS = 300;
const TARGET_REEXTRACT_MS = 50;

function genBlockFile(i: number): string {
  const j = (i + 1) % N; // ring of collaborator edges
  return `/**
 * @sivru
 * schema: 1
 * role: gen-node-${i}
 * responsibility: synthetic block ${i} for the DESIGN-0021 block-ui perf fixture
 * collaborators: [genNode${j}]
 * maturity: stable
 * @end
 */
export function genNode${i}(): number {
  return ${i};
}
`;
}

/** Write an N-block fixture into a fresh temp dir. Returns its path. */
export function generateFixture(n: number): string {
  const root = mkdtempSync(join(tmpdir(), "sivru-blocks-500-"));
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  for (let i = 0; i < n; i++) {
    writeFileSync(join(src, `node-${i}.ts`), genBlockFile(i));
  }
  return root;
}

/** The exact engine path `buildBlocksResponse` runs. */
async function buildPath(root: string): Promise<number> {
  const graph = await computeBlockGraph(root);
  const nodeFiles = [...new Set(graph.nodes.map((nd) => nd.filePath))];
  await extractBlocksFromFiles(nodeFiles);
  return graph.nodes.length;
}

function ms(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000; // ms with µs precision
}

async function main(): Promise<void> {
  const gate = process.argv.includes("--gate");
  const root = generateFixture(N);
  try {
    // Cold — first build (grammars + walk uncached).
    let t = ms();
    const nodeCount = await buildPath(root);
    const coldMs = ms() - t;

    // Warm — second build.
    t = ms();
    await buildPath(root);
    const warmMs = ms() - t;

    // Per-file re-extract — median of 20 on one block file.
    const one = join(root, "src", "node-0.ts");
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const s = ms();
      await extractBlocksFromFiles([one]);
      samples.push(ms() - s);
    }
    samples.sort((a, b) => a - b);
    const reExtractMs = samples[Math.floor(samples.length / 2)] ?? 0;

    const rows = [
      { metric: "/api/blocks cold", value: coldMs, target: TARGET_COLD_MS },
      { metric: "/api/blocks warm", value: warmMs, target: TARGET_WARM_MS },
      { metric: "per-file re-extract (median)", value: reExtractMs, target: TARGET_REEXTRACT_MS },
    ];

    process.stdout.write(`block-ui perf — ${nodeCount} blocks (${N}-file fixture)\n`);
    process.stdout.write(`  node ${process.version} · ${process.platform}\n\n`);
    let overGate = false;
    for (const r of rows) {
      const over = r.value > r.target;
      if (over) overGate = true;
      const label = over ? "OVER" : "ok";
      process.stdout.write(
        `  ${r.metric.padEnd(30)} ${r.value.toFixed(1).padStart(9)} ms  (target < ${r.target} ms) [${label}]\n`,
      );
    }
    process.stdout.write("\n");

    if (gate && overGate) {
      process.stderr.write(
        "block-ui perf: at least one metric exceeded its M-series target (--gate). " +
          "Note: targets assume the DESIGN-0013 baseline hardware.\n",
      );
      process.exitCode = 1;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Run only when invoked directly (not when imported by a test).
const invokedDirectly = process.argv[1]?.endsWith("block-ui-perf.ts") === true;
if (invokedDirectly) {
  void main();
}
