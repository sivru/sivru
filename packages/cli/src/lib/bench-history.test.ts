import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BENCH_HISTORY_FORMAT_VERSION,
  listBenchHistory,
  readBenchHistory,
  saveBenchHistory,
} from "./bench-history.js";

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sivru-bench-history-"));
  originalHome = process.env["HOME"];
  process.env["HOME"] = tmpHome;
  vi.stubEnv("HOME", tmpHome);
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  vi.unstubAllEnvs();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("saveBenchHistory + readBenchHistory", () => {
  it("round-trips a minimal entry", () => {
    const path = saveBenchHistory({
      startedAt: "2026-05-04T15:30:00.000Z",
      sivruVersion: "0.1.0-rc.1",
      node: "20.0.0",
      platform: "darwin",
      argv: ["bench", "personal", "--n=5"],
      repos: [],
    });
    expect(path).toMatch(/2026-05-04T15-30-00\.json$/);
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      formatVersion: number;
      sivruVersion: string;
      argv: string[];
    };
    expect(raw.formatVersion).toBe(BENCH_HISTORY_FORMAT_VERSION);
    expect(raw.sivruVersion).toBe("0.1.0-rc.1");
    expect(raw.argv).toEqual(["bench", "personal", "--n=5"]);
  });

  it("listBenchHistory returns newest first", () => {
    saveBenchHistory({
      startedAt: "2026-05-01T10:00:00.000Z",
      sivruVersion: "0.1.0-rc.1",
      node: "20.0.0",
      platform: "darwin",
      argv: [],
      repos: [],
    });
    saveBenchHistory({
      startedAt: "2026-05-03T10:00:00.000Z",
      sivruVersion: "0.1.0-rc.1",
      node: "20.0.0",
      platform: "darwin",
      argv: [],
      repos: [],
    });
    saveBenchHistory({
      startedAt: "2026-05-02T10:00:00.000Z",
      sivruVersion: "0.1.0-rc.1",
      node: "20.0.0",
      platform: "darwin",
      argv: [],
      repos: [],
    });
    const list = listBenchHistory();
    expect(list).toHaveLength(3);
    expect(list[0]?.id).toMatch(/^2026-05-03/);
    expect(list[2]?.id).toMatch(/^2026-05-01/);
  });

  it("readBenchHistory returns null on missing id", () => {
    expect(readBenchHistory("2099-01-01T00-00-00")).toBeNull();
  });

  it("readBenchHistory returns null on incompatible formatVersion", () => {
    const id = "2026-05-04T16-00-00";
    const dir = join(tmpHome, ".cache", "sivru", "bench-history");
    saveBenchHistory({
      startedAt: "2026-05-04T16:00:00.000Z",
      sivruVersion: "0.1.0-rc.1",
      node: "20.0.0",
      platform: "darwin",
      argv: [],
      repos: [],
    });
    // Tamper with formatVersion to simulate a future schema.
    const path = join(dir, `${id}.json`);
    const tampered = { ...JSON.parse(readFileSync(path, "utf8")), formatVersion: 99 };
    require("node:fs").writeFileSync(path, JSON.stringify(tampered));
    expect(readBenchHistory(id)).toBeNull();
  });

  it("returns empty list when history dir doesn't exist yet", () => {
    expect(listBenchHistory()).toEqual([]);
  });
});
