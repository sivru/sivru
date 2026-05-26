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
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

import { extractBlocks } from "./extract.js";
import type { BlockCache } from "./block-cache.js";
import type { BlockDiagnostic, ExtractedBlock, SourceRange } from "./types.js";

const execFileP = promisify(execFile);

export type StalenessOptions = {
  rootPath: string;
  since: string;
  /**
   * DESIGN-0019 §2 / D3: when supplied, the HEAD-side block extraction
   * is skipped — staleness reads block ranges + content hashes from
   * the pre-built cache instead. Saves one parse per changed file.
   * The "before" side still needs `git show + extract` because the
   * cache only covers HEAD.
   */
  cache?: BlockCache;
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

/**
 * Walk upward from `start` looking for a `.git` directory; return the
 * first ancestor that contains one, else `start` (best-effort).
 *
 * Critical for staleness because `git diff --name-only` returns paths
 * relative to the repo root — if the user invokes `block staleness` from
 * a subdirectory and we mis-detect the root, we produce wrong absolute
 * paths and the file-existence check silently drops every changed file.
 */
function findRepoRoot(start: string): string {
  let cur = resolvePath(start);
  for (let i = 0; i < 32; i++) {
    if (existsSync(resolvePath(cur, ".git"))) return cur;
    const parent = resolvePath(cur, "..");
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
  // git diff returns paths relative to the repo root; we resolve to the
  // top-level .git ancestor up-front so `resolvePath(repoRoot, rel)`
  // always lands on a real file.
  const repoRoot = findRepoRoot(opts.rootPath);
  const changed = await gitChangedFiles(repoRoot, opts.since);
  const diagnostics: BlockDiagnostic[] = [];

  // Restrict to files under the user-supplied `rootPath` (when it's
  // narrower than the repo) so `block staleness packages/search/` is
  // scoped, not repo-wide. `path.relative` is the right tool here:
  // a sibling path like `packages/search2/` produces a leading `..`,
  // which a `startsWith` check would have silently let through.
  const scope = resolvePath(opts.rootPath);

  for (const rel of changed) {
    const abs = resolvePath(repoRoot, rel);
    const scopedRel = relative(scope, abs);
    if (scopedRel.startsWith("..") || isAbsolute(scopedRel)) continue;

    // HEAD-side blocks: prefer the cache (one parse already paid) if
    // it has an entry for this file; otherwise extract on the fly.
    let currentBlocks: Array<{
      symbolName: string;
      range: SourceRange;
      contentHash: string | null;
    }>;
    const cached = opts.cache?.get(abs);
    if (cached !== undefined) {
      currentBlocks = cached.map((c) => ({
        symbolName: c.symbolName,
        range: {
          filePath: abs,
          startLine: c.startLine,
          endLine: c.endLine,
        },
        contentHash: c.contentHash,
      }));
    } else {
      let currentContent: string;
      try {
        currentContent = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      const extracted = await extractBlocks(abs, { content: currentContent });
      currentBlocks = extracted.map((eb): {
        symbolName: string;
        range: SourceRange;
        contentHash: string | null;
      } => ({
        symbolName: eb.symbolName ?? "(module)",
        range: eb.range,
        contentHash: eb.block === null ? null : hashContent(JSON.stringify(eb.block)),
      }));
    }

    if (currentBlocks.length === 0) continue;

    // BEFORE-side: still requires `git show` + extract (the cache only
    // covers HEAD). DESIGN-0017's authored-baseline drift detector
    // would carry historical state; until then, the git path is the
    // authority.
    const before = await gitShow(repoRoot, opts.since, rel);
    if (before === null) continue;
    const beforeBlocks = await extractBlocks(abs, { content: before });
    const beforeBySymbol = new Map<string, ExtractedBlock>();
    for (const b of beforeBlocks) {
      beforeBySymbol.set(b.symbolName ?? "(module)", b);
    }

    for (const cur of currentBlocks) {
      if (cur.contentHash === null) continue;
      const beforeMatch = beforeBySymbol.get(cur.symbolName);
      if (beforeMatch === undefined || beforeMatch.block === null) continue;
      const beforeHash = hashContent(JSON.stringify(beforeMatch.block));
      if (cur.contentHash !== beforeHash) continue;

      const outside = await gitHunksOutsideRange(repoRoot, opts.since, rel, cur.range);
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
