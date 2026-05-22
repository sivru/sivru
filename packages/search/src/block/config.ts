// Config loader for @sivru block module (DESIGN-0016 §6).
//
// Precedence: project `<repoRoot>/.sivru/block.json` > user
// `~/.config/sivru/block.json` (honors XDG_CONFIG_HOME) > built-in
// defaults. Same precedence as the v0.5 explain config pattern.
//
// `maxLines` controls only the SIVRU-E211 warning threshold. The
// SIVRU-E212 runaway error ceiling (100 lines) is hardcoded and is NOT
// configurable; implementers must not add a `maxRunawayLines` key.
//
// Override-replaces-default semantics for arrays (DESIGN-0016 E4): a
// user `maturityValues: ['gold']` fully replaces the default set; to
// extend the defaults the user must include them explicitly.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SivruBlockConfig } from "./types.js";

export const DEFAULT_BLOCK_CONFIG: SivruBlockConfig = {
  requiredFields: ["role", "responsibility"],
  optionalFields: ["collaborators", "invariants", "decisions", "maturity"],
  maxLines: 25,
  maturityValues: ["stable", "experimental", "deprecated", "wip"],
};

/** Hardcoded ceiling for SIVRU-E212 block-runaway. NOT configurable. */
export const RUNAWAY_LINES = 100;

function userConfigPath(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg.length > 0) {
    return join(xdg, "sivru", "block.json");
  }
  return join(homedir(), ".config", "sivru", "block.json");
}

function projectConfigPath(repoRoot: string): string {
  return join(repoRoot, ".sivru", "block.json");
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function mergeConfig(
  base: SivruBlockConfig,
  patch: Record<string, unknown> | undefined,
): SivruBlockConfig {
  if (patch === undefined) return base;
  const out: SivruBlockConfig = { ...base };
  if (isStringArray(patch["requiredFields"])) out.requiredFields = patch["requiredFields"];
  if (isStringArray(patch["optionalFields"])) out.optionalFields = patch["optionalFields"];
  if (typeof patch["maxLines"] === "number" && Number.isFinite(patch["maxLines"]) && patch["maxLines"] > 0) {
    out.maxLines = patch["maxLines"];
  }
  if (isStringArray(patch["maturityValues"])) out.maturityValues = patch["maturityValues"];
  if (typeof patch["drift"] === "object" && patch["drift"] !== null) {
    out.drift = patch["drift"] as Record<string, unknown>;
  }
  return out;
}

function readJsonOrUndef(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Load and merge block config. Defaults are always present; user and
 * project configs add on top. Never throws — corrupt config falls back
 * to the next layer (and ultimately defaults) so block validation is
 * never blocked by config-file errors.
 */
export function loadBlockConfig(repoRoot?: string): SivruBlockConfig {
  let cfg = DEFAULT_BLOCK_CONFIG;
  cfg = mergeConfig(cfg, readJsonOrUndef(userConfigPath()));
  if (repoRoot !== undefined && repoRoot.length > 0) {
    cfg = mergeConfig(cfg, readJsonOrUndef(projectConfigPath(repoRoot)));
  }
  return cfg;
}
