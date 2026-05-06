// Tests for the Claude Code session.jsonl reader.
//
// Strategy: build a small fixture tree inside an OS tmp dir that mirrors the
// real `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` layout, point
// `listSessions` / `readSession` at it, and assert the normalization matches
// the spec in DESIGN.md §5.3.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SivruEvent } from "../../types.js";
import { createJsonlSource, listSessions, readSession } from "./index.js";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const ENCODED_PROJECT = "-Users-test-projects-foo";
const DECODED_PROJECT = "Users/test/projects/foo";

// Hand-written jsonl content covering the fan-out and edge cases.
// Lines correspond to:
//   1. permission-mode (system)
//   2. user message, plain string content
//   3. user message, array content with text + tool_use (fan-out)
//   4. assistant message, array content with text + tool_use (fan-out)
//   5. user message, array content with a single tool_result block
//   6. corrupted line (not valid JSON)
//   7. file-history-snapshot (system)
const FIXTURE_LINES: string[] = [
  JSON.stringify({
    type: "permission-mode",
    permissionMode: "bypassPermissions",
    sessionId: SESSION_ID,
  }),
  JSON.stringify({
    type: "user",
    sessionId: SESSION_ID,
    timestamp: "2026-04-25T17:52:59.000Z",
    message: { role: "user", content: "hello world" },
  }),
  JSON.stringify({
    type: "user",
    sessionId: SESSION_ID,
    timestamp: "2026-04-25T17:53:00.000Z",
    message: {
      role: "user",
      content: [
        { type: "text", text: "please run " },
        { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant",
    sessionId: SESSION_ID,
    timestamp: "2026-04-25T17:53:01.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "running it now" },
        { type: "tool_use", id: "tu_2", name: "Read", input: { path: "/etc/hosts" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    sessionId: SESSION_ID,
    timestamp: "2026-04-25T17:53:02.000Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_2",
          content: "127.0.0.1 localhost",
          is_error: false,
        },
      ],
    },
  }),
  "{this is not valid json",
  JSON.stringify({
    type: "file-history-snapshot",
    messageId: "msg-1",
    timestamp: "2026-04-25T17:53:03.000Z",
    snapshot: { trackedFileBackups: {}, timestamp: "2026-04-25T17:53:03.000Z" },
    isSnapshotUpdate: false,
  }),
];

let tmpRoot: string;

async function writeFixture(
  encodedDir: string,
  sessionId: string,
  lines: string[],
): Promise<string> {
  const projectDir = join(tmpRoot, encodedDir);
  await mkdir(projectDir, { recursive: true });
  const filePath = join(projectDir, `${sessionId}.jsonl`);
  await writeFile(filePath, lines.join("\n"), "utf8");
  return filePath;
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "sivru-observe-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("listSessions", () => {
  it("returns one Session per .jsonl with correct metadata", async () => {
    const filePath = await writeFixture(ENCODED_PROJECT, SESSION_ID, FIXTURE_LINES);

    const sessions = await listSessions({ projectsRoot: tmpRoot });

    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.id).toBe(SESSION_ID);
    expect(s.path).toBe(filePath);
    expect(s.project).toBe(DECODED_PROJECT);
    // 7 source lines, even though normalization fans some of them out.
    // listSessions counts source lines (cheap), not normalized events.
    expect(s.eventCount).toBe(FIXTURE_LINES.length);
    expect(s.startedAt).toBe("2026-04-25T17:52:59.000Z");
    expect(s.updatedAt).toBe("2026-04-25T17:53:03.000Z");
  });

  it("returns [] for a missing projects root (no throw)", async () => {
    const sessions = await listSessions({
      projectsRoot: join(tmpRoot, "does-not-exist"),
    });
    expect(sessions).toEqual([]);
  });

  it("returns [] for an empty projects root", async () => {
    const sessions = await listSessions({ projectsRoot: tmpRoot });
    expect(sessions).toEqual([]);
  });

  // The encoded directory name is lossy — `~/.claude/worktrees/foo` encodes
  // to `-Users-x--claude-worktrees-foo` and decodes back ambiguously (the
  // `.` is gone). The jsonl events themselves carry the real cwd, so we
  // prefer that when it's present.
  it("uses the recorded cwd from event payloads as `project`", async () => {
    const lossyDir = "-Users-x--claude-worktrees-feature";
    const projectPath = join(tmpRoot, lossyDir);
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      join(projectPath, `${SESSION_ID}.jsonl`),
      [
        JSON.stringify({
          type: "user",
          sessionId: SESSION_ID,
          timestamp: "2026-05-04T12:00:00.000Z",
          cwd: "/Users/x/.claude/worktrees/feature",
          gitBranch: "feature-x",
          message: { role: "user", content: "hi" },
        }),
      ].join("\n"),
    );

    const sessions = await listSessions({ projectsRoot: tmpRoot });
    expect(sessions).toHaveLength(1);
    // The lossy decode would return "Users/x//claude/worktrees/feature";
    // the recorded cwd is the actual filesystem path.
    expect(sessions[0]?.project).toBe("/Users/x/.claude/worktrees/feature");
    expect(sessions[0]?.branch).toBe("feature-x");
  });

  // Falls back to the decoded directory name when the jsonl never recorded
  // a cwd. Worst-case path; the lossy decode is only used when we have
  // nothing better.
  it("falls back to decoded dir name when no event carries cwd", async () => {
    const projectPath = join(tmpRoot, ENCODED_PROJECT);
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      join(projectPath, `${SESSION_ID}.jsonl`),
      [
        JSON.stringify({
          type: "user",
          sessionId: SESSION_ID,
          timestamp: "2026-05-04T12:00:00.000Z",
          // no cwd, no gitBranch — older Claude Code or partial recording
          message: { role: "user", content: "hi" },
        }),
      ].join("\n"),
    );

    const sessions = await listSessions({ projectsRoot: tmpRoot });
    expect(sessions[0]?.project).toBe(DECODED_PROJECT);
    expect(sessions[0]?.branch).toBeNull();
  });

  it("lists sessions across multiple project subdirs and sorts by updatedAt desc", async () => {
    const olderId = "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa";
    const newerId = "bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb";

    await writeFixture("-tmp-old", olderId, [
      JSON.stringify({
        type: "user",
        sessionId: olderId,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "old" },
      }),
    ]);
    await writeFixture("-tmp-new", newerId, [
      JSON.stringify({
        type: "user",
        sessionId: newerId,
        timestamp: "2026-12-31T23:59:59.000Z",
        message: { role: "user", content: "new" },
      }),
    ]);

    const sessions = await listSessions({ projectsRoot: tmpRoot });

    expect(sessions.map((s) => s.id)).toEqual([newerId, olderId]);
    expect(sessions[0]!.project).toBe("tmp/new");
    expect(sessions[1]!.project).toBe("tmp/old");
  });
});

