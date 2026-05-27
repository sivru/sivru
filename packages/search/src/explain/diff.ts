// --diff mode (DESIGN-0004 §5 / T15).
//
// Reads the working-tree diff for `<path>` against HEAD, identifies which
// exported symbols are *removed* by the edit, and for each one runs the
// region-level caller analysis against the COMMITTED-state symbol index.
//
// v0.5 ships REMOVED symbols only — renames are deferred (the design
// notes that compounding git's `-M`/`-C` rename heuristics with the
// already-imprecise identifier-based call graph multiplies false positives
// unsafely).
//
// The in-session parse cache (T16) is wired by the explainer surface, not
// here — diff.ts itself reads from the cached symbol index for the
// committed state and from the diff stream for the working state.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { assembleArtifact, type AssembleArtifactDeps } from "./artifact.js";
import type {
  ExplainArtifact,
  ExplainOptions,
  RemovedSymbolReport,
  SymbolIndex,
} from "./types.js";

const execFileAsync = promisify(execFile);

export type DiffDeps = AssembleArtifactDeps & {
  /** Git diff stdout. Real impl shells out; tests fake it. */
  gitDiff?: (
    args: readonly string[],
    cwd: string,
  ) => Promise<string>;
};

async function defaultGitDiff(
  args: readonly string[],
  cwd: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args.slice(), { cwd });
    return stdout;
  } catch {
    return "";
  }
}

/**
 * Walk the unified diff and report which exported symbols look like they
 * were *removed* by the edit. A symbol is "removed" iff a minus-line
 * (deletion) contains its declaration AND no plus-line (addition) reissues
 * the same declaration — that cross-check is what makes the report survive
 * a rewrite that git's diff algorithm reports as "delete all + add all".
 *
 * `candidateNames` is an optional filter: when provided, only symbols whose
 * name is in this set are reported. Callers that have the committed-state
 * exports cached (T6) can pass `exports.map(e=>e.name)` to tighten the
 * report; callers that don't know can omit it and accept the slightly
 * wider recall.
 *
 * False positives are bounded by T17's fixture corpus (≤ 15% FP rate gate).
 */
export function parseRemovedSymbols(
  diff: string,
  candidateNames?: readonly { name: string }[],
): string[] {
  const minusLines: string[] = [];
  const plusLines: string[] = [];
  for (const rawLine of diff.split("\n")) {
    if (rawLine.startsWith("--- ") || rawLine.startsWith("+++ ")) continue;
    if (rawLine.startsWith("@@")) continue;
    if (rawLine.startsWith("-")) minusLines.push(rawLine.slice(1));
    else if (rawLine.startsWith("+")) plusLines.push(rawLine.slice(1));
  }
  if (minusLines.length === 0) return [];

  const minusDeclared = scanDeclaredNames(minusLines);
  const plusDeclared = scanDeclaredNames(plusLines);
  const candidateSet = candidateNames
    ? new Set(candidateNames.map((c) => c.name))
    : null;

  const out: string[] = [];
  for (const name of minusDeclared) {
    if (plusDeclared.has(name)) continue; // re-declared on the plus side
    if (candidateSet !== null && !candidateSet.has(name)) continue;
    out.push(name);
  }
  return out;
}

/**
 * Scan a set of source lines and return identifiers that look like they're
 * being declared on that line. Covers the v0.5 language set:
 * function/class/interface/enum/type/const/let/var/def/struct/public-class.
 */
function scanDeclaredNames(lines: readonly string[]): Set<string> {
  const names = new Set<string>();
  const patterns: readonly RegExp[] = [
    // function / class / interface / enum / type / struct declarations
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|enum|type|struct)\s+([A-Za-z_$][\w$]*)\b/,
    // const / let / var (incl. `export const foo = …`)
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/,
    // Python `def foo(...)`
    /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/,
    // Java `public class Foo` / `public interface Foo`
    /^\s*public\s+(?:abstract\s+)?(?:class|interface|enum)\s+([A-Za-z_$][\w$]*)\b/,
  ];
  for (const line of lines) {
    for (const re of patterns) {
      const m = line.match(re);
      if (m !== null) names.add(m[1]!);
    }
  }
  return names;
}

