import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_THRESHOLD_MS,
  basenamePath,
  formatTimestamp,
  isLive,
  isSivruSearchTool,
  truncate,
} from "./util";

describe("LIVE_THRESHOLD_MS / isLive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false for null / undefined / invalid timestamps", () => {
    expect(isLive(null)).toBe(false);
    expect(isLive(undefined)).toBe(false);
    expect(isLive("not a date")).toBe(false);
  });

  it("returns true for timestamps within the live window", () => {
    const oneMinuteAgo = new Date(
      Date.now() - 60 * 1000,
    ).toISOString();
    expect(isLive(oneMinuteAgo)).toBe(true);
  });

  it("returns false for timestamps outside the live window", () => {
    const tenMinutesAgo = new Date(
      Date.now() - 10 * 60 * 1000,
    ).toISOString();
    expect(isLive(tenMinutesAgo)).toBe(false);
  });

  it("uses a 5-minute window", () => {
    expect(LIVE_THRESHOLD_MS).toBe(5 * 60 * 1000);
  });
});

describe("basenamePath", () => {
  it.each([
    ["/Users/x/dev/sivru", "sivru"],
    ["/Users/x/dev/sivru/", "sivru"],
    ["sivru", "sivru"],
    ["", ""],
    ["C:\\Users\\x\\projects\\foo", "foo"],
    ["/", "/"], // edge: only slashes
    ["/a/b/c.json", "c.json"],
  ])("basenamePath(%s) === %s", (input, expected) => {
    expect(basenamePath(input)).toBe(expected);
  });
});

describe("truncate", () => {
  it("returns the input unchanged when shorter than the limit", () => {
    expect(truncate("hi", 10)).toBe("hi");
  });
  it("truncates with an ellipsis when over the limit", () => {
    expect(truncate("hello world", 5)).toBe("hell…");
  });
});

describe("formatTimestamp", () => {
  it("formats valid timestamps as HH:MM:SS", () => {
    expect(formatTimestamp("2026-01-01T13:45:09.000Z")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
  it("returns the placeholder for null/undefined/invalid", () => {
    expect(formatTimestamp(undefined)).toBe("--:--:--");
    expect(formatTimestamp(null)).toBe("--:--:--");
    expect(formatTimestamp("not a date")).toBe("--:--:--");
  });
});

describe("isSivruSearchTool", () => {
  it.each([
    ["mcp__sivru__search", true],
    ["sivru.search", true],
    ["sivru_search", true],
    ["Sivru/Search", true],
    ["SIVRU__SEARCH", true],
    ["search", false], // too generic
    ["sivru", false],
    [undefined, false],
    ["mcp__sivru__find_related", false],
  ])("isSivruSearchTool(%s) === %s", (input, expected) => {
    expect(isSivruSearchTool(input)).toBe(expected);
  });
});
