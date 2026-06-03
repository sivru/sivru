import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

import { isAbsolutePathStrict, isUnder, pathContainment } from "./path-safety.js";

describe("isAbsolutePathStrict", () => {
  it("accepts POSIX absolute, rejects relative", () => {
    if (process.platform !== "win32") {
      expect(isAbsolutePathStrict("/repo/a")).toBe(true);
      expect(isAbsolutePathStrict("repo/a")).toBe(false);
      expect(isAbsolutePathStrict("./a")).toBe(false);
    }
  });
});

describe("isUnder", () => {
  it("matches self and descendants at a path boundary", () => {
    expect(isUnder("/repo", "/repo")).toBe(true);
    expect(isUnder("/repo/src/a.ts", "/repo")).toBe(true);
  });
  it("rejects prefix-collision siblings", () => {
    expect(isUnder("/repofoo/a", "/repo")).toBe(false);
    expect(isUnder("/other", "/repo")).toBe(false);
  });
});

describe("pathContainment", () => {
  it("allows a path under homedir without consulting git", async () => {
    const c = await pathContainment(join(homedir(), "some", "project"));
    expect(c.allowed).toBe(true);
    expect(c.degraded).toBe(false);
  });
  it("rejects a path outside homedir that is not a git tree", async () => {
    // /proc never sits under homedir and is not a git working tree.
    const c = await pathContainment("/proc-not-a-repo-xyz");
    expect(c.allowed).toBe(false);
  });
});
