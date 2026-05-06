// `sivru session list` and `sivru session show <id-prefix>` — list and inspect
// Claude Code sessions captured under `~/.claude/projects/`.
//
// Default output is a human-readable table / event log; `--json` swaps to
// machine-friendly NDJSON (one JSON object per line for `show`, a single
// JSON envelope for `list`). Mirrors the `runX(argv): Promise<number>` and
// argv-parser style of the other command modules in this directory.

import { basename } from "node:path";

import { listSessions, readSession } from "@sivru/observe";
import type {
  JsonlSourceOptions,
  Session,
  SivruEvent,
} from "@sivru/observe";

const DEFAULT_LIST_LIMIT = 20;
const TEXT_TEXT_SNIPPET_MAX = 120;

type ListArgs = {
  kind: "list";
  all: boolean;
  json: boolean;
  projectsRoot: string | undefined;
};

type ShowArgs = {
  kind: "show";
  prefix: string;
  json: boolean;
  limit?: number;
  projectsRoot: string | undefined;
};

type ParsedArgs =
  | ListArgs
  | ShowArgs
  | { kind: "error"; message: string; exitCode: 1 | 2 };

function parseListArgs(argv: readonly string[]): ParsedArgs {
  let all = false;
  let json = false;
  let projectsRoot: string | undefined;

  // argv[0] is "session", argv[1] is "list" — start at i=2.
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--all") {
      all = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--projects-root") {
      const next = argv[i + 1];
      if (next === undefined) {
        return {
          kind: "error",
          message: "missing value for --projects-root",
          exitCode: 2,
        };
      }
      projectsRoot = next;
      i++;
    } else if (arg.startsWith("--projects-root=")) {
      projectsRoot = arg.slice("--projects-root=".length);
    } else if (arg.startsWith("--")) {
      return { kind: "error", message: `unknown flag: ${arg}`, exitCode: 2 };
    } else {
      return {
        kind: "error",
        message: `unexpected argument: ${arg}`,
        exitCode: 2,
      };
    }
  }

  return { kind: "list", all, json, projectsRoot };
}

function parseShowArgs(argv: readonly string[]): ParsedArgs {
  let json = false;
  let limit: number | undefined;
  let projectsRoot: string | undefined;
  const positional: string[] = [];

  // argv[0] is "session", argv[1] is "show" — start at i=2.
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("--limit=")) {
      const raw = arg.slice("--limit=".length);
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return {
          kind: "error",
          message: `invalid --limit value: ${raw}`,
          exitCode: 2,
        };
      }
      limit = n;
    } else if (arg === "--limit") {
      const next = argv[i + 1];
      if (next === undefined) {
        return {
          kind: "error",
          message: "missing value for --limit",
          exitCode: 2,
        };
      }
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return {
          kind: "error",
          message: `invalid --limit value: ${next}`,
          exitCode: 2,
        };
      }
      limit = n;
      i++;
    } else if (arg === "--projects-root") {
      const next = argv[i + 1];
      if (next === undefined) {
        return {
          kind: "error",
          message: "missing value for --projects-root",
          exitCode: 2,
        };
      }
      projectsRoot = next;
      i++;
    } else if (arg.startsWith("--projects-root=")) {
      projectsRoot = arg.slice("--projects-root=".length);
    } else if (arg.startsWith("--")) {
      return { kind: "error", message: `unknown flag: ${arg}`, exitCode: 2 };
    } else {
      positional.push(arg);
    }
  }

  const prefix = positional[0];
  if (prefix === undefined || prefix.length === 0) {
    return {
      kind: "error",
      message: "missing <id-prefix>; usage: sivru session show <id-prefix>",
      exitCode: 1,
    };
  }

  const args: ShowArgs = {
    kind: "show",
    prefix,
    json,
    projectsRoot,
  };
  if (limit !== undefined) args.limit = limit;
  return args;
}

