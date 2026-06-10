import { describe, expect, it } from "vitest";

import { moduleDirOf, packageSegOf } from "./levels.js";

describe("moduleDirOf", () => {
  const monorepo = ["", "packages/cli", "packages/search", "benchmarks"];

  it("maps a file to the deepest workspace package (monorepo)", () => {
    expect(moduleDirOf("packages/cli/src/commands/explain.ts", monorepo)).toBe(
      "packages/cli",
    );
    expect(moduleDirOf("packages/search/src/block/extract.ts", monorepo)).toBe(
      "packages/search",
    );
  });

  it("maps a non-package file to the repo root ('')", () => {
    expect(moduleDirOf("scripts/build.ts", monorepo)).toBe("");
  });

  it("collapses to one module when only the root has a package.json", () => {
    const single = [""];
    expect(moduleDirOf("src/foo.ts", single)).toBe("");
    expect(moduleDirOf("src/lib/bar.ts", single)).toBe("");
  });

  it("prefers the deepest match when packages nest", () => {
    const nested = ["", "packages/a", "packages/a/plugins/b"];
    expect(moduleDirOf("packages/a/plugins/b/src/x.ts", nested)).toBe(
      "packages/a/plugins/b",
    );
    expect(moduleDirOf("packages/a/src/x.ts", nested)).toBe("packages/a");
  });

  it("does not match a prefix that isn't a path-segment boundary", () => {
    // "packages/cli-extra" must not match module "packages/cli".
    expect(moduleDirOf("packages/cli-extra/src/x.ts", ["", "packages/cli"])).toBe(
      "",
    );
  });
});

describe("packageSegOf", () => {
  it("takes the first src subdir as the package (monorepo)", () => {
    expect(packageSegOf("packages/cli/src/commands/explain.ts", "packages/cli")).toBe(
      "commands",
    );
    expect(packageSegOf("packages/search/src/block/extract.ts", "packages/search")).toBe(
      "block",
    );
  });

  it("returns (root) for a file directly under src/", () => {
    expect(packageSegOf("packages/cli/src/index.ts", "packages/cli")).toBe("(root)");
  });

  it("handles a single-package repo (module is the root)", () => {
    expect(packageSegOf("src/commands/foo.ts", "")).toBe("commands");
    expect(packageSegOf("src/index.ts", "")).toBe("(root)");
  });

  it("does not require a src/ dir", () => {
    expect(packageSegOf("packages/cli/bin/run.ts", "packages/cli")).toBe("bin");
  });
});
