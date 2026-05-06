import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { computeStateId } from "./state-id.js";

const isWindows = process.platform === "win32";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sivru-stateid-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(p: string, content: string): Promise<void> {
  const abs = join(root, p);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  });
}

function initRepo(repo: string): void {
  // -b main avoids a noisy "init.defaultBranch" warning on newer git.
  try {
    git(repo, ["init", "-b", "main"]);
  } catch {
    // Older git without -b: fall back.
    git(repo, ["init"]);
  }
  git(repo, ["config", "user.email", "test@test"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
}

describe("computeStateId", () => {
  describe("non-git directory", () => {
    it("returns a stable mtime: id across calls when content is unchanged", async () => {
      await write("a.txt", "hello\n");
      await write("b/c.md", "world\n");
      // Pin mtimes so a passing CI clock doesn't shift the hash between
      // the two `computeStateId` calls.
      const fixed = new Date("2024-01-01T00:00:00Z");
      await utimes(join(root, "a.txt"), fixed, fixed);
      await utimes(join(root, "b/c.md"), fixed, fixed);

      const a = await computeStateId(root);
      const b = await computeStateId(root);

      expect(a).toBe(b);
      expect(a.startsWith("mtime:")).toBe(true);
      // sha256 -> 64 hex chars after the `mtime:` prefix.
      expect(a.length).toBe("mtime:".length + 64);
    });

    it("changes when a tracked file is modified", async () => {
      await write("a.txt", "hello\n");
      const fixed = new Date("2024-01-01T00:00:00Z");
      await utimes(join(root, "a.txt"), fixed, fixed);
      const before = await computeStateId(root);

      // Bump mtime explicitly so we don't depend on filesystem timestamp
      // resolution catching a millisecond-fast write.
      await writeFile(join(root, "a.txt"), "hello\nchanged\n");
      const later = new Date("2024-06-01T00:00:00Z");
      await utimes(join(root, "a.txt"), later, later);

      const after = await computeStateId(root);
      expect(after).not.toBe(before);
      expect(after.startsWith("mtime:")).toBe(true);
    });
  });

  describe("git repository", () => {
    it.skipIf(isWindows)(
      "returns the HEAD sha when the working tree is clean",
      async () => {
        initRepo(root);
        await write("a.txt", "hello\n");
        git(root, ["add", "-A"]);
        git(root, ["commit", "-m", "init"]);

        const sha = git(root, ["rev-parse", "HEAD"]).trim();
        expect(sha).toMatch(/^[0-9a-f]{40}$/);

        const id = await computeStateId(root);
        expect(id).toBe(sha);
      },
    );

    it.skipIf(isWindows)(
      "returns `<sha>:<dirty-hash>` when the working tree is dirty",
      async () => {
        initRepo(root);
        await write("a.txt", "hello\n");
        git(root, ["add", "-A"]);
        git(root, ["commit", "-m", "init"]);
        const sha = git(root, ["rev-parse", "HEAD"]).trim();

        // Dirty edit (tracked file modified, not staged).
        await writeFile(join(root, "a.txt"), "hello\nchanged\n");

        const id = await computeStateId(root);
        const colon = id.indexOf(":");
        expect(colon).toBeGreaterThan(0);
        const prefix = id.slice(0, colon);
        const tail = id.slice(colon + 1);
        expect(prefix).toBe(sha);
        expect(tail).toMatch(/^[0-9a-f]{64}$/);
      },
    );
  });
});
