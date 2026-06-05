// Shared one-line renderer for a block `BlockDiagnostic`. Two tool-wide
// styles, because the two contexts that print diagnostics genuinely differ:
//
//   - "path-prefixed" — the `sivru block` subcommands list diagnostics
//     across many files, so each line must name its file:
//         path/to/foo.ts:12: error SIVRU-E217: missing-required: `role` ...
//
//   - "code-first" — the `sivru explain` BLOCKS HEALTH section is already
//     scoped to one target file (named in the artifact header), so the path
//     would be redundant noise; the line leads with the code instead:
//         SIVRU-E217 [error] missing-required: `role` ...  (line 12)
//
// One function, one place to change diagnostic line shape, the variation
// made explicit by the `style` argument rather than two divergent inline
// formatters.

import type { BlockDiagnostic } from "@sivru/search";

export type DiagnosticStyle = "path-prefixed" | "code-first";

export function formatDiagnostic(
  d: BlockDiagnostic,
  style: DiagnosticStyle,
): string {
  if (style === "path-prefixed") {
    const where =
      d.location !== undefined
        ? `${d.location.filePath}:${d.location.startLine}`
        : "<unknown>";
    return `${where}: ${d.severity} ${d.code}: ${d.message}`;
  }
  // "code-first"
  const where =
    d.location !== undefined ? `  (line ${d.location.startLine})` : "";
  return `${d.code} [${d.severity}] ${d.message}${where}`;
}
