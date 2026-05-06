// Sivru observe — Claude Code session.jsonl reader.
// See DESIGN.md §5.2 (sources) and §5.3 (event model).
//
// PRIVACY (DESIGN.md §5.5): filesystem-only. No network imports.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { SessionSource } from "../adapter.js";
import type { Session, SivruEvent, SivruEventKind } from "../../types.js";
import { resolveGitInfo } from "./git-info.js";
import { inferProjectRootFromPrefix } from "./infer-root.js";

export type JsonlSourceOptions = {
  /** Default: `~/.claude/projects/`. */
  projectsRoot?: string;
};

const DEFAULT_PROJECTS_ROOT = join(homedir(), ".claude", "projects");

// ---------------------------------------------------------------------------
// helpers

/**
 * Decode the encoded cwd directory name back to a display path.
 * Claude Code encodes by replacing `/` with `-` and prefixing with `-`.
 * Best-effort: a project path that contains a literal `-` cannot be perfectly
 * round-tripped, so we treat this as display-only.
 */
function decodeProjectDir(name: string): string {
  const replaced = name.replace(/-/g, "/");
  return replaced.startsWith("/") ? replaced.slice(1) : replaced;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Render a single content block down to plain text. `tool_use` blocks get a
 * placeholder token so the surrounding text stays coherent — the actual
 * tool_use is emitted as its own event.
 */
function blockToText(block: unknown): string {
  if (typeof block === "string") return block;
  if (!isObject(block)) return "";
  const t = block["type"];
  if (t === "text") {
    const txt = block["text"];
    return typeof txt === "string" ? txt : "";
  }
  if (t === "tool_use") {
    const name = asString(block["name"]) ?? "unknown";
    return `[tool_use:${name}]`;
  }
  if (t === "tool_result") {
    // tool_result blocks always emit their own structured event; they don't
    // contribute to the narrative text of the wrapping message.
    return "";
  }
  if (t === "thinking") {
    // Thinking blocks are not user-visible content; suppress entirely.
    return "";
  }
  return "";
}

function joinBlocksAsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const piece = blockToText(block);
    if (piece.length > 0) parts.push(piece);
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// normalization: raw jsonl object -> 0+ SivruEvent (without index assigned)

type PartialEvent = Omit<SivruEvent, "index">;

function makeUnknown(sessionId: string, raw: unknown, ts?: string): PartialEvent {
  const base: PartialEvent = { kind: "unknown", sessionId, raw };
  if (ts !== undefined) base.ts = ts;
  return base;
}

/**
 * Convert a parsed jsonl object into one or more SivruEvents (sans index).
 * Returns an empty array only if input is unrecognizable structure (we still
 * emit an `unknown` event from the caller in that case).
 */
function normalizeRecord(record: unknown, fallbackSessionId: string): PartialEvent[] {
  if (!isObject(record)) {
    return [makeUnknown(fallbackSessionId, record)];
  }

  const ts = asString(record["timestamp"]);
  const sessionId = asString(record["sessionId"]) ?? fallbackSessionId;
  const type = asString(record["type"]);

  if (type === "user" || type === "assistant") {
    return normalizeMessage(record, sessionId, ts, type);
  }

  // Any other top-level type (permission-mode, file-history-snapshot, summary,
  // etc.) is normalized as a system event. We keep raw so callers can inspect.
  if (typeof type === "string") {
    const evt: PartialEvent = { kind: "system", sessionId, raw: record };
    if (ts !== undefined) evt.ts = ts;
    return [evt];
  }

  // No `type` at all — treat as unknown but keep raw.
  return [makeUnknown(sessionId, record, ts)];
}

function normalizeMessage(
  record: Record<string, unknown>,
  sessionId: string,
  ts: string | undefined,
  topType: "user" | "assistant",
): PartialEvent[] {
  const message = record["message"];
  if (!isObject(message)) {
    return [makeUnknown(sessionId, record, ts)];
  }
  const content = message["content"];

  // String content: simple message.
  if (typeof content === "string") {
    return [buildMessageEvent(topType, sessionId, ts, content, record)];
  }

  if (!Array.isArray(content)) {
    return [makeUnknown(sessionId, record, ts)];
  }

  const events: PartialEvent[] = [];

  // 1. Joined text from all blocks. Non-text blocks (tool_use, tool_result)
  // contribute placeholder tokens (e.g. `[tool_use:Bash]`) so the surrounding
  // narrative reads coherently; the actual structured events are emitted in
  // step 2 below.
  const joinedText = joinBlocksAsText(content);
  if (joinedText.length > 0) {
    events.push(buildMessageEvent(topType, sessionId, ts, joinedText, record));
  }

  // 2. Per-block events for tool_use / tool_result.
  for (const block of content) {
    if (!isObject(block)) continue;
    const bt = block["type"];
    if (bt === "tool_use") {
      const evt: PartialEvent = {
        kind: "tool_use",
        sessionId,
        raw: block,
      };
      if (ts !== undefined) evt.ts = ts;
      const name = asString(block["name"]);
      if (name !== undefined) evt.tool = name;
      if ("input" in block) evt.input = block["input"];
      events.push(evt);
    } else if (bt === "tool_result") {
      const evt: PartialEvent = {
        kind: "tool_result",
        sessionId,
        raw: block,
      };
      if (ts !== undefined) evt.ts = ts;
      // Tool name isn't on the tool_result block itself; leave unset.
      if ("content" in block) evt.output = block["content"];
      const isErr = block["is_error"];
      if (typeof isErr === "boolean") evt.isError = isErr;
      events.push(evt);
    }
  }

  if (events.length === 0) {
    // Array content existed but produced nothing useful (e.g. only thinking
    // blocks with empty text). Emit a single empty message event so the line
    // is still represented.
    events.push(buildMessageEvent(topType, sessionId, ts, "", record));
  }

  return events;
}

function buildMessageEvent(
  topType: "user" | "assistant",
  sessionId: string,
  ts: string | undefined,
  text: string,
  raw: unknown,
): PartialEvent {
  const kind: SivruEventKind =
    topType === "user" ? "user_message" : "assistant_message";
  const evt: PartialEvent = { kind, sessionId, raw };
  if (ts !== undefined) evt.ts = ts;
  evt.text = text;
  return evt;
}

// ---------------------------------------------------------------------------
// public api

/** Walk every `<projectsRoot>/<encoded-cwd>/<sessionId>.jsonl` and return Session metadata. */
export async function listSessions(options?: JsonlSourceOptions): Promise<Session[]> {
  const root = options?.projectsRoot ?? DEFAULT_PROJECTS_ROOT;

  let projectDirs: string[];
  try {
    projectDirs = await readdir(root);
  } catch (err) {
    // Missing root → no sessions. Anything else → also no sessions (display
    // tools should still come up; we don't want to crash the daemon if the
    // user's ~/.claude is borked).
    if (isNoEntError(err)) return [];
    return [];
  }

  const sessions: Session[] = [];

  for (const dirName of projectDirs) {
    const projectPath = join(root, dirName);
    let s;
    try {
      s = await stat(projectPath);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;

    let entries: string[];
    try {
      entries = await readdir(projectPath);
    } catch {
      continue;
    }

    // The encoded directory name (`-Users-pochadri--claude-worktrees-...`)
    // decodes lossily — every `.` and `/` becomes `-` — so we treat it as
    // a fallback only. The real cwd lives on each event in the jsonl.
    const decodedDirName = decodeProjectDir(dirName);

    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const filePath = join(projectPath, entry);
      const id = entry.slice(0, -".jsonl".length);
      const meta = await summarizeSession(filePath);

      // Authoritative cwd from the jsonl events; fall back to the decoded
      // dir name when no event carried `cwd` (e.g. minimal sessions).
      const project = meta.recordedCwd ?? decodedDirName;

      // Resolve the canonical git project root from the REAL cwd. Cache
      // (in git-info.ts) collapses repeat lookups for the same path.
      const gitInfo = await resolveGitInfo(project);
      const projectRoot = gitInfo?.projectRoot ?? project;
      const isWorktree = gitInfo?.isWorktree ?? false;
      // Prefer the recorded branch (cheap, matches what Claude saw at the
      // time) and fall back to a live `git branch --show-current` only
      // when the jsonl didn't capture one.
      const branch = meta.recordedBranch ?? gitInfo?.branch ?? null;

      sessions.push({
        id,
        path: filePath,
        project,
        projectRoot,
        isWorktree,
        branch,
        projectRootSource: gitInfo !== null ? "git" : "fallback-cwd",
        startedAt: meta.startedAt,
        updatedAt: meta.updatedAt,
        eventCount: meta.eventCount,
      });
    }
  }

  // Second pass: for sessions whose cwd is gone (`fallback-cwd`), try to
  // infer their project root from a path-prefix match against the set of
  // git-verified roots gathered in the first pass. This lets deleted
  // worktrees collapse under their parent repo when the naming makes
  // it obvious. The boundary check inside inferProjectRootFromPrefix
  // prevents false positives like grouping `buildwright` with the
  // unrelated `buildwrightV2`.
  const verifiedRoots = new Set<string>();
  for (const s of sessions) {
    if (s.projectRootSource === "git") verifiedRoots.add(s.projectRoot);
  }
  if (verifiedRoots.size > 0) {
    for (const s of sessions) {
      if (s.projectRootSource !== "fallback-cwd") continue;
      const inferred = inferProjectRootFromPrefix(s.project, verifiedRoots);
      if (inferred !== null) {
        s.projectRoot = inferred;
        s.projectRootSource = "inferred-prefix";
        // We don't have git proof, but the naming pattern strongly suggests
        // the cwd was a worktree of the main repo. Mark as such so the UI
        // can show the ⎇ marker.
        s.isWorktree = true;
      }
    }
  }

  // Sort: most-recently-updated first. Sessions with no timestamp sink last.
  sessions.sort((a, b) => {
    const at = a.updatedAt ?? "";
    const bt = b.updatedAt ?? "";
    if (at === bt) return 0;
    return at < bt ? 1 : -1;
  });

  return sessions;
}

/**
 * Parse a single jsonl line into one or more SivruEvents, assigning indices
 * starting at `startIndex`. Returns the produced events and the next index
 * the caller should pass in for the following line. Mirrors the per-line
 * branching of `readSession` so live-tail (W6 SSE) can reuse it without
 * re-implementing the empty-line / parse-error / multi-event-per-record
 * fan-out.
 */
export function parseJsonlLine(
  line: string,
  fallbackSessionId: string,
  startIndex: number,
): { events: SivruEvent[]; nextIndex: number } {
  const events: SivruEvent[] = [];
  let index = startIndex;

  if (line.length === 0) {
    events.push({ kind: "unknown", sessionId: fallbackSessionId, index, raw: "" });
    return { events, nextIndex: index + 1 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    events.push({ kind: "unknown", sessionId: fallbackSessionId, index, raw: line });
    return { events, nextIndex: index + 1 };
  }

  const partials = normalizeRecord(parsed, fallbackSessionId);
  for (const e of partials) {
    events.push({ ...e, index });
    index += 1;
  }
  return { events, nextIndex: index };
}

/** Stream parsed/normalized events for the given session jsonl path. */
export async function* readSession(sessionPath: string): AsyncGenerator<SivruEvent> {
  // Derive a fallback sessionId from the filename so events from malformed
  // lines (no `sessionId` field) still carry an identifier.
  const fallbackSessionId = deriveSessionIdFromPath(sessionPath);

  let index = 0;
  for await (const line of streamLines(sessionPath)) {
    const { events, nextIndex } = parseJsonlLine(line, fallbackSessionId, index);
    for (const e of events) yield e;
    index = nextIndex;
  }
}

/**
 * Derive a fallback session id from a jsonl path. Re-exported for the live-
 * tail SSE path so it can reuse the same convention (filename minus extension).
 */
export function sessionIdFromPath(p: string): string {
  return deriveSessionIdFromPath(p);
}

/** Bundle into a `SessionSource` so callers can pass one object around. */
export function createJsonlSource(options?: JsonlSourceOptions): SessionSource {
  return {
    listSessions: () => listSessions(options),
    readSession: (sessionPath: string) => readSession(sessionPath),
  };
}

// ---------------------------------------------------------------------------
// internals

type SessionMetaSummary = {
  startedAt: string | null;
  updatedAt: string | null;
  eventCount: number;
  /**
   * Real cwd Claude Code recorded on its events. Authoritative — far more
   * reliable than decoding the encoded directory name (which is lossy for
   * paths containing `.` or `-`). null only for sessions whose events
   * never carried a `cwd` field.
   */
  recordedCwd: string | null;
  /** Branch from the same event source. null for non-git sessions. */
  recordedBranch: string | null;
};

async function summarizeSession(filePath: string): Promise<SessionMetaSummary> {
  let startedAt: string | null = null;
  let updatedAt: string | null = null;
  let eventCount = 0;
  let recordedCwd: string | null = null;
  let recordedBranch: string | null = null;

  try {
    for await (const line of streamLines(filePath)) {
      if (line.length === 0) {
        eventCount += 1;
        continue;
      }
      eventCount += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObject(parsed)) continue;
      const ts = asString(parsed["timestamp"]);
      if (ts !== undefined) {
        if (startedAt === null) startedAt = ts;
        updatedAt = ts;
      }
      // Each Claude Code message event carries `cwd` + `gitBranch`. Take the
      // first occurrence — sessions don't typically change cwd mid-flight,
      // and even if they did the first reading is what defined the project.
      if (recordedCwd === null) {
        const cwd = asString(parsed["cwd"]);
        if (cwd !== undefined && cwd.length > 0) recordedCwd = cwd;
      }
      if (recordedBranch === null) {
        const br = asString(parsed["gitBranch"]);
        if (br !== undefined && br.length > 0) recordedBranch = br;
      }
    }
  } catch (err) {
    if (isNoEntError(err))
      return {
        startedAt: null,
        updatedAt: null,
        eventCount: 0,
        recordedCwd: null,
        recordedBranch: null,
      };
    // Other read errors: best-effort, return what we have.
  }

  return { startedAt, updatedAt, eventCount, recordedCwd, recordedBranch };
}

async function* streamLines(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      yield line;
    }
  } finally {
    rl.close();
    stream.close();
  }
}

function deriveSessionIdFromPath(p: string): string {
  // Find the last separator regardless of platform — Windows uses `\\`, POSIX uses `/`.
  const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

function isNoEntError(err: unknown): boolean {
  return (
    isObject(err) &&
    typeof (err as { code?: unknown }).code === "string" &&
    (err as { code: string }).code === "ENOENT"
  );
}
