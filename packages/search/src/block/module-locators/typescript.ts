// TypeScript / JavaScript module-level @sivru block locator
// (DESIGN-0016 §3, E1, A2).
//
// Resolution: the locator is given the parsed top-of-file. It returns
// the first contiguous `/** */` (or `///` / `//`) block comment if it
// sits at the very top of the file (before any non-trivia node). The
// caller (extract.ts) is responsible for choosing WHICH file is the
// package's entry point — typically the package.json `main`, falling
// back to `src/index.ts`, then `index.ts`. This locator runs against
// whatever file the caller resolved.
//
// `exports` subpath entries are deferred to v0.6.x.

import type { SyntaxNode } from "../../chunker/grammars.js";
import type { LocatorResult } from "./python.js";

function sliceLines(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): string {
  return lines.slice(startLine - 1, endLine).join("\n");
}

export function typescriptModuleLocator(
  filePath: string,
  root: SyntaxNode,
  lines: readonly string[],
): LocatorResult | null {
  if (
    root.type !== "program" &&
    root.type !== "module" &&
    root.type !== "source_file"
  ) {
    return null;
  }

  // Collect the leading contiguous own-line comments from the very top.
  // Tree-sitter-typescript emits comments as named children of `program`.
  let firstRow = -1;
  let lastRow = -1;
  for (const child of root.children) {
    if (child.type === "comment" || child.type.endsWith("_comment")) {
      const col = child.startPosition.column;
      const lineText = lines[child.startPosition.row] ?? "";
      if (lineText.slice(0, col).trim() !== "") {
        // Trailing comment — skip.
        continue;
      }
      const startRow = child.startPosition.row;
      const endRow =
        child.endPosition.column === 0
          ? child.endPosition.row - 1
          : child.endPosition.row;
      if (firstRow === -1) {
        firstRow = startRow;
        lastRow = endRow;
      } else if (startRow === lastRow + 1) {
        // Contiguous next comment.
        lastRow = endRow;
      } else {
        // Gap — stop collecting.
        break;
      }
    } else {
      // First non-comment node ends the top-of-file run.
      break;
    }
  }

  if (firstRow === -1) {
    return {};
  }

  // Module-level only if the comment block is followed by a BLANK line
  // before any declaration. Without that gap the comment is the leading
  // doc-comment carrier of the next symbol (per-symbol path picks it up)
  // and a module block here would double-count.
  const nextLineText = lines[lastRow + 1];
  if (nextLineText !== undefined && nextLineText.trim() !== "") {
    return {};
  }

  const startLine = firstRow + 1;
  const endLine = lastRow + 1;
  return {
    carrier: {
      text: sliceLines(lines, startLine, endLine),
      startLine,
      endLine,
    },
  };

  void filePath;
}
