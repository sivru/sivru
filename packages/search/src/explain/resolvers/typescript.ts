// TS / JS file-level resolver (DESIGN-0004 §3b).
//
// Scope (v0.5):
//   - relative imports (`./foo`, `../bar`) only; tsconfig `paths` aliases
//     deferred to v0.5.x (footer surfaces the limitation)
//   - identifier extraction via lightweight regex over the import source
//     line — best-effort, no full TS parse on the import path
//   - exports = chunker's tree-sitter `Chunk[]` with `symbolName` defined
//     filtered to declaration node-types known to be exportable

import { existsSync, statSync } from "node:fs";
import { dirname, join, posix, resolve as resolvePath } from "node:path";

import type { Chunk } from "../../types.js";
import type { Export, Resolver } from "../types.js";
import { codeHead } from "./chunk-head.js";

// Tree-sitter `nodeType` values the chunker produces for exportable
// declarations in TS/JS. The chunker uses TypeScript and JavaScript
// grammars; the union covers both.
const TS_JS_EXPORTABLE_NODE_TYPES = new Set([
  "function_declaration",
  "method_definition",
  "method_signature",
  "class_declaration",
  "lexical_declaration",
  "variable_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "generator_function_declaration",
  "abstract_class_declaration",
  "export_statement",
]);

function nodeTypeToExportKind(nodeType: string): Export["kind"] {
  if (
    nodeType === "function_declaration" ||
    nodeType === "generator_function_declaration"
  )
    return "function";
  if (
    nodeType === "class_declaration" ||
    nodeType === "abstract_class_declaration"
  )
    return "class";
  if (nodeType === "method_definition" || nodeType === "method_signature")
    return "method";
  if (
    nodeType === "interface_declaration" ||
    nodeType === "type_alias_declaration" ||
    nodeType === "enum_declaration"
  )
    return "type";
  if (
    nodeType === "lexical_declaration" ||
    nodeType === "variable_declaration"
  )
    return "const";
  return "other";
}

/**
 * Pull the first non-empty CODE line of a chunk as the signature — past any
 * leading `@sivru`/JSDoc comment. Strips leading whitespace; truncates if the
 * line is unusually long.
 */
function signatureFromChunk(chunk: Chunk): string {
  const firstLine = codeHead(chunk.content, 1).split(/\r?\n/)[0];
  if (firstLine === undefined || firstLine.trim().length === 0) return "";
  const trimmed = firstLine.trim();
  return trimmed.length > 200 ? trimmed.slice(0, 197) + "..." : trimmed;
}

const EXTENSIONS_TS_JS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const INDEX_FILES_TS_JS = EXTENSIONS_TS_JS.map((ext) => `index${ext}`);

/**
 * Resolve a relative TS/JS import specifier (after stripping `.js`/`.ts`
 * extensions that may or may not be present) to a concrete on-disk file.
 *
 * Returns the absolute path on disk, or `null` if nothing matches.
 */
