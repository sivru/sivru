// File-level artifact assembly (DESIGN-0004 §1, §3 / T8).
//
// Takes a `SymbolIndex` plus explain options and emits the canonical
// `ExplainArtifact` shape. Every section is descriptive only — no
// recommendations, no quality verdicts — so the artifact reads like a
// reference card the agent uses before editing.
//
// The MCP cap (T11) and the precision floor (T12) wrap this function;
// region-level (T14) and --diff (T15) compose with it. T8 itself only
// covers the file-level cut.

import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, posix, resolve as resolvePath, sep } from "node:path";
import { promisify } from "node:util";

import {
  type CalleeRef,
  type CallerRef,
  type ChurnInfo,
  type ExplainArtifact,
  type ExplainOptions,
  type OwnershipEntry,
  type SymbolIndex,
  type TestHit,
  SivruExplainError,
} from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_SINCE_DAYS = 90;

export type AssembleArtifactDeps = {
  /** Inject git stdout. Real impl shells out; tests fake it. */
  gitLog?: (args: readonly string[], cwd: string) => Promise<string>;
  gitShortlog?: (args: readonly string[], cwd: string) => Promise<string>;
  /** File-exists hook for the test-pattern matcher. */
  fileExists?: (absPath: string) => boolean;
  /** Read file synchronously for the test-case counter. */
  readSyncOrUndef?: (absPath: string) => string | undefined;
  /**
   * Realpath check (T13 threat model). When provided, the test-pattern
   * matcher uses it to reject candidate paths whose realpath escapes the
   * repo root. Default uses `node:fs#realpathSync` and asserts the
   * resolved path stays inside `index.repoPath`.
   */
  isInsideRepoRealpath?: (absPath: string, repoRoot: string) => boolean;
};

async function defaultGit(
  args: readonly string[],
  cwd: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args.slice(), { cwd });
    return stdout;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new SivruExplainError("SIVRU-E2006", `git not found on PATH`);
    }
    // Unknown failures bubble up empty — git not initialised, no commits, etc.
    return "";
  }
}

