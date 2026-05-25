// Checkup config loader (DESIGN-0005 §8).
//
// Three-layer precedence:
//   1. Built-in defaults (DEFAULT_CONFIG below).
//   2. User-global: `~/.config/sivru/checkup.json`.
//   3. Project: `<repoRoot>/.sivru/checkup.json` — wins.
//
// `pathExtensions` is override-replaces-default (matches v0.6
// `maturityValues` precedent). `disabled` and `severityOverrides` are
// additive merges into defaults.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CheckupConfig, Severity } from "./types.js";

export const DEFAULT_CONFIG: CheckupConfig = {
  ageDays: 90,
  ageCommits: 50,
  disabled: [],
  severityOverrides: {},
  skipPaths: [],
  pathExtensions: [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".md",
    ".json",
    ".yaml",
    ".yml",
    ".sh",
    ".py",
    ".go",
    ".rs",
    ".java",
  ],
};

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>(["info", "warning", "error"]);

export class CheckupConfigError extends Error {
  /** Always SIVRU-E240 at v0.7. */
  readonly code = "SIVRU-E240";
  /** Absolute path of the malformed config file. */
  readonly file: string;
  constructor(message: string, file: string) {
    super(message);
    this.name = "CheckupConfigError";
    this.file = file;
  }
}

interface LoadDeps {
  homeDir?: string;
}

/**
 * Resolve the effective config for `repoRoot`. Throws
 * `CheckupConfigError` (SIVRU-E240) on malformed JSON or schema
 * violation — never silently substitutes defaults for bad input.
 */
export async function loadCheckupConfig(
  repoRoot: string,
  deps: LoadDeps = {},
): Promise<CheckupConfig> {
  const home = deps.homeDir ?? homedir();
  const userPath = join(home, ".config", "sivru", "checkup.json");
  const projectPath = join(repoRoot, ".sivru", "checkup.json");

  let cfg: CheckupConfig = { ...DEFAULT_CONFIG };
  for (const p of [userPath, projectPath]) {
    const layer = await readLayer(p);
    if (layer !== null) cfg = mergeLayer(cfg, layer);
  }
  return cfg;
}

async function readLayer(file: string): Promise<Partial<CheckupConfig> | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT" || e.code === "EACCES") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CheckupConfigError(
      `${file}: invalid JSON (${(err as Error).message})`,
      file,
    );
  }
  return validateLayer(parsed, file);
}

function validateLayer(input: unknown, file: string): Partial<CheckupConfig> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new CheckupConfigError(`${file}: must be a JSON object`, file);
  }
  const obj = input as Record<string, unknown>;
  const out: Partial<CheckupConfig> = {};

  if ("ageDays" in obj) {
    const v = obj["ageDays"];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new CheckupConfigError(`${file}: ageDays must be a non-negative number`, file);
    }
    out.ageDays = v;
  }
  if ("ageCommits" in obj) {
    const v = obj["ageCommits"];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new CheckupConfigError(`${file}: ageCommits must be a non-negative number`, file);
    }
    out.ageCommits = v;
  }
  if ("disabled" in obj) {
    const v = obj["disabled"];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      throw new CheckupConfigError(`${file}: disabled must be an array of strings`, file);
    }
    out.disabled = v;
  }
  if ("severityOverrides" in obj) {
    const v = obj["severityOverrides"];
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      throw new CheckupConfigError(
        `${file}: severityOverrides must be an object of checkId → severity`,
        file,
      );
    }
    const ov: Record<string, Severity> = {};
    for (const [k, sev] of Object.entries(v as Record<string, unknown>)) {
      if (typeof sev !== "string" || !VALID_SEVERITIES.has(sev as Severity)) {
        throw new CheckupConfigError(
          `${file}: severityOverrides["${k}"] must be one of info|warning|error`,
          file,
        );
      }
      ov[k] = sev as Severity;
    }
    out.severityOverrides = ov;
  }
  if ("skipPaths" in obj) {
    const v = obj["skipPaths"];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      throw new CheckupConfigError(`${file}: skipPaths must be an array of strings`, file);
    }
    out.skipPaths = v;
  }
  if ("pathExtensions" in obj) {
    const v = obj["pathExtensions"];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.startsWith("."))) {
      throw new CheckupConfigError(
        `${file}: pathExtensions must be an array of strings starting with "."`,
        file,
      );
    }
    out.pathExtensions = v;
  }
  return out;
}

function mergeLayer(base: CheckupConfig, layer: Partial<CheckupConfig>): CheckupConfig {
  return {
    ageDays: layer.ageDays ?? base.ageDays,
    ageCommits: layer.ageCommits ?? base.ageCommits,
    // Additive: union the disabled lists.
    disabled: layer.disabled !== undefined
      ? Array.from(new Set([...base.disabled, ...layer.disabled]))
      : base.disabled,
    // Additive: layer overrides win per-key.
    severityOverrides: layer.severityOverrides !== undefined
      ? { ...base.severityOverrides, ...layer.severityOverrides }
      : base.severityOverrides,
    // Additive: union.
    skipPaths: layer.skipPaths !== undefined
      ? Array.from(new Set([...base.skipPaths, ...layer.skipPaths]))
      : base.skipPaths,
    // Override-replaces-default semantics.
    pathExtensions: layer.pathExtensions ?? base.pathExtensions,
  };
}
