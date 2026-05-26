// `sivru block` — validate / extract / check-enforcement / staleness /
// graph / init / check-bridges (DESIGN-0016 §2 + DESIGN-0019 slots 1-3).
//
// Subcommands:
//   - `sivru block validate [path...]` [--changed-since=<ref>] [--autofix]
//     [--force] — lints every @sivru block under each `path` (default
//     cwd). Multi-path. Exit non-zero on any error-level diagnostic.
//   - `sivru block extract [path...] [--json]` — emits every block +
//     diagnostics. Invalid blocks appear with `block:null` (never
//     silently dropped).
//   - `sivru block check-enforcement [path...]` [--changed-since=<ref>]
//     (DESIGN-0019 §1) — walks `enforced-by` references and emits
//     SIVRU-E230 / SIVRU-E231 when the test is missing or skipped.
//   - `sivru block staleness [path]` [--since=<ref>] [--strict] [--json]
//     (DESIGN-0019 §2) — diff-aware staleness check.
//   - `sivru block graph [path]` [--check] [--json]
//     (DESIGN-0019 §3) — cross-block consistency.
//   - `sivru block init <file>` [--write] [--symbol=<name>] [--force]
//     (DESIGN-0019 §7) — scaffolds a starter block.
//   - `sivru block check-bridges [path...]` [--changed-since=<ref>]
//     (DESIGN-0019 §10) — annotation→invariant bridge audit.
//
// `--changed-since=<ref>` filters the discovered file list to whatever
// `git diff --name-only <ref>...HEAD` reports. Same flag attaches to
// validate / check-enforcement / check-bridges.

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import {
  autofixFiles,
  blockToJSON,
  checkBridges,
  checkEnforcement,
  computeBlockGraph,
  extractBlocksFromFiles,
  hasErrors,
  initBlock,
  isBlockWalkSkippable,
  loadBlockConfig,
  staleBlocks,
  validateExtracted,
  walk,
  type BlockDiagnostic,
  type ExtractedBlock,
  type SivruBlockJSON,
} from "@sivru/search";

type ValidateArgs = {
  subcommand: "validate";
  rootPaths: string[];
  changedSince: string | null;
  autofix: boolean;
  /**
   * Allow `--autofix` to rewrite files that have uncommitted changes
   * (otherwise we refuse, to avoid clobbering in-progress edits).
   * Named distinctly from `init`'s `--force` to avoid the
   * "same flag, different blast radius" UX trap.
   */
  allowDirty: boolean;
};
type ExtractArgs = {
  subcommand: "extract";
  rootPaths: string[];
  json: boolean;
};
type CheckEnforcementArgs = {
  subcommand: "check-enforcement";
  rootPaths: string[];
  changedSince: string | null;
};
type StalenessArgs = {
  subcommand: "staleness";
  rootPath: string;
  since: string | null;
  strict: boolean;
  json: boolean;
};
type GraphArgs = {
  subcommand: "graph";
  rootPath: string;
  check: boolean;
  json: boolean;
  changedSince: string | null;
};
type InitArgs = {
  subcommand: "init";
  filePath: string;
  write: boolean;
  symbol: string | null;
  force: boolean;
};
type CheckBridgesArgs = {
  subcommand: "check-bridges";
  rootPaths: string[];
  changedSince: string | null;
};
type BlockArgs =
  | ValidateArgs
  | ExtractArgs
  | CheckEnforcementArgs
  | StalenessArgs
  | GraphArgs
  | InitArgs
  | CheckBridgesArgs;

type ParseOk = { kind: "ok"; args: BlockArgs };
type ParseErr = { kind: "err"; message: string };

const SUBCOMMANDS = new Set([
  "validate",
  "extract",
  "check-enforcement",
  "staleness",
  "graph",
  "init",
  "check-bridges",
]);

function flagValue(arg: string, name: string): string | null {
  if (arg === `--${name}`) return "";
  if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  return null;
}

