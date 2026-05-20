// Cold-build budget acceptance (DESIGN-0004 / T18).
//
// CI gate: a cold buildSymbolIndex over a representative corpus must
// complete within the design's 15s wall-clock budget. Five trials, assert
// the p95 (which on n=5 is the max) stays under budget.
//
// Corpus: a synthetic 200-file TS tree generated under a tmpdir so the
// benchmark is deterministic and independent of CI machine size.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildSymbolIndex } from "./symbol-index.js";

const CORPUS_FILES = 200;
const BUDGET_MS = 15_000;
const TRIALS = 5;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sivru-explain-budget-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(p: string, content: string): Promise<void> {
  const abs = join(root, p);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function makeCorpus(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const dir = `pkg${Math.floor(i / 10)}`;
    const src = [
      `// auto-generated benchmark fixture ${i}`,
      `import { helper as h${(i + 1) % n} } from "./../pkg${Math.floor(((i + 1) % n) / 10)}/file${(i + 1) % n}.js";`,
      `export function helper() { return h${(i + 1) % n}(); }`,
      `export class Widget {`,
      `  constructor(public id: number) {}`,
      `  render() { return \`<\${this.id}/>\`; }`,
      `}`,
    ].join("\n");
    await write(`${dir}/file${i}.ts`, src);
  }
}

function percentile(values: readonly number[], p: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

describe("explain cold-build budget", () => {
  it(
    `${CORPUS_FILES}-file cold buildSymbolIndex p95 < ${BUDGET_MS}ms (${TRIALS} trials)`,
    async () => {
      await makeCorpus(CORPUS_FILES);
      const timings: number[] = [];
      for (let t = 0; t < TRIALS; t++) {
        const start = performance.now();
        const index = await buildSymbolIndex(root);
        const elapsed = performance.now() - start;
        timings.push(elapsed);
        expect(index.size()).toBeGreaterThanOrEqual(CORPUS_FILES);
      }
      const p95 = percentile(timings, 95);
      // Surface every trial on failure so a regression is debuggable.
      if (p95 >= BUDGET_MS) {
        throw new Error(
          `cold-build p95 ${p95.toFixed(0)} ms exceeds ${BUDGET_MS} ms budget\n` +
            `trials: ${timings.map((t) => t.toFixed(0)).join(", ")} ms`,
        );
      }
      expect(p95).toBeLessThan(BUDGET_MS);
    },
    // Each trial reads + chunks 200 files; allow generous test-level
    // timeout independent of the budget itself.
    BUDGET_MS * TRIALS,
  );
});
