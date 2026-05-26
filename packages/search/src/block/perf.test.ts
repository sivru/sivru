// Performance gates for DESIGN-0019 (§"Performance gates").
//
// These are SOFT gates: they run only when `SIVRU_PERF=1` is set
// (and so do not slow down the default CI pipeline), and they fail
// only when the timing exceeds an order-of-magnitude headroom over
// the design budget. The point is regression detection, not
// hard-real-time enforcement.
//
// Slot-1 budget: diff-scoped validate on 500-file fixture < 200ms.
// Slot-2 budget: graph check on 21-block set < 100ms; scales linearly
//                to ~500 blocks → < 2.5s.
// Slot-3 budget: scaffolding on a single symbol < 500ms.
// Slot-4 budget: language-coverage audit adds < 5% to chunker time
//                (measured against the existing chunker perf-gate).
//
// Three of the four gates can be measured against generated fixtures
// in-process. The slot-4 chunker-overhead gate is a comparison rather
// than an absolute timing — its baseline lives in `benchmarks/`.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractBlocksFromFiles } from "./extract.js";
import { validateExtracted } from "./validate.js";
import { computeBlockGraph } from "./graph.js";
import { initBlock } from "./init.js";

const RUN_PERF = process.env["SIVRU_PERF"] === "1";

const describePerf = RUN_PERF ? describe : describe.skip;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sivru-perf-"));
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function writeBlockedFile(name: string, sym: string): void {
  writeFileSync(
    join(tmpDir, name),
    `/**
 * @sivru
 * schema: 1
 * role: ${sym}
 * responsibility: "perf fixture ${sym}"
 * @end
 */
export function ${sym}() {}
`,
  );
}

function writeUnblockedFile(name: string): void {
  writeFileSync(
    join(tmpDir, name),
    `export const ${name.replace(/\W/g, "_")} = 1;\n`,
  );
}

describePerf("DESIGN-0019 perf gates (set SIVRU_PERF=1 to run)", () => {
  it("slot 1: extract+validate on 500 files completes in < 2000ms (10x design budget)", async () => {
    // Generate 500 files; 5% have a block (matches the "diff-scoped
    // validate filters most files out" shape).
    for (let i = 0; i < 500; i++) {
      if (i % 20 === 0) writeBlockedFile(`f${i}.ts`, `sym${i}`);
      else writeUnblockedFile(`g${i}.ts`);
    }
    const paths: string[] = [];
    for (let i = 0; i < 500; i++) {
      paths.push(
        join(tmpDir, i % 20 === 0 ? `f${i}.ts` : `g${i}.ts`),
      );
    }
    const t0 = performance.now();
    const blocks = await extractBlocksFromFiles(paths);
    validateExtracted(blocks);
    const elapsed = performance.now() - t0;
    // The design budget is 200ms for diff-scoped validate on a
    // 500-file fixture with a handful of changed paths. Our fixture
    // here is the FULL set; we apply a 10x headroom (2000ms) to
    // turn this into a regression detector, not a real-time gate.
    expect(elapsed).toBeLessThan(2000);
    console.log(`slot1: ${elapsed.toFixed(0)}ms for 500 files (${blocks.length} blocks)`);
  }, 30_000);

  it("slot 2: block graph --check on 21-block set completes in < 1000ms (10x design budget)", async () => {
    for (let i = 0; i < 21; i++) {
      writeBlockedFile(`f${i}.ts`, `sym${i}`);
    }
    const t0 = performance.now();
    await computeBlockGraph(tmpDir);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1000);
    console.log(`slot2: ${elapsed.toFixed(0)}ms for 21-block graph`);
  }, 30_000);

  it("slot 2: graph scales linearly to 500 blocks in < 10000ms (~4x of 2.5s design budget)", async () => {
    for (let i = 0; i < 500; i++) {
      writeBlockedFile(`f${i}.ts`, `sym${i}`);
    }
    const t0 = performance.now();
    await computeBlockGraph(tmpDir);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(10_000);
    console.log(`slot2-500: ${elapsed.toFixed(0)}ms for 500-block graph`);
  }, 60_000);

  it("slot 3: scaffolding on a single symbol completes in < 2000ms (4x design budget)", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "FooService.ts"),
      `import { Logger } from "./logger";\nimport { Storage } from "./storage";\n\nexport class FooService {\n  do() {}\n}\n`,
    );
    const t0 = performance.now();
    await initBlock(join(tmpDir, "src", "FooService.ts"), {
      write: false,
      force: false,
    });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    console.log(`slot3: ${elapsed.toFixed(0)}ms per-symbol scaffolding`);
  }, 30_000);
});
