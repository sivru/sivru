// CLI smoke tests for `sivru block`.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseBlockArgs, runBlock } from "./block.js";

const created: string[] = [];

afterEach(() => {
  for (const p of created.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
  vi.restoreAllMocks();
});

function mkRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sivru-block-cli-"));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, "..").replace(/\/[^/]+$/, ""), { recursive: true });
    mkdirSync(abs.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

describe("parseBlockArgs", () => {
  it("requires a subcommand", () => {
    const out = parseBlockArgs([]);
    expect(out.kind).toBe("err");
  });

  it("rejects unknown subcommand", () => {
    const out = parseBlockArgs(["weird"]);
    expect(out.kind).toBe("err");
  });

  it("parses validate subcommand with default path", () => {
    const out = parseBlockArgs(["validate"]);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.args.subcommand).toBe("validate");
      expect(out.args.json).toBe(false);
    }
  });

  it("parses extract --json subcommand", () => {
    const out = parseBlockArgs(["extract", "--json", "/some/path"]);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.args.subcommand).toBe("extract");
      expect(out.args.json).toBe(true);
      expect(out.args.rootPath).toBe("/some/path");
    }
  });

  it("rejects unknown flags", () => {
    expect(parseBlockArgs(["validate", "--weird"]).kind).toBe("err");
  });
});

describe("runBlock — validate", () => {
  it("exits 0 on an all-valid fixture", async () => {
    const dir = mkRepo({
      "foo.ts": [
        "/**",
        " * @sivru",
        " * schema: 1",
        " * role: routing-brain",
        " * responsibility: route messages",
        " * @end",
        " */",
        "export function foo(): void {}",
      ].join("\n"),
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await runBlock(["validate", dir]);
    expect(code).toBe(0);
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("exits 1 on a fixture with an error-level diagnostic", async () => {
    const dir = mkRepo({
      "bad.ts": [
        "/**",
        " * @sivru",
        " * schema: 2",
        " * role: r",
        " * responsibility: p",
        " * @end",
        " */",
        "export function bad(): void {}",
      ].join("\n"),
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await runBlock(["validate", dir]);
    expect(code).toBe(1);
    // Diagnostic was written somewhere.
    const allOutput =
      stderr.mock.calls.map((c) => c[0]).join("") +
      stdout.mock.calls.map((c) => c[0]).join("");
    expect(allOutput).toContain("SIVRU-E214");
    stdout.mockRestore();
    stderr.mockRestore();
  });
});

describe("runBlock — extract --json", () => {
  it("emits invalid blocks with block:null and diagnostics populated (never silently dropped)", async () => {
    const dir = mkRepo({
      "broken.ts": [
        "/**",
        " * @sivru",
        " * schema: 1",
        " * role: r",
        " * responsibility: p",
        // No @end!
        " */",
        "export function broken(): void {}",
      ].join("\n"),
    });
    let captured = "";
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        captured += String(chunk);
        return true;
      });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runBlock(["extract", "--json", dir]);
    expect(code).toBe(0);
    const out = JSON.parse(captured) as Array<{
      block: unknown;
      diagnostics: Array<{ code: string }>;
    }>;
    expect(out).toHaveLength(1);
    expect(out[0]!.block).toBeNull();
    expect(out[0]!.diagnostics.map((d) => d.code)).toContain("SIVRU-E215");
    stdout.mockRestore();
    stderr.mockRestore();
  });
});
