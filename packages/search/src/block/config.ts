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

import type { SivruBlockConfig, SivruBlockMaxLines } from "./types.js";

/**
 * Default per-language line caps (DESIGN-0019 §8). Java is bumped to 40
 * because JavaDoc carries multi-line invariants about tenant isolation /
 * RBAC that routinely need 3–4 lines each. Other languages stay at the
 * v0.6 default (25).
 */
export const DEFAULT_MAX_LINES: SivruBlockMaxLines = {
  default: 25,
  java: 40,
  python: 30,
  rust: 30,
};

export const DEFAULT_BLOCK_CONFIG: SivruBlockConfig = {
  requiredFields: ["role", "responsibility"],
  optionalFields: ["collaborators", "invariants", "decisions", "maturity"],
  maxLines: DEFAULT_MAX_LINES,
  maturityValues: ["stable", "experimental", "deprecated", "wip"],
};

/**
 * Resolve the effective max-lines threshold for a given language. The
 * config's `maxLines` accepts either a bare number (v0.6 shorthand for
 * `{ default: <n> }`) or the per-language object form (DESIGN-0019 §8).
 *
 * @param maxLines the config value, possibly number or object form
 * @param language the chunker language id (`typescript`, `python`,
 *   `java`, etc.) or undefined for a non-detected file
 */
export function resolveMaxLines(
  maxLines: SivruBlockConfig["maxLines"],
  language: string | undefined,
): number {
  if (typeof maxLines === "number") return maxLines;
  if (language !== undefined) {
    const lang = language as keyof SivruBlockMaxLines;
    const perLang = maxLines[lang];
    if (typeof perLang === "number") return perLang;
  }
  return maxLines.default;
}

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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function coerceMaxLines(
  v: unknown,
): SivruBlockConfig["maxLines"] | undefined {
  if (isPositiveNumber(v)) return v;
  if (!isPlainObject(v)) return undefined;
  const dflt = v["default"];
  if (!isPositiveNumber(dflt)) return undefined;
  const out: SivruBlockMaxLines = { default: dflt };
  for (const k of [
    "java",
    "typescript",
    "javascript",
    "tsx",
    "jsx",
    "python",
    "go",
    "rust",
  ] as const) {
    const val = v[k];
    if (isPositiveNumber(val)) out[k] = val;
  }
  return out;
}

function mergeConfig(
  base: SivruBlockConfig,
  patch: Record<string, unknown> | undefined,
): SivruBlockConfig {
  if (patch === undefined) return base;
  const out: SivruBlockConfig = { ...base };
  if (isStringArray(patch["requiredFields"])) out.requiredFields = patch["requiredFields"];
  if (isStringArray(patch["optionalFields"])) out.optionalFields = patch["optionalFields"];
  const maxLines = coerceMaxLines(patch["maxLines"]);
  if (maxLines !== undefined) out.maxLines = maxLines;
  if (isStringArray(patch["maturityValues"])) out.maturityValues = patch["maturityValues"];

  // DESIGN-0019 slot 1: enforcement / diff blocks.
  if (isPlainObject(patch["enforcement"])) {
    const requireFlag = patch["enforcement"]["requireForObjectInvariants"];
    out.enforcement = {};
    if (typeof requireFlag === "boolean") {
      out.enforcement.requireForObjectInvariants = requireFlag;
    }
  }
  if (isPlainObject(patch["diff"])) {
    const since = patch["diff"]["defaultSince"];
    out.diff = {};
    if (typeof since === "string" && since.length > 0) {
      out.diff.defaultSince = since;
    }
  }

  // DESIGN-0019 slot 2: graph config.
  if (isPlainObject(patch["graph"])) {
    const allowed = patch["graph"]["allowedAsymmetric"];
    const ordering = patch["graph"]["orderingChecks"];
    out.graph = {};
    if (isStringArray(allowed)) out.graph.allowedAsymmetric = allowed;
    if (typeof ordering === "boolean") out.graph.orderingChecks = ordering;
  }

  // DESIGN-0019 slot 3: bridge overrides.
  if (isPlainObject(patch["bridges"])) {
    const bridges: SivruBlockConfig["bridges"] = {};
    const java = patch["bridges"]["java"];
    if (isPlainObject(java)) {
      const m: Record<string, string> = {};
      for (const [k, v] of Object.entries(java)) {
        if (typeof v === "string") m[k] = v;
      }
      bridges.java = m;
    }
    const py = patch["bridges"]["python"];
    if (isPlainObject(py)) {
      const m: Record<string, string> = {};
      for (const [k, v] of Object.entries(py)) {
        if (typeof v === "string") m[k] = v;
      }
      bridges.python = m;
    }
    const disable = patch["bridges"]["disable"];
    if (isStringArray(disable)) bridges.disable = disable;
    out.bridges = bridges;
  }

  if (isPlainObject(patch["drift"])) out.drift = patch["drift"];
  if (isPlainObject(patch["decisions"])) out.decisions = patch["decisions"];
  if (isPlainObject(patch["generated"])) out.generated = patch["generated"];
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
