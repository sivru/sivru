// CLI smoke tests for `sivru block`.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseBlockArgs, runBlock } from "./block.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
    if (out.kind === "ok" && out.args.subcommand === "validate") {
      expect(out.args.rootPaths.length).toBe(1);
      expect(out.args.autofix).toBe(false);
      expect(out.args.changedSince).toBeNull();
    }
  });

  it("parses extract --json subcommand with a single path", () => {
    const out = parseBlockArgs(["extract", "--json", "/some/path"]);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok" && out.args.subcommand === "extract") {
      expect(out.args.json).toBe(true);
      expect(out.args.rootPaths).toEqual(["/some/path"]);
    }
  });

  it("parses validate with multiple paths (DESIGN-0019 §5)", () => {
    const out = parseBlockArgs(["validate", "/a", "/b", "/c"]);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok" && out.args.subcommand === "validate") {
      expect(out.args.rootPaths).toEqual(["/a", "/b", "/c"]);
    }
  });

  it("parses validate with --changed-since=<ref>", () => {
    const out = parseBlockArgs(["validate", "--changed-since=origin/main"]);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok" && out.args.subcommand === "validate") {
      expect(out.args.changedSince).toBe("origin/main");
    }
  });

  it("parses validate --autofix --allow-dirty", () => {
    const out = parseBlockArgs(["validate", "--autofix", "--allow-dirty"]);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok" && out.args.subcommand === "validate") {
      expect(out.args.autofix).toBe(true);
      expect(out.args.allowDirty).toBe(true);
    }
  });

  it("parses check-enforcement subcommand", () => {
    const out = parseBlockArgs(["check-enforcement", "/a", "/b"]);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok" && out.args.subcommand === "check-enforcement") {
      expect(out.args.rootPaths).toEqual(["/a", "/b"]);
    }
  });

  it("parses staleness with --since", () => {
    const out = parseBlockArgs(["staleness", "--since=HEAD~5", "--strict"]);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok" && out.args.subcommand === "staleness") {
      expect(out.args.since).toBe("HEAD~5");
      expect(out.args.strict).toBe(true);
    }
  });

  it("parses graph --check --json", () => {
    const out = parseBlockArgs(["graph", "--check", "--json"]);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok" && out.args.subcommand === "graph") {
      expect(out.args.check).toBe(true);
      expect(out.args.json).toBe(true);
    }
  });

  it("parses init with --symbol --write", () => {
    const out = parseBlockArgs(["init", "/some/file.ts", "--symbol=Foo", "--write"]);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok" && out.args.subcommand === "init") {
      expect(out.args.filePath).toBe("/some/file.ts");
      expect(out.args.symbol).toBe("Foo");
      expect(out.args.write).toBe(true);
    }
  });

  it("rejects unknown flags", () => {
    expect(parseBlockArgs(["validate", "--weird"]).kind).toBe("err");
  });

  it("rejects multi-path + --changed-since on validate (different repos would diff wrong)", () => {
    const out = parseBlockArgs([
      "validate",
      "/a",
      "/b",
      "--changed-since=main",
    ]);
    expect(out.kind).toBe("err");
    if (out.kind === "err") {
      expect(out.message).toContain("--changed-since");
    }
  });

  it("rejects multi-path + --changed-since on check-enforcement", () => {
    const out = parseBlockArgs([
      "check-enforcement",
      "/a",
      "/b",
      "--changed-since=main",
    ]);
    expect(out.kind).toBe("err");
  });

  it("allows multi-path without --changed-since", () => {
    const out = parseBlockArgs(["validate", "/a", "/b", "/c"]);
    expect(out.kind).toBe("ok");
  });

  it("allows single-path with --changed-since", () => {
    const out = parseBlockArgs(["validate", "/a", "--changed-since=main"]);
    expect(out.kind).toBe("ok");
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

describe("runBlock — extract --json output complete (regression)", () => {
  // Regression for the QA-found bug where the CLI's process.exit handler
  // truncated piped stdout at the OS pipe-buffer boundary (~8 KiB on
  // macOS). This silently corrupted extract --json output for any
  // non-trivial repo and broke the CI role-coverage gate.
  //
  // Spawn the actual built binary as a child and read its full stdout
  // via a pipe — this is the only way to exercise the drain path; an
  // in-process spy mock would always observe the unfiltered output.
  it("extract --json over a large input produces complete, parseable stdout", async () => {
    // Skip when the built binary doesn't exist yet (clean checkout
    // before `pnpm build`). Vitest runs from src/, so we check dist/.
    const binPath = join(__dirname, "..", "..", "dist", "index.js");
    if (!existsSync(binPath)) {
      return;
    }
    // Build a fixture with enough blocks to easily exceed 8 KiB.
    const dir = mkRepo(
      Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [
          `file-${i}.ts`,
          [
            "/**",
            " * @sivru",
            " * schema: 1",
            ` * role: role-${i}`,
            ` * responsibility: file-${i} responsibility text padded to give the output real bulk for the drain test`,
            ` * collaborators: [a-${i}, b-${i}, c-${i}]`,
            " * @end",
            " */",
            `export function fn${i}(): void {}`,
          ].join("\n"),
        ]),
      ),
    );
    const out = execFileSync("node", [binPath, "block", "extract", "--json", dir], {
      encoding: "utf8",
      // Default maxBuffer is 1 MiB; well above what 30 blocks emit but
      // explicit so a future expansion of the fixture doesn't tip over.
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(out.length).toBeGreaterThan(8192);
    // The whole array parses cleanly — no truncation at any boundary.
    const data = JSON.parse(out) as unknown[];
    expect(data).toHaveLength(30);
  });
});

describe("runBlock — DESIGN-0019 subcommands", () => {
  function captureIo<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
    let stdoutBuf = "";
    let stderrBuf = "";
    const sout = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      stdoutBuf += String(c);
      return true;
    });
    const serr = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      stderrBuf += String(c);
      return true;
    });
    return fn()
      .then((result) => ({ result, stdout: stdoutBuf, stderr: stderrBuf }))
      .finally(() => {
        sout.mockRestore();
        serr.mockRestore();
      });
  }

  it("check-enforcement exits 1 when an enforced-by reference doesn't resolve", async () => {
    const dir = mkRepo({
      "src/subject.ts": [
        "/**",
        " * @sivru",
        " * schema: 1",
        " * role: r",
        " * responsibility: r",
        " * invariants:",
        " *   - rule: \"y\"",
        " *     enforced-by: doesNotExistAnywhere",
        " * @end",
        " */",
        "export function bad(): void {}",
      ].join("\n"),
    });
    const { result, stdout, stderr } = await captureIo(() =>
      runBlock(["check-enforcement", dir]),
    );
    expect(result).toBe(1);
    expect(stdout + stderr).toContain("SIVRU-E230");
  });

  it("validate --autofix rewrites E237 silent-drift on a colon-in-prose invariant", async () => {
    const dir = mkRepo({
      "foo.ts": [
        "/**",
        " * @sivru",
        " * schema: 1",
        " * role: r",
        " * responsibility: r",
        " * invariants:",
        " *   - tx: REQUIRES_NEW per-row failure does not abort the run",
        " * @end",
        " */",
        "export function foo(): void {}",
      ].join("\n"),
    });
    // --allow-dirty because the file is brand-new (not committed).
    const { result, stdout } = await captureIo(() =>
      runBlock(["validate", "--autofix", "--allow-dirty", dir]),
    );
    expect(stdout).toContain("rewrite(s)");
    // After autofix the second pass exits 0 (no remaining errors).
    void result;
    const after = await captureIo(() => runBlock(["validate", dir]));
    expect(after.result).toBe(0);
  });

  it("graph --check exits 1 on asymmetric collaborators", async () => {
    const dir = mkRepo({
      "src/A.ts": [
        "/**",
        " * @sivru",
        " * schema: 1",
        " * role: r",
        " * responsibility: rA",
        " * collaborators:",
        " *   - B",
        " * @end",
        " */",
        "export class A {}",
      ].join("\n"),
      "src/B.ts": [
        "/**",
        " * @sivru",
        " * schema: 1",
        " * role: r",
        " * responsibility: rB",
        " * @end",
        " */",
        "export class B {}",
      ].join("\n"),
    });
    const { stdout, stderr } = await captureIo(() =>
      runBlock(["graph", "--check", dir]),
    );
    expect(stdout + stderr).toContain("SIVRU-E234");
  });

  it("init prints a scaffolded block to stdout when --write is absent", async () => {
    const dir = mkRepo({
      // A doc comment so the responsibility extraction triggers the
      // "auto-generated, replace" marker.
      "src/Service.ts": [
        "/** Resolve and dispatch routes. */",
        "export class FooService { foo() {} }",
      ].join("\n"),
    });
    const { result, stdout } = await captureIo(() =>
      runBlock(["init", join(dir, "src/Service.ts")]),
    );
    expect(result).toBe(0);
    expect(stdout).toContain("@sivru");
    expect(stdout).toContain("@end");
    expect(stdout).toContain("role: service");
    expect(stdout).toContain("auto-generated, replace");
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
