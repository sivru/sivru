// Argument-parsing tests for `sivru checkup`.

import { describe, expect, it } from "vitest";

import { parseCheckupArgs } from "./checkup.js";

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
