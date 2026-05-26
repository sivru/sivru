// Diff-aware staleness signal (DESIGN-0019 §2). SIVRU-E233
// `block-likely-stale` fires when a file diffed since `<ref>` but the
// blocks inside it are byte-identical — i.e., the code around the block
// changed and the block claim may now lie.
//
// Algorithm (per design, revised at eng-review iter-1 D3):
//   1. `git diff --name-only <ref>...HEAD` → changed files.
//   2. For each changed file:
//      a. Read pre-`<ref>` content via `git show <ref>:<path>`.
//      b. Extract block ranges + content hashes from BOTH pre and HEAD.
//      c. For matching block (same approximate range), if content hash
//         is identical AND `git diff --unified=0 <ref> -- <file>` has
//         hunks outside that range, emit SIVRU-E233 (warning).
//
// The pre-ref content load is one `git show` per changed file — that
// matches the design's "index-cache" direction at slot-2 fidelity
// without depending on the larger symbol-index extension yet.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

import { extractBlocks } from "./extract.js";
import type { BlockDiagnostic, ExtractedBlock, SourceRange } from "./types.js";

const execFileP = promisify(execFile);

export type StalenessOptions = {
  rootPath: string;
  since: string;
};

export type StalenessReport = {
  since: string;
  changedFiles: number;
  diagnostics: BlockDiagnostic[];
};

function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

async function gitChangedFiles(repoRoot: string, since: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP("git", ["diff", "--name-only", `${since}...HEAD`], {
      cwd: repoRoot,
    });
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

async function gitShow(repoRoot: string, ref: string, relPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["show", `${ref}:${relPath}`], {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

async function gitHunksOutsideRange(
  repoRoot: string,
  ref: string,
  relPath: string,
  range: SourceRange,
): Promise<number> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["diff", "--unified=0", ref, "--", relPath],
      { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 },
    );
    // Parse `@@ -a,b +c,d @@` hunks; count lines outside [startLine, endLine].
    let outside = 0;
    for (const m of stdout.matchAll(/@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/g)) {
      const start = parseInt(m[1]!, 10);
      const len = m[2] !== undefined ? parseInt(m[2], 10) : 1;
      const end = start + len - 1;
      // Subtract the overlap with the block range.
      const overlapStart = Math.max(start, range.startLine);
      const overlapEnd = Math.min(end, range.endLine);
      const overlap = overlapEnd >= overlapStart ? overlapEnd - overlapStart + 1 : 0;
      outside += len - overlap;
    }
    return outside;
  } catch {
    return 0;
  }
}

function findRepoRoot(start: string): string {
  let cur = start;
  for (let i = 0; i < 32; i++) {
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return start;
}

/**
 * Compute the staleness report.
 *
 * @sivru
 * schema: 1
 * role: staleness-checker
 * responsibility: emit SIVRU-E233 for blocks whose surrounding code changed since <ref> while the block body is byte-identical
 * collaborators: [extractBlocks, git]
 * invariants:
 *   - rule: only files in `git diff --name-only` are considered — clean files are skipped at zero cost
 *     enforced-by: null
 *   - rule: a block with a different content hash since <ref> is not stale; the author updated it
 *     enforced-by: null
 * decisions:
 *   - chose: git show per changed file rather than maintaining a symbol-index cache
 *     because: slot 2 ships the staleness signal first; symbol-index extension lands as a follow-on optimisation when CI cost demands it
 *     valid-while: changed-file count per PR stays in the low hundreds at most
 *     revisit-if: a CI run on a refactor-heavy PR exceeds 10s in staleness alone
 * maturity: experimental
 * @end
 */
export async function staleBlocks(opts: StalenessOptions): Promise<StalenessReport> {
  const rootPath = opts.rootPath;
  const repoRoot = findRepoRoot(rootPath);
  void repoRoot; // git invocations run with cwd = rootPath; repoRoot detection is best-effort.
  const changed = await gitChangedFiles(rootPath, opts.since);
  const diagnostics: BlockDiagnostic[] = [];

  for (const rel of changed) {
    const abs = resolvePath(rootPath, rel);
    let currentContent: string;
    try {
      currentContent = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    const before = await gitShow(rootPath, opts.since, rel);
    if (before === null) continue;

    const currentBlocks = await extractBlocks(abs, { content: currentContent });
    const beforeBlocks = await extractBlocks(abs, { content: before });

    // Index before-blocks by symbol name (best-effort match — module-level
    // matches by the literal `(module)` key).
    const beforeBySymbol = new Map<string, ExtractedBlock>();
    for (const b of beforeBlocks) {
      const key = b.symbolName ?? "(module)";
      beforeBySymbol.set(key, b);
    }

    for (const cur of currentBlocks) {
      const key = cur.symbolName ?? "(module)";
      const before = beforeBySymbol.get(key);
      if (before === undefined) continue;
      if (cur.block === null || before.block === null) continue;
      const curHash = hashContent(JSON.stringify(cur.block));
      const beforeHash = hashContent(JSON.stringify(before.block));
      if (curHash !== beforeHash) continue;

      const outside = await gitHunksOutsideRange(rootPath, opts.since, rel, cur.range);
      if (outside > 0) {
        diagnostics.push({
          code: "SIVRU-E233",
          severity: "warning",
          message: `block-likely-stale: ${outside} line(s) changed outside the block range while the block is byte-identical`,
          location: cur.range,
        });
      }
    }
  }

  return {
    since: opts.since,
    changedFiles: changed.length,
    diagnostics,
  };
}
