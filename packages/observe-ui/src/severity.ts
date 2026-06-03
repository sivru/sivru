// Shared severity helpers (DESIGN-0021). One source of truth for diagnostic
// severity ranking + the Tailwind dot/glyph color, so the Blocks-tab surfaces
// (triage inbox, graph, inspector, Replay lane) sort and color consistently.

export type Severity = "error" | "warning" | "info";

const SEVERITY_RANK: Record<string, number> = { error: 0, warning: 1, info: 2 };

/** Sort rank (lower = more severe); unknown severities sort last. */
export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 9;
}

/** Tailwind background class for a filled severity dot. */
export function severityDotClass(severity: string): string {
  if (severity === "error") return "bg-sivru-error";
  if (severity === "warning") return "bg-sivru-warn";
  return "bg-sivru-mute";
}