function defaultFileExists(absPath: string): boolean {
  try {
    return existsSync(absPath) && statSync(absPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Default realpath-inside check (T13). Resolves both sides and asserts the
 * target sits under the repo. Any failure (missing file, permission) is
 * conservative — return false so the candidate is dropped, not read.
 */
function defaultIsInsideRepoRealpath(
  absPath: string,
  repoRoot: string,
): boolean {
  try {
    const realTarget = realpathSync(absPath);
    const realRoot = realpathSync(repoRoot);
    const rootSlash = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    const targetSlash = realTarget.endsWith(sep)
      ? realTarget
      : realTarget + sep;
    if (realTarget === realRoot) return true;
    return targetSlash.startsWith(rootSlash);
  } catch {
    return false;
  }
}

function defaultReadSync(absPath: string): string | undefined {
  try {
    // Avoid pulling node:fs at the top — readFileSync is hot-path only on
    // matched test files, which is bounded by §3d's pattern set.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require("node:fs") as typeof import("node:fs")).readFileSync(
      absPath,
      "utf8",
    );
  } catch {
    return undefined;
  }
}

/**
 * Build the canonical `ExplainArtifact` for a file-level explain target.
 *
 * Caps (`opts.mcpCap`), precision floors (T12), region slicing (T14), and
 * diff mode (T15) are explicitly NOT applied here — they wrap or compose
 * with the result.
 */
export async function assembleArtifact(
  opts: ExplainOptions,
  index: SymbolIndex,
  deps: AssembleArtifactDeps = {},
): Promise<ExplainArtifact> {
  const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
  const target = opts.target;
  const targetEntry = index.get(target);
  const gitLog = deps.gitLog ?? defaultGit;
  const gitShortlog = deps.gitShortlog ?? defaultGit;
  const fileExists = deps.fileExists ?? defaultFileExists;
  const readSyncOrUndef = deps.readSyncOrUndef ?? defaultReadSync;
  const isInsideRepoRealpath =
    deps.isInsideRepoRealpath ?? defaultIsInsideRepoRealpath;

  // ---- public_api ------------------------------------------------------
  const public_api = targetEntry?.exports.slice() ?? [];

  // ---- callees ---------------------------------------------------------
  const calleesByPath = new Map<string, Set<string>>();
  if (targetEntry !== undefined) {
    for (const imp of targetEntry.imports) {
      if (imp.resolved === null) continue;
      if (imp.resolved === target) continue;
      const bucket = calleesByPath.get(imp.resolved) ?? new Set();
      for (const id of imp.identifiers) bucket.add(id);
      calleesByPath.set(imp.resolved, bucket);
    }
  }
  const callees: CalleeRef[] = Array.from(calleesByPath.entries())
    .map(([filePath, syms]) => ({
      filePath,
      symbols: Array.from(syms).sort(),
    }))
    .sort((a, b) => {
      // Same D15 sort as callers: low-churn first so the truncated tail is
      // the dangerous-because-noisy stuff, not the dangerous-because-stable
      // stuff.
      const cA = index.get(a.filePath)?.commitCount ?? 0;
      const cB = index.get(b.filePath)?.commitCount ?? 0;
      if (cA !== cB) return cA - cB;
      const mA = index.get(a.filePath)?.mtimeMs ?? 0;
      const mB = index.get(b.filePath)?.mtimeMs ?? 0;
      if (mA !== mB) return mA - mB;
      return a.filePath.localeCompare(b.filePath);
    });

  // ---- callers ---------------------------------------------------------
  // A file is a caller iff one of its imports resolves to <target> AND the
  // imported identifiers overlap with this file's exported names. Identifier
  // overlap is what the design calls "identifier match across an import";
  // it's the cheap second-stage filter that turns the noisy "anything that
  // imports me" into a useful caller list.
  const exportedNames = new Set(public_api.map((e) => e.name));
  const callers: CallerRef[] = [];
  for (const entry of index.entries()) {
    if (entry.filePath === target) continue;
    for (const imp of entry.imports) {
      if (imp.resolved !== target) continue;
      let matched: string[];
      if (exportedNames.size === 0) {
        // No declared exports (uncovered language, or empty file). Skip — we
        // can't claim a true caller match without something to match on.
        matched = [];
      } else if (imp.identifiers.length === 0) {
        // Side-effect import (`import "./foo.css"`) or wildcard — keep the
        // edge but report no specific symbols.
        matched = [];
      } else {
        matched = imp.identifiers.filter((id) => exportedNames.has(id));
        if (matched.length === 0) continue;
      }
      callers.push({
        filePath: entry.filePath,
        line: 1, // T11 sort uses commitCount; per-line precision deferred
        symbols: matched,
      });
      break; // one entry per caller file; subsequent imports are noise
    }
  }
  callers.sort((a, b) => {
    const cA = index.get(a.filePath)?.commitCount ?? 0;
    const cB = index.get(b.filePath)?.commitCount ?? 0;
    if (cA !== cB) return cA - cB; // ascending: low-churn first
    const mA = index.get(a.filePath)?.mtimeMs ?? 0;
    const mB = index.get(b.filePath)?.mtimeMs ?? 0;
    if (mA !== mB) return mA - mB; // ascending: oldest first
    return a.filePath.localeCompare(b.filePath);
  });

  // T12: scaled precision floor (D16 + D4). Go and Java resolve at a
  // coarser grain (package / source-root+class), so a util file in those
  // languages can fan out to hundreds of "callers" that are mostly noise.
  // When the candidate list exceeds the scaled floor, drop it entirely and
  // surface `callers_skipped_reason: "precision-floor"`. The footer
  // already reports the chosen floor so the agent sees what gate fired.
  const language = targetEntry?.language ?? null;
  const precisionFloor = Math.max(100, Math.round(index.size() * 0.05));
  let finalCallers: CallerRef[] | null = callers;
  let callersSkippedReason: string | null = null;
  if (
    (language === "go" || language === "java") &&
    callers.length > precisionFloor
  ) {
    finalCallers = null;
    callersSkippedReason = "precision-floor";
  }

  // ---- churn -----------------------------------------------------------
  const churn: ChurnInfo = await collectChurn(
    index.repoPath,
    target,
    sinceDays,
    gitLog,
    targetEntry?.commitCount,
  );

  // ---- ownership -------------------------------------------------------
  const ownership = await collectOwnership(index.repoPath, target, gitShortlog);

  // ---- tests -----------------------------------------------------------
  const tests = collectTests(
    index,
    target,
    fileExists,
    readSyncOrUndef,
    isInsideRepoRealpath,
  );

  // ---- footer ----------------------------------------------------------
  const footer = buildFooter({
    repoFileCount: index.size(),
    language: targetEntry?.language ?? null,
    sinceDays,
    isRegion: false,
  });

  return {
    path: target,
    public_api,
    callers: finalCallers,
    callees,
    churn,
    ownership,
    tests,
    authored: [],
    callers_truncated: null,
    callees_truncated: null,
    callers_skipped_reason: callersSkippedReason,
    footer,
  };
}

async function collectChurn(
  repoPath: string,
  target: string,
  sinceDays: number,
  gitLog: NonNullable<AssembleArtifactDeps["gitLog"]>,
  fallbackCount?: number,
): Promise<ChurnInfo> {
  const args = [
    "log",
    "--follow",
    `--since=${sinceDays}.days`,
    "--pretty=format:%H %cI",
    "--",
    target,
  ];
  const out = await gitLog(args, repoPath);
  const lines = out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) {
    return {
      commitCount: fallbackCount ?? 0,
      lastCommitAt: null,
      sinceDays,
    };
  }
  const first = lines[0]!;
  // `%cI` is the committer ISO timestamp. The line shape is `<sha> <iso>`.
  const firstSpace = first.indexOf(" ");
  const lastCommitAt = firstSpace >= 0 ? first.slice(firstSpace + 1) : null;
  return {
    commitCount: lines.length,
    lastCommitAt,
    sinceDays,
  };
}

async function collectOwnership(
  repoPath: string,
  target: string,
  gitShortlog: NonNullable<AssembleArtifactDeps["gitShortlog"]>,
): Promise<OwnershipEntry[]> {
  // `git shortlog` reads commits from stdin unless a rev is given on the
  // command line. Without `HEAD` it would block waiting for stdin and hang
  // the entire request.
  const out = await gitShortlog(
    ["shortlog", "-ns", "HEAD", "--", target],
    repoPath,
  );
  const rows: { author: string; count: number }[] = [];
  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const m = line.match(/^(\d+)\s+(.+)$/);
    if (m === null) continue;
    rows.push({ count: Number.parseInt(m[1]!, 10), author: m[2]! });
  }
  const total = rows.reduce((acc, r) => acc + r.count, 0);
  if (total === 0) return [];
  return rows.map((r) => ({
    author: r.author,
    percent: Math.round((r.count / total) * 100),
    count: r.count,
  }));
}

