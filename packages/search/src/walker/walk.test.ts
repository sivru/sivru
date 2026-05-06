import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { walk } from "./walk.js";
import type { SkipReason, WalkEntry } from "../types.js";

const isWindows = process.platform === "win32";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sivru-walker-"));
});

afterEach(async () => {
  // Restore any 0o000 perms before rm so cleanup succeeds.
  try {
    await chmod(root, 0o755);
  } catch {
    /* ignore */
  }
  await rm(root, { recursive: true, force: true });
});

async function write(p: string, content: string): Promise<void> {
  const abs = join(root, p);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function collect(
  options?: Parameters<typeof walk>[1],
): Promise<{ files: string[]; skips: Array<{ path: string; reason: SkipReason }> }> {
  const skips: Array<{ path: string; reason: SkipReason }> = [];
  const files: WalkEntry[] = [];
  for await (const e of walk(root, {
    onSkip: (p, r) => skips.push({ path: p, reason: r }),
    ...options,
  })) {
    files.push(e);
  }
  return { files: files.map((f) => f.filePath).sort(), skips };
}

describe("walk", () => {
  it("yields every regular text file under the root in deterministic order", async () => {
    await write("a.txt", "hello\n");
    await write("b/c.md", "world\n");
    await write("b/d/e.json", "{}\n");

    const { files } = await collect();
    expect(files).toEqual(["a.txt", "b/c.md", "b/d/e.json"]);
  });

  it("skips files matched by the root .gitignore", async () => {
    await write(".gitignore", "ignored.log\nbuild/\n");
    await write("keep.ts", "ok\n");
    await write("ignored.log", "skip\n");
    await write("build/output.bin", "skip\n");

    const { files, skips } = await collect();
    expect(files).toEqual([".gitignore", "keep.ts"]);
    expect(skips.some((s) => s.path === "ignored.log" && s.reason === "gitignore")).toBe(true);
    expect(skips.some((s) => s.path === "build" && s.reason === "gitignore")).toBe(true);
  });

  it("honors a nested .gitignore that re-includes a file via negation", async () => {
    await write(".gitignore", "*.log\n");
    await write("subdir/.gitignore", "!important.log\n");
    await write("subdir/important.log", "keep\n");
    await write("subdir/noisy.log", "skip\n");
    await write("top.log", "skip\n");
    await write("real.ts", "ok\n");

    const { files } = await collect();
    expect(files).toContain("subdir/.gitignore");
    expect(files).toContain("subdir/important.log");
    expect(files).toContain("real.ts");
    expect(files).toContain(".gitignore");
    expect(files).not.toContain("top.log");
    expect(files).not.toContain("subdir/noisy.log");
  });

  it("always skips the .git directory regardless of .gitignore presence", async () => {
    await write(".git/HEAD", "ref: refs/heads/main\n");
    await write("real.ts", "ok\n");

    const { files } = await collect();
    expect(files).toEqual(["real.ts"]);
  });

  it("skips binary files by NUL-byte heuristic", async () => {
    await write("text.txt", "hello world\n");
    const binary = Buffer.from([0x48, 0x00, 0x49]); // H \0 I
    await writeFile(join(root, "binary.dat"), binary);

    const { files, skips } = await collect();
    expect(files).toEqual(["text.txt"]);
    expect(skips.some((s) => s.path === "binary.dat" && s.reason === "binary")).toBe(true);
  });

  it("skips files larger than maxFileBytes", async () => {
    await write("small.txt", "x");
    await write("large.txt", "x".repeat(2048));

    const { files, skips } = await collect({ maxFileBytes: 1024 });
    expect(files).toEqual(["small.txt"]);
    expect(skips.some((s) => s.path === "large.txt" && s.reason === "too-large")).toBe(true);
  });

  it("does not follow symlinks by default", async () => {
    if (isWindows) return; // symlink creation typically requires admin on Windows
    await write("real.ts", "ok\n");
    await mkdir(join(root, "linked-dir"));
    await write("linked-dir/inside.ts", "ok\n");
    await symlink(join(root, "linked-dir"), join(root, "alias"), "dir");

    const { files } = await collect();
    expect(files).toEqual(["linked-dir/inside.ts", "real.ts"]);
  });

  it("bounds symlink loops when followSymlinks is on", async () => {
    if (isWindows) return;
    await write("seed.ts", "ok\n");
    await mkdir(join(root, "loop"));
    await symlink(join(root, "loop"), join(root, "loop", "self"), "dir");

    const { files, skips } = await collect({ followSymlinks: true });
    expect(files).toEqual(["seed.ts"]);
    expect(skips.some((s) => s.reason === "symlink-loop")).toBe(true);
  });

  it("skips a directory whose contents are unreadable", async () => {
    if (isWindows || process.getuid?.() === 0) return; // chmod on Windows / root has no effect
    await write("readable.ts", "ok\n");
    await mkdir(join(root, "locked"));
    await write("locked/inside.ts", "x\n");
    await chmod(join(root, "locked"), 0o000);

    try {
      const { files, skips } = await collect();
      expect(files).toEqual(["readable.ts"]);
      expect(skips.some((s) => s.path === "locked" && s.reason === "permission-denied")).toBe(true);
    } finally {
      // Restore perms so the afterEach `rm -rf` can clean up.
      await chmod(join(root, "locked"), 0o755);
    }
  });

  it("can disable .gitignore handling entirely", async () => {
    await write(".gitignore", "ignored.log\n");
    await write("ignored.log", "skip\n");
    await write("keep.ts", "ok\n");

    const { files } = await collect({ respectGitignore: false });
    expect(files).toEqual([".gitignore", "ignored.log", "keep.ts"]);
  });
});
