import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgressReporter, formatDuration } from "./progress.js";

type Captured = {
  out: { write: (s: string) => true; isTTY: boolean };
  text: () => string;
};

function makeStream(isTTY: boolean): Captured {
  const buf: string[] = [];
  return {
    out: {
      write: (s: string) => {
        buf.push(s);
        return true;
      },
      isTTY,
    },
    text: () => buf.join(""),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-04T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createProgressReporter — append mode", () => {
  it("emits one line per event in non-TTY mode", () => {
    const cap = makeStream(false);
    const r = createProgressReporter({ out: cap.out, embedThrottleMs: 0 });
    r.onEvent({ phase: "walked", totalChunks: 5 });
    r.onEvent({ phase: "chunked", totalChunks: 100 });
    r.onEvent({ phase: "embed_progress", totalChunks: 100, embedded: 50 });
    r.onEvent({ phase: "embed_done", totalChunks: 100, embedded: 100 });
    r.finish();
    const lines = cap.text().split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/walked 5 files/);
    expect(lines[1]).toMatch(/chunked 100 chunks; embedding…/);
    expect(lines[2]).toMatch(/embedded 50\/100 \(50%/);
    expect(lines[3]).toMatch(/embedded 100 chunks/);
  });

  it("includes ETA + rate in embed_progress", () => {
    const cap = makeStream(false);
    const r = createProgressReporter({ out: cap.out, embedThrottleMs: 0 });
    r.onEvent({ phase: "chunked", totalChunks: 1000 });
    vi.advanceTimersByTime(2000);
    r.onEvent({ phase: "embed_progress", totalChunks: 1000, embedded: 200 });
    expect(cap.text()).toMatch(/200\/1000 \(20%, 100\/sec\)/);
    expect(cap.text()).toMatch(/ETA ~8s/);
  });

  it("prefixes label when supplied", () => {
    const cap = makeStream(false);
    const r = createProgressReporter({
      label: "all-MiniLM-L6-v2",
      out: cap.out,
    });
    r.onEvent({ phase: "walked", totalChunks: 7 });
    expect(cap.text()).toMatch(/all-MiniLM-L6-v2: walked 7 files/);
  });

  it("emits cached-rehydrate line when embed_done.fromCache", () => {
    const cap = makeStream(false);
    const r = createProgressReporter({ out: cap.out });
    r.onEvent({
      phase: "embed_done",
      totalChunks: 42,
      embedded: 42,
      fromCache: true,
    });
    expect(cap.text()).toMatch(/rehydrated from cache \(42 chunks\)/);
  });

  it("emits cached-load line on `cached` phase", () => {
    const cap = makeStream(false);
    const r = createProgressReporter({ out: cap.out });
    r.onEvent({ phase: "cached", totalChunks: 99, fromCache: true });
    expect(cap.text()).toMatch(/loaded 99 chunks from cache/);
  });
});

describe("createProgressReporter — heartbeat", () => {
  it("fires when no embed_progress event arrives within heartbeatMs", () => {
    const cap = makeStream(false);
    const r = createProgressReporter({
      label: "minilm",
      coldStartMin: 12,
      out: cap.out,
      heartbeatMs: 1000,
    });
    r.onEvent({ phase: "chunked", totalChunks: 1000 });
    expect(cap.text()).toMatch(/chunked 1000 chunks/);
    vi.advanceTimersByTime(1000);
    expect(cap.text()).toMatch(/still preparing model/);
    expect(cap.text()).toMatch(/~12 min for download \+ warm-up/);
  });

  it("stops firing once embed_progress arrives", () => {
    const cap = makeStream(false);
    const r = createProgressReporter({
      out: cap.out,
      heartbeatMs: 1000,
      embedThrottleMs: 0,
    });
    r.onEvent({ phase: "chunked", totalChunks: 1000 });
    vi.advanceTimersByTime(1000);
    r.onEvent({ phase: "embed_progress", totalChunks: 1000, embedded: 100 });
    const before = cap.text();
    vi.advanceTimersByTime(5000); // would fire heartbeat 5x if still running
    expect(cap.text()).toBe(before);
    r.finish();
  });

  it("stops firing on finish()", () => {
    const cap = makeStream(false);
    const r = createProgressReporter({
      out: cap.out,
      heartbeatMs: 1000,
    });
    r.onEvent({ phase: "chunked", totalChunks: 1000 });
    r.finish();
    const before = cap.text();
    vi.advanceTimersByTime(5000);
    expect(cap.text()).toBe(before);
  });
});

describe("createProgressReporter — silent mode", () => {
  it("emits nothing when silent: true", () => {
    const cap = makeStream(false);
    const r = createProgressReporter({ out: cap.out, silent: true });
    r.onEvent({ phase: "walked", totalChunks: 1 });
    r.onEvent({ phase: "chunked", totalChunks: 1 });
    r.onEvent({ phase: "embed_progress", totalChunks: 1, embedded: 1 });
    vi.advanceTimersByTime(60_000);
    r.finish();
    expect(cap.text()).toBe("");
  });
});

describe("createProgressReporter — TTY in-place mode", () => {
  it("uses CR + clear-EOL escape and commits on phase change", () => {
    const cap = makeStream(true);
    const r = createProgressReporter({ out: cap.out, embedThrottleMs: 0 });
    r.onEvent({ phase: "walked", totalChunks: 5 });
    r.onEvent({ phase: "chunked", totalChunks: 100 });
    r.onEvent({ phase: "embed_progress", totalChunks: 100, embedded: 50 });
    r.finish();
    const text = cap.text();
    // Each line begins with "\r" (in-place) and ends with "\x1b[K".
    expect(text).toMatch(/\r .*walked 5 files\x1b\[K/);
    expect(text).toMatch(/\r .*chunked 100 chunks/);
    // Phase transitions commit with a newline so scrollback retains
    // the previous line.
    const newlines = text.split("\n").length - 1;
    expect(newlines).toBeGreaterThanOrEqual(2);
  });
});

describe("createProgressReporter — throttling", () => {
  it("skips embed_progress events within throttle window", () => {
    const cap = makeStream(false);
    const r = createProgressReporter({ out: cap.out, embedThrottleMs: 250 });
    r.onEvent({ phase: "chunked", totalChunks: 1000 });
    r.onEvent({ phase: "embed_progress", totalChunks: 1000, embedded: 128 });
    // Without advancing time, the next embed_progress should be dropped.
    r.onEvent({ phase: "embed_progress", totalChunks: 1000, embedded: 256 });
    expect(cap.text()).toMatch(/embedded 128\/1000/);
    expect(cap.text()).not.toMatch(/embedded 256\/1000/);
    vi.advanceTimersByTime(300);
    r.onEvent({ phase: "embed_progress", totalChunks: 1000, embedded: 384 });
    expect(cap.text()).toMatch(/embedded 384\/1000/);
  });
});

describe("formatDuration", () => {
  it("renders seconds for <60s", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(7)).toBe("7s");
    expect(formatDuration(59)).toBe("59s");
  });

  it("renders minutes + zero-padded seconds for >=60s", () => {
    expect(formatDuration(60)).toBe("1m00s");
    expect(formatDuration(125)).toBe("2m05s");
    expect(formatDuration(3661)).toBe("61m01s");
  });

  it("returns 0s for non-finite or negative input", () => {
    expect(formatDuration(NaN)).toBe("0s");
    expect(formatDuration(-1)).toBe("0s");
  });
});
