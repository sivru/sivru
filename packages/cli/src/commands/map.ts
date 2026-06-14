// `sivru map` — the CLI mirror of the `map` MCP tool (DESIGN-0024). Its own
// top-level subcommand (parity with the MCP tool name and with `find-related`),
// NOT a flag on `explain --project`. For parity + testing: a human can run the
// exact slice an agent receives.
//
//   sivru map <file>                 orient on a file (module/package slice)
//   sivru map <file>::<symbol>       orient on a symbol
//   sivru map <file> --symbol <sym>  same, symbol as a flag
//   sivru map --task "<free text>"   ranked candidate targets first
//   sivru map ... --json             the raw slice JSON (what the agent sees)

import { mapByPath, mapByTask, type MapResult } from "../explainer/agent-map.js";
import { loadModelAndHealth, type FreshAsOf } from "../explainer/map-serve.js";

const USAGE = `Usage:
  sivru map <file>[::<symbol>] [--symbol <name>] [--repo <dir>] [--json]
  sivru map --task "<free text>"      [--repo <dir>] [--json]

Orient in the architecture around a target before editing it: module + role,
1-hop dependency neighbours (blast radius), collaborators, and descriptive
health (hot rank, dependency cycle, broken @sivru linkages).`;

interface MapArgs {
  path?: string;
  symbol?: string;
  task?: string;
  repoRoot: string;
  json: boolean;
}

export type ParseMapResult = { kind: "ok"; args: MapArgs } | { kind: "err"; message: string } | { kind: "help" };

/** Parse `sivru map` argv. Exported for tests. */
export function parseMapArgs(argv: readonly string[]): ParseMapResult {
  const args: MapArgs = { repoRoot: ".", json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") return { kind: "help" };
    else if (a === "--json") args.json = true;
    else if (a === "--task") args.task = argv[++i] ?? "";
    else if (a.startsWith("--task=")) args.task = a.slice("--task=".length);
    else if (a === "--symbol") args.symbol = argv[++i] ?? "";
    else if (a.startsWith("--symbol=")) args.symbol = a.slice("--symbol=".length);
    else if (a === "--repo") args.repoRoot = argv[++i] ?? ".";
    else if (a.startsWith("--repo=")) args.repoRoot = a.slice("--repo=".length);
    else if (a.startsWith("-")) return { kind: "err", message: `unknown flag: ${a}` };
    else if (args.path === undefined) args.path = a;
    else return { kind: "err", message: `unexpected argument: ${a}` };
  }
  if (args.path === undefined && args.task === undefined) {
    return { kind: "err", message: "a <file> target or --task is required" };
  }
  if (args.task !== undefined && (args.task ?? "").trim().length === 0) {
    return { kind: "err", message: "--task needs a non-empty value" };
  }
  return { kind: "ok", args };
}

/** Human-readable rendering of a slice / candidates / error. */
export function renderMap(result: MapResult, freshAsOf: FreshAsOf): string {
  const lines: string[] = [];
  if (result.kind === "candidates") {
    if (result.candidates.length === 0) {
      lines.push(result.hint ?? "no clear target");
    } else {
      lines.push("Candidates (confirm one, then map it):");
      for (const c of result.candidates) {
        lines.push(`  ${c.score.toFixed(2)}  ${c.ref.level.padEnd(7)} ${c.ref.name}  (${c.ref.path})`);
      }
    }
  } else if (result.kind === "error") {
    lines.push(`error: ${result.error}`);
    if (result.candidates && result.candidates.length > 0) {
      lines.push("did you mean:");
      for (const c of result.candidates) {
        lines.push(`  ${c.score.toFixed(2)}  ${c.ref.level.padEnd(7)} ${c.ref.name}  (${c.ref.path})`);
      }
    } else if (result.hint) {
      lines.push(`  (${result.hint})`);
    }
  } else {
    const t = result.target;
    lines.push(`${t.level}: ${t.name}  (${t.path})`);
    if (result.module !== null) {
      const m = result.module;
      const tags = [
        m.role !== undefined ? `role=${m.role}` : null,
        m.rank !== undefined ? `hot #${m.rank}` : null,
        `churn=${m.churn}`,
      ].filter((x): x is string => x !== null);
      lines.push(`module: ${m.name}  [${tags.join(", ")}]`);
      if (m.responsibility !== undefined) lines.push(`  ${m.responsibility}`);
    }
    const refLine = (label: string, refs: { name: string; path: string }[], more?: number): void => {
      if (refs.length === 0) return;
      const names = refs.map((r) => r.name).join(", ");
      lines.push(`${label}: ${names}${more ? ` (+${more} more)` : ""}`);
    };
    refLine("depends on", result.dependsOn, result.truncated?.dependsOn);
    refLine("depended on by", result.dependedOnBy, result.truncated?.dependedOnBy);
    if (result.collaborators.length > 0) {
      lines.push(
        `collaborators: ${result.collaborators.join(", ")}` +
          (result.truncated?.collaborators ? ` (+${result.truncated.collaborators} more)` : ""),
      );
    }
    const h = result.health;
    const flags: string[] = [];
    if (h.hot !== null) flags.push(`hot (score ${h.hot.score}, #${h.hot.rank})`);
    if (h.inCycle !== null) flags.push(`in cycle: ${h.inCycle.render}`);
    for (const d of h.driftBroken) flags.push(`drift: "${d.rule}" -> ${d.enforcedBy} (${d.reason})`);
    for (const u of h.unguardable) flags.push(`unguardable: "${u.rule}"`);
    lines.push(`health: ${flags.length > 0 ? flags.join("; ") : "clear"}`);
    if (result.authoring !== undefined) lines.push(`authoring: ${result.authoring.stubHint}`);
  }
  lines.push(`freshAsOf: ${freshAsOf.note}${freshAsOf.stale ? " [STALE]" : ""}`);
  return lines.join("\n");
}

export async function runMap(argv: readonly string[]): Promise<number> {
  const parsed = parseMapArgs(argv);
  if (parsed.kind === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (parsed.kind === "err") {
    process.stderr.write(`sivru map: ${parsed.message}\n\n${USAGE}\n`);
    return 1;
  }
  const { args } = parsed;
  try {
    const { model, health, freshAsOf } = await loadModelAndHealth(args.repoRoot);
    // path wins when both are given (documented contract, mirrors the MCP tool).
    const result: MapResult =
      args.path !== undefined ? mapByPath(model, health, args.path, args.symbol) : mapByTask(model, args.task!);
    if (args.json) {
      process.stdout.write(JSON.stringify({ ...result, freshAsOf }, null, 2) + "\n");
    } else {
      process.stdout.write(renderMap(result, freshAsOf) + "\n");
    }
    // A did-you-mean miss is a non-zero exit (no target resolved), but still prints help.
    return result.kind === "error" ? 1 : 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`sivru map: ${msg}\n`);
    return 1;
  }
}