export function parseBlockArgs(argv: readonly string[]): ParseOk | ParseErr {
  const positionals: string[] = [];
  let subcommand: BlockArgs["subcommand"] | null = null;
  let json = false;
  let autofix = false;
  let force = false;
  let allowDirty = false;
  let strict = false;
  let check = false;
  let write = false;
  let symbol: string | null = null;
  let changedSince: string | null = null;
  let since: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--autofix") {
      autofix = true;
      continue;
    }
    if (a === "--force") {
      // `--force` only carries meaning on `init` (overwrite existing
      // block). The validate-side equivalent is `--allow-dirty`.
      force = true;
      continue;
    }
    if (a === "--allow-dirty") {
      allowDirty = true;
      continue;
    }
    if (a === "--strict") {
      strict = true;
      continue;
    }
    if (a === "--check") {
      check = true;
      continue;
    }
    if (a === "--write") {
      write = true;
      continue;
    }
    const cs = flagValue(a, "changed-since");
    if (cs !== null) {
      changedSince = cs;
      continue;
    }
    const sn = flagValue(a, "since");
    if (sn !== null) {
      since = sn;
      continue;
    }
    const sym = flagValue(a, "symbol");
    if (sym !== null) {
      symbol = sym;
      continue;
    }
    if (a.startsWith("--")) {
      return { kind: "err", message: `unknown flag "${a}"` };
    }
    if (subcommand === null) {
      if (SUBCOMMANDS.has(a)) {
        subcommand = a as BlockArgs["subcommand"];
      } else {
        return {
          kind: "err",
          message: `unknown subcommand "${a}" — expected one of ${[...SUBCOMMANDS].join(", ")}`,
        };
      }
      continue;
    }
    positionals.push(a);
  }

  if (subcommand === null) {
    return {
      kind: "err",
      message: `missing subcommand — expected one of ${[...SUBCOMMANDS].join(", ")}`,
    };
  }

  const rootPaths =
    positionals.length === 0
      ? [resolvePath(process.cwd())]
      : positionals.map((p) => resolvePath(p));

  // --changed-since runs `git diff` against ONE repo root. With multi-
  // path, we'd silently filter paths from repo-B against repo-A's diff
  // output. Reject the combination explicitly rather than produce
  // wrong results.
  if (
    changedSince !== null &&
    rootPaths.length > 1 &&
    (subcommand === "validate" ||
      subcommand === "check-enforcement" ||
      subcommand === "check-bridges")
  ) {
    return {
      kind: "err",
      message:
        "--changed-since works with at most one root path; run it once per repo",
    };
  }

  if (subcommand === "validate") {
    return {
      kind: "ok",
      args: {
        subcommand: "validate",
        rootPaths,
        changedSince,
        autofix,
        allowDirty,
      },
    };
  }
  if (subcommand === "extract") {
    return {
      kind: "ok",
      args: { subcommand: "extract", rootPaths, json },
    };
  }
  if (subcommand === "check-enforcement") {
    return {
      kind: "ok",
      args: { subcommand: "check-enforcement", rootPaths, changedSince },
    };
  }
  if (subcommand === "staleness") {
    if (rootPaths.length > 1) {
      return { kind: "err", message: "block staleness takes at most one path" };
    }
    return {
      kind: "ok",
      args: { subcommand: "staleness", rootPath: rootPaths[0]!, since, strict, json },
    };
  }
  if (subcommand === "graph") {
    if (rootPaths.length > 1) {
      return { kind: "err", message: "block graph takes at most one path" };
    }
    return {
      kind: "ok",
      args: {
        subcommand: "graph",
        rootPath: rootPaths[0]!,
        check,
        json,
        changedSince,
      },
    };
  }
  if (subcommand === "init") {
    if (positionals.length !== 1) {
      return { kind: "err", message: "block init takes exactly one file path" };
    }
    return {
      kind: "ok",
      args: { subcommand: "init", filePath: rootPaths[0]!, write, symbol, force },
    };
  }
  // check-bridges
  return {
    kind: "ok",
    args: { subcommand: "check-bridges", rootPaths, changedSince },
  };
}

