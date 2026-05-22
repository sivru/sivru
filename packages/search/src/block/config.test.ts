// Config loader tests (DESIGN-0016 §6).

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_BLOCK_CONFIG, loadBlockConfig } from "./config.js";

const created: string[] = [];

afterEach(() => {
  for (const p of created.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function mkRepoWithConfig(json: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "sivru-block-cfg-"));
  created.push(dir);
  mkdirSync(join(dir, ".sivru"), { recursive: true });
  writeFileSync(join(dir, ".sivru", "block.json"), JSON.stringify(json));
  return dir;
}

describe("loadBlockConfig", () => {
  it("returns defaults when no project/user config exists", () => {
    expect(loadBlockConfig()).toEqual(DEFAULT_BLOCK_CONFIG);
  });

  it("project config overrides defaults (override-replaces-default)", () => {
    const dir = mkRepoWithConfig({
      maturityValues: ["gold"],
      maxLines: 12,
    });
    const cfg = loadBlockConfig(dir);
    expect(cfg.maturityValues).toEqual(["gold"]);
    expect(cfg.maxLines).toBe(12);
    // Untouched arrays remain at defaults.
    expect(cfg.requiredFields).toEqual(DEFAULT_BLOCK_CONFIG.requiredFields);
  });

  it("ignores invalid JSON and falls back to defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "sivru-block-cfg-"));
    created.push(dir);
    mkdirSync(join(dir, ".sivru"), { recursive: true });
    writeFileSync(join(dir, ".sivru", "block.json"), "{ this is not json");
    expect(loadBlockConfig(dir)).toEqual(DEFAULT_BLOCK_CONFIG);
  });

  it("ignores non-string entries inside string arrays", () => {
    const dir = mkRepoWithConfig({
      maturityValues: ["stable", 42, true],
    });
    // The mixed-type array is rejected wholesale; defaults remain.
    const cfg = loadBlockConfig(dir);
    expect(cfg.maturityValues).toEqual(DEFAULT_BLOCK_CONFIG.maturityValues);
  });
});
