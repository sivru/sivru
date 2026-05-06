// `sivru observe [<subcommand>]` — four modes:
//
//   sivru observe              boots the HTTP server + observe-ui (default)
//   sivru observe init         one-shot setup (MCP registration + CLAUDE.md hint + subagent file)
//   sivru observe replay <id>  static counterfactual replay of one session
//   sivru observe costs        aggregate counterfactual rollup across all sessions
//
// All four modes are local-only. The replay/costs subcommands do zero
// network I/O and zero API calls — they walk `~/.claude/projects/<cwd>/<id>.jsonl`
// and statically estimate "what if sivru had been there?" for each tool call.
// DESIGN.md §5.5 / §6.1 / §20.1 / §20.3 (offline default) / §21.4 (init).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggregateReplay,
  createObserveServer,
  listSessions,
  readSession,
  replaySession,
} from "@sivru/observe";
import type { ReplayedEvent, ReplayResult, AggregateReport } from "@sivru/observe";

const DEFAULT_PORT = 7676;

export async function runObserve(argv: readonly string[]): Promise<number> {
  const sub = argv[1];
  if (sub === "init") return runObserveInit(argv.slice(1));
  if (sub === "replay") return runObserveReplay(argv.slice(1));
  if (sub === "costs") return runObserveCosts(argv.slice(1));
  return runObserveServer(argv);
}

// ---------- server ----------

type ServerArgs = {
  port: number;
  host: string;
  noUi: boolean;
};

function parseServerArgs(argv: readonly string[]): ServerArgs | { error: string } {
  let port = DEFAULT_PORT;
  let host = "127.0.0.1";
  let noUi = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--no-ui") {
      noUi = true;
    } else if (arg === "--port" || arg === "-p") {
      const next = argv[++i];
      if (next === undefined) return { error: "--port requires a value" };
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n < 0 || n > 65535) return { error: `invalid port: ${next}` };
      port = n;
    } else if (arg.startsWith("--port=")) {
      const value = arg.slice("--port=".length);
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n < 0 || n > 65535) return { error: `invalid port: ${value}` };
      port = n;
    } else if (arg === "--host") {
      const next = argv[++i];
      if (next === undefined) return { error: "--host requires a value" };
      host = next;
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
    } else if (arg.startsWith("--")) {
      return { error: `unknown flag: ${arg}` };
    }
  }
  return { port, host, noUi };
}

/** Resolve packages/observe-ui/dist relative to this script. Returns null when missing. */
function resolveUiDist(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // Walk up from packages/cli/dist/commands/observe.js → repo root → packages/observe-ui/dist
  const repoRoot = resolve(here, "..", "..", "..", "..");
  const dist = resolve(repoRoot, "packages", "observe-ui", "dist");
  return existsSync(resolve(dist, "index.html")) ? dist : null;
}

async function runObserveServer(argv: readonly string[]): Promise<number> {
  const parsed = parseServerArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`sivru observe: ${parsed.error}\n`);
    return 1;
  }

  const uiDist = parsed.noUi ? null : resolveUiDist();
  const server = await createObserveServer({
    port: parsed.port,
    host: parsed.host,
    ...(uiDist !== null ? { uiDistDir: uiDist } : {}),
  });

  process.stdout.write(`sivru observe — listening on ${server.url}\n`);
  if (uiDist !== null) {
    process.stdout.write(`  ui:   ${server.url}/\n`);
  } else if (!parsed.noUi) {
    process.stdout.write(
      `  ui:   not bundled (run \`pnpm --filter @sivru/observe-ui build\` to produce one)\n`,
    );
  }
  process.stdout.write(`  api:  ${server.url}/api/sessions\n`);
  process.stdout.write(`Ctrl+C to stop.\n`);

  await new Promise<void>((doneResolve) => {
    const stop = (): void => {
      process.stdout.write("\nstopping...\n");
      void server.close().then(() => doneResolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  return 0;
}

// ---------- replay <id> ----------

type ReplayArgs = {
  prefix: string;
  json: boolean;
  projectsRoot: string | null;
};

function parseReplayArgs(argv: readonly string[]): ReplayArgs | { error: string } {
  let prefix: string | null = null;
  let json = false;
  let projectsRoot: string | null = null;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--projects-root") {
      const next = argv[++i];
      if (next === undefined) return { error: "--projects-root requires a value" };
      projectsRoot = next;
    } else if (arg.startsWith("--")) {
      return { error: `unknown flag: ${arg}` };
    } else if (prefix === null) {
      prefix = arg;
    }
  }
  if (prefix === null) return { error: "missing session id (try `sivru observe replay <id-prefix>`)" };
  return { prefix, json, projectsRoot };
}

async function runObserveReplay(argv: readonly string[]): Promise<number> {
  const parsed = parseReplayArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`sivru observe replay: ${parsed.error}\n`);
    return 1;
  }

  const sessions = await listSessions(
    parsed.projectsRoot !== null ? { projectsRoot: parsed.projectsRoot } : undefined,
  );
  const matches = sessions.filter((s) =>
    s.id.toLowerCase().startsWith(parsed.prefix.toLowerCase()),
  );
  if (matches.length === 0) {
    process.stderr.write(`sivru observe replay: no session matching prefix \`${parsed.prefix}\`\n`);
    return 1;
  }
  if (matches.length > 1) {
    process.stderr.write(
      `sivru observe replay: ambiguous prefix \`${parsed.prefix}\` matches ${matches.length} sessions; use a longer prefix\n`,
    );
    return 1;
  }
  const session = matches[0]!;

  const result = await replaySession(readSession(session.path));

  if (parsed.json) {
    process.stdout.write(JSON.stringify({ sessionId: session.id, ...result }) + "\n");
    return 0;
  }
  printReplayTable(session.id, session.project, result);
  return 0;
}

