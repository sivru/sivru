// `sivru doctor` — preflight + diagnostic.
//
// Walks a fixed sequence of environment checks (Node version, pnpm, the
// sivru CLI dist, observe-ui dist, cache dir, Claude Code projects dir,
// MCP registration, model cache, HF Hub reachability) and prints a
// PASS / WARN / FAIL line per check, with the exact remediation command
// when applicable. Designed so any "why doesn't sivru work?" thread
// becomes a one-line answer.
//
// Exit code: 0 if no checks failed (warnings are fine), 1 if any failed.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SIVRU_VERSION } from "./version.js";

export type Severity = "ok" | "warn" | "fail";

export type CheckResult = {
  name: string;
  severity: Severity;
  detail: string;
  fix?: string;
};

export type DoctorReport = {
  version: string;
  checks: CheckResult[];
  summary: { ok: number; warn: number; fail: number };
};

type ParsedNodeVersion = { major: number; minor: number; patch: number };

/** "v22.2.0" / "22.2.0" / "v22.2.0-rc.1" → { major, minor, patch }. */
export function parseNodeVersion(raw: string): ParsedNodeVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (m === null) return null;
  return {
    major: Number.parseInt(m[1] ?? "0", 10),
    minor: Number.parseInt(m[2] ?? "0", 10),
    patch: Number.parseInt(m[3] ?? "0", 10),
  };
}

function exec(
  cmd: string,
  args: readonly string[],
  timeoutMs = 4000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveFn) => {
    const child = execFile(
      cmd,
      args,
      { timeout: timeoutMs, encoding: "utf8" },
      (err, stdout, stderr) => {
        resolveFn({
          code: err === null ? 0 : ((err as NodeJS.ErrnoException).code === undefined ? 1 : 1),
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
    child.on("error", () => {
      // Spawning failed (binary missing); resolve with code 127.
      resolveFn({ code: 127, stdout: "", stderr: "" });
    });
  });
}

// ---------------------------------------------------------------------------
// Individual checks. Each returns a CheckResult.
// ---------------------------------------------------------------------------

export function checkNodeVersion(): CheckResult {
  const raw = process.versions.node;
  const parsed = parseNodeVersion(raw);
  if (parsed === null) {
    return {
      name: "node",
      severity: "fail",
      detail: `couldn't parse Node version: ${raw}`,
      fix: "nvm install 22.11 && nvm use 22.11",
    };
  }
  if (parsed.major < 20) {
    return {
      name: "node",
      severity: "fail",
      detail: `Node ${raw} — sivru requires Node 20+`,
      fix: "nvm install 22.11 && nvm alias default 22.11",
    };
  }
  if (parsed.major === 22 && parsed.minor < 11) {
    return {
      name: "node",
      severity: "warn",
      detail: `Node ${raw} — older than 22.11; onnxruntime-node may crash with "mutex lock failed: Invalid argument" when paired with worker_threads`,
      fix: "nvm install 22.11 && nvm alias default 22.11",
    };
  }
  return { name: "node", severity: "ok", detail: `Node ${raw} (>= 20)` };
}

export async function checkPnpmVersion(): Promise<CheckResult> {
  const r = await exec("pnpm", ["--version"]);
  if (r.code === 127) {
    return {
      name: "pnpm",
      severity: "fail",
      detail: "pnpm not found on PATH",
      fix: "npm install -g pnpm@9.15.0",
    };
  }
  const ver = r.stdout.trim();
  const parsed = parseNodeVersion(ver);
  if (parsed === null) {
    return {
      name: "pnpm",
      severity: "warn",
      detail: `pnpm output unrecognized: ${ver}`,
      fix: "npm install -g pnpm@9.15.0",
    };
  }
  if (parsed.major < 9) {
    return {
      name: "pnpm",
      severity: "warn",
      detail: `pnpm ${ver} — sivru recommends 9.x`,
      fix: "npm install -g pnpm@9.15.0",
    };
  }
  return { name: "pnpm", severity: "ok", detail: `pnpm ${ver}` };
}

/** Resolve repo root assuming this script lives at packages/cli/dist/commands/doctor.js. */
function resolveRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..");
}

export function checkSivruDist(): CheckResult {
  const repoRoot = resolveRepoRoot();
  const distEntry = resolve(repoRoot, "packages", "cli", "dist", "index.js");
  if (!existsSync(distEntry)) {
    return {
      name: "sivru cli dist",
      severity: "fail",
      detail: `not found at ${distEntry}`,
      fix: "pnpm install && pnpm build",
    };
  }
  return {
    name: "sivru cli dist",
    severity: "ok",
    detail: `built at ${distEntry}`,
  };
}

export function checkObserveUiDist(): CheckResult {
  const repoRoot = resolveRepoRoot();
  const indexHtml = resolve(repoRoot, "packages", "observe-ui", "dist", "index.html");
  if (!existsSync(indexHtml)) {
    return {
      name: "observe-ui dist",
      severity: "warn",
      detail: "observe-ui dist not built — `sivru observe` UI won't render",
      fix: "pnpm --filter @sivru/observe-ui build",
    };
  }
  return { name: "observe-ui dist", severity: "ok", detail: "built" };
}

export function checkSivruCacheDir(): CheckResult {
  const dir = join(homedir(), ".cache", "sivru");
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, ".doctor-probe");
    writeFileSync(probe, "x");
    unlinkSync(probe);
    return { name: "cache dir", severity: "ok", detail: dir };
  } catch (err) {
    return {
      name: "cache dir",
      severity: "fail",
      detail: `${dir} not writable: ${(err as Error).message}`,
      fix: `chmod u+w ${dir} (or remove and recreate)`,
    };
  }
}

