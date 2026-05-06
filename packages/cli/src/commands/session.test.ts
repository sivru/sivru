import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSession } from "./session.js";

let root: string;
let projectsRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sivru-cli-session-"));
  projectsRoot = join(root, "projects");
  await mkdir(projectsRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Captured = { stdout: string; stderr: string; restore: () => void };

function captureIO(): Captured {
  const captured: Captured = {
    stdout: "",
    stderr: "",
    restore: () => {},
  };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: unknown): boolean => {
    captured.stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: unknown): boolean => {
    captured.stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  captured.restore = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = origOut;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = origErr;
  };
  return captured;
}

// Write a single Claude Code-style jsonl session under
// `<projectsRoot>/<encodedProject>/<sessionId>.jsonl`. Returns the session id.
async function writeFixtureSession(opts: {
  encodedProject: string;
  sessionId: string;
  events?: ReadonlyArray<Record<string, unknown>>;
}): Promise<string> {
  const dir = join(projectsRoot, opts.encodedProject);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${opts.sessionId}.jsonl`);
  const events = opts.events ?? [
    {
      type: "user",
      sessionId: opts.sessionId,
      timestamp: "2026-04-25T17:50:00.000Z",
      message: { role: "user", content: "hello world" },
    },
    {
      type: "assistant",
      sessionId: opts.sessionId,
      timestamp: "2026-04-25T17:51:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_01",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    },
  ];
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(file, lines);
  return opts.sessionId;
}

describe("runSession", () => {
  it("list --json returns one session with events > 0 and a non-null updatedAt", async () => {
    const id = "6d3a083c-1111-4222-8333-444455556666";
    await writeFixtureSession({
      encodedProject: "-Users-test-myproject",
      sessionId: id,
    });

    const cap = captureIO();
    let code: number;
    try {
      code = await runSession([
        "session",
        "list",
        "--json",
        "--projects-root",
        projectsRoot,
      ]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stderr).toBe("");

    const trimmed = cap.stdout.trim();
    expect(trimmed.includes("\n")).toBe(false);
    const parsed = JSON.parse(trimmed) as {
      sessions: Array<{
        id: string;
        path: string;
        project: string;
        startedAt: string | null;
        updatedAt: string | null;
        eventCount: number;
      }>;
    };
    expect(parsed.sessions.length).toBe(1);
    const s = parsed.sessions[0]!;
    expect(s.id).toBe(id);
    expect(s.eventCount).toBeGreaterThan(0);
    expect(s.updatedAt).not.toBeNull();
  });

  it("list (text mode) prints a header + at least one data row", async () => {
    const id = "7e4b194d-2222-4222-8333-444455556666";
    await writeFixtureSession({
      encodedProject: "-Users-test-myproject",
      sessionId: id,
    });

    const cap = captureIO();
    let code: number;
    try {
      code = await runSession([
        "session",
        "list",
        "--projects-root",
        projectsRoot,
      ]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stderr).toBe("");

    const lines = cap.stdout.trimEnd().split("\n");
    // Header + at least one data row.
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const header = lines[0]!;
    expect(header).toContain("events");
    expect(header).toContain("project");
    // The data row contains the short id (first 8 chars).
    const dataLine = lines.slice(1).find((l) => l.includes(id.slice(0, 8)));
    expect(dataLine).toBeDefined();
  });

  it("show --json emits one JSON object per line including a user_message", async () => {
    const id = "8f5c2a5e-3333-4222-8333-444455556666";
    await writeFixtureSession({
      encodedProject: "-Users-test-myproject",
      sessionId: id,
    });

    const cap = captureIO();
    let code: number;
    try {
      code = await runSession([
        "session",
        "show",
        id.slice(0, 8),
        "--projects-root",
        projectsRoot,
        "--json",
      ]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stderr).toBe("");

    const lines = cap.stdout.trimEnd().split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = lines.map((l) => JSON.parse(l) as { kind: string });
    const hasUser = parsed.some((e) => e.kind === "user_message");
    expect(hasUser).toBe(true);
  });

  it("show with a non-matching prefix exits 1 with 'no session matching prefix'", async () => {
    const id = "abc12345-4444-4222-8333-444455556666";
    await writeFixtureSession({
      encodedProject: "-Users-test-myproject",
      sessionId: id,
    });

    const cap = captureIO();
    let code: number;
    try {
      code = await runSession([
        "session",
        "show",
        "ffff9999",
        "--projects-root",
        projectsRoot,
      ]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    expect(cap.stderr).toMatch(/no session matching prefix/);
  });

  it("show with an ambiguous prefix exits 1 with 'ambiguous'", async () => {
    // Two UUIDs sharing the first 4 chars.
    const idA = "dead0001-0001-4222-8333-444455556666";
    const idB = "dead0002-0002-4222-8333-444455556666";
    await writeFixtureSession({
      encodedProject: "-Users-test-projA",
      sessionId: idA,
    });
    await writeFixtureSession({
      encodedProject: "-Users-test-projB",
      sessionId: idB,
    });

    const cap = captureIO();
    let code: number;
    try {
      code = await runSession([
        "session",
        "show",
        "dead",
        "--projects-root",
        projectsRoot,
      ]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    expect(cap.stderr).toMatch(/ambiguous/);
  });

  it("list --json on a missing projects root returns 0 with empty sessions", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runSession([
        "session",
        "list",
        "--projects-root",
        "/no/such/dir/sivru-test",
        "--json",
      ]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout.trim()) as { sessions: unknown[] };
    expect(parsed.sessions).toEqual([]);
  });

  it("rejects an unknown subcommand with exit 2", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runSession(["session", "frobnicate"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/unknown session subcommand/);
  });
});