const USAGE = [
  "sivru block <subcommand> [path...] [flags]",
  "",
  "  validate [path...]           Lint every @sivru block under `path`",
  "                               (default cwd). Multi-path. Exit non-zero",
  "                               on any error-level diagnostic.",
  "                               --changed-since=<ref>  Only walk files",
  "                                                      changed since <ref>.",
  "                               --autofix              Rewrite E237/E238",
  "                                                      lines in place.",
  "                               --allow-dirty          With --autofix, allow",
  "                                                      files with uncommitted",
  "                                                      changes.",
  "  extract [path...] [--json]  Emit every block + diagnostics.",
  "  check-enforcement [path...] Verify every invariant.enforced-by resolves",
  "                              to a real, non-skipped test (SIVRU-E230/E231).",
  "                               --changed-since=<ref>",
  "  staleness [path] [--since]  Diff-aware staleness check (SIVRU-E233).",
  "                               --strict   Exit non-zero on any signal.",
  "                               --json",
  "  graph [path] [--check]      Cross-block consistency (SIVRU-E234..E236).",
  "                               --json     Emit the raw graph.",
  "  init <file> [--write]       Scaffold a starter @sivru block.",
  "                               --symbol=<name>  Target a specific symbol.",
  "                               --force    Overwrite existing blocks.",
  "  check-bridges [path...]     Annotation→invariant bridge audit",
  "                              (SIVRU-E239 + SIVRU-E260).",
  "                               --changed-since=<ref>",
].join("\n");

/**
 * Best-effort repo-root detection by walking upward from `start` for a
 * `.git` directory. Returns `start` when no `.git` is found.
 */
