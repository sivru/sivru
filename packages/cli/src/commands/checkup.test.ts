// Argument-parsing + end-to-end spawn tests for `sivru checkup`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCheckupArgs } from "./checkup.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = resolve(HERE, "../../dist/index.js");

function runCli(
  args: readonly string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveFn) => {
    execFile(
      "node",
      [CLI_BIN, ...args],
      { cwd, timeout: 30_000, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as NodeJS.ErrnoException | null;
        const code = e === null ? 0 : (typeof (e as { code?: unknown }).code === "number" ? Number((e as { code: number }).code) : 1);
        resolveFn({
          code,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
  });
}

describe("parseCheckupArgs", () => {
  it("defaults path to cwd", () => {
    const r = parseCheckupArgs([]);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.args.path).toBe(process.cwd());
      expect(r.args.json).toBe(false);
      expect(r.args.noGit).toBe(false);
      expect(r.args.check).toEqual([]);
    }
  });

  it("accepts a positional path", () => {
    const r = parseCheckupArgs(["/some/abs/path"]);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.args.path).toBe("/some/abs/path");
  });

  it("parses --json", () => {
    const r = parseCheckupArgs(["--json"]);
    if (r.kind === "ok") expect(r.args.json).toBe(true);
  });

  it("parses --no-git", () => {
    const r = parseCheckupArgs(["--no-git"]);
    if (r.kind === "ok") expect(r.args.noGit).toBe(true);
  });

  it("accepts --check both as separate arg and --check=value", () => {
    const r = parseCheckupArgs(["--check", "memory-claude-age", "--check=memory-dead-reference"]);
    if (r.kind === "ok") {
      expect(r.args.check).toEqual(["memory-claude-age", "memory-dead-reference"]);
    }
  });

  it("rejects --check without a value", () => {
    const r = parseCheckupArgs(["--check"]);
    expect(r.kind).toBe("err");
  });

  it("rejects unknown flags", () => {
    const r = parseCheckupArgs(["--bogus"]);
    expect(r.kind).toBe("err");
  });

  it("rejects more than one positional", () => {
    const r = parseCheckupArgs(["a", "b"]);
    expect(r.kind).toBe("err");
  });
});

describe("sivru checkup — CLI end-to-end (spawn)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "sivru-cli-checkup-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  // Per-test timeouts are 30s — the spawn wrapper itself is 30s, and these
  // tests pull in real user-global memory files on the developer's machine
  // which can take >5s (vitest default) under parallel test load.
  it("exits 1 with SIVRU-E241 when the path argument doesn't exist", async () => {
    const r = await runCli(["checkup", join(tmp, "nope")], tmp);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/SIVRU-E241/);
  }, 30_000);

  it("exits 0 with --json and emits a valid CheckupReport for an empty dir", async () => {
    const r = await runCli(["checkup", "--no-git", "--json", tmp], tmp);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { schema: number };
    expect(parsed.schema).toBe(1);
  }, 30_000);

  it("exits 0 and prints the 'everything checked' message on a clean tmp", async () => {
    const r = await runCli(["checkup", "--no-git", tmp], tmp);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Everything checked|files scanned/);
  }, 30_000);
});