describe("readSession", () => {
  it("emits the expected normalized event sequence", async () => {
    const filePath = await writeFixture(ENCODED_PROJECT, SESSION_ID, FIXTURE_LINES);

    const events: SivruEvent[] = [];
    for await (const e of readSession(filePath)) {
      events.push(e);
    }

    // Expected fan-out:
    //  index 0: permission-mode -> system
    //  index 1: user "hello world" -> user_message
    //  index 2: user array text+tool_use -> user_message ("please run ")
    //  index 3:                          -> tool_use (Bash)
    //  index 4: assistant array          -> assistant_message ("running it now")
    //  index 5:                          -> tool_use (Read)
    //  index 6: user tool_result         -> tool_result
    //  index 7: corrupted line           -> unknown
    //  index 8: file-history-snapshot    -> system
    expect(events.map((e) => e.kind)).toEqual([
      "system",
      "user_message",
      "user_message",
      "tool_use",
      "assistant_message",
      "tool_use",
      "tool_result",
      "unknown",
      "system",
    ]);

    expect(events.map((e) => e.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);

    // Indices are monotonic and 0-based.
    for (let i = 0; i < events.length; i += 1) {
      expect(events[i]!.index).toBe(i);
    }

    // Plain-string user message.
    expect(events[1]!.text).toBe("hello world");
    expect(events[1]!.ts).toBe("2026-04-25T17:52:59.000Z");

    // User message text from array fan-out — tool_use blocks contribute a
    // placeholder token so the joined narrative reads coherently.
    expect(events[2]!.text).toBe("please run [tool_use:Bash]");

    // tool_use details.
    expect(events[3]!.tool).toBe("Bash");
    expect(events[3]!.input).toEqual({ command: "ls" });

    // Assistant text + tool_use.
    expect(events[4]!.text).toBe("running it now[tool_use:Read]");
    expect(events[5]!.tool).toBe("Read");
    expect(events[5]!.input).toEqual({ path: "/etc/hosts" });

    // tool_result.
    expect(events[6]!.output).toBe("127.0.0.1 localhost");
    expect(events[6]!.isError).toBe(false);

    // Corrupted line surfaces as `unknown` with the raw string preserved.
    expect(events[7]!.kind).toBe("unknown");
    expect(events[7]!.raw).toBe("{this is not valid json");

    // System event for the snapshot.
    expect(events[8]!.kind).toBe("system");

    // sessionId is propagated from the source line where present, and falls
    // back to the filename for the corrupted line.
    expect(events[7]!.sessionId).toBe(SESSION_ID);
    for (const e of events) {
      expect(e.sessionId).toBe(SESSION_ID);
    }
  });

  it("uses placeholder text for inline tool_use blocks alongside text", async () => {
    // Sanity check on the joined-text rule: a `tool_use` block embedded inline
    // among text blocks contributes a `[tool_use:<name>]` token to the joined
    // text in addition to a separate tool_use event.
    const sessionId = "cccccccc-3333-3333-3333-cccccccccccc";
    const filePath = await writeFixture("-tmp-x", sessionId, [
      JSON.stringify({
        type: "assistant",
        sessionId,
        timestamp: "2026-04-25T17:53:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "before " },
            { type: "tool_use", id: "tu_x", name: "Grep", input: { q: "x" } },
            { type: "text", text: " after" },
          ],
        },
      }),
    ]);

    const events: SivruEvent[] = [];
    for await (const e of readSession(filePath)) {
      events.push(e);
    }

    expect(events.map((e) => e.kind)).toEqual(["assistant_message", "tool_use"]);
    expect(events[0]!.text).toBe("before [tool_use:Grep] after");
    expect(events[1]!.tool).toBe("Grep");
  });
});

describe("createJsonlSource", () => {
  it("returns a SessionSource bound to the given options", async () => {
    await writeFixture(ENCODED_PROJECT, SESSION_ID, FIXTURE_LINES);
    const source = createJsonlSource({ projectsRoot: tmpRoot });

    const sessions = await source.listSessions();
    expect(sessions).toHaveLength(1);

    const events: SivruEvent[] = [];
    for await (const e of source.readSession(sessions[0]!.path)) {
      events.push(e);
    }
    expect(events.length).toBeGreaterThan(0);
  });
});
