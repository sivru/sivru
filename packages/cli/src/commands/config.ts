// `sivru config` — read/write the persisted CLI config.
//
//   sivru config get <key>
//   sivru config set <key> <value>
//   sivru config unset <key>
//   sivru config list
//   sivru config path

import {
  isValidConfigKey,
  loadConfig,
  saveConfig,
  _internal,
} from "../lib/config.js";
import { resolveModel } from "../lib/model-catalog.js";

export async function runConfig(argv: readonly string[]): Promise<number> {
  const sub = argv[1];
  if (sub === undefined || sub === "help" || sub === "--help") {
    process.stdout.write(helpText());
    return 0;
  }
  if (sub === "list") {
    const cfg = loadConfig();
    const keys = Object.keys(cfg);
    if (keys.length === 0) {
      process.stdout.write("(no config set)\n");
      return 0;
    }
    for (const k of keys) {
      const v = cfg[k as keyof typeof cfg];
      process.stdout.write(`${k} = ${String(v)}\n`);
    }
    return 0;
  }
  if (sub === "path") {
    process.stdout.write(_internal.configPath() + "\n");
    return 0;
  }
  if (sub === "get") {
    const key = argv[2];
    if (key === undefined) {
      process.stderr.write("sivru config get: missing <key>\n");
      return 2;
    }
    if (!isValidConfigKey(key)) {
      process.stderr.write(
        `sivru config get: unknown key "${key}" (valid: ${_internal.VALID_KEYS.join(", ")})\n`,
      );
      return 2;
    }
    const cfg = loadConfig();
    const v = cfg[key];
    if (v === undefined) {
      // Exit 1 like `git config` for unset keys, no output.
      return 1;
    }
    process.stdout.write(`${v}\n`);
    return 0;
  }
  if (sub === "set") {
    const key = argv[2];
    const value = argv[3];
    if (key === undefined || value === undefined) {
      process.stderr.write("sivru config set: usage: sivru config set <key> <value>\n");
      return 2;
    }
    if (!isValidConfigKey(key)) {
      process.stderr.write(
        `sivru config set: unknown key "${key}" (valid: ${_internal.VALID_KEYS.join(", ")})\n`,
      );
      return 2;
    }
    if (key === "embedder") {
      const resolved = resolveModel(value);
      if (resolved === null) {
        process.stderr.write(
          `sivru config set embedder: unknown model "${value}". ` +
            `Try \`sivru bench models\` to list registered names, or use ` +
            `\`hf:owner/model-name\` for a custom HF model.\n`,
        );
        return 2;
      }
    }
    const cfg = loadConfig();
    cfg[key] = value;
    saveConfig(cfg);
    process.stdout.write(`set ${key} = ${value}\n`);
    return 0;
  }
  if (sub === "unset") {
    const key = argv[2];
    if (key === undefined) {
      process.stderr.write("sivru config unset: missing <key>\n");
      return 2;
    }
    if (!isValidConfigKey(key)) {
      process.stderr.write(
        `sivru config unset: unknown key "${key}" (valid: ${_internal.VALID_KEYS.join(", ")})\n`,
      );
      return 2;
    }
    const cfg = loadConfig();
    if (cfg[key] === undefined) {
      // Idempotent: already unset is fine.
      return 0;
    }
    delete cfg[key];
    saveConfig(cfg);
    process.stdout.write(`unset ${key}\n`);
    return 0;
  }
  process.stderr.write(`sivru config: unknown subcommand "${sub}"\n${helpText()}`);
  return 2;
}

function helpText(): string {
  return [
    "sivru config — manage persistent CLI settings",
    "",
    "Usage:",
    "  sivru config get <key>           Print the current value (exit 1 if unset)",
    "  sivru config set <key> <value>   Persist <value>",
    "  sivru config unset <key>         Remove",
    "  sivru config list                Print all set keys",
    "  sivru config path                Print the config file path",
    "",
    "Keys:",
    "  embedder    Default embedding model. One of:",
    "                  bm25                — lexical only (no model download)",
    "                  potion              — Model2Vec, fast cold-start",
    "                  minilm              — all-MiniLM-L6-v2",
    "                  bge-small           — bge-small-en-v1.5",
    "                  jina-code           — code-specific",
    "                  nomic-embed         — nomic-embed-text-v1.5",
    "                  hf:owner/model      — any HF feature-extraction model",
    "",
    "List models with details:  sivru bench models",
    "",
  ].join("\n");
}
