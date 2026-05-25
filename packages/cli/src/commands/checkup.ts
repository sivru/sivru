// `sivru checkup [path]` — run the coach loop's drift checks
// (DESIGN-0005 §2). Flags: --json, --check <id> (repeatable),
// --no-git.
//
// Exit codes:
//   0 — checks ran (findings are descriptive; their presence is not an error).
//   1 — config malformed (SIVRU-E240) or path missing/not-a-directory (SIVRU-E241).
//   2 — bad command-line argument.
//
// Argument parsing is hand-rolled per the project convention.

import { resolve as resolvePath } from "node:path";
import { stat } from "node:fs/promises";

import {
  CheckupConfigError,
  runCheckup,
  type AuditFinding,
  type CheckupReport,
  type Severity,
} from "@sivru/observe/coach";

interface ParsedArgs {
  path: string;
  json: boolean;
  noGit: boolean;
  check: string[];
}

export function parseCheckupArgs(
  argv: readonly string[],
): { kind: "ok"; args: ParsedArgs } | { kind: "err"; message: string } {
  let path = process.cwd();
  let json = false;
  let noGit = false;
  const check: string[] = [];
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--json") { json = true; continue; }
    if (a === "--no-git") { noGit = true; continue; }
    if (a === "--check") {
      const v = argv[i + 1];
      if (v === undefined) return { kind: "err", message: "--check requires a value" };
      check.push(v);
      i++;
      continue;
    }
    if (a.startsWith("--check=")) {
      check.push(a.slice("--check=".length));
      continue;
    }
    if (a.startsWith("--")) {
      return { kind: "err", message: `unknown flag: ${a}` };
    }
    positionals.push(a);
  }
  if (positionals.length > 1) {
    return { kind: "err", message: "checkup accepts at most one path argument" };
  }
  if (positionals[0] !== undefined) {
    path = resolvePath(positionals[0]);
  }
  return { kind: "ok", args: { path, json, noGit, check } };
}

export async function runCheckupCmd(argv: readonly string[]): Promise<number> {
  const parsed = parseCheckupArgs(argv);
  if (parsed.kind === "err") {
    process.stderr.write(`sivru checkup: ${parsed.message}\n`);
    return 2;
  }
  const { path, json, noGit, check } = parsed.args;

  try {
    const st = await stat(path);
    if (!st.isDirectory()) {
      process.stderr.write(`sivru checkup: SIVRU-E241 not a directory: ${path}\n`);
      return 1;
    }
  } catch {
    process.stderr.write(`sivru checkup: SIVRU-E241 path doesn't exist: ${path}\n`);
    return 1;
  }

  let report: CheckupReport;
  try {
    report = await runCheckup(path, {
      noGit,
      ...(check.length > 0 ? { check } : {}),
    });
  } catch (err) {
    if (err instanceof CheckupConfigError) {
      process.stderr.write(`sivru checkup: ${err.code} ${err.message}\n`);
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`sivru checkup: ${msg}\n`);
    return 1;
  }

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(formatHumanReport(report));
  return 0;
}

const SEV_LABELS: Record<Severity, string> = {
  info: "info ",
  warning: "warn ",
  error: "error",
};

function severityRank(s: Severity): number {
  if (s === "error") return 0;
  if (s === "warning") return 1;
  return 2;
}

function formatHumanReport(r: CheckupReport): string {
  const lines: string[] = [];

  // Diagnostics (e.g., SIVRU-E244 git unavailable) at the top — surfacing
  // them before findings tells the user what mode the run was in.
  for (const d of r.diagnostics) {
    lines.push(`${d.code}: ${d.message}`);
  }
  if (r.diagnostics.length > 0) lines.push("");

  if (r.findings.length === 0) {
    lines.push(`Everything checked, nothing aged or dead. (${r.files.length} files)`);
    return lines.join("\n") + "\n";
  }

  // Group findings by file then sort within each file: errors → warnings → info.
  const byFile = new Map<string, AuditFinding[]>();
  for (const f of r.findings) {
    const arr = byFile.get(f.filePath) ?? [];
    arr.push(f);
    byFile.set(f.filePath, arr);
  }
  // Maintain file order from r.files for stability.
  const fileOrder = r.files.map((f) => f.path).filter((p) => byFile.has(p));
  for (const fp of fileOrder) {
    const findings = byFile.get(fp)!;
    findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    const display = r.files.find((f) => f.path === fp)?.displayPath ?? fp;
    lines.push(display);
    for (const f of findings) {
      const line = f.line !== undefined ? `:${f.line}` : "";
      lines.push(`  [${SEV_LABELS[f.severity]}] ${f.checkId}${line} ${f.summary}`);
    }
    lines.push("");
  }

  const counts = { info: 0, warning: 0, error: 0 };
  for (const f of r.findings) counts[f.severity]++;
  lines.push(`${r.findings.length} findings: ${counts.error} error, ${counts.warning} warning, ${counts.info} info across ${byFile.size} files (${r.files.length} files scanned).`);
  return lines.join("\n") + "\n";
}