/**
 * Build the diff artifact: regular file-level artifact (against the
 * symbol-index we were given, which represents the working tree on cold
 * cache or the committed state on warm cache per §5) plus `diff_mode: true`
 * and `removed_symbols` populated by a per-symbol caller scan over the same
 * index.
 *
 * Callers for a removed symbol = entries whose import.resolved === target
 * AND import.identifiers contains the symbol name. We compute this directly
 * here rather than recursing through `assembleArtifact`'s region path so
 * "the symbol no longer exists in the file" doesn't trigger SIVRU-E2004.
 *
 * @sivru
 * schema: 1
 * role: explain-diff
 * responsibility: assemble the explain artifact in --diff mode, including the removed_symbols section that surfaces orphaned callers
 * collaborators: [assembleArtifact, parsePathAndSymbol]
 * invariants:
 *   - rule: "removed_symbols is only populated when an export disappeared from the working-tree diff"
 *     enforced-by: null
 *   - rule: "diff_mode:true distinguishes the diff artifact from the regular artifact for downstream consumers"
 *     enforced-by: null
 * decisions:
 *   - chose: compute removed-symbol callers directly here instead of recursing through assembleArtifact's region path
 *     because: a removed symbol no longer appears in the file's exports, so the region path would throw SIVRU-E2004
 *     valid-while: SIVRU-E2004 stays the contract for missing region symbols
 *     revisit-if: a unified path through assembleArtifact becomes feasible without changing that contract
 * maturity: stable
 * @end
 */
export async function assembleDiffArtifact(
  opts: ExplainOptions,
  index: SymbolIndex,
  deps: DiffDeps = {},
): Promise<ExplainArtifact> {
  const gitDiff = deps.gitDiff ?? defaultGitDiff;
  const diff = await gitDiff(
    ["diff", "--no-color", "HEAD", "--", opts.target],
    opts.repoRoot,
  );

  // File-level artifact carries the regular five-section view; diff_mode is
  // additive on top of that.
  const baseArtifact = await assembleArtifact(opts, index, deps);

  // Don't pre-filter by working-tree exports — those are the post-edit
  // exports, so a truly-removed symbol won't be in them. The minus-vs-plus
  // cross-check inside parseRemovedSymbols is what surfaces removals.
  const removedNames = parseRemovedSymbols(diff);

  const removed_symbols: RemovedSymbolReport[] = [];
  for (const name of removedNames) {
    const callers = collectCallersForSymbol(index, opts.target, name);
    removed_symbols.push({
      symbol: name,
      callers,
      callers_truncated: null,
      callers_skipped_reason: null,
    });
  }

  return {
    ...baseArtifact,
    diff_mode: true,
    removed_symbols,
  };
}

/**
 * Find files whose imports resolve to `target` AND whose identifier list
 * mentions `symbolName`. Sorted by commitCount asc / mtime asc / path asc,
 * mirroring the file-level D15 sort.
 */
function collectCallersForSymbol(
  index: SymbolIndex,
  target: string,
  symbolName: string,
): RemovedSymbolReport["callers"] {
  const callers: RemovedSymbolReport["callers"] = [];
  for (const entry of index.entries()) {
    if (entry.filePath === target) continue;
    for (const imp of entry.imports) {
      if (imp.resolved !== target) continue;
      if (!imp.identifiers.includes(symbolName)) continue;
      callers.push({
        filePath: entry.filePath,
        line: 1,
        symbols: [symbolName],
      });
      break;
    }
  }
  callers.sort((a, b) => {
    const cA = index.get(a.filePath)?.commitCount ?? 0;
    const cB = index.get(b.filePath)?.commitCount ?? 0;
    if (cA !== cB) return cA - cB;
    const mA = index.get(a.filePath)?.mtimeMs ?? 0;
    const mB = index.get(b.filePath)?.mtimeMs ?? 0;
    if (mA !== mB) return mA - mB;
    return a.filePath.localeCompare(b.filePath);
  });
  return callers;
}