function buildSourceOptions(
  projectsRoot: string | undefined,
): JsonlSourceOptions | undefined {
  if (projectsRoot === undefined) return undefined;
  return { projectsRoot };
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function shortTs(ts: string | null): string {
  if (ts === null) return "(empty)        ";
  // YYYY-MM-DDTHH:MM — 16 chars wide.
  return ts.slice(0, 16);
}

function projectBase(projectPath: string): string {
  // listSessions returns `project` as the project path (or basename).
  // basename works for both forms.
  const b = basename(projectPath);
  return b.length > 0 ? b : projectPath;
}

function formatSessionRow(s: Session): string {
  const id = shortId(s.id).padEnd(8, " ");
  const updated = shortTs(s.updatedAt).padEnd(16, " ");
  const events = String(s.eventCount).padStart(6, " ");
  const project = projectBase(s.project);
  return `${id}  ${updated}  ${events}  ${project}`;
}

function formatSessionHeader(): string {
  const id = "id".padEnd(8, " ");
  const updated = "updated".padEnd(16, " ");
  const events = "events".padStart(6, " ");
  const project = "project";
  return `${id}  ${updated}  ${events}  ${project}`;
}

function snippet(text: string): string {
  // Single-line, max TEXT_TEXT_SNIPPET_MAX chars; replace newlines.
  const collapsed = text.replace(/\r?\n/g, "↵");
  if (collapsed.length <= TEXT_TEXT_SNIPPET_MAX) return collapsed;
  return collapsed.slice(0, TEXT_TEXT_SNIPPET_MAX - 1) + "…";
}

function formatEventDetails(ev: SivruEvent): string {
  switch (ev.kind) {
    case "user_message":
    case "assistant_message":
      return ev.text !== undefined ? snippet(ev.text) : "";
    case "tool_use":
      return ev.tool ?? "";
    case "tool_result": {
      const tool = ev.tool ?? "";
      return ev.isError === true ? `${tool} (error)` : tool;
    }
    case "system":
    case "unknown":
      return "";
    default:
      return "";
  }
}

function formatEventLine(ev: SivruEvent): string {
  const idx = `[${ev.index}]`;
  const ts = ev.ts !== undefined ? ev.ts.slice(0, 19) : "";
  const details = formatEventDetails(ev);
  // Always include the kind. If `details` is empty, drop the trailing space.
  const head = `${idx} ${ts} ${ev.kind}`.replace(/\s+$/, "");
  return details.length > 0 ? `${head}  ${details}` : head;
}

async function runList(args: ListArgs): Promise<number> {
  const opts = buildSourceOptions(args.projectsRoot);
  let sessions: Session[];
  try {
    sessions = opts === undefined ? await listSessions() : await listSessions(opts);
  } catch (err) {
    process.stderr.write(
      `sivru session list: ${(err as Error).message ?? String(err)}\n`,
    );
    return 1;
  }

  const trimmed = args.all ? sessions : sessions.slice(0, DEFAULT_LIST_LIMIT);

  if (args.json) {
    const payload = {
      sessions: trimmed.map((s) => ({
        id: s.id,
        path: s.path,
        project: s.project,
        startedAt: s.startedAt,
        updatedAt: s.updatedAt,
        eventCount: s.eventCount,
      })),
    };
    process.stdout.write(JSON.stringify(payload) + "\n");
    return 0;
  }

  if (trimmed.length === 0) {
    process.stdout.write("no sessions found in ~/.claude/projects/\n");
    return 0;
  }

  const lines = [formatSessionHeader(), ...trimmed.map(formatSessionRow)];
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

async function runShow(args: ShowArgs): Promise<number> {
  const opts = buildSourceOptions(args.projectsRoot);
  let sessions: Session[];
  try {
    sessions = opts === undefined ? await listSessions() : await listSessions(opts);
  } catch (err) {
    process.stderr.write(
      `sivru session show: ${(err as Error).message ?? String(err)}\n`,
    );
    return 1;
  }

  const needle = args.prefix.toLowerCase();
  const matches = sessions.filter((s) => s.id.toLowerCase().startsWith(needle));

  if (matches.length === 0) {
    process.stderr.write(
      `sivru session show: no session matching prefix \`${args.prefix}\`\n`,
    );
    return 1;
  }
  if (matches.length > 1) {
    process.stderr.write(
      `sivru session show: ambiguous prefix \`${args.prefix}\` matches ${matches.length} sessions; please use a longer prefix\n`,
    );
    return 1;
  }

  const session = matches[0]!;
  const limit = args.limit;

  let count = 0;
  try {
    for await (const ev of readSession(session.path)) {
      if (limit !== undefined && count >= limit) break;
      if (args.json) {
        process.stdout.write(JSON.stringify(ev) + "\n");
      } else {
        process.stdout.write(formatEventLine(ev) + "\n");
      }
      count++;
    }
  } catch (err) {
    process.stderr.write(
      `sivru session show: ${(err as Error).message ?? String(err)}\n`,
    );
    return 1;
  }

  return 0;
}

export async function runSession(argv: readonly string[]): Promise<number> {
  // argv is the FULL `process.argv.slice(2)` — argv[0] === "session".
  const sub = argv[1];
  if (sub === "list") {
    const parsed = parseListArgs(argv);
    if (parsed.kind === "error") {
      process.stderr.write(`sivru session: ${parsed.message}\n`);
      return parsed.exitCode;
    }
    if (parsed.kind !== "list") {
      // Unreachable — parseListArgs only returns "list" or "error".
      process.stderr.write("sivru session: internal parse error\n");
      return 1;
    }
    return runList(parsed);
  }
  if (sub === "show") {
    const parsed = parseShowArgs(argv);
    if (parsed.kind === "error") {
      process.stderr.write(`sivru session: ${parsed.message}\n`);
      return parsed.exitCode;
    }
    if (parsed.kind !== "show") {
      process.stderr.write("sivru session: internal parse error\n");
      return 1;
    }
    return runShow(parsed);
  }

  const label = sub === undefined ? "(missing)" : sub;
  process.stderr.write(
    `sivru session: unknown session subcommand: ${label}\n`,
  );
  return 2;
}
