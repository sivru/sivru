import { describe, expect, it } from "vitest";
import { compareReports, formatFailures } from "./perf-gate.js";
import type { PerfReport } from "./perf.js";

function fakeReport(
  ts: string,
  rows: Array<{ repo: string; chunks: number; buildMs: number; peakHeapMiB: number }>,
): PerfReport {
  return {
    timestamp: ts,
    version: "0.0.0",
    node: "22.0.0",
    platform: "linux",
    repos: rows.map((r) => ({
      repo: r.repo,
      language: "test",
      chunks: r.chunks,
      buildMs: r.buildMs,
      peakHeapMiB: r.peakHeapMiB,
    })),
    totals: {
      chunks: rows.reduce((s, r) => s + r.chunks, 0),
      buildMs: rows.reduce((s, r) => s + r.buildMs, 0),
      peakHeapMiB: rows.reduce((s, r) => s + r.peakHeapMiB, 0),
    },
  };
}

describe("compareReports", () => {
  it("flags no failures when current matches baseline", () => {
    const r = fakeReport("2026-01-01", [
      { repo: "zod", chunks: 1000, buildMs: 500, peakHeapMiB: 80 },
    ]);
    const failures = compareReports(r, r);
    expect(failures).toEqual([]);
  });

  it("flags chunk regression > 1%", () => {
    const baseline = fakeReport("2026-01-01", [
      { repo: "zod", chunks: 1000, buildMs: 500, peakHeapMiB: 80 },
    ]);
    const current = fakeReport("2026-02-01", [
      { repo: "zod", chunks: 1015, buildMs: 500, peakHeapMiB: 80 },
    ]);
    const failures = compareReports(baseline, current);
    expect(failures.length).toBe(1);
    expect(failures[0]?.metric).toBe("chunks");
  });

  it("ignores chunk drift within 1%", () => {
    const baseline = fakeReport("2026-01-01", [
      { repo: "zod", chunks: 1000, buildMs: 500, peakHeapMiB: 80 },
    ]);
    const current = fakeReport("2026-02-01", [
      { repo: "zod", chunks: 1005, buildMs: 500, peakHeapMiB: 80 },
    ]);
    expect(compareReports(baseline, current)).toEqual([]);
  });

  it("flags buildMs regression > 50%", () => {
    const baseline = fakeReport("2026-01-01", [
      { repo: "zod", chunks: 1000, buildMs: 500, peakHeapMiB: 80 },
    ]);
    const current = fakeReport("2026-02-01", [
      { repo: "zod", chunks: 1000, buildMs: 800, peakHeapMiB: 80 },
    ]);
    const failures = compareReports(baseline, current);
    expect(failures.find((f) => f.metric === "buildMs")).toBeDefined();
  });

  it("ignores tiny buildMs baselines (< 100 ms)", () => {
    const baseline = fakeReport("2026-01-01", [
      { repo: "tiny", chunks: 10, buildMs: 5, peakHeapMiB: 2 },
    ]);
    const current = fakeReport("2026-02-01", [
      // 4× regression, but baseline is below the noise floor
      { repo: "tiny", chunks: 10, buildMs: 50, peakHeapMiB: 2 },
    ]);
    expect(compareReports(baseline, current)).toEqual([]);
  });

  it("flags peak-heap regression > 15%", () => {
    const baseline = fakeReport("2026-01-01", [
      { repo: "zod", chunks: 1000, buildMs: 500, peakHeapMiB: 80 },
    ]);
    const current = fakeReport("2026-02-01", [
      { repo: "zod", chunks: 1000, buildMs: 500, peakHeapMiB: 100 }, // +25%
    ]);
    const failures = compareReports(baseline, current);
    expect(failures.find((f) => f.metric === "peakHeapMiB")).toBeDefined();
  });

  it("ignores tiny peak-heap baselines (< 4 MiB)", () => {
    const baseline = fakeReport("2026-01-01", [
      { repo: "tiny", chunks: 10, buildMs: 200, peakHeapMiB: 1 },
    ]);
    const current = fakeReport("2026-02-01", [
      // 5× regression but absolute is small
      { repo: "tiny", chunks: 10, buildMs: 200, peakHeapMiB: 5 },
    ]);
    expect(compareReports(baseline, current)).toEqual([]);
  });

  it("ignores repos that disappear from the current report", () => {
    const baseline = fakeReport("2026-01-01", [
      { repo: "zod", chunks: 1000, buildMs: 500, peakHeapMiB: 80 },
      { repo: "gone", chunks: 50, buildMs: 200, peakHeapMiB: 10 },
    ]);
    const current = fakeReport("2026-02-01", [
      { repo: "zod", chunks: 1000, buildMs: 500, peakHeapMiB: 80 },
    ]);
    expect(compareReports(baseline, current)).toEqual([]);
  });

  it("ignores brand-new repos in the current report", () => {
    const baseline = fakeReport("2026-01-01", [
      { repo: "zod", chunks: 1000, buildMs: 500, peakHeapMiB: 80 },
    ]);
    const current = fakeReport("2026-02-01", [
      { repo: "zod", chunks: 1000, buildMs: 500, peakHeapMiB: 80 },
      { repo: "newone", chunks: 99999, buildMs: 99999, peakHeapMiB: 999 },
    ]);
    expect(compareReports(baseline, current)).toEqual([]);
  });
});

describe("formatFailures", () => {
  it("returns 'no regressions' on empty input", () => {
    expect(formatFailures([])).toMatch(/no regressions/);
  });

  it("includes re-baseline command on failure", () => {
    const out = formatFailures([
      {
        repo: "zod",
        metric: "buildMs",
        baseline: 500,
        current: 800,
        ratio: 0.6,
        threshold: 0.5,
      },
    ]);
    expect(out).toMatch(/REGRESSIONS DETECTED/);
    expect(out).toMatch(/zod\.buildMs/);
    expect(out).toMatch(/perf-baseline\.json/);
  });
});