export async function checkClaudeProjectsDir(): Promise<CheckResult> {
  const dir = join(homedir(), ".claude", "projects");
  if (!existsSync(dir)) {
    return {
      name: "claude code projects",
      severity: "warn",
      detail: `${dir} doesn't exist — observe needs Claude Code session data`,
      fix: "run a Claude Code session first; the directory is created automatically",
    };
  }
  let sessionFiles = 0;
  try {
    const projectDirs = await readdir(dir);
    for (const project of projectDirs) {
      try {
        const inner = await readdir(join(dir, project));
        for (const f of inner) if (f.endsWith(".jsonl")) sessionFiles += 1;
      } catch {
        // Skip non-directories.
      }
    }
  } catch {
    // Walk failed; treat as zero sessions.
  }
  return {
    name: "claude code projects",
    severity: "ok",
    detail: `${dir} (${sessionFiles} session${sessionFiles === 1 ? "" : "s"})`,
  };
}

export async function checkMcpRegistration(): Promise<CheckResult> {
  const which = await exec("which", ["claude"]);
  if (which.code !== 0) {
    return {
      name: "mcp registration",
      severity: "warn",
      detail: "`claude` binary not on PATH — can't verify MCP registration",
      fix: "install Claude Code from https://claude.ai/code, then run `sivru observe init`",
    };
  }
  const list = await exec("claude", ["mcp", "list"]);
  if (list.code !== 0) {
    return {
      name: "mcp registration",
      severity: "warn",
      detail: `\`claude mcp list\` failed with exit ${list.code}`,
      fix: "claude mcp add sivru -s user -- sivru mcp",
    };
  }
  if (!list.stdout.includes("sivru")) {
    return {
      name: "mcp registration",
      severity: "warn",
      detail: "sivru is not registered in Claude Code's MCP config",
      fix: "claude mcp add sivru -s user -- sivru mcp  (or run `sivru observe init`)",
    };
  }
  return {
    name: "mcp registration",
    severity: "ok",
    detail: "sivru is registered",
  };
}

export function checkModelCache(): CheckResult {
  const dir = join(
    homedir(),
    ".cache",
    "sivru",
    "models",
    "minishlab",
    "potion-retrieval-32M",
  );
  if (existsSync(dir)) {
    return {
      name: "embedding model cache",
      severity: "ok",
      detail: "potion-retrieval-32M cached",
    };
  }
  return {
    name: "embedding model cache",
    severity: "warn",
    detail: "default embedder not cached — first --hybrid call downloads ~129 MB",
    fix: "run `sivru search \"warm\" .` once to pre-cache, or just wait for the first real query",
  };
}

export async function checkHfHub(): Promise<CheckResult> {
  if (typeof globalThis.fetch !== "function") {
    return {
      name: "hf hub reachability",
      severity: "warn",
      detail: "global fetch unavailable; skipping reachability check",
    };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch("https://huggingface.co/", {
      method: "HEAD",
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.ok || (res.status >= 300 && res.status < 400)) {
      return {
        name: "hf hub reachability",
        severity: "ok",
        detail: `huggingface.co reachable (${res.status})`,
      };
    }
    return {
      name: "hf hub reachability",
      severity: "warn",
      detail: `huggingface.co returned ${res.status}`,
      fix: "check network connectivity; sivru still works if the model is already cached",
    };
  } catch (err) {
    return {
      name: "hf hub reachability",
      severity: "warn",
      detail: `couldn't reach huggingface.co: ${(err as Error).message}`,
      fix: "check network connectivity; sivru still works if the model is already cached",
    };
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/** Run every check and return a structured report. Pure: no I/O outside of the checks themselves. */
export async function runAllChecks(): Promise<DoctorReport> {
  const checks: CheckResult[] = [];
  checks.push(checkNodeVersion());
  checks.push(await checkPnpmVersion());
  checks.push(checkSivruDist());
  checks.push(checkObserveUiDist());
  checks.push(checkSivruCacheDir());
  checks.push(await checkClaudeProjectsDir());
  checks.push(await checkMcpRegistration());
  checks.push(checkModelCache());
  checks.push(await checkHfHub());

  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) summary[c.severity] += 1;
  return { version: SIVRU_VERSION, checks, summary };
}

function severityMarker(s: Severity): string {
  if (s === "ok") return "[ok]  ";
  if (s === "warn") return "[warn]";
  return "[fail]";
}

function renderReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`sivru doctor ${report.version}`);
  lines.push("");
  for (const c of report.checks) {
    lines.push(`  ${severityMarker(c.severity)} ${c.name} — ${c.detail}`);
    if (c.fix !== undefined) {
      lines.push(`         fix: ${c.fix}`);
      lines.push("");
    }
  }
  if (lines[lines.length - 1] !== "") lines.push("");
  const { ok, warn, fail } = report.summary;
  const total = ok + warn + fail;
  lines.push(`${ok}/${total} ok, ${warn} warn, ${fail} fail.`);
  return lines.join("\n");
}

type ParsedArgs = {
  json: boolean;
};

function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  let json = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--json") {
      json = true;
    } else if (a.startsWith("--")) {
      return { error: `unknown flag: ${a}` };
    }
  }
  return { json };
}

export async function runDoctor(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`sivru doctor: ${parsed.error}\n`);
    return 2;
  }
  const report = await runAllChecks();
  if (parsed.json) {
    process.stdout.write(JSON.stringify(report) + "\n");
  } else {
    process.stdout.write(renderReport(report) + "\n");
  }
  return report.summary.fail > 0 ? 1 : 0;
}
