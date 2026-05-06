import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runIndex } from "./index-cmd.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sivru-cli-index-"));
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

describe("runIndex", () => {
  it("emits valid JSON with chunks > 0 when --json is passed", async () => {
    await write("a.ts", "function alpha() { return 1 }\n");
    await write("b.ts", "function beta() { return 2 }\n");

    const cap = captureIO();
    let code: number;
    try {
      code = await runIndex(["index", root, "--json"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stderr).toBe("");

    const trimmed = cap.stdout.trim();
    expect(trimmed.includes("\n")).toBe(false);
    const parsed = JSON.parse(trimmed) as {
      path: string;
      chunks: number;
      ms: number;
    };
    expect(parsed.path).toBe(root);
    expect(parsed.chunks).toBeGreaterThan(0);
    expect(typeof parsed.ms).toBe("number");
    expect(parsed.ms).toBeGreaterThanOrEqual(0);
  });

  it("emits a human-readable summary by default", async () => {
    await write("a.ts", "function alpha() {}\n");

    const cap = captureIO();
    let code: number;
    try {
      code = await runIndex(["index", root]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stdout).toMatch(/indexed /);
    expect(cap.stdout).toMatch(/chunks:/);
    expect(cap.stdout).toMatch(/took:/);
  });

  it("rejects a nonexistent path with exit 1", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runIndex(["index", join(root, "missing")]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    expect(cap.stderr).toMatch(/does not exist/);
  });
});
