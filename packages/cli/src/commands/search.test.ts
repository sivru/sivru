import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runSearch } from "./search.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sivru-cli-search-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

type Captured = { stdout: string; stderr: string; restore: () => void };

function captureIO(): Captured {
  const captured: Captured = {
    stdout: "",
    stderr: "",
    restore: () => {},
  };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // Cast to `any` — `process.stdout.write` has overloaded signatures that are
  // a pain to satisfy from a monkey-patch; the runtime contract we care about
  // is "accept a string, return true".
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: unknown): boolean => {
    captured.stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: unknown): boolean => {
    captured.stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  captured.restore = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = origOut;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = origErr;
  };
  return captured;
}

// All tests use `--bm25` to opt out of the default hybrid mode. Hybrid would
// either trigger a network model download (slow + flaky in CI) or, on a
// machine with the model cached, return semantic similarity scores that
// don't honor the strict no-match expectation in the "no matches" test.
describe("runSearch", () => {
  it("emits JSON with hits when --json is passed", async () => {
    await write("auth/login.ts", "function alpha() { return 'alpha-token' }\n");
    await write("auth/jwt.ts", "function beta() { return 'beta-token' }\n");
    await write("ui/button.ts", "function gamma() { return null }\n");

    const cap = captureIO();
    let code: number;
    try {
      code = await runSearch(["search", "alpha", root, "--bm25", "--json"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stderr).toBe("");

    const trimmed = cap.stdout.trim();
    // Single JSON line.
    expect(trimmed.includes("\n")).toBe(false);
    const parsed = JSON.parse(trimmed) as {
      query: string;
      mode: string;
      hits: Array<{
        filePath: string;
        startLine: number;
        endLine: number;
        score: number;
        content: string;
      }>;
    };
    expect(parsed.query).toBe("alpha");
    expect(parsed.mode).toBe("bm25");
    expect(parsed.hits.length).toBeGreaterThan(0);
    const top = parsed.hits[0]!;
    expect(typeof top.filePath).toBe("string");
    expect(typeof top.startLine).toBe("number");
    expect(typeof top.endLine).toBe("number");
    expect(typeof top.score).toBe("number");
    expect(typeof top.content).toBe("string");
    expect(top.filePath.startsWith("auth/")).toBe(true);
  });

  it("rejects an empty query with exit 1", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runSearch(["search", "", root, "--bm25", "--json"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    expect(cap.stdout).toBe("");
    expect(cap.stderr).toMatch(/missing query/);
  });

  it("rejects a nonexistent path with exit 1", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runSearch([
        "search",
        "alpha",
        join(root, "does-not-exist"),
        "--bm25",
        "--json",
      ]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    expect(cap.stderr).toMatch(/does not exist/);
  });

  it("truncates results to --top=N", async () => {
    // Five files, all containing the same query token, so BM25 returns 5 hits.
    for (let i = 0; i < 5; i++) {
      await write(`f${i}.ts`, `function alpha${i}() { return 'alpha' }\n`);
    }

    const cap = captureIO();
    let code: number;
    try {
      code = await runSearch(["search", "alpha", root, "--top=2", "--bm25", "--json"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout.trim()) as {
      hits: unknown[];
    };
    expect(parsed.hits.length).toBe(2);
  });

  it("default text output contains a file path and a score", async () => {
    await write("auth/login.ts", "function alpha() { return 'alpha-token' }\n");
    await write("ui/button.ts", "function gamma() { return null }\n");

    const cap = captureIO();
    let code: number;
    try {
      code = await runSearch(["search", "alpha", root, "--bm25"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    // Progress is logged to stderr now; just check it isn't an error message.
    expect(cap.stderr).not.toMatch(/error|missing|invalid/i);
    expect(cap.stdout).toMatch(/auth\/login\.ts:\d+-\d+\s+\d+\.\d+/);
  });

  it("prints 'no matches' for a query with no hits", async () => {
    await write("a.ts", "function alpha() {}\n");
    const cap = captureIO();
    let code: number;
    try {
      code = await runSearch(["search", "zzznoexistnoncexyz", root, "--bm25"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stdout.trim()).toBe("no matches");
  });
});
