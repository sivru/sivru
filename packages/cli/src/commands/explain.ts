// `sivru explain <path> [--json] [--since=<N>] [--depth=1]` — emit the
// canonical ExplainArtifact for a file (or `path::symbol` region, T14 wires
// the slicer) as either pretty markdown (default) or bare JSON.
//
// The CLI is uncapped per the design (§2): markdown and `--json` return the
// full caller/callee lists. The MCP path (T10/T11) is what applies the cap.
//
// Argument parsing is hand-rolled to match the project's `parseSearchArgs`
// convention. No zod.

import { resolve as resolvePath } from "node:path";

import {
  assembleArtifact,
  assembleDiffArtifact,
  buildSymbolIndex,
  buildCommitCounts,
  computeStateId,
  loadOrBuildSymbolIndex,
  parsePathAndSymbol,
  resolveAndAssertInside,
  SivruExplainError,
  type ExplainArtifact,
  type ExplainOptions,
} from "@sivru/search";

type ExplainArgs = {
  /** Raw target argument (`<path>` or `<path>::<symbol>`). */
  target: string;
  /** Repo root to explain against (defaults to cwd). */
  repoRoot: string;
  sinceDays: number;
  depth: number;
  diff: boolean;
  json: boolean;
};

type ParseOk = { kind: "ok"; args: ExplainArgs };
type ParseErr = { kind: "err"; message: string };

export function parseExplainArgs(argv: readonly string[]): ParseOk | ParseErr {
  let target: string | null = null;
  let repoRoot = process.cwd();
  let sinceDays = 90;
  let depth = 1;
  let diff = false;
  let json = false;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--diff") {
      diff = true;
      continue;
    }
    if (a.startsWith("--since=")) {
      const v = Number.parseInt(a.slice("--since=".length), 10);
      if (Number.isNaN(v) || v < 0) {
        return { kind: "err", message: `invalid --since value: "${a}"` };
      }
      sinceDays = v;
      continue;
    }
    if (a.startsWith("--depth=")) {
      const v = Number.parseInt(a.slice("--depth=".length), 10);
      if (Number.isNaN(v) || v !== 1) {
        return { kind: "err", message: `invalid --depth value: "${a}" (only 1 is supported in v0.5)` };
      }
      depth = v;
      continue;
    }
    if (a.startsWith("--repo=")) {
      repoRoot = resolvePath(a.slice("--repo=".length));
      continue;
    }
    if (a === "--repo") {
      const next = argv[i + 1];
      if (next === undefined) {
        return { kind: "err", message: `--repo requires a value` };
      }
      repoRoot = resolvePath(next);
      i++;
      continue;
    }
    if (a.startsWith("--")) {
      return { kind: "err", message: `unknown flag: ${a}` };
    }
    positionals.push(a);
  }

  if (positionals.length === 0) {
    return { kind: "err", message: "missing <path> argument" };
  }
  target = positionals[0]!;
  if (positionals.length > 1) {
    return { kind: "err", message: `unexpected extra positional arguments` };
  }
  return {
    kind: "ok",
    args: { target, repoRoot, sinceDays, depth, diff, json },
  };
}

const USAGE = [
  "sivru explain <path> [--json] [--since=<N>] [--depth=1] [--repo=<dir>]",
  "",
  "  <path>            Repo-relative file path (or path::symbol for region-level)",
  "  --json            Emit the bare ExplainArtifact JSON",
  "  --since=<N>       Churn window in days (default 90)",
  "  --depth=<N>       Call-graph depth (v0.5 only supports 1)",
  "  --repo=<dir>      Repo root to resolve <path> against (default cwd)",
].join("\n");

export async function runExplain(argv: readonly string[]): Promise<number> {
  const parsed = parseExplainArgs(argv);
  if (parsed.kind === "err") {
    process.stderr.write(`sivru explain: ${parsed.message}\n\n${USAGE}\n`);
    return 1;
  }
  const { args } = parsed;

  try {
    const { path: relPath, symbol } = parsePathAndSymbol(args.target);
    await resolveAndAssertInside(relPath, args.repoRoot);
    const stateId = await computeStateId(args.repoRoot);
    const commitCounts = await buildCommitCounts(args.repoRoot, {
      sinceDays: args.sinceDays,
    });
    const { index } = await loadOrBuildSymbolIndex(args.repoRoot, stateId, {
      commitCounts,
    });
    const explainOpts: ExplainOptions = {
      repoRoot: args.repoRoot,
      target: relPath,
      sinceDays: args.sinceDays,
      depth: args.depth,
    };
    if (symbol !== null) explainOpts.symbol = symbol;
    const artifact = args.diff
      ? await assembleDiffArtifact(explainOpts, index)
      : await assembleArtifact(explainOpts, index);

    if (args.json) {
      process.stdout.write(JSON.stringify(artifact) + "\n");
      return 0;
    }
    process.stdout.write(renderArtifactMarkdown(artifact) + "\n");
    return 0;
  } catch (err) {
    if (err instanceof SivruExplainError) {
      process.stderr.write(`sivru explain: ${err.message}\n`);
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`sivru explain: ${msg}\n`);
    return 1;
  }
  // Silence the "unused" warning on buildSymbolIndex (used by the resolve
  // path in tests / future region wiring).
  void buildSymbolIndex;
}