function printReplayTable(sessionId: string, project: string, r: ReplayResult): void {
  process.stdout.write(`session ${sessionId.slice(0, 8)} — ${project}\n`);
  process.stdout.write(
    `  ${r.events.length} events  ·  ${r.totals.replaceableCallCount} replaceable tool calls\n`,
  );
  process.stdout.write(
    `  actual    ${formatTokens(r.totals.actualTokens)} tokens\n`,
  );
  process.stdout.write(
    `  with-sivru ${formatTokens(r.totals.counterfactualTokens)} tokens\n`,
  );
  const sign = r.totals.tokensSaved >= 0 ? "+" : "";
  process.stdout.write(
    `  saved     ${sign}${formatTokens(r.totals.tokensSaved)} (${(r.totals.percentSaved * 100).toFixed(1)}%)\n`,
  );
  if (r.totals.replaceableCallCount === 0) {
    process.stdout.write(
      `\nno replaceable tool calls in this session — sivru wouldn't have helped here.\n`,
    );
    return;
  }
  process.stdout.write("\nreplaceable calls:\n");
  for (const ev of r.events) {
    if (!ev.replaceableBySivru) continue;
    if (ev.kind !== "tool_use") continue; // print one row per pair, on the use side
    const result = r.events.find(
      (e) => e.index === ev.index + 1 && e.kind === "tool_result",
    );
    const actualT = result?.actualTokens ?? 0;
    const cfT = result?.counterfactualTokens ?? 0;
    process.stdout.write(
      `  [${String(ev.index).padStart(4)}] ${(ev.tool ?? "?").padEnd(8)}  actual ${formatTokens(actualT).padStart(6)}  →  with-sivru ${formatTokens(cfT).padStart(6)}\n`,
    );
  }
}

function formatTokens(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ---------- costs ----------

type CostsArgs = {
  json: boolean;
  projectsRoot: string | null;
  /** When set, only include sessions updated within the last N days. */
  sinceDays: number | null;
};

function parseCostsArgs(argv: readonly string[]): CostsArgs | { error: string } {
  let json = false;
  let projectsRoot: string | null = null;
  let sinceDays: number | null = null;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--projects-root") {
      const next = argv[++i];
      if (next === undefined) return { error: "--projects-root requires a value" };
      projectsRoot = next;
    } else if (arg.startsWith("--since=")) {
      const value = arg.slice("--since=".length);
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n <= 0) return { error: `invalid --since value: ${value}` };
      sinceDays = n;
    } else if (arg.startsWith("--")) {
      return { error: `unknown flag: ${arg}` };
    }
  }
  return { json, projectsRoot, sinceDays };
}

async function runObserveCosts(argv: readonly string[]): Promise<number> {
  const parsed = parseCostsArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`sivru observe costs: ${parsed.error}\n`);
    return 1;
  }

  const allSessions = await listSessions(
    parsed.projectsRoot !== null ? { projectsRoot: parsed.projectsRoot } : undefined,
  );
  const cutoff =
    parsed.sinceDays !== null ? Date.now() - parsed.sinceDays * 86_400_000 : null;
  const filtered = allSessions.filter((s) => {
    if (cutoff === null) return true;
    if (s.updatedAt === null) return false;
    return Date.parse(s.updatedAt) >= cutoff;
  });

  const report = await aggregateReplay(
    filtered.map((s) => ({ id: s.id, events: readSession(s.path) })),
  );

  if (parsed.json) {
    process.stdout.write(JSON.stringify(report) + "\n");
    return 0;
  }
  printCostsSummary(report, filtered.length);
  return 0;
}

