// Java module-level @sivru block locator (DESIGN-0019 slot 4).
//
// Resolution: Java's package-level documentation lives in
// `package-info.java` as the top-of-file `/** ... */` comment above
// the `package` declaration. We accept that comment as the module-
// level carrier; behavior matches the TypeScript locator (the first
// contiguous comment must sit at file top before any non-comment
// node).
//
// Per design §3 — Java module-level was deferred from v0.6 to v0.6.x;
// slot 4 ships it.

import { basename } from "node:path";

import type { SyntaxNode } from "../../chunker/grammars.js";
import type { LocatorResult } from "./python.js";

function sliceLines(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): string {
  return lines.slice(startLine - 1, endLine).join("\n");
}

/**
 * Locate the module-level @sivru carrier in a Java source file.
 * Returns null when the file is NOT `package-info.java` (Java's
 * per-package documentation convention); other Java files only host
 * per-symbol blocks.
 */
export function javaModuleLocator(
  filePath: string,
  root: SyntaxNode,
  lines: readonly string[],
): LocatorResult | null {
  if (basename(filePath) !== "package-info.java") return null;
  if (root.type !== "program" && root.type !== "source_file") return null;

  let firstRow = -1;
  let lastRow = -1;
  for (const child of root.children) {
    if (child.type === "comment" || child.type === "block_comment" || child.type === "line_comment") {
      const col = child.startPosition.column;
      const lineText = lines[child.startPosition.row] ?? "";
      if (lineText.slice(0, col).trim() !== "") continue;
      const startRow = child.startPosition.row;
      const endRow =
        child.endPosition.column === 0
          ? child.endPosition.row - 1
          : child.endPosition.row;
      if (firstRow === -1) {
        firstRow = startRow;
        lastRow = endRow;
      } else if (startRow === lastRow + 1) {
        lastRow = endRow;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  if (firstRow === -1) return {};

  const startLine = firstRow + 1;
  const endLine = lastRow + 1;
  return {
    carrier: {
      text: sliceLines(lines, startLine, endLine),
      startLine,
      endLine,
    },
  };
}