function findRepoRoot(start: string): string {
  let cur = start;
  for (let i = 0; i < 32; i++) {
    if (existsSync(`${cur}/.git`)) return cur;
    const parent = resolvePath(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }
  return start;
}

/**
 * Return the set of files changed since `<ref>` according to
 * `git diff --name-only <ref>...HEAD`. Paths are joined to repoRoot so
 * they can be compared to walker output. Empty array on git failure.
 */
function changedFilesSince(repoRoot: string, ref: string): Set<string> {
  try {
    const stdout = execFileSync(
      "git",
      ["diff", "--name-only", `${ref}...HEAD`],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const out = new Set<string>();
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      out.add(resolvePath(repoRoot, trimmed));
    }
    return out;
  } catch {
    return new Set();
  }
}

async function discoverFiles(rootPath: string): Promise<string[]> {
  let isDir = false;
  try {
    isDir = statSync(rootPath).isDirectory();
  } catch {
    // Path missing entirely; let the walker raise the canonical error.
  }
  if (!isDir) {
    return [rootPath];
  }
  const files: string[] = [];
  for await (const entry of walk(rootPath)) {
    if (isBlockWalkSkippable(entry.absPath)) continue;
    files.push(entry.absPath);
  }
  return files;
}

async function discoverFilesMulti(
  rootPaths: readonly string[],
  changedSince: string | null,
): Promise<string[]> {
  const seen = new Set<string>();
  for (const p of rootPaths) {
    for (const f of await discoverFiles(p)) {
      seen.add(f);
    }
  }
  let files = [...seen];
  if (changedSince !== null && rootPaths.length > 0) {
    const repoRoot = findRepoRoot(rootPaths[0]!);
    const changed = changedFilesSince(repoRoot, changedSince);
    files = files.filter((f) => changed.has(f));
  }
  return files;
}

function isCleanInGit(filePath: string, repoRoot: string): boolean {
  try {
    const out = execFileSync(
      "git",
      ["status", "--porcelain", filePath],
      { cwd: repoRoot, encoding: "utf8" },
    );
    return out.trim().length === 0;
  } catch {
    return false;
  }
}

function formatDiagnostic(d: BlockDiagnostic): string {
  const loc = d.location;
  const where =
    loc !== undefined ? `${loc.filePath}:${loc.startLine}` : "<unknown>";
  return `${where}: ${d.severity} ${d.code}: ${d.message}`;
}

type ExtractEntry = {
  filePath: string;
  kind: "symbol" | "module";
  symbolName?: string;
  range: { filePath: string; startLine: number; endLine: number };
  block: SivruBlockJSON | null;
  diagnostics: BlockDiagnostic[];
};

function toExtractEntry(eb: ExtractedBlock): ExtractEntry {
  const entry: ExtractEntry = {
    filePath: eb.filePath,
    kind: eb.kind,
    range: eb.range,
    block: eb.block === null ? null : blockToJSON(eb.block),
    diagnostics: eb.diagnostics,
  };
  if (eb.symbolName !== undefined) entry.symbolName = eb.symbolName;
  return entry;
}

/**
 * @sivru
 * schema: 1
 * role: cli-block
 * responsibility: dispatch the sivru block subcommand and surface diagnostics with proper exit code semantics
 * collaborators: [extractBlocksFromFiles, validateExtracted, checkEnforcement, autofixFiles, staleBlocks, computeBlockGraph, initBlock, checkBridges]
 * invariants:
 *   - rule: extract --json NEVER silently drops an invalid block; invalid entries appear with block:null and diagnostics:[...]
 *     enforced-by: null
 *   - rule: validate exit code reads from BlockDiagnostic.severity — any error-level diagnostic flips to exit 1
 *     enforced-by: null
 *   - rule: --autofix refuses to rewrite a file with uncommitted changes unless --force is also passed
 *     enforced-by: null
 * decisions:
 *   - chose: validate writes errors to stderr, warnings to stdout
 *     because: CI scripts pipe stderr separately; warnings should not pollute the same stream as machine-readable error output
 *     valid-while: the standard CI convention of separating streams holds
 *     revisit-if: a CI runner needs both on stdout for log correlation
 * maturity: stable
 * @end
 */
export async function runBlock(argv: readonly string[]): Promise<number> {
  const parsed = parseBlockArgs(argv);
  if (parsed.kind === "err") {
    process.stderr.write(`sivru block: ${parsed.message}\n\n${USAGE}\n`);
    return 2;
  }
  const { args } = parsed;

  try {
    if (args.subcommand === "init") {
      return await runInit(args);
    }
    if (args.subcommand === "staleness") {
      return await runStaleness(args);
    }
    if (args.subcommand === "graph") {
      return await runGraph(args);
    }

    // Multi-path subcommands share file discovery.
    const rootPaths = (args as { rootPaths: string[] }).rootPaths;
    const config = loadBlockConfig(rootPaths[0]!);
    const repoRoot = findRepoRoot(rootPaths[0]!);

    if (args.subcommand === "validate" && args.autofix) {
      const filesBeforeFix = await discoverFilesMulti(rootPaths, args.changedSince);
      // Refuse to autofix any file with uncommitted changes unless
      // --allow-dirty is passed. Distinct from init's --force.
      const candidates: string[] = [];
      const skipped: string[] = [];
      for (const f of filesBeforeFix) {
        if (args.allowDirty || isCleanInGit(f, repoRoot)) {
          candidates.push(f);
        } else {
          skipped.push(f);
        }
      }
      const results = await autofixFiles(candidates);
      let totalRewrites = 0;
      for (const r of results) {
        totalRewrites += r.rewrites;
        if (r.rewrites > 0) {
          process.stdout.write(`autofixed ${r.filePath}: ${r.rewrites} rewrite(s)\n`);
        }
      }
      for (const f of skipped) {
        process.stderr.write(`autofix skipped (uncommitted changes — pass --allow-dirty): ${f}\n`);
      }
      process.stdout.write(`sivru block validate --autofix: ${totalRewrites} rewrite(s) across ${results.length} file(s)\n`);
      // Fall through to a normal validate pass on the rewritten tree.
    }

    const files = await discoverFilesMulti(rootPaths, (args as { changedSince?: string | null }).changedSince ?? null);
    const blocks = await extractBlocksFromFiles(files);
    const diagnostics = validateExtracted(blocks, config);

    if (args.subcommand === "extract") {
      const entries = blocks.map(toExtractEntry);
      if (args.json) {
        process.stdout.write(JSON.stringify(entries) + "\n");
      } else {
        for (const e of entries) {
          const role = e.block?.role ?? "<invalid>";
          const sym = e.symbolName ?? "(module)";
          process.stdout.write(
            `${e.filePath}:${e.range.startLine} ${e.kind} ${sym} role=${role}\n`,
          );
          for (const d of e.diagnostics) {
            process.stdout.write(`  ${formatDiagnostic(d)}\n`);
          }
        }
      }
      return 0;
    }

    if (args.subcommand === "check-enforcement") {
      const enf = await checkEnforcement(blocks, repoRoot);
      for (const d of enf) {
        const stream = d.severity === "error" ? process.stderr : process.stdout;
        stream.write(formatDiagnostic(d) + "\n");
      }
      const errCount = enf.filter((d) => d.severity === "error").length;
      const warnCount = enf.length - errCount;
      process.stdout.write(
        `sivru block check-enforcement: ${blocks.length} block(s); ${errCount} error(s), ${warnCount} warning(s)\n`,
      );
      return errCount > 0 ? 1 : 0;
    }

    if (args.subcommand === "check-bridges") {
      const bridges = await checkBridges(blocks, repoRoot);
      for (const d of bridges) {
        const stream = d.severity === "error" ? process.stderr : process.stdout;
        stream.write(formatDiagnostic(d) + "\n");
      }
      const errCount = bridges.filter((d) => d.severity === "error").length;
      const warnCount = bridges.length - errCount;
      process.stdout.write(
        `sivru block check-bridges: ${blocks.length} block(s); ${errCount} error(s), ${warnCount} warning(s)\n`,
      );
      return errCount > 0 ? 1 : 0;
    }

    // validate
    for (const d of diagnostics) {
      const stream = d.severity === "error" ? process.stderr : process.stdout;
      stream.write(formatDiagnostic(d) + "\n");
    }
    const errCount = diagnostics.filter((d) => d.severity === "error").length;
    const warnCount = diagnostics.length - errCount;
    process.stdout.write(
      `sivru block validate: ${blocks.length} block(s); ${errCount} error(s), ${warnCount} warning(s)\n`,
    );
    return hasErrors(diagnostics) ? 1 : 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`sivru block: ${msg}\n`);
    return 1;
  }
}

