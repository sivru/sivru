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
  countSeverities,
  loadOrBuildSymbolIndex,
  parsePathAndSymbol,
  resolveAndAssertInside,
  SivruExplainError,
  type ExplainArtifact,
  type ExplainOptions,
} from "@sivru/search";

import { formatDiagnostic } from "../lib/diagnostics.js";
import { writeFile } from "node:fs/promises";

import {
  buildBaseModel,
  buildDiffContext,
  checkDrift,
  cycleMemberIds,
  diffModels,
  evaluateGate,
  formatDelta,
  formatGateText,
  loadAllowlist,
  projectModel,
  renderDiffHtml,
  renderHtml,
  staticBrokenLinkages,
} from "../explainer/index.js";

/** Warn (not fail) when the generated HTML exceeds this size. */
const HTML_SIZE_WARN_BYTES = 5 * 1024 * 1024;
const DEFAULT_HTML_OUT = "sivru-explainer.html";
const DEFAULT_DIFF_HTML_OUT = "sivru-arch-delta.html";

/**
 * Max block-health diagnostics rendered inline in the markdown BLOCKS HEALTH
 * section. The full set is always in `--json` and `sivru block validate`;
 * this only bounds the human render so a pathological file does not bury the
 * derived-fact sections that follow.
 */
const BLOCKS_HEALTH_RENDER_CAP = 20;

