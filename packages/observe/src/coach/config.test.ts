// Tests for the checkup config loader.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CheckupConfigError, DEFAULT_CONFIG, loadCheckupConfig } from "./config.js";

describe("loadCheckupConfig", () => {
  let tmp: string;
  let repoRoot: string;
  let homeDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "sivru-config-"));
    repoRoot = join(tmp, "repo");
    homeDir = join(tmp, "home");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(homeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns defaults when no config files are present", async () => {
    const cfg = await loadCheckupConfig(repoRoot, { homeDir });
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it("user-global config overrides defaults", async () => {
    await mkdir(join(homeDir, ".config", "sivru"), { recursive: true });
    await writeFile(
      join(homeDir, ".config", "sivru", "checkup.json"),
      JSON.stringify({ ageDays: 30 }),
    );
    const cfg = await loadCheckupConfig(repoRoot, { homeDir });
    expect(cfg.ageDays).toBe(30);
    expect(cfg.ageCommits).toBe(DEFAULT_CONFIG.ageCommits);
  });

  it("project config wins over user-global", async () => {
    await mkdir(join(homeDir, ".config", "sivru"), { recursive: true });
    await mkdir(join(repoRoot, ".sivru"), { recursive: true });
    await writeFile(
      join(homeDir, ".config", "sivru", "checkup.json"),
      JSON.stringify({ ageDays: 30 }),
    );
    await writeFile(
      join(repoRoot, ".sivru", "checkup.json"),
      JSON.stringify({ ageDays: 7 }),
    );
    const cfg = await loadCheckupConfig(repoRoot, { homeDir });
    expect(cfg.ageDays).toBe(7);
  });

  it("pathExtensions overrides REPLACE the default array (not merge)", async () => {
    await mkdir(join(repoRoot, ".sivru"), { recursive: true });
    await writeFile(
      join(repoRoot, ".sivru", "checkup.json"),
      JSON.stringify({ pathExtensions: [".ts"] }),
    );
    const cfg = await loadCheckupConfig(repoRoot, { homeDir });
    expect(cfg.pathExtensions).toEqual([".ts"]);
  });

  it("disabled and severityOverrides MERGE additively", async () => {
    await mkdir(join(homeDir, ".config", "sivru"), { recursive: true });
    await mkdir(join(repoRoot, ".sivru"), { recursive: true });
    await writeFile(
      join(homeDir, ".config", "sivru", "checkup.json"),
      JSON.stringify({
        disabled: ["a"],
        severityOverrides: { "memory-claude-age": "warning" },
      }),
    );
    await writeFile(
      join(repoRoot, ".sivru", "checkup.json"),
      JSON.stringify({
        disabled: ["b"],
        severityOverrides: { "memory-dead-reference": "info" },
      }),
    );
    const cfg = await loadCheckupConfig(repoRoot, { homeDir });
    expect(cfg.disabled.sort()).toEqual(["a", "b"]);
    expect(cfg.severityOverrides).toEqual({
      "memory-claude-age": "warning",
      "memory-dead-reference": "info",
    });
  });

  it("throws SIVRU-E240 on invalid JSON", async () => {
    await mkdir(join(repoRoot, ".sivru"), { recursive: true });
    await writeFile(join(repoRoot, ".sivru", "checkup.json"), "{ not json");
    await expect(loadCheckupConfig(repoRoot, { homeDir })).rejects.toMatchObject({
      code: "SIVRU-E240",
    });
  });

  it("throws SIVRU-E240 on schema violation with the field named", async () => {
    await mkdir(join(repoRoot, ".sivru"), { recursive: true });
    await writeFile(
      join(repoRoot, ".sivru", "checkup.json"),
      JSON.stringify({ ageDays: "ninety" }),
    );
    await expect(loadCheckupConfig(repoRoot, { homeDir })).rejects.toMatchObject({
      code: "SIVRU-E240",
      message: expect.stringContaining("ageDays"),
    });
  });

  it("rejects severityOverrides with an unknown severity string", async () => {
    await mkdir(join(repoRoot, ".sivru"), { recursive: true });
    await writeFile(
      join(repoRoot, ".sivru", "checkup.json"),
      JSON.stringify({ severityOverrides: { foo: "critical" } }),
    );
    await expect(loadCheckupConfig(repoRoot, { homeDir })).rejects.toBeInstanceOf(CheckupConfigError);
  });

  it("rejects pathExtensions entries that don't start with .", async () => {
    await mkdir(join(repoRoot, ".sivru"), { recursive: true });
    await writeFile(
      join(repoRoot, ".sivru", "checkup.json"),
      JSON.stringify({ pathExtensions: ["ts"] }),
    );
    await expect(loadCheckupConfig(repoRoot, { homeDir })).rejects.toMatchObject({
      code: "SIVRU-E240",
    });
  });
});