function printCostsSummary(report: AggregateReport, totalSessions: number): void {
  process.stdout.write(
    `sivru observe costs — ${totalSessions} sessions analyzed\n`,
  );
  process.stdout.write(
    `  actual         ${formatTokens(report.totals.actualTokens)} tokens\n`,
  );
  process.stdout.write(
    `  with-sivru     ${formatTokens(report.totals.counterfactualTokens)} tokens\n`,
  );
  const sign = report.totals.tokensSaved >= 0 ? "+" : "";
  process.stdout.write(
    `  saved          ${sign}${formatTokens(report.totals.tokensSaved)} (${(report.totals.percentSaved * 100).toFixed(1)}%)\n`,
  );
  process.stdout.write(
    `  replaceable    ${report.totals.replaceableCallCount} tool calls\n`,
  );
  if (report.sessions.length === 0) {
    return;
  }
  process.stdout.write("\ntop sessions by tokens-saved:\n");
  const sorted = [...report.sessions].sort((a, b) => b.tokensSaved - a.tokensSaved);
  for (const s of sorted.slice(0, 10)) {
    const sgn = s.tokensSaved >= 0 ? "+" : "";
    process.stdout.write(
      `  ${s.id.slice(0, 8)}  ${sgn}${formatTokens(s.tokensSaved).padStart(7)} saved  ·  ${s.replaceableCallCount} calls\n`,
    );
  }
}

// ---------- init ----------

const CLAUDE_MD_HINT_BLOCK = `<!-- sivru-hint -->
Prefer the \`mcp__sivru__search\` tool for code search — it returns ranked
chunks with file paths and line ranges, far cheaper than Bash grep + Read
on whole files. Pass \`hybrid: false\` for pure lexical (faster cold start).
<!-- /sivru-hint -->`;

const SUBAGENT_FILE_CONTENT = `---
name: sivru-search
description: Code-search subagent that prefers sivru.search for grep-like and Read-like queries.
---

Use the \`mcp__sivru__search\` MCP tool to search code in this repo.
Always prefer it over \`Bash grep\` or \`Read\` on a whole file when the
user is asking about code structure, function definitions, or
cross-file patterns. Pass \`hybrid: false\` for pure lexical retrieval
(faster cold start), \`true\` (default) for semantic + lexical fusion.
`;

type InitArgs = {
  dryRun: boolean;
  skipMcp: boolean;
  skipClaudeMd: boolean;
  skipSubagent: boolean;
  cwd: string;
};

function parseInitArgs(argv: readonly string[]): InitArgs | { error: string } {
  let dryRun = false;
  let skipMcp = false;
  let skipClaudeMd = false;
  let skipSubagent = false;
  let cwd = process.cwd();
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--skip-mcp") {
      skipMcp = true;
    } else if (a === "--skip-claude-md") {
      skipClaudeMd = true;
    } else if (a === "--skip-subagent") {
      skipSubagent = true;
    } else if (a === "--cwd") {
      const next = argv[++i];
      if (next === undefined) return { error: "--cwd requires a value" };
      cwd = next;
    } else if (a.startsWith("--cwd=")) {
      cwd = a.slice("--cwd=".length);
    } else if (a.startsWith("--")) {
      return { error: `unknown flag: ${a}` };
    }
  }
  return { dryRun, skipMcp, skipClaudeMd, skipSubagent, cwd };
}

