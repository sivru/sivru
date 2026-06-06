// Go file-level resolver (DESIGN-0004 §3b / T4).
//
// Scope (v0.5):
//   - imports: every `import "..."` statement (single or grouped) is captured;
//     resolution to a repo-relative path is attempted only when the import
//     path is prefixed by the module name from the closest enclosing
//     `go.mod`. Standard library + third-party paths return null.
//   - exports: capitalized top-level symbols (Go's public-API convention) —
//     function_declaration, method_declaration, type_declaration nodes whose
//     symbolName begins with an uppercase letter.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, resolve as resolvePath, sep } from "node:path";

import type { Chunk } from "../../types.js";
import type { Export, ImportEdge, Resolver } from "../types.js";
import { codeHead } from "./chunk-head.js";

const GO_EXPORTABLE_NODE_TYPES = new Set([
  "function_declaration",
  "method_declaration",
  "type_declaration",
]);

function nodeTypeToExportKind(nodeType: string): Export["kind"] {
  if (nodeType === "function_declaration") return "function";
  if (nodeType === "method_declaration") return "method";
  if (nodeType === "type_declaration") return "type";
  return "other";
}

function signatureFromChunk(chunk: Chunk): string {
  // Past any leading `//` doc-comment / `@sivru` block, not the comment line.
  const firstLine = codeHead(chunk.content, 1).split(/\r?\n/)[0];
  if (firstLine === undefined || firstLine.trim().length === 0) return "";
  const trimmed = firstLine.trim();
  return trimmed.length > 200 ? trimmed.slice(0, 197) + "..." : trimmed;
}

function startsWithUpper(name: string): boolean {
  if (name.length === 0) return false;
  const ch = name[0]!;
  return ch >= "A" && ch <= "Z";
}

/**
 * Cache go.mod module-path lookups by directory. Resolution walks up from the
 * importing file's dir to find the closest `go.mod`; results are memoised so
 * `buildSymbolIndex` is O(go.mod count), not O(file count).
 */
const goModCache = new Map<string, { dir: string; module: string } | null>();

/** Find module path + module root by walking up from `dir` for a `go.mod`. */
export function findGoModule(
  dir: string,
  repoRoot: string,
): { dir: string; module: string } | null {
  const cached = goModCache.get(dir);
  if (cached !== undefined) return cached;
  let current = dir;
  const repoSlash = repoRoot.endsWith(sep) ? repoRoot : repoRoot + sep;
  while (current.length >= repoRoot.length) {
    const candidate = join(current, "go.mod");
    if (existsSync(candidate)) {
      try {
        const text = readFileSync(candidate, "utf8");
        const m = text.match(/^\s*module\s+(\S+)/m);
        if (m !== null) {
          const result = { dir: current, module: m[1]! };
          goModCache.set(dir, result);
          return result;
        }
      } catch {
        /* unreadable — fall through and try the parent */
      }
    }
    if (current === repoRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    if (!parent.startsWith(repoSlash) && parent !== repoRoot) break;
    current = parent;
  }
  goModCache.set(dir, null);
  return null;
}

/** Extract the import path from a single Go import line, e.g. `_ "foo/bar"` → `foo/bar`. */
export function extractGoImportPath(line: string): string | null {
  const m = line.match(/["`]([^"`]+)["`]/);
  return m === null ? null : m[1]!;
}

/**
 * Capture every Go import statement — both the `import "x"` single form and
 * the `import ( ... )` group form.
 */
function extractImportLines(source: string): { raw: string; startLine: number }[] {
  const out: { raw: string; startLine: number }[] = [];
  const lines = source.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("import ")) {
      // Grouped form: `import (` ... `)`
      if (trimmed.includes("(")) {
        let j = i + 1;
        while (j < lines.length && !lines[j]!.includes(")")) {
          const innerTrim = lines[j]!.trim();
          if (innerTrim.length > 0 && extractGoImportPath(innerTrim) !== null) {
            out.push({ raw: innerTrim, startLine: j + 1 });
          }
          j++;
        }
        i = j + 1;
        continue;
      }
      // Single form: `import "x"` or `import alias "x"`
      out.push({ raw: trimmed, startLine: i + 1 });
    }
    i++;
  }
  return out;
}

/**
 * Resolve a Go import path against the module declared in the nearest go.mod.
 * Returns the repo-relative directory of the target package or null.
 *
 * Note: Go imports name *directories* (packages), not files. The "resolved"
 * field here is therefore a directory path — the artifact layer (T8) maps
 * directories to their constituent files.
 */
export function resolveGoImport(
  importPath: string,
  fromFile: string,
  repoRoot: string,
): string | null {
  const fromAbs = resolvePath(repoRoot, fromFile);
  const fromDir = dirname(fromAbs);
  const mod = findGoModule(fromDir, repoRoot);
  if (mod === null) return null;
  if (!importPath.startsWith(mod.module)) return null;
  const tail = importPath.slice(mod.module.length).replace(/^\//, "");
  const targetDir = tail.length === 0 ? mod.dir : join(mod.dir, tail);
  if (!existsSync(targetDir)) return null;
  try {
    if (!statSync(targetDir).isDirectory()) return null;
  } catch {
    return null;
  }
  const rootPosix = repoRoot.split(/[\\/]/).join(posix.sep);
  const targetPosix = targetDir.split(/[\\/]/).join(posix.sep);
  if (!targetPosix.startsWith(rootPosix)) return null;
  return targetPosix.slice(rootPosix.length).replace(/^\/+/, "");
}

export const goResolver: Resolver = {
  language: "go",

  resolveImport(importStmt: string, fromFile: string, repoRoot: string): string | null {
    const importPath = extractGoImportPath(importStmt);
    if (importPath === null) return null;
    return resolveGoImport(importPath, fromFile, repoRoot);
  },

  parseFile(
    filePath: string,
    source: string,
    chunks: readonly Chunk[],
  ): { exports: Export[]; imports: Omit<ImportEdge, "resolved">[] } {
    const exports: Export[] = [];
    for (const chunk of chunks) {
      if (chunk.kind !== "tree-sitter") continue;
      if (chunk.symbolName === undefined) continue;
      const nodeType = chunk.nodeType;
      if (nodeType === undefined) continue;
      if (!GO_EXPORTABLE_NODE_TYPES.has(nodeType)) continue;
      if (!startsWithUpper(chunk.symbolName)) continue;
      exports.push({
        name: chunk.symbolName,
        kind: nodeTypeToExportKind(nodeType),
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        signature: signatureFromChunk(chunk),
      });
    }
    const imports = extractImportLines(source).map((stmt) => {
      const path = extractGoImportPath(stmt.raw);
      return {
        raw: stmt.raw,
        identifiers: path === null ? [] : [path.split("/").pop() ?? path],
      };
    });
    void filePath;
    return { exports, imports };
  },
};

/** Test hook: reset go.mod cache between tests. */
export function _resetGoModCacheForTests(): void {
  goModCache.clear();
}
