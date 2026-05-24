// Tests for the shared execFile wrapper.

import { describe, expect, it } from "vitest";

import { runCmd } from "./exec.js";

describe("runCmd", () => {
  it("returns ok with stdout for a successful command", async () => {
    // `echo` is universal and instant — chosen over `node -e` so we
    // don't race the 4s default timeout under parallel test load.
    const r = await runCmd("echo", ["hello"], { timeoutMs: 30_000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stdout.trim()).toBe("hello");
  });

  it("returns missing when the binary doesn't exist", async () => {
    const r = await runCmd("definitely-not-a-real-binary-xyz", ["--version"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing");
  });

  it("returns non-zero on non-zero exit", async () => {
    // `false` exits 1 with no I/O — chosen over `node -e` to avoid
    // spawn latency under parallel test load (a slow `node` startup
    // can race the 4s default timeout).
    const r = await runCmd("false", [], { timeoutMs: 30_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("non-zero");
  });

  it("returns timeout when the timeout fires", async () => {
    // `sleep 5` is fast to spawn and exits cleanly when killed.
    const r = await runCmd("sleep", ["5"], { timeoutMs: 200 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("timeout");
  });
});
