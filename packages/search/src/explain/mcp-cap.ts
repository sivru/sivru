// MCP token cap (DESIGN-0004 §2a / T11).
//
// The CLI surface is uncapped (markdown + --json return everything); only
// the MCP path applies caps. `applyMcpCap` trims `callers` and `callees`
// independently, surfacing the dropped count via `*_truncated`. The hard
// ceiling at 500 and the `0 → ceiling` foot-cannon fix live here too.
//
// Sort order for both lists is the design's commitCount ascending → mtime
// ascending → filePath ascending; T8 already sorts callers that way, T11
// extends the same order to callees.

import { promises as fsp } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { SivruExplainError, type ExplainArtifact } from "./types.js";

export const MCP_CAP_DEFAULT = 30;
export const MCP_CAP_HARD_CEILING = 500;

export type McpCapConfig = {
  /** Cap applied to `callers` and `callees` independently. */
  mcpCap: number;
};

/**
 * Resolve the on-the-wire effective cap. Per §2a #10:
 *   - any positive integer ≤ ceiling passes through
 *   - any positive integer > ceiling clamps to the ceiling
 *   - `0` means "use the ceiling" (NOT "no cap" — the foot-cannon fix)
 *   - negative or non-integer values raise SIVRU-E2008
 */
export function effectiveCap(configValue: number): number {
  if (!Number.isInteger(configValue) || configValue < 0) {
    throw new SivruExplainError(
      "SIVRU-E2008",
      `mcpCap must be a non-negative integer, got ${configValue}`,
    );
  }
  if (configValue === 0) return MCP_CAP_HARD_CEILING;
  return Math.min(configValue, MCP_CAP_HARD_CEILING);
}

/**
 * Load `.sivru/explain.json` from the repo root, returning the resolved
 * `mcpCap`. Missing / unreadable file falls back to the default.
 */
export async function loadMcpCapConfig(repoRoot: string): Promise<number> {
  const path = resolvePath(repoRoot, ".sivru", "explain.json");
  let raw: string;
  try {
    raw = await fsp.readFile(path, "utf8");
  } catch {
    return MCP_CAP_DEFAULT;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SivruExplainError(
      "SIVRU-E2008",
      `${path}: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new SivruExplainError(
      "SIVRU-E2008",
      `${path}: top-level value must be an object`,
    );
  }
  const cap = (parsed as Record<string, unknown>).mcpCap;
  if (cap === undefined) return MCP_CAP_DEFAULT;
  if (typeof cap !== "number") {
    throw new SivruExplainError(
      "SIVRU-E2008",
      `${path}: \`mcpCap\` must be a number`,
    );
  }
  // Validate via effectiveCap so the user-facing error matches a direct call.
  effectiveCap(cap);
  return cap;
}

/**
 * Apply the MCP cap to `artifact.callers` and `artifact.callees` in place
 * (returning a new artifact — the source is not mutated). The cap value is
 * passed through `effectiveCap` so callers can hand a raw config number.
 *
 * When a list is null (e.g. callers dropped by precision-floor in T12), the
 * cap does not touch it.
 */
export function applyMcpCap(
  artifact: ExplainArtifact,
  cap: number,
): ExplainArtifact {
  const eff = effectiveCap(cap);
  let callers = artifact.callers;
  let callersTruncated: number | null = artifact.callers_truncated;
  if (callers !== null && callers.length > eff) {
    callersTruncated = (callersTruncated ?? 0) + (callers.length - eff);
    callers = callers.slice(0, eff);
  }
  let callees = artifact.callees;
  let calleesTruncated: number | null = artifact.callees_truncated;
  if (callees.length > eff) {
    calleesTruncated = (calleesTruncated ?? 0) + (callees.length - eff);
    callees = callees.slice(0, eff);
  }
  return {
    ...artifact,
    callers,
    callees,
    callers_truncated: callersTruncated,
    callees_truncated: calleesTruncated,
  };
}