function exec(
  cmd: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveFn) => {
    const child = execFile(
      cmd,
      args,
      { encoding: "utf8", timeout: 8000 },
      (err, stdout, stderr) => {
        resolveFn({
          code: err === null ? 0 : 1,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
    child.on("error", () => resolveFn({ code: 127, stdout: "", stderr: "" }));
  });
}

/**
 * Resolve the absolute path to the running sivru CLI's dist/index.js. We pass
 * this to `claude mcp add` so the registration is portable across `cd` and
 * shell rc reloads.
 */
function resolveCliEntry(): string {
  // This file is dist/commands/observe.js when published; the CLI entry is
  // dist/index.js in the same package.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "index.js");
}

/**
 * Internal seam for tests to stub the spawn calls. The whole module reads
 * `_internal.spawn` instead of calling `execFile` directly so a test can
 * substitute a record-and-replay stub.
 */
type SpawnFn = (cmd: string, args: readonly string[]) => Promise<{
  code: number;
  stdout: string;
  stderr: string;
}>;

async function runObserveInit(argv: readonly string[]): Promise<number> {
  const parsed = parseInitArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`sivru observe init: ${parsed.error}\n`);
    return 2;
  }
  const { dryRun, skipMcp, skipClaudeMd, skipSubagent, cwd } = parsed;
  const lines: string[] = [];
  lines.push(`sivru observe init${dryRun ? "  [dry-run]" : ""}`);
  lines.push("");

  // Step 1: MCP registration.
  if (skipMcp) {
    lines.push("  [=] mcp registration (skipped via --skip-mcp)");
  } else {
    const result = await registerMcp(dryRun);
    lines.push(...result);
  }

  // Step 2: CLAUDE.md hint.
  if (skipClaudeMd) {
    lines.push("  [=] CLAUDE.md hint (skipped via --skip-claude-md)");
  } else {
    const result = await writeClaudeMd(cwd, dryRun);
    lines.push(...result);
  }

  // Step 3: Subagent file.
  if (skipSubagent) {
    lines.push("  [=] subagent file (skipped via --skip-subagent)");
  } else {
    const result = await writeSubagentFile(cwd, dryRun);
    lines.push(...result);
  }

  lines.push("");
  if (dryRun) {
    lines.push("(dry run — no changes written)");
  } else {
    lines.push("done. Restart Claude Code for the MCP changes to take effect.");
  }

  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

async function registerMcp(dryRun: boolean): Promise<string[]> {
  const spawn = _initInternal.spawn;
  const out: string[] = [];

  // Is `claude` on PATH?
  const probe = await spawn("claude", ["--version"]);
  if (probe.code !== 0) {
    out.push(
      "  [!] claude binary not found on PATH — install Claude Code from https://claude.ai/code",
    );
    return out;
  }

  // Already registered?
  const list = await spawn("claude", ["mcp", "list"]);
  if (list.code === 0 && list.stdout.includes("sivru")) {
    out.push("  [=] mcp server already registered as 'sivru'");
    return out;
  }

  const cliEntry = resolveCliEntry();
  const addArgs = [
    "mcp",
    "add",
    "sivru",
    "-s",
    "user",
    "--",
    "node",
    cliEntry,
    "mcp",
  ];
  if (dryRun) {
    out.push(`  [+] would run: claude ${addArgs.join(" ")}`);
    return out;
  }
  const add = await spawn("claude", addArgs);
  if (add.code !== 0) {
    out.push(
      `  [!] \`claude mcp add\` failed with exit ${add.code}: ${add.stderr.trim() || "(no stderr)"}`,
    );
    return out;
  }
  out.push("  [+] registered mcp server (run `claude mcp list` to verify)");
  return out;
}

async function writeClaudeMd(cwd: string, dryRun: boolean): Promise<string[]> {
  const target = resolve(cwd, "CLAUDE.md");
  const out: string[] = [];

  let existing: string | null = null;
  try {
    existing = await readFile(target, "utf8");
  } catch {
    existing = null;
  }

  if (existing !== null && existing.includes("<!-- sivru-hint -->")) {
    out.push("  [=] CLAUDE.md already has the sivru hint");
    return out;
  }

  if (dryRun) {
    out.push(
      existing === null
        ? `  [+] would create ${target} with sivru hint`
        : `  [+] would append sivru hint to ${target}`,
    );
    return out;
  }

  const content =
    existing === null
      ? `# CLAUDE.md\n\n${CLAUDE_MD_HINT_BLOCK}\n`
      : existing.endsWith("\n")
        ? `${existing}\n${CLAUDE_MD_HINT_BLOCK}\n`
        : `${existing}\n\n${CLAUDE_MD_HINT_BLOCK}\n`;
  await writeFile(target, content, "utf8");
  out.push(
    existing === null
      ? `  [+] created ${target} with sivru hint`
      : `  [+] appended sivru hint to ${target}`,
  );
  return out;
}

async function writeSubagentFile(
  cwd: string,
  dryRun: boolean,
): Promise<string[]> {
  const target = resolve(cwd, ".claude", "agents", "sivru-search.md");
  const out: string[] = [];

  if (existsSync(target)) {
    out.push(`  [=] subagent file already exists at ${target}`);
    return out;
  }
  if (dryRun) {
    out.push(`  [+] would write ${target}`);
    return out;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, SUBAGENT_FILE_CONTENT, "utf8");
  out.push(`  [+] wrote ${target}`);
  return out;
}

/**
 * Test-only seam. Tests assign `_initInternal.spawn` to a stub before
 * calling `runObserveInit` to record / fake `claude` invocations.
 */
export const _initInternal: { spawn: SpawnFn } = { spawn: exec };

/** Re-exported for unit tests that don't want to spawn the dispatcher. */
export const _internal = {
  runObserveReplay,
  runObserveCosts,
  runObserveServer,
  runObserveInit,
};
// Touch the imported types to keep them in the binary's d.ts surface.
export type { ReplayedEvent };
