// Shared chunk-head helper for the export/visibility resolvers.
//
// The tree-sitter chunker prepends a symbol's leading doc-comment to
// `chunk.content` (DESIGN-0016). Resolvers that decide "is this exported /
// public?" or that pull a signature line by scanning the FIRST few lines of
// the chunk were silently defeated by this: a multi-line `@sivru` block (7+
// lines) pushes the real declaration — and its `export` / `public` keyword —
// past a small fixed head window, so the symbol was dropped from the index
// (absent from public_api; region explain 404'd on exactly the annotated
// symbols). `codeHead` skips the leading comment carrier first.
//
// Comment forms handled: C-style block comments (`/* … */`, `/** … */`,
// single- or multi-line) and `//` line comments. Python `#` / `"""` are NOT
// handled here on purpose — `#` is a private-field sigil in JS/TS, and the
// Python resolver does not need this (its declaration line precedes the
// docstring).

export function codeHead(content: string, n: number): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of content.split(/\r?\n/)) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) continue; // still inside the block comment
      line = line.slice(end + 2);
      inBlock = false;
    }
    line = line.replace(/\/\*.*?\*\//g, " "); // complete inline block comments
    const open = line.indexOf("/*");
    if (open !== -1) {
      inBlock = true; // an unterminated block comment opens a multi-line skip
      line = line.slice(0, open);
    }
    line = line.replace(/\/\/.*$/, ""); // trailing line comment
    if (line.trim().length === 0) continue;
    out.push(line);
    if (out.length >= n) break;
  }
  return out.join("\n");
}