async function runInit(args: InitArgs): Promise<number> {
  const result = await initBlock(args.filePath, {
    targetSymbol: args.symbol ?? undefined,
    write: args.write,
    force: args.force,
  });
  if (result.kind === "err") {
    process.stderr.write(`sivru block init: ${result.message}\n`);
    return 1;
  }
  if (!args.write) {
    process.stdout.write(result.block + "\n");
  } else {
    process.stdout.write(`sivru block init: inserted block into ${args.filePath}\n`);
  }
  return 0;
}

async function runStaleness(args: StalenessArgs): Promise<number> {
  const since = args.since ?? "origin/main";
  const result = await staleBlocks({
    rootPath: args.rootPath,
    since,
  });
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    if (result.diagnostics.length === 0) {
      process.stdout.write(
        `sivru block staleness: no likely-stale blocks since ${since}\n`,
      );
    } else {
      process.stdout.write(
        `| file | block-line | changed lines outside block |\n` +
          `|------|------------|-----------------------------|\n`,
      );
      for (const d of result.diagnostics) {
        const loc = d.location;
        process.stdout.write(
          `| ${loc?.filePath ?? "?"} | ${loc?.startLine ?? "?"} | ${d.message} |\n`,
        );
      }
    }
  }
  if (args.strict) {
    return result.diagnostics.length > 0 ? 1 : 0;
  }
  return 0;
}

async function runGraph(args: GraphArgs): Promise<number> {
  const opts: { files?: readonly string[] } = {};
  if (args.changedSince !== null) {
    const files = await discoverFilesMulti([args.rootPath], args.changedSince);
    opts.files = files;
  }
  const graph = await computeBlockGraph(args.rootPath, opts);
  if (args.json) {
    process.stdout.write(JSON.stringify(graph, null, 2) + "\n");
    return 0;
  }
  if (!args.check) {
    process.stdout.write(
      `sivru block graph: ${graph.nodes.length} blocked symbol(s), ${graph.edges.length} edge(s)\n`,
    );
    return 0;
  }
  for (const d of graph.diagnostics) {
    const stream = d.severity === "error" ? process.stderr : process.stdout;
    stream.write(formatDiagnostic(d) + "\n");
  }
  const errCount = graph.diagnostics.filter((d) => d.severity === "error").length;
  const warnCount = graph.diagnostics.length - errCount;
  process.stdout.write(
    `sivru block graph --check: ${graph.nodes.length} block(s); ${errCount} error(s), ${warnCount} warning(s)\n`,
  );
  return errCount > 0 ? 1 : 0;
}
