// Staleness exercises real git history — set up a tmp repo, commit two
// states, and run the detector. Slower than the rest of the block-test
// suite but the only way to validate the diff-aware path end-to-end.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { staleBlocks } from "./staleness.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sivru-staleness-test-"));
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function git(args: string[]): void {
  execFileSync("git", args, { cwd: tmpDir, stdio: "ignore" });
}

function setupRepo(): void {
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);
}

const blockSrc = `/**
 * @sivru
 * schema: 1
 * role: r
 * responsibility: "the thing"
 * @end
 */
export function foo() {
  return 1;
}
`;

const blockSrcWithChange = `/**
 * @sivru
 * schema: 1
 * role: r
 * responsibility: "the thing"
 * @end
 */
export function foo() {
  // refactored
  return 2 * 1;
}

export const NEW_THING = "added";
`;

describe("staleBlocks", () => {
  it("emits SIVRU-E233 when code changed around a byte-identical block", async () => {
    setupRepo();
    const f = join(tmpDir, "foo.ts");
    writeFileSync(f, blockSrc);
    git(["add", "foo.ts"]);
    git(["commit", "-q", "-m", "v1"]);
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: tmpDir,
      encoding: "utf8",
    }).trim();
    writeFileSync(f, blockSrcWithChange);
    git(["add", "foo.ts"]);
    git(["commit", "-q", "-m", "v2"]);

    const report = await staleBlocks({ rootPath: tmpDir, since: baseSha });
    expect(report.changedFiles).toBe(1);
    expect(report.diagnostics.map((d) => d.code)).toContain("SIVRU-E233");
  });

  it("clears when the block content also changed", async () => {
    setupRepo();
    const f = join(tmpDir, "foo.ts");
    writeFileSync(f, blockSrc);
    git(["add", "foo.ts"]);
    git(["commit", "-q", "-m", "v1"]);
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: tmpDir,
      encoding: "utf8",
    }).trim();
    // Modify both the block AND surrounding code.
    const dualChange = blockSrcWithChange.replace(
      `responsibility: "the thing"`,
      `responsibility: "the updated thing"`,
    );
    writeFileSync(f, dualChange);
    git(["add", "foo.ts"]);
    git(["commit", "-q", "-m", "v2"]);

    const report = await staleBlocks({ rootPath: tmpDir, since: baseSha });
    expect(report.diagnostics.filter((d) => d.code === "SIVRU-E233")).toHaveLength(0);
  });

  it("clears when only the block was changed (no surrounding edits)", async () => {
    setupRepo();
    const f = join(tmpDir, "foo.ts");
    writeFileSync(f, blockSrc);
    git(["add", "foo.ts"]);
    git(["commit", "-q", "-m", "v1"]);
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: tmpDir,
      encoding: "utf8",
    }).trim();
    // Only change the block, keep code the same.
    const blockOnly = blockSrc.replace(
      `responsibility: "the thing"`,
      `responsibility: "the updated thing"`,
    );
    writeFileSync(f, blockOnly);
    git(["add", "foo.ts"]);
    git(["commit", "-q", "-m", "v2"]);

    const report = await staleBlocks({ rootPath: tmpDir, since: baseSha });
    // Block content changed → not stale.
    expect(report.diagnostics.filter((d) => d.code === "SIVRU-E233")).toHaveLength(0);
  });

  it("scopes to the supplied rootPath subdirectory", async () => {
    setupRepo();
    mkdirSync(join(tmpDir, "in-scope"), { recursive: true });
    mkdirSync(join(tmpDir, "out-of-scope"), { recursive: true });
    writeFileSync(join(tmpDir, "in-scope", "foo.ts"), blockSrc);
    writeFileSync(join(tmpDir, "out-of-scope", "bar.ts"), blockSrc);
    git(["add", "."]);
    git(["commit", "-q", "-m", "v1"]);
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: tmpDir,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(tmpDir, "in-scope", "foo.ts"), blockSrcWithChange);
    writeFileSync(join(tmpDir, "out-of-scope", "bar.ts"), blockSrcWithChange);
    git(["add", "."]);
    git(["commit", "-q", "-m", "v2"]);

    const report = await staleBlocks({
      rootPath: join(tmpDir, "in-scope"),
      since: baseSha,
    });
    // Both files changed in git, but the scope filter drops the out-of-scope one.
    for (const d of report.diagnostics) {
      expect(d.location?.filePath).toMatch(/in-scope/);
    }
  });
});
