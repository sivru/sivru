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
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, posix, resolve as resolvePath, sep } from "node:path";
import { promisify } from "node:util";

import {
  type AuthoredEntry,
  type CalleeRef,
  type CallerRef,
  type ChurnInfo,
  type Export,
  type ExplainArtifact,
  type ExplainOptions,
  type OwnershipEntry,
  type SymbolIndex,
  type TestHit,
  SivruExplainError,
} from "./types.js";

import { extractBlocks } from "../block/extract.js";
import { blockToJSON } from "../block/toJSON.js";
import { validateExtracted } from "../block/validate.js";
import type { BlockDiagnostic } from "../block/types.js";

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
    return readFileSync(absPath, "utf8");
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
 *
 * @sivru
 * schema: 1
 * role: explain-assembler
 * responsibility: emit the canonical ExplainArtifact for one target — public_api, callers, callees, churn, ownership, tests, authored
 * collaborators: [buildSymbolIndex, extractBlocks, parsePathAndSymbol]
 * invariants:
 *   - rule: "every section is descriptive only — no recommendations, no quality verdicts"
 *     enforced-by: null
 *   - rule: "authored entries reflect @sivru blocks from the target file only; cross-file aggregation is out of scope at v0.6"
 *     enforced-by: null
 * decisions:
 *   - chose: one shared assembler for file-level and region-level explain
 *     because: caps, precision floors, and diff mode all compose more cleanly when they wrap one assembler
 *     valid-while: region-level remains a slice of file-level rather than a different data shape
 *     revisit-if: region-level needs information that file-level cannot also expose
 * maturity: stable
 * @end
 */
export async function assembleArtifact(
  opts: ExplainOptions,
  index: SymbolIndex,
  deps: AssembleArtifactDeps = {},
): Promise<ExplainArtifact> {
  const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
  const target = opts.target;
  const symbol = opts.symbol ?? null;
  const targetEntry = index.get(target);
  const gitLog = deps.gitLog ?? defaultGit;
  const gitShortlog = deps.gitShortlog ?? defaultGit;
  const fileExists = deps.fileExists ?? defaultFileExists;
  const readSyncOrUndef = deps.readSyncOrUndef ?? defaultReadSync;
  const isInsideRepoRealpath =
    deps.isInsideRepoRealpath ?? defaultIsInsideRepoRealpath;

  // ---- region resolution (T14) ----------------------------------------
  // When `opts.symbol` is set we slice the artifact to one exported
  // symbol's line range. If the file is indexed but the symbol isn't a
  // declared export, raise SIVRU-E2004 — that's the contract the MCP and
  // CLI surfaces rely on for "symbol not found" reporting.
  let regionExport: Export | null = null;
  if (symbol !== null && targetEntry !== undefined) {
    regionExport =
      targetEntry.exports.find((e) => e.name === symbol) ?? null;
    if (regionExport === null) {
      throw new SivruExplainError(
        "SIVRU-E2004",
        `symbol "${symbol}" not found in ${target}`,
      );
    }
  }
  const isRegion = regionExport !== null;

  // ---- public_api ------------------------------------------------------
  const public_api: Export[] =
    regionExport !== null ? [regionExport] : targetEntry?.exports.slice() ?? [];

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
  // imports me" into a useful caller list. In region mode the match set is
  // just the one symbol — narrows the caller list to "who imports THIS
  // symbol", which is the whole point of region-level explain.
  const exportedNames =
    regionExport !== null
      ? new Set([regionExport.name])
      : new Set(public_api.map((e) => e.name));
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
  const churn: ChurnInfo =
    regionExport !== null
      ? await collectRegionChurn(
          index.repoPath,
          target,
          regionExport.startLine,
          regionExport.endLine,
          sinceDays,
          gitLog,
        )
      : await collectChurn(
          index.repoPath,
          target,
          sinceDays,
          gitLog,
          targetEntry?.commitCount,
        );

  // ---- ownership -------------------------------------------------------
  // Region-level ownership uses git blame -L; file-level uses git shortlog.
  // Both injected — tests stub both.
  const ownership =
    regionExport !== null
      ? await collectRegionOwnership(
          index.repoPath,
          target,
          regionExport.startLine,
          regionExport.endLine,
          gitShortlog,
        )
      : await collectOwnership(index.repoPath, target, gitShortlog);

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
    isRegion,
  });

  const artifactPath = isRegion ? `${target}::${symbol}` : target;

  // ---- authored (DESIGN-0016) + health (DESIGN-0017 §2) ----------------
  // v0.5 emitted `authored: []` unconditionally; v0.6 fills the slot from
  // `@sivru` blocks extracted from the target file. Region-level filters to
  // the region's symbol; file-level includes every block. Any extraction or
  // validation failure becomes empty lists (never blocks the artifact).
  // `blocks_health` carries the lint diagnostics from the SAME extraction —
  // including for invalid blocks that `authored` omits, so a broken block
  // surfaces instead of vanishing.
  const { authored, health: blocks_health } = await collectAuthoredAndHealth(
    index.repoPath,
    target,
    regionExport,
  );

  return {
    path: artifactPath,
    public_api,
    callers: finalCallers,
    callees,
    churn,
    ownership,
    tests,
    authored,
    blocks_health,
    callers_truncated: null,
    callees_truncated: null,
    callers_skipped_reason: callersSkippedReason,
    footer,
  };
}