function probeRelativeImport(specRel: string, fromDir: string): string | null {
  const baseAbs = resolvePath(fromDir, specRel);
  // Exact match (with extension)
  if (existsSync(baseAbs) && statSync(baseAbs).isFile()) return baseAbs;
  // Strip .js / .mjs / .cjs that may need to be re-mapped to .ts (NodeNext)
  const explicitExtMatch = baseAbs.match(/\.(m|c)?(js|ts)x?$/);
  if (explicitExtMatch !== null) {
    const stem = baseAbs.replace(/\.(m|c)?(js|ts)x?$/, "");
    for (const ext of EXTENSIONS_TS_JS) {
      const candidate = stem + ext;
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  // Try each extension on the un-extensioned base
  for (const ext of EXTENSIONS_TS_JS) {
    const candidate = baseAbs + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  // Try index.* if base is a directory
  if (existsSync(baseAbs)) {
    try {
      const s = statSync(baseAbs);
      if (s.isDirectory()) {
        for (const idx of INDEX_FILES_TS_JS) {
          const candidate = join(baseAbs, idx);
          if (existsSync(candidate) && statSync(candidate).isFile())
            return candidate;
        }
      }
    } catch {
      /* ignore — fall through to null */
    }
  }
  return null;
}

/**
 * Extract the identifiers brought into scope by one import statement.
 * Pragmatic regex pass — TS source we care about is well-formed so the
 * common shapes are all we need.
 */
export function extractImportedIdentifiers(importStmt: string): string[] {
  const stmt = importStmt.trim();
  // Side-effect import (no identifiers)
  if (/^import\s+["']/.test(stmt)) return [];
  // Default import: `import Foo from '...'` or `import Foo, { ... } from '...'`
  const def = stmt.match(/^import\s+([A-Za-z_$][\w$]*)(?:\s*,|\s+from)/);
  // Namespace import: `import * as Foo from '...'` or `import Default, * as Foo from '...'`
  const ns = stmt.match(/\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/);
  // Named imports: `import { a, b as c } from '...'` (single or multi line)
  const namedBraces = stmt.match(/^import\s+[\w$* ,{}\s]*\{([^}]*)\}/);
  const ids: string[] = [];
  if (def !== null) ids.push(def[1]!);
  if (ns !== null) ids.push(ns[1]!);
  if (namedBraces !== null) {
    const inside = namedBraces[1]!;
    for (const part of inside.split(",")) {
      const piece = part.trim();
      if (piece.length === 0) continue;
      // `foo as bar`  → bar (local name); `foo` → foo
      const m = piece.match(/^(?:[A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (m !== null) {
        ids.push(m[1]!);
      } else {
        const n = piece.match(/^([A-Za-z_$][\w$]*)$/);
        if (n !== null) ids.push(n[1]!);
      }
    }
  }
  return ids;
}

/**
 * Extract `from "..."` specifier from an import statement. Returns `null`
 * when no specifier is found (e.g. `export default foo;`).
 */
export function extractImportSpecifier(importStmt: string): string | null {
  const m = importStmt.match(/from\s+["']([^"']+)["']/);
  if (m !== null) return m[1]!;
  // Side-effect form: `import "./foo.css"`
  const s = importStmt.match(/^\s*import\s+["']([^"']+)["']/);
  if (s !== null) return s[1]!;
  return null;
}

/** Match every `import …` / `export … from …` statement in a TS/JS file. */
const IMPORT_REGEX =
  /(?:^|\n)\s*(?:import\s+[^;]*?["'][^"']+["']\s*;?|export\s+(?:\*|\{[^}]*\})\s+from\s+["'][^"']+["']\s*;?)/g;

function extractImportStatements(source: string): {
  raw: string;
  startLine: number;
}[] {
  // Naive but effective: find import / export-from statements at line starts.
  // Doesn't parse a TS AST — works for the well-formed source we index.
  const out: { raw: string; startLine: number }[] = [];
  const lines = source.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (
      trimmed.startsWith("import ") ||
      trimmed.startsWith("import{") ||
      trimmed.startsWith('import"') ||
      trimmed.startsWith("import'") ||
      (trimmed.startsWith("export ") && trimmed.includes(" from "))
    ) {
      // Gobble up continuation lines until we hit a `;` or a `from "..."`
      const start = i;
      let raw = line;
      // Find the closing pattern on this line or following lines
      while (
        i < lines.length &&
        !/from\s+["'][^"']+["']\s*;?\s*$/.test(lines[i]!.trim()) &&
        !/import\s+["'][^"']+["']\s*;?\s*$/.test(lines[i]!.trim())
      ) {
        i++;
        if (i < lines.length) raw += "\n" + lines[i]!;
        if (i - start > 20) break; // guard
      }
      out.push({ raw, startLine: start + 1 });
    }
    i++;
  }
  return out;
}

export const typescriptResolver: Resolver = {
  language: "typescript",

  resolveImport(
    importStmt: string,
    fromFile: string,
    repoRoot: string,
  ): string | null {
    const spec = extractImportSpecifier(importStmt);
    if (spec === null) return null;
    // Bare specifier (`react`, `node:fs`, etc.) — out of scope for v0.5
    // (footer notes path-alias deferral).
    if (!spec.startsWith(".")) return null;
    const fromAbs = resolvePath(repoRoot, fromFile);
    const fromDir = dirname(fromAbs);
    const probed = probeRelativeImport(spec, fromDir);
    if (probed === null) return null;
    // Return repo-relative POSIX path
    const rootPosix = repoRoot.split(/[\\/]/).join(posix.sep);
    const probedPosix = probed.split(/[\\/]/).join(posix.sep);
    if (!probedPosix.startsWith(rootPosix)) return null;
    const rel = probedPosix.slice(rootPosix.length).replace(/^\/+/, "");
    return rel;
  },

  parseFile(
    filePath: string,
    source: string,
    chunks: readonly Chunk[],
  ): {
    exports: Export[];
    imports: Omit<import("../types.js").ImportEdge, "resolved">[];
  } {
    const exports: Export[] = [];
    for (const chunk of chunks) {
      if (chunk.kind !== "tree-sitter") continue;
      if (chunk.symbolName === undefined) continue;
      const nodeType = chunk.nodeType;
      if (nodeType === undefined) continue;
      if (!TS_JS_EXPORTABLE_NODE_TYPES.has(nodeType)) continue;
      // Determine if the chunk is actually exported: the chunker preserves
      // a leading doc comment + `export` keyword in `chunk.content`. Cheap
      // string check is good enough — false positives are tolerable here
      // (we surface "public_api"; the agent can still see non-exported
      // declarations as informational context). `codeHead` skips the leading
      // comment carrier first, so a long `@sivru` block no longer pushes the
      // `export` keyword out of the window (BUG: annotated symbols dropped).
      const isExported = /\bexport\b/.test(codeHead(chunk.content, 5));
      if (!isExported) continue;
      exports.push({
        name: chunk.symbolName,
        kind: nodeTypeToExportKind(nodeType),
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        signature: signatureFromChunk(chunk),
      });
    }
    const imports = extractImportStatements(source).map((stmt) => ({
      raw: stmt.raw,
      identifiers: extractImportedIdentifiers(stmt.raw),
    }));
    void filePath;
    return { exports, imports };
  },
};
