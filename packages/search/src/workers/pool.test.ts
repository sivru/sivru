import { afterEach, describe, expect, it } from "vitest";
import { cpus } from "node:os";

import { chunkFile } from "../chunker/chunk.js";
import { createWorkerPool, type WorkerPool } from "./pool.js";

let pool: WorkerPool | null = null;

afterEach(async () => {
  if (pool !== null) {
    await pool.close();
    pool = null;
  }
});

function bigSource(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(`const v${i} = ${i}; // padded line padded line padded line`);
  }
  return out.join("\n");
}

describe("createWorkerPool", () => {
  it("returns chunks matching `chunkFile` for files run through the pool", async () => {
    pool = createWorkerPool({ size: 2 });
    const inputs = [
      { path: "a.ts", content: "function alpha() { return 1; }\nfunction beta() {}\n" },
      { path: "b.ts", content: "// hello\nconst x = 42;\n" },
      { path: "nested/c.ts", content: bigSource(120) },
      { path: "d.md", content: "# Title\n\nSome prose with words.\n" },
      { path: "e.py", content: "def f():\n    return 1\n\ndef g():\n    return 2\n" },
    ];

    const got = await Promise.all(
      inputs.map((i) => pool!.chunk(i.path, i.content)),
    );
    const want = inputs.map((i) => chunkFile(i.path, i.content));

    expect(got).toEqual(want);
  });

  it("propagates errors thrown inside the worker via promise rejection", async () => {
    pool = createWorkerPool({ size: 2 });
    // `lineFallbackChunks` rejects `maxLines: 0` synchronously; the worker
    // catches the throw and reports it back as `ok: false`.
    await expect(
      pool.chunk("bad.ts", "console.log(1)\n", { maxLines: 0 }),
    ).rejects.toThrow(/maxLines must be > 0/);

    // Worker should still be alive and serving subsequent tasks.
    const ok = await pool.chunk("good.ts", "const x = 1;\n");
    expect(ok).toEqual(chunkFile("good.ts", "const x = 1;\n"));
  });

  it("rejects new tasks after close()", async () => {
    pool = createWorkerPool({ size: 2 });
    await pool.chunk("a.ts", "const x = 1;\n");
    await pool.close();
    await expect(pool.chunk("a.ts", "const x = 1;\n")).rejects.toThrow(
      /closed/,
    );
    pool = null; // already closed; afterEach skips
  });

  it("honors the size option and defaults to min(8, cpus)", async () => {
    const sized = createWorkerPool({ size: 4 });
    expect(sized.size).toBe(4);
    await sized.close();

    const def = createWorkerPool();
    expect(def.size).toBe(Math.min(8, cpus().length));
    await def.close();
  });

  it("processes 100 concurrent tasks without dropping any results", async () => {
    pool = createWorkerPool({ size: 4 });
    const N = 100;
    const inputs: Array<{ path: string; content: string }> = [];
    for (let i = 0; i < N; i++) {
      inputs.push({
        path: `f${i}.ts`,
        content: `// file ${i}\n${bigSource(20 + (i % 30))}`,
      });
    }

    const got = await Promise.all(
      inputs.map((i) => pool!.chunk(i.path, i.content)),
    );
    expect(got.length).toBe(N);

    for (let i = 0; i < N; i++) {
      const input = inputs[i];
      const result = got[i];
      if (input === undefined || result === undefined) {
        throw new Error(`missing input or result at index ${i}`);
      }
      expect(result).toEqual(chunkFile(input.path, input.content));
    }
  });
});
