// Gitignore-aware repo walker.
//
// Emits one `WalkEntry` per file under `rootDir` that survives the filter set:
// honors `.gitignore` (root + nested + negations), bounds symlink loops,
// caps file size, skips binaries, and surfaces every skip reason via the
// optional `onSkip` callback so callers can log when they care.
//
// DESIGN.md §3 (layout), §4 module map (walker uses the `ignore` npm).
// W1 issue #2 owns the test plan.

import { promises as fsp } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { sep, relative, resolve, isAbsolute } from "node:path";
import ignoreImport from "ignore";
import type { Ignore } from "ignore";

// `ignore`'s `.d.ts` exports the factory via a function/namespace merge,
// which TypeScript surfaces as a non-callable namespace under
// verbatimModuleSyntax + NodeNext. Cast to the documented call signature.
const ignore = ignoreImport as unknown as () => Ignore;

import type { WalkEntry, WalkOptions } from "../types.js";

const DEFAULT_MAX_FILE_BYTES = 1_048_576; // 1 MiB
const BINARY_PROBE_BYTES = 8192;
// `.git/` is always skipped — independent of any user-supplied .gitignore.
const ALWAYS_IGNORE = [".git"];

type Layer = {
  /** Absolute directory the rules in `ig` are scoped to. */
  dir: string;
  ig: Ignore;
};

type Resolved = {
  respectGitignore: boolean;
  followSymlinks: boolean;
  maxFileBytes: number;
  onSkip: WalkOptions["onSkip"];
};

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function relPosix(rootDir: string, absPath: string): string {
  return toPosix(relative(rootDir, absPath));
}

/**
 * Test whether `absPath` is ignored by any layer in the stack. Inner layers
 * can re-include a path via `!pattern`, implementing gitignore's
 * last-match-wins semantics across nested `.gitignore` files.
 *
 * `kind` lets us match directory-only patterns (`foo/`) against directories.
 */
function isIgnored(
  layers: readonly Layer[],
  absPath: string,
  kind: "file" | "dir",
): boolean {
  let ignored = false;
  for (const layer of layers) {
    const rel = relative(layer.dir, absPath);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    const candidate = kind === "dir" ? `${toPosix(rel)}/` : toPosix(rel);
    const result = layer.ig.test(candidate);
    if (result.unignored) {
      ignored = false;
    } else if (result.ignored) {
      ignored = true;
    }
  }
  return ignored;
}

async function readGitignore(dir: string): Promise<string | null> {
  try {
    return await fsp.readFile(resolve(dir, ".gitignore"), "utf8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    // No file, or directory unreadable — either way we have no extra rules
    // to layer in from here, and the caller surfaces the perm-denied skip
    // when readdir() fails next.
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return null;
    throw err;
  }
}

/** Probe the first 8 KiB for a NUL byte; classic UNIX heuristic for binary. */
async function isBinary(absPath: string): Promise<boolean> {
  const handle = await fsp.open(absPath, "r");
  try {
    const buf = Buffer.alloc(BINARY_PROBE_BYTES);
    const { bytesRead } = await handle.read(buf, 0, BINARY_PROBE_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } finally {
    await handle.close();
  }
}

function isPermissionDenied(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Walk `rootDir`, yielding entries for every file that passes the filter set.
 *
 * Iteration is depth-first, sorted by `readdir` lexical order so cache
 * `state_id` hashes don't drift across platforms (DESIGN.md §4.6).
 */
export async function* walk(
  rootDir: string,
  options: WalkOptions = {},
): AsyncGenerator<WalkEntry> {
  const root = resolve(rootDir);
  const resolvedOpts: Resolved = {
    respectGitignore: options.respectGitignore ?? true,
    followSymlinks: options.followSymlinks ?? false,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    onSkip: options.onSkip,
  };

  const baseLayer: Layer = { dir: root, ig: ignore().add(ALWAYS_IGNORE) };
  const seenDirs = new Set<string>();

  yield* walkDir(root, root, [baseLayer], seenDirs, resolvedOpts);
}

async function* walkDir(
  rootDir: string,
  currentDir: string,
  layers: readonly Layer[],
  seenDirs: Set<string>,
  opts: Resolved,
): AsyncGenerator<WalkEntry> {
  let realStat: Stats;
  try {
    realStat = await fsp.stat(currentDir);
  } catch (err) {
    if (isPermissionDenied(err)) {
      opts.onSkip?.(relPosix(rootDir, currentDir), "permission-denied");
      return;
    }
    throw err;
  }
  const inodeKey = `${realStat.dev}:${realStat.ino}`;
  if (seenDirs.has(inodeKey)) {
    opts.onSkip?.(relPosix(rootDir, currentDir), "symlink-loop");
    return;
  }
  seenDirs.add(inodeKey);

  let activeLayers = layers;
  if (opts.respectGitignore) {
    const text = await readGitignore(currentDir);
    if (text !== null) {
      activeLayers = [...layers, { dir: currentDir, ig: ignore().add(text) }];
    }
  }

  let entries: Dirent[];
  try {
    entries = await fsp.readdir(currentDir, { withFileTypes: true });
  } catch (err) {
    if (isPermissionDenied(err)) {
      opts.onSkip?.(relPosix(rootDir, currentDir), "permission-denied");
      return;
    }
    throw err;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const absPath = resolve(currentDir, entry.name);
    const isSymlink = entry.isSymbolicLink();

    let isFile: boolean;
    let isDir: boolean;
    if (isSymlink) {
      if (!opts.followSymlinks) {
        opts.onSkip?.(relPosix(rootDir, absPath), "not-a-regular-file");
        continue;
      }
      try {
        const targetStat = await fsp.stat(absPath);
        isFile = targetStat.isFile();
        isDir = targetStat.isDirectory();
      } catch (err) {
        if (isPermissionDenied(err) || isMissing(err)) {
          opts.onSkip?.(relPosix(rootDir, absPath), "permission-denied");
          continue;
        }
        throw err;
      }
    } else {
      isFile = entry.isFile();
      isDir = entry.isDirectory();
    }

    if (isDir) {
      if (opts.respectGitignore && isIgnored(activeLayers, absPath, "dir")) {
        opts.onSkip?.(relPosix(rootDir, absPath), "gitignore");
        continue;
      }
      yield* walkDir(rootDir, absPath, activeLayers, seenDirs, opts);
      continue;
    }

    if (!isFile) {
      opts.onSkip?.(relPosix(rootDir, absPath), "not-a-regular-file");
      continue;
    }

    if (opts.respectGitignore && isIgnored(activeLayers, absPath, "file")) {
      opts.onSkip?.(relPosix(rootDir, absPath), "gitignore");
      continue;
    }

    let stat: Stats;
    try {
      stat = await fsp.stat(absPath);
    } catch (err) {
      if (isPermissionDenied(err) || isMissing(err)) {
        opts.onSkip?.(relPosix(rootDir, absPath), "permission-denied");
        continue;
      }
      throw err;
    }

    if (stat.size > opts.maxFileBytes) {
      opts.onSkip?.(relPosix(rootDir, absPath), "too-large");
      continue;
    }

    let binary: boolean;
    try {
      binary = await isBinary(absPath);
    } catch (err) {
      if (isPermissionDenied(err)) {
        opts.onSkip?.(relPosix(rootDir, absPath), "permission-denied");
        continue;
      }
      throw err;
    }
    if (binary) {
      opts.onSkip?.(relPosix(rootDir, absPath), "binary");
      continue;
    }

    yield {
      filePath: relPosix(rootDir, absPath),
      absPath,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
    };
  }
}
