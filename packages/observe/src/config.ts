// `.sivru/observe.json` — declarative overrides (DESIGN-0021 §"Customization
// shape", layer 2). Best-effort: a missing or malformed file is a no-op (empty
// config). Only the keys with real consumers are read today; the rest of the
// design's surface (graph.collapseDirs, custom store paths) is reserved.
//
// Local-disk only; no network.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ObserveConfig {
  ui?: {
    blocks?: {
      /** Override the Blocks-tab landing pane. */
      defaultSubview?: "issues" | "graph";
    };
    audit?: {
      /** Override the audit-file retention window (default 7). */
      retentionDays?: number;
    };
  };
}

/** Read `.sivru/observe.json`; returns {} when absent or unparseable. */
export function loadObserveConfig(rootPath: string): ObserveConfig {
  try {
    const raw = readFileSync(join(rootPath, ".sivru", "observe.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as ObserveConfig) : {};
  } catch {
    return {};
  }
}

/** The configured Blocks default sub-view, or "issues" (the built-in default). */
export function defaultSubview(config: ObserveConfig): "issues" | "graph" {
  return config.ui?.blocks?.defaultSubview === "graph" ? "graph" : "issues";
}

/** The configured audit retention window in days, or 7 (the built-in default). */
export function auditRetentionDays(config: ObserveConfig): number {
  const n = config.ui?.audit?.retentionDays;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 7;
}
