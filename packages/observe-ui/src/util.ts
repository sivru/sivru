// Small formatting / display helpers shared across components.
// Keep this dependency-free — no React imports here.

export function formatJson(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    // Cyclic refs or weird hosts.
    return String(value);
  }
}

export function formatTimestamp(ts: string | undefined | null): string {
  if (ts === undefined || ts === null) return "--:--:--";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

/**
 * A session is "live" when its updatedAt is within this window. Drives
 * the amber pulse in the header, project switcher, and session list.
 * Centralized here so tweaking it touches one place.
 */
export const LIVE_THRESHOLD_MS = 5 * 60 * 1000;

export function isLive(updatedAt: string | null | undefined): boolean {
  if (updatedAt === undefined || updatedAt === null) return false;
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t < LIVE_THRESHOLD_MS;
}

/**
 * Last segment of a slash- or backslash-separated path. Empty string in,
 * empty string out. We use this to render `~/some/long/project/path` as
 * just `path` in tight UI surfaces.
 */
export function basenamePath(path: string): string {
  if (path.length === 0) return "";
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
  return parts.length > 0 ? (parts[parts.length - 1] ?? path) : path;
}

// Recognize sivru's search tool across the naming variants we've seen:
//   mcp__sivru__search   — Claude Code namespacing for MCP tools
//   sivru.search         — DESIGN.md / older clients
//   sivru_search         — underscored alias
//   sivru/search         — slash-separated (rare)
// Strip non-alphanum and check that the result contains the substring
// "sivrusearch". We intentionally do NOT match plain "search" alone — too
// generic, would false-positive on built-in or third-party tools.
export function isSivruSearchTool(name: string | undefined): boolean {
  if (name === undefined) return false;
  return name.toLowerCase().replace(/[^a-z0-9]/g, "").includes("sivrusearch");
}
