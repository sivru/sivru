// Persistent CLI config — stored at:
//
//   $XDG_CONFIG_HOME/sivru/config.json   (Linux / portable)
//   ~/Library/Application Support/sivru/config.json   (macOS, future)
//   ~/.config/sivru/config.json          (everything else, default)
//
// We deliberately keep the file location predictable and the schema flat
// — config is read by the MCP server on startup, so corruption / parse
// failure must not prevent search from working. All reads return defaults
// on error (no throw).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Whitelisted config keys. Extending the schema requires bumping this. */
export type ConfigKey = "embedder";

/** Shape of the persisted config. All keys optional. */
export type SivruConfig = {
  /**
   * Default embedder short name (one of MODEL_REGISTRY keys, or `hf:owner/repo`,
   * or `bm25` for lexical-only). The MCP server uses this when no per-call
   * `hybrid` argument is set; the CLI's `sivru search` honors it as the
   * default for `--embed`.
   */
  embedder?: string;
};

const VALID_KEYS: readonly ConfigKey[] = ["embedder"];

function configDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg.length > 0) {
    return join(xdg, "sivru");
  }
  return join(homedir(), ".config", "sivru");
}

function configPath(): string {
  return join(configDir(), "config.json");
}

/**
 * Load the persisted config. Returns an empty object on miss / corrupt
 * file — by design, we never block the user's actual work because of a
 * config parse failure.
 */
export function loadConfig(): SivruConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: SivruConfig = {};
    const obj = parsed as Record<string, unknown>;
    if (typeof obj["embedder"] === "string") {
      out.embedder = obj["embedder"];
    }
    return out;
  } catch {
    return {};
  }
}

/** Save the config. Atomic write via tmp + rename. */
export function saveConfig(cfg: SivruConfig): void {
  const dir = configDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = configPath();
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  // renameSync is atomic on POSIX + NTFS for same-filesystem moves.
  // We're inside the user's home dir so no cross-mount concern.
  renameSync(tmp, path);
}

export function isValidConfigKey(key: string): key is ConfigKey {
  return (VALID_KEYS as readonly string[]).includes(key);
}

export const _internal = {
  configPath,
  configDir,
  VALID_KEYS,
};
