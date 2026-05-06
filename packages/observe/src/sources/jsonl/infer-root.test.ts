import { describe, expect, it } from "vitest";
import { inferProjectRootFromPrefix } from "./infer-root";

describe("inferProjectRootFromPrefix", () => {
  it("returns null for empty input", () => {
    expect(inferProjectRootFromPrefix("", new Set(["/x"]))).toBeNull();
    expect(inferProjectRootFromPrefix("/x", new Set())).toBeNull();
  });

  it("matches dash-separated worktree paths", () => {
    const roots = new Set(["/dev/buildwrightV2"]);
    expect(
      inferProjectRootFromPrefix("/dev/buildwrightV2-arch-p4", roots),
    ).toBe("/dev/buildwrightV2");
  });

  it("matches slash-separated descendant paths", () => {
    const roots = new Set(["/dev/myrepo"]);
    expect(inferProjectRootFromPrefix("/dev/myrepo/sub/dir", roots)).toBe(
      "/dev/myrepo",
    );
  });

  // The CRITICAL false-positive guard: prefixes that don't end at a
  // natural boundary should NOT match.
  it("does NOT match when the boundary is a regular character", () => {
    const roots = new Set(["/dev/buildwright"]);
    // "buildwright" is a literal prefix of "buildwrightV2", but the next
    // character ('V') isn't a separator — they're different projects.
    expect(
      inferProjectRootFromPrefix("/dev/buildwrightV2-arch-p4", roots),
    ).toBeNull();
  });

  it("returns the LONGEST matching prefix when multiple verified roots match", () => {
    const roots = new Set([
      "/dev/build",
      "/dev/buildwrightV2",
      "/dev/buildwrightV2-base",
    ]);
    // /dev/buildwrightV2 wins over /dev/build (both technically match if we
    // stripped the boundary check, but only /dev/buildwrightV2 is a longer
    // prefix with a valid separator after it).
    expect(
      inferProjectRootFromPrefix("/dev/buildwrightV2-feat-x", roots),
    ).toBe("/dev/buildwrightV2");
  });

  it("returns null when no root matches", () => {
    const roots = new Set(["/work/sivru", "/personal/playground"]);
    expect(
      inferProjectRootFromPrefix("/dev/some-project-xyz", roots),
    ).toBeNull();
  });

  it("does not match when cwd === root (handled by callers)", () => {
    const roots = new Set(["/dev/foo"]);
    expect(inferProjectRootFromPrefix("/dev/foo", roots)).toBeNull();
  });

  it("accepts underscore as a boundary too", () => {
    const roots = new Set(["/x/proj"]);
    expect(inferProjectRootFromPrefix("/x/proj_v2", roots)).toBe("/x/proj");
  });
});
