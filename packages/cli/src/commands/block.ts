// `sivru block` — validate / extract @sivru annotation blocks
// (DESIGN-0016 §2).
//
// Two subcommands:
//   - `sivru block validate [path]` — lints all @sivru blocks under
//     `path` (defaults to cwd). Exit non-zero on any error-level
//     diagnostic. CI-friendly.
//   - `sivru block extract [path] --json` — emits every block plus its
//     diagnostics. Invalid blocks appear with `block:null` and
//     `diagnostics:[…]` populated — NEVER silently dropped.
//
// Argument parsing is hand-rolled to match v0.5's parseSearchArgs /
// parseExplainArgs convention. No zod.

import { resolve as resolvePath } from "node:path";

import {
  blockToJSON,
  extractBlocksFromFiles,
  hasErrors,
  loadBlockConfig,
  validateExtracted,
  walk,
  type BlockDiagnostic,
  type ExtractedBlock,
  type SivruBlockJSON,
} from "@sivru/search";

type BlockArgs = {
  subcommand: "validate" | "extract";
  rootPath: string;
  json: boolean;
};

type ParseOk = { kind: "ok"; args: BlockArgs };
type ParseErr = { kind: "err"; message: string };

export function parseBlockArgs(argv: readonly string[]): ParseOk | ParseErr {
  const positionals: string[] = [];
  let subcommand: BlockArgs["subcommand"] | null = null;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a.startsWith("--")) {
      return { kind: "err", message: `unknown flag "${a}"` };
    }
    if (subcommand === null) {
      if (a === "validate" || a === "extract") {
        subcommand = a;
      } else {
        return {
          kind: "err",
          message: `unknown subcommand "${a}" — expected "validate" or "extract"`,
        };
      }
      continue;
    }
    positionals.push(a);
  }

  if (subcommand === null) {
    return {
      kind: "err",
      message: 'missing subcommand — expected "validate" or "extract"',
    };
  }

  if (positionals.length > 1) {
    return { kind: "err", message: "unexpected extra positional arguments" };
  }

  const rootPath = resolvePath(positionals[0] ?? process.cwd());
  return { kind: "ok", args: { subcommand, rootPath, json } };
}

const USAGE = [
  "sivru block <subcommand> [path] [--json]",
  "",
  "  validate [path]   Lint every @sivru block under `path` (default cwd).",
  "                    Exit non-zero on any error-level diagnostic.",
  "  extract  [path]   Emit every block + its diagnostics as JSON",
  "                    (use with --json). Invalid blocks appear with",
  "                    block:null and diagnostics:[…]; never silently dropped.",
].join("\n");

async function discoverFiles(rootPath: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of walk(rootPath)) {
    files.push(entry.absPath);
  }
  return files;
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

export async function runBlock(argv: readonly string[]): Promise<number> {
  const parsed = parseBlockArgs(argv);
  if (parsed.kind === "err") {
    process.stderr.write(`sivru block: ${parsed.message}\n\n${USAGE}\n`);
    return 2;
  }
  const { args } = parsed;
  const config = loadBlockConfig(args.rootPath);

  try {
    const files = await discoverFiles(args.rootPath);
    const blocks = await extractBlocksFromFiles(files);
    const diagnostics = validateExtracted(blocks, config);

    if (args.subcommand === "extract") {
      const entries = blocks.map(toExtractEntry);
      if (args.json) {
        process.stdout.write(JSON.stringify(entries) + "\n");
      } else {
        // Default rendering for `extract` without --json: line-per-block.
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