const TEST_DIR_SEGMENT = "__tests__";

function collectTests(
  index: SymbolIndex,
  target: string,
  fileExists: (absPath: string) => boolean,
  readSyncOrUndef: (absPath: string) => string | undefined,
  isInsideRepoRealpath: (absPath: string, repoRoot: string) => boolean,
): TestHit[] {
  const ext = extname(target);
  const stem = target.slice(0, target.length - ext.length);
  const base = stem.split(posix.sep).pop() ?? stem;
  const dir = dirname(target);
  // Candidate paths derived from §3d.
  const candidates = new Set<string>();
  const extsToTry = ext.length > 0 ? [ext] : ["", ".ts", ".tsx", ".js", ".jsx"];
  for (const e of extsToTry) {
    candidates.add(`${stem}.test${e}`);
    candidates.add(`${stem}.spec${e}`);
    candidates.add(posix.join(dir, `${base}_test${e}`)); // Go convention
    candidates.add(posix.join(dir, TEST_DIR_SEGMENT, `${base}${e}`));
  }
  // Python: `tests/test_<stem>.py` next to the module.
  candidates.add(posix.join(dir, `test_${base}.py`));

  const out: TestHit[] = [];
  for (const c of candidates) {
    const indexed = index.get(c);
    const absPath = resolvePath(index.repoPath, c);
    if (indexed === undefined && !fileExists(absPath)) continue;
    // T13: a test fixture or symlink that points outside the repo would be
    // a credential-exfil vector if we read it blindly. Realpath both sides
    // and drop the candidate if the resolved path escapes repoRoot.
    if (!isInsideRepoRealpath(absPath, index.repoPath)) continue;
    const source = readSyncOrUndef(absPath) ?? "";
    const cases = countTestCases(source);
    out.push({ filePath: c, cases });
  }
  return out;
}

/** Count test cases by grepping for `it(` / `test(` / `def test_`. */
function countTestCases(source: string): number {
  if (source.length === 0) return 0;
  let count = 0;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^(?:it|test)\s*\(/.test(line)) count++;
    else if (/^def\s+test_/.test(line)) count++;
  }
  return count;
}

export function buildFooter(opts: {
  repoFileCount: number;
  language: string | null;
  sinceDays: number;
  isRegion: boolean;
}): string {
  const floor = Math.max(100, Math.round(opts.repoFileCount * 0.05));
  const parts: string[] = [
    "call graph is identifier-based; not type-resolved — expect false positives on common names.",
  ];
  if (opts.language === "go") {
    parts.push("Go callers resolve at package granularity.");
  }
  if (opts.language === "java") {
    parts.push("Java resolves at source-root + class granularity.");
  }
  if (opts.language === null) {
    parts.push("language is not in the resolver set — public_api is empty.");
  }
  parts.push(`Churn window: ${opts.sinceDays} days.`);
  parts.push(`Precision floor at this repo size: ${floor}.`);
  if (opts.isRegion) {
    parts.push(
      "Region-level explain runs git log -L per call; may be slow on hot files.",
    );
  }
  return parts.join(" ");
}
