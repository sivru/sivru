// Python module-level @sivru block locator (DESIGN-0016 §3, E1, A2).
//
// PEP 257 strict: the module docstring is the first statement of the
// module body when that statement is a bare string expression. `from
// __future__ import ...` lines are skipped per PEP 257 — a string
// statement immediately after them still counts as the module docstring.
// F-strings are NOT docstrings (matches CPython behavior).

import type { SyntaxNode } from "../../chunker/grammars.js";
import type { BlockDiagnostic } from "../types.js";
import type { LocatorResult } from "./types.js";

// Re-export the shared types so callers that previously imported them
// from this module keep working.
export type { LocatorResult, ModuleCarrier } from "./types.js";
// `BlockDiagnostic` re-export retained for the same reason.
export type { BlockDiagnostic };

function sliceLines(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): string {
  return lines.slice(startLine - 1, endLine).join("\n");
}

/**
 * Locate the Python module docstring, if any. Returns null when there
 * is no usable module — e.g., empty file — and a result with neither
 * carrier nor diagnostic when the file simply has no docstring.
 */
export function pythonModuleLocator(
  filePath: string,
  root: SyntaxNode,
  lines: readonly string[],
): LocatorResult | null {
  if (root.type !== "module") return null;

  for (const child of root.namedChildren) {
    // Skip past `__future__` imports — they're allowed to precede the
    // docstring per PEP 257.
    if (child.type === "future_import_statement") continue;
    if (child.type === "comment") continue; // license headers etc.

    if (child.type === "expression_statement") {
      const inner = child.namedChildren[0];
      if (inner === undefined || inner.type !== "string") {
        return {};
      }
      // F-string detection: tree-sitter-python may include an
      // `interpolation` child, OR the source prefix may be `f`/`F`.
      for (const sc of inner.namedChildren) {
        if (sc.type === "interpolation") return {};
      }
      const startRow = inner.startPosition.row;
      const startCol = inner.startPosition.column;
      const lineText = lines[startRow] ?? "";
      const prefix = lineText.slice(startCol, startCol + 2).toLowerCase();
      if (prefix.startsWith("f")) return {};

      const startLine = startRow + 1;
      const endLine =
        inner.endPosition.column === 0
          ? inner.endPosition.row
          : inner.endPosition.row + 1;
      const raw = sliceLines(lines, startLine, endLine);
      const stripped = raw
        .replace(/^[urbURB]?(?:"""|'''|"|')/, "")
        .replace(/(?:"""|'''|"|')$/, "");
      return {
        carrier: { text: stripped, startLine, endLine },
      };
    }

    // Anything else (an actual statement) → no docstring.
    return {};
  }

  // Empty body — no docstring possible.
  return {};

  // SIVRU-E218 emission is reserved for the case where we cannot reach
  // the module root at all (tree-sitter failure). That path lives in
  // extract.ts (which won't call this function in that case).
  void filePath; // future use for E218 diagnostic location
}