/**
 * Extract the target file's `@sivru` blocks ONCE and split the result into
 * two views (DESIGN-0017): `authored` — the valid blocks rendered as
 * authored context (intent) — and `health` — every lint diagnostic,
 * INCLUDING those on blocks that failed to parse or validate. The two views
 * differ deliberately: authored context must never show a misleading
 * intent, but a broken block must still surface as a health signal rather
 * than disappear (v0.6's behaviour of silently dropping invalid blocks is
 * exactly the rot DESIGN-0017 §2 closes). Region-level filters both views to
 * the region's symbol. Any extraction failure yields empty lists.
 */
async function collectAuthoredAndHealth(
  repoPath: string,
  target: string,
  regionExport: Export | null,
): Promise<{ authored: AuthoredEntry[]; health: BlockDiagnostic[] }> {
  try {
    const abs = resolvePath(repoPath, target);
    const extracted = await extractBlocks(abs);
    // Side effect: pushes validateBlock diagnostics into each eb.diagnostics
    // (parse errors are already there from extractBlocks). We read them off
    // the blocks below so authored and health stay in lockstep.
    validateExtracted(extracted);
    const authored: AuthoredEntry[] = [];
    const health: BlockDiagnostic[] = [];
    for (const eb of extracted) {
      if (regionExport !== null) {
        // A region targets a single symbol; module-level and other-symbol
        // blocks are out of scope for both views.
        if (eb.kind !== "symbol") continue;
        if (eb.symbolName !== regionExport.name) continue;
      }
      // Health includes diagnostics for invalid (block === null) blocks too.
      health.push(...eb.diagnostics);
      if (eb.block === null) continue; // invalid: surfaced in health, not authored.
      const entry: AuthoredEntry = {
        kind: eb.kind,
        startLine: eb.range.startLine,
        endLine: eb.range.endLine,
        block: blockToJSON(eb.block),
      };
      if (eb.symbolName !== undefined) entry.symbol = eb.symbolName;
      authored.push(entry);
    }
    return { authored, health };
  } catch {
    return { authored: [], health: [] };
  }
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

/**
 * Region-level churn (T14). `git log -L <startLine>,<endLine>:<path>` walks
 * the history of that exact range. The output is one commit header per
 * touched commit; we count commits and pull the most-recent ISO timestamp.
 */
async function collectRegionChurn(
  repoPath: string,
  target: string,
  startLine: number,
  endLine: number,
  sinceDays: number,
  gitLog: NonNullable<AssembleArtifactDeps["gitLog"]>,
): Promise<ChurnInfo> {
  // `--` separator is defensive: prevents a target like `--upload-pack.ts`
  // from being interpreted by git as a flag rather than a path. The path
  // sits inside the `-L` value here too — git allows it, but a leading `--`
  // also short-circuits any argument-injection ambiguity.
  const args = [
    "log",
    "-L",
    `${startLine},${endLine}:${target}`,
    `--since=${sinceDays}.days`,
    "--pretty=format:%H %cI",
    "-s", // suppress diff body — we only want the header
    "--",
    target,
  ];
  const out = await gitLog(args, repoPath);
  const headers: { sha: string; iso: string }[] = [];
  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const m = line.match(/^([0-9a-f]{7,40})\s+(\S+)/);
    if (m === null) continue;
    headers.push({ sha: m[1]!, iso: m[2]! });
  }
  if (headers.length === 0) {
    return { commitCount: 0, lastCommitAt: null, sinceDays };
  }
  return {
    commitCount: headers.length,
    lastCommitAt: headers[0]!.iso,
    sinceDays,
  };
}

/**
 * Region-level ownership (T14). `git blame --line-porcelain -L start,end <path>`
 * emits `author <name>` lines one per source line; we bucket lines by author
 * and report percent + count.
 */
async function collectRegionOwnership(
  repoPath: string,
  target: string,
  startLine: number,
  endLine: number,
  gitBlame: NonNullable<AssembleArtifactDeps["gitShortlog"]>,
): Promise<OwnershipEntry[]> {
  const args = [
    "blame",
    "--line-porcelain",
    "-L",
    `${startLine},${endLine}`,
    "--", // separator: target may start with `-` (e.g. `--upload-pack.ts`)
    target,
  ];
  const out = await gitBlame(args, repoPath);
  const lineCounts = new Map<string, number>();
  for (const rawLine of out.split("\n")) {
    if (!rawLine.startsWith("author ")) continue;
    const author = rawLine.slice("author ".length).trim();
    lineCounts.set(author, (lineCounts.get(author) ?? 0) + 1);
  }
  const total = Array.from(lineCounts.values()).reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  return Array.from(lineCounts.entries())
    .map(([author, count]) => ({
      author,
      percent: Math.round((count / total) * 100),
      count,
    }))
    .sort((a, b) => b.count - a.count);
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
    "Dynamic imports and runtime dispatch (await import(...), importlib, reflection) are not resolved — empty-or-best-effort, never silently wrong.",
  ];
  if (opts.language === "go") {
    parts.push("Go callers resolve at package granularity.");
  }
  if (opts.language === "java") {
    parts.push("Java resolves at source-root + class granularity.");
  }
  if (
    opts.language === "typescript" ||
    opts.language === "tsx" ||
    opts.language === "javascript" ||
    opts.language === "jsx"
  ) {
    parts.push(
      "TS/JS resolves relative imports only — tsconfig path aliases are deferred to v0.5.x.",
    );
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