type ExplainArgs = {
  /** Raw target argument (`<path>` or `<path>::<symbol>`). Empty when --project. */
  target: string;
  /** Repo root to explain against (defaults to cwd). */
  repoRoot: string;
  sinceDays: number;
  depth: number;
  diff: boolean;
  json: boolean;
  /** Whole-repo projection (DESIGN-0018): emit the explainer model, ignore <path>. */
  project: boolean;
  /** Render the projection as a single self-contained HTML file (implies --project). */
  html: boolean;
  /** Output path for --html (default ./sivru-explainer.html). */
  out: string | null;
  /** --project --diff: base ref to diff HEAD against (default: merge-base with the default branch). */
  base: string | null;
  /** --project --diff output format. */
  format: "text" | "json" | "github";
  /** --project --diff --gate: exit 1 on a gateable regression (new cycle / broken linkage). */
  gate: boolean;
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
  let project = false;
  let html = false;
  let out: string | null = null;
  let base: string | null = null;
  let format: ExplainArgs["format"] = "text";
  let formatSet = false;
  let gate = false;
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
    if (a === "--project") {
      project = true;
      continue;
    }
    if (a === "--gate") {
      gate = true;
      diff = true; // the gate is a property of the diff
      project = true;
      continue;
    }
    if (a === "--html") {
      html = true;
      project = true; // --html only renders the whole-repo projection
      continue;
    }
    if (a.startsWith("--out=")) {
      out = a.slice("--out=".length);
      continue;
    }
    if (a === "--out") {
      const next = argv[i + 1];
      if (next === undefined) {
        return { kind: "err", message: `--out requires a value` };
      }
      out = next;
      i++;
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
    if (a.startsWith("--base=")) {
      base = a.slice("--base=".length);
      continue;
    }
    if (a === "--base") {
      const next = argv[i + 1];
      if (next === undefined) return { kind: "err", message: `--base requires a value` };
      base = next;
      i++;
      continue;
    }
    if (a.startsWith("--format=")) {
      const v = a.slice("--format=".length);
      if (v !== "text" && v !== "json" && v !== "github") {
        return { kind: "err", message: `invalid --format value: "${v}" (text|json|github)` };
      }
      format = v;
      formatSet = true;
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

  if (out !== null && !html) {
    return { kind: "err", message: "--out only applies to --html" };
  }
  // The gate reports a pass/fail exit code; --html writes a visual file. Combining
  // them would make one silently win — and a gate that silently turns itself off
  // is worse than no gate (DESIGN-0023). Reject the combination outright.
  if (gate && html) {
    return { kind: "err", message: "--gate cannot be combined with --html (use --json for machine-readable gate output)" };
  }
  // --format shapes the textual diff report only; with --html or --gate it would
  // be silently ignored. Fail loud instead of dropping it.
  if (formatSet && (html || gate)) {
    return {
      kind: "err",
      message: "--format applies to the --project --diff report; it has no effect with --html or --gate (use --json there)",
    };
  }
  if (project) {
    // Whole-repo projection takes no <path>; reject one so the contract is clear.
    if (positionals.length > 0) {
      return {
        kind: "err",
        message: "--project explains the whole repo; it takes no <path> argument",
      };
    }
    return {
      kind: "ok",
      args: { target: "", repoRoot, sinceDays, depth, diff, json, project: true, html, out, base, format, gate },
    };
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
    args: { target, repoRoot, sinceDays, depth, diff, json, project: false, html: false, out: null, base, format, gate: false },
  };
}

const USAGE = [
  "sivru explain <path> [--json] [--since=<N>] [--depth=1] [--repo=<dir>]",
  "sivru explain --project [--repo=<dir>]",
  "sivru explain --html [--out=<path>] [--repo=<dir>]",
  "sivru explain --project --diff [--base=<ref>] [--format=text|json|github] [--gate]",
  "",
  "  <path>            Repo-relative file path (or path::symbol for region-level)",
  "  --project         Whole-repo projection: emit the explainer model JSON",
  "                    (System → Module → Package → Symbol). Takes no <path>.",
  "  --diff            (with --project) the architectural delta vs a base ref:",
  "                    new edges / cycles / @sivru block changes. Exit 0 (report,",
  "                    no gate); 2 if the base can't be evaluated.",
  "  --base=<ref>      (--project --diff) base ref (default: merge-base w/ default branch)",
  "  --format=<f>      (--project --diff) text (default) | json | github (PR-comment markdown)",
  "                    With --html, writes the delta as a standalone visual page instead.",
  "  --gate            (--project --diff) exit 1 on a gateable regression — a new",
  "                    dependency cycle or a broken @sivru invariant→test linkage on a",
  "                    touched symbol. Exit 2 if the base can't be evaluated. Suppress",
  "                    an accepted finding via .sivru/gate-allowlist (one key per line).",
  "  --html            Render the projection as one self-contained HTML file",
  "                    (implies --project). Default ./sivru-explainer.html.",
  "  --out=<path>      Output path for --html",
  "  --json            Emit the bare ExplainArtifact JSON",
  "  --since=<N>       Churn window in days (default 90)",
  "  --depth=<N>       Call-graph depth (v0.5 only supports 1)",
  "  --repo=<dir>      Repo root to resolve <path> against (default cwd)",
].join("\n");

/**
 * @sivru
 * schema: 1
 * role: cli-explain
 * responsibility: drive the sivru explain CLI subcommand — parse argv, build the symbol index, assemble the artifact, render as markdown or JSON
 * collaborators: [assembleArtifact, parsePathAndSymbol, loadOrBuildSymbolIndex, renderArtifactMarkdown]
 * invariants:
 *   - "exit code reflects the failure class: 1 for an invalid argument or runtime error, 0 on success"
 *   - the artifact is descriptive only — explain never prescribes a fix or rewrites code
 * decisions:
 *   - chose: uncapped CLI output (markdown and --json return the full lists)
 *     because: the agent operator chose CLI explicitly; capping should only happen in the MCP path where the budget is a real constraint
 *     valid-while: CLI users want completeness more than they want size
 *     revisit-if: a CLI use case develops where capping is essential
 * maturity: stable
 * @end
 */
export async function runExplain(argv: readonly string[]): Promise<number> {
  const parsed = parseExplainArgs(argv);
  if (parsed.kind === "err") {
    process.stderr.write(`sivru explain: ${parsed.message}\n\n${USAGE}\n`);
    return 1;
  }
  const { args } = parsed;

  // DESIGN-0018 Slice 1: whole-repo projection. Emits the explainer model as
  // JSON; the `--html` projection and feedback loop are later slices.
  if (args.project) {
    try {
      // DESIGN-0023 Slice 1: the architectural diff of a change. Build the model
      // at a base ref (via a worktree) + at HEAD, diff them, report. Report-only
      // in v0.14 — exit 0 on success, 2 when the base can't be evaluated (never
      // a silent pass); the `--gate` (non-zero on a regression) lands in v0.15.
      if (args.diff) {
        const base = await buildBaseModel(args.repoRoot, args.base);
        if (!base.ok) {
          process.stderr.write(`sivru explain --project --diff: ${base.reason}\n`);
          return 2;
        }
        const head = await projectModel(args.repoRoot);
        const delta = diffModels(base.model, head, base.baseRef);
        // Surface-area + touched-hot-spot views so a large change shows its real
        // footprint, not just the structural-delta headline (DESIGN-0023 Slice 2).
        const diffCtx = buildDiffContext(head, delta);
        if (args.html) {
          // The delta as a standalone, shareable visual: HEAD architecture map
          // with the change overlaid + a text digest (WCAG: tags, not color alone).
          const html = renderDiffHtml(head, delta, diffCtx);
          const outPath = resolvePath(args.out ?? DEFAULT_DIFF_HTML_OUT);
          await writeFile(outPath, html, "utf8");
          process.stdout.write(`Wrote ${outPath} (${Math.round(html.length / 1024)} KB)\n`);
          return 0;
        }
        if (args.gate) {
          // DESIGN-0023 Slice 3: exit 1 on a gateable regression (new cycle or a
          // broken @sivru invariant→test linkage on a touched symbol), 0 when
          // clean or fully suppressed by .sivru/gate-allowlist. (Exit 2 — base
          // could-not-evaluate — is handled above.) Never a silent pass.
          const drift = await checkDrift(head, delta);
          const allowlist = await loadAllowlist(args.repoRoot);
          const result = evaluateGate(delta, drift, allowlist);
          process.stdout.write(
            (args.json
              ? JSON.stringify({ baseRef: delta.baseRef, ...result, drift })
              : formatGateText(result, drift, delta.baseRef)) + "\n",
          );
          return result.fired ? 1 : 0;
        }
        process.stdout.write(formatDelta(delta, args.json ? "json" : args.format, diffCtx) + "\n");
        return 0;
      }
      const model = await projectModel(args.repoRoot);
      if (args.html) {
        // Static health annotations (DESIGN-0023): `↻ in a cycle` for dependency-
        // cycle members, `⚠ drift` for symbols whose @sivru linkage no longer
        // resolves — drift you can see without a PR.
        const annotations = {
          cycleMembers: cycleMemberIds(model),
          brokenLinkages: await staticBrokenLinkages(model),
        };
        // renderHtml self-verifies and throws SIVRU-E2011 rather than emit a
        // broken file — so a written file is always a coherent artifact.
        const html = renderHtml(model, annotations);
        const outPath = resolvePath(args.out ?? DEFAULT_HTML_OUT);
        await writeFile(outPath, html, "utf8");
        const kb = Math.round(html.length / 1024);
        process.stdout.write(`Wrote ${outPath} (${kb} KB)\n`);
        if (html.length > HTML_SIZE_WARN_BYTES) {
          process.stderr.write(
            `sivru explain --html: warning — output is ${kb} KB; ` +
              `very large repos may produce big files\n`,
          );
        }
        return 0;
      }
      process.stdout.write(JSON.stringify(model) + "\n");
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`sivru explain ${args.html ? "--html" : "--project"}: ${msg}\n`);
      return 1;
    }
  }

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

  // DESIGN-0017: authored context renders before derived facts — intent
  // before mechanism. The agent reads why the code is shaped this way
  // before it reads what the code mechanically is.
  for (const line of renderAuthoredSection(art)) lines.push(line);

  // DESIGN-0017 §2: block health — lint diagnostics for the file's blocks,
  // including broken ones the authored section omits. Quiet for blockless
  // files. Diff-scoped git drift lives in the `sivru block` subcommands.
  for (const line of renderBlocksHealth(art)) lines.push(line);

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

/**
 * Render the AUTHORED CONTEXT section (DESIGN-0017 §1). One entry per
 * `@sivru` block on the target — role, responsibility, invariants (with
 * their `enforced-by` reference when present), time-bounded decisions
 * (`chose / because / valid-while / revisit-if`), maturity, and
 * collaborators. This is the authored intent the agent reads before the
 * derived facts. A target with no blocks renders a single
 * "(no @sivru blocks attached)" line so the section is always present and
 * consumers can rely on it. The structured payload is also in `--json`.
 */
export function renderAuthoredSection(art: ExplainArtifact): string[] {
  const lines: string[] = ["AUTHORED CONTEXT"];
  const entries = art.authored.filter((e) => e.block != null);
  if (entries.length === 0) {
    lines.push("  (no @sivru blocks attached)");
    lines.push("");
    return lines;
  }
  for (const entry of entries) {
    // Non-null by the filter above; narrow for the type checker.
    const block = entry.block!;
    const label =
      entry.kind === "module" || !entry.symbol ? "(module)" : entry.symbol;
    const maturity = block.maturity ? `  [${block.maturity}]` : "";
    lines.push(`  ${label}${maturity}`);
    lines.push(`    role: ${block.role}`);
    lines.push(`    responsibility: ${block.responsibility}`);
    if (block.invariantsV2.length > 0) {
      lines.push("    invariants:");
      for (const inv of block.invariantsV2) {
        const by = inv.enforcedBy ? `  (enforced-by: ${inv.enforcedBy})` : "";
        lines.push(`      - ${inv.rule}${by}`);
      }
    }
    if (block.decisions.length > 0) {
      lines.push("    decisions:");
      for (const d of block.decisions) {
        lines.push(`      - chose: ${d.chose}`);
        lines.push(`        because: ${d.because}`);
        lines.push(`        valid-while: ${d.validWhile}`);
        if (d.revisitIf) lines.push(`        revisit-if: ${d.revisitIf}`);
      }
    }
    if (block.collaborators.length > 0) {
      lines.push(`    collaborators: ${block.collaborators.join(", ")}`);
    }
    lines.push("");
  }
  return lines;
}

/**
 * Render the BLOCKS HEALTH section (DESIGN-0017 §2). Surfaces the lint
 * diagnostics carried in `art.blocks_health` — the cheap, git-free checks
 * (missing-required and the rest of the v0.6/v0.19 block linter), computed
 * over the target file during artifact assembly. Crucially this INCLUDES
 * diagnostics for blocks that failed to parse or validate, which the
 * authored section omits: a broken block surfaces here instead of silently
 * vanishing — the rot DESIGN-0017 §2 exists to close.
 *
 * The section is quiet by design:
 *   - diagnostics present            → list them + a pointer to the
 *                                      diff-scoped `sivru block` drift checks
 *   - blocks present, no diagnostics → a one-line "clean" note
 *   - no blocks at all               → omit the section entirely, so
 *                                      blockless files read exactly as before
 *
 * Diff-scoped git drift (staleness, cross-block graph) is intentionally NOT
 * run inline — it needs a git ref `explain` does not carry and is better as
 * the dedicated, already-shipped `sivru block staleness` / `graph` commands.
 */
export function renderBlocksHealth(art: ExplainArtifact): string[] {
  const diags = art.blocks_health;
  const hasBlocks = art.authored.length > 0 || diags.length > 0;
  if (!hasBlocks) return []; // blockless file: stay silent.

  const lines: string[] = ["BLOCKS HEALTH"];
  if (diags.length === 0) {
    const n = art.authored.length;
    lines.push(`  (clean — ${n} block${n === 1 ? "" : "s"}, no issues)`);
    lines.push("");
    return lines;
  }

  const { errors, warnings } = countSeverities(diags);
  lines.push(`  ${errors} error(s), ${warnings} warning(s)`);
  // Health renders before the derived facts, so an unbounded list would bury
  // PUBLIC API et al. Cap the human render (the full set is always in --json /
  // `sivru block validate`); the cap is generous since real files carry a
  // handful of blocks.
  const shown = diags.slice(0, BLOCKS_HEALTH_RENDER_CAP);
  for (const d of shown) {
    lines.push(`    - ${formatDiagnostic(d, "code-first")}`);
  }
  if (diags.length > shown.length) {
    lines.push(
      `    ... ${diags.length - shown.length} more (run \`sivru block validate <path>\` for all)`,
    );
  }
  lines.push(
    "  run `sivru block staleness` / `sivru block graph` for diff-scoped drift",
  );
  lines.push("");
  return lines;
}