/**
 * Render the canonical artifact as a human-readable markdown block, matching
 * the example in DESIGN-0004 §1. The shape is illustrative; sections are
 * always emitted (even when empty) so the agent's CLI consumer can rely on
 * them.
 */
export function renderArtifactMarkdown(art: ExplainArtifact): string {
  const lines: string[] = [];
  const title = `explain  ${art.path}`;
  lines.push(title);
  lines.push("=".repeat(Math.max(title.length, 40)));
  lines.push("");

  lines.push("PUBLIC API");
  if (art.public_api.length === 0) {
    lines.push("  (none)");
  } else {
    for (const e of art.public_api) {
      lines.push(`  ${e.name}  — ${e.signature || "(no signature)"}`);
    }
  }
  lines.push("");

  lines.push("CALLERS (1-hop, within this repo)");
  if (art.callers === null) {
    lines.push(`  (skipped — ${art.callers_skipped_reason ?? "unknown"})`);
  } else if (art.callers.length === 0) {
    lines.push("  (none found)");
  } else {
    for (const c of art.callers) {
      const syms = c.symbols.length > 0 ? c.symbols.join(", ") : "*";
      lines.push(`  ${c.filePath}:${c.line} → ${syms}`);
    }
    if (art.callers_truncated !== null) {
      lines.push(`  ... ${art.callers_truncated} more (truncated)`);
    }
  }
  lines.push("");

  lines.push("CALLEES (1-hop)");
  if (art.callees.length === 0) {
    lines.push("  (none)");
  } else {
    for (const c of art.callees) {
      lines.push(`  ${c.filePath}: ${c.symbols.join(", ")}`);
    }
    if (art.callees_truncated !== null) {
      lines.push(`  ... ${art.callees_truncated} more (truncated)`);
    }
  }
  lines.push("");

  lines.push(`CHURN  (last ${art.churn.sinceDays} days)`);
  const churnLastLine =
    art.churn.lastCommitAt !== null ? `last ${art.churn.lastCommitAt.slice(0, 10)}` : "no commits in window";
  lines.push(`  ${art.churn.commitCount} commits · ${churnLastLine}`);
  lines.push("");

  lines.push("OWNERSHIP");
  if (art.ownership.length === 0) {
    lines.push("  (no git history)");
  } else {
    const top = art.ownership.slice(0, 3);
    lines.push(
      `  top ${top.length}: ` +
        top.map((o) => `${o.author} ${o.percent}% (${o.count})`).join(", "),
    );
  }
  lines.push("");

  lines.push("TESTS");
  if (art.tests.length === 0) {
    lines.push("  (none found)");
  } else {
    for (const t of art.tests) {
      lines.push(`  ${t.filePath}  (${t.cases} cases)`);
    }
  }
  lines.push("");

  lines.push("AUTHORED  (none yet — see v0.6)");
  lines.push("");

  if (art.diff_mode === true) {
    lines.push("DIFF MODE — removed symbols + their callers");
    if (!art.removed_symbols || art.removed_symbols.length === 0) {
      lines.push("  (no removed exports detected in the working-tree diff)");
    } else {
      for (const r of art.removed_symbols) {
        lines.push(`  - ${r.symbol}`);
        if (r.callers.length === 0) {
          lines.push("      (no callers — safe to remove)");
        } else {
          for (const c of r.callers) {
            const syms = c.symbols.length > 0 ? c.symbols.join(", ") : "*";
            lines.push(`      ${c.filePath}:${c.line} → ${syms}`);
          }
          if (r.callers_truncated !== null) {
            lines.push(`      ... ${r.callers_truncated} more (truncated)`);
          }
        }
      }
    }
    lines.push("");
  }

  lines.push("FOOTER");
  lines.push(`  ${art.footer}`);

  return lines.join("\n");
}
