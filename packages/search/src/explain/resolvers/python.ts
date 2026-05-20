// Python file-level resolver (DESIGN-0004 §3b / T3).
//
// Scope (v0.5):
//   - relative imports (`from .x import y`, `from ..pkg import z`) resolved
//     against the importing file's directory
//   - absolute imports (`import foo`, `from foo.bar import baz`) are left
//     unresolved (null) — Python's import path depends on `sys.path` /
//     setup.cfg / pyproject configuration that v0.5 does not parse. Footer
//     surfaces the limitation.
//   - exports = top-level `function_definition` / `class_definition` whose
//     name does not start with `_` (PEP 8 public-API convention)

import { existsSync, statSync } from "node:fs";
import { dirname, join, posix, resolve as resolvePath } from "node:path";

import type { Chunk } from "../../types.js";
import type { Export, ImportEdge, Resolver } from "../types.js";

const PY_EXPORTABLE_NODE_TYPES = new Set([
  "function_definition",
  "class_definition",
]);

function nodeTypeToExportKind(nodeType: string): Export["kind"] {
  if (nodeType === "function_definition") return "function";
  if (nodeType === "class_definition") return "class";
  return "other";
}

function signatureFromChunk(chunk: Chunk): string {
  const firstLine = chunk.content.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (firstLine === undefined) return "";
  const trimmed = firstLine.trim();
  return trimmed.length > 200 ? trimmed.slice(0, 197) + "..." : trimmed;
}

/** Find one of `<base>.py` / `<base>/__init__.py` on disk. Returns the absolute path or null. */
function probePyTarget(baseAbs: string): string | null {
  const pyFile = baseAbs + ".py";
  if (existsSync(pyFile) && statSync(pyFile).isFile()) return pyFile;
  const pyiFile = baseAbs + ".pyi";
  if (existsSync(pyiFile) && statSync(pyiFile).isFile()) return pyiFile;
  // Package: `<base>/__init__.py`
  if (existsSync(baseAbs)) {
    try {
      if (statSync(baseAbs).isDirectory()) {
        const initPy = join(baseAbs, "__init__.py");
        if (existsSync(initPy) && statSync(initPy).isFile()) return initPy;
        const initPyi = join(baseAbs, "__init__.pyi");
        if (existsSync(initPyi) && statSync(initPyi).isFile()) return initPyi;
      }
    } catch {
      /* ignore — fall through */
    }
  }
  return null;
}

/**
 * Parse the leading dot run + dotted module name out of a `from ... import …`
 * statement. Returns `{ leadingDots, module }` where `module` may be the empty
 * string for bare `from . import x` forms.
 */
export function parseFromSpec(stmt: string): {
  leadingDots: number;
  module: string;
  identifiers: string[];
} | null {
  // Match: from <dots><module> import <names>
  const m = stmt.match(/^\s*from\s+(\.+)?([A-Za-z_][\w.]*)?\s+import\s+(.+?)(?:\s*#.*)?$/);
  if (m === null) return null;
  const leadingDots = m[1]?.length ?? 0;
  const module = m[2] ?? "";
  const namesText = m[3]!.trim();
  // `from foo import *` — no specific identifiers
  if (namesText === "*") return { leadingDots, module, identifiers: [] };
  // Strip enclosing parens for the multi-line `from x import (a, b,)` form
  const cleaned = namesText.replace(/^\(|\)$/g, "");
  const identifiers: string[] = [];
  for (const part of cleaned.split(",")) {
    const piece = part.trim();
    if (piece.length === 0) continue;
    const aliased = piece.match(/^([A-Za-z_][\w]*)\s+as\s+([A-Za-z_][\w]*)$/);
    if (aliased !== null) {
      identifiers.push(aliased[2]!);
    } else {
      const plain = piece.match(/^([A-Za-z_][\w]*)$/);
      if (plain !== null) identifiers.push(plain[1]!);
    }
  }
  return { leadingDots, module, identifiers };
}

/**
 * Parse an `import x` / `import x.y as z` line. Returns the bound local name
 * and the dotted module path.
 */
export function parseImportSpec(stmt: string): {
  module: string;
  localNames: string[];
} | null {
  const m = stmt.match(/^\s*import\s+(.+?)(?:\s*#.*)?$/);
  if (m === null) return null;
  // `import a, b as c, d.e` — at most we resolve the *first* module per stmt
  // for v0.5; complex multi-import lines are rare in idiomatic Python.
  const parts = m[1]!.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const first = parts[0]!;
  const aliased = first.match(/^([\w.]+)\s+as\s+([A-Za-z_]\w*)$/);
  const localNames: string[] = [];
  let module: string;
  if (aliased !== null) {
    module = aliased[1]!;
    localNames.push(aliased[2]!);
  } else {
    module = first;
    // `import a.b.c` binds the *top* name `a` in the local namespace
    const top = module.split(".")[0];
    if (top !== undefined && top.length > 0) localNames.push(top);
  }
  return { module, localNames };
}

/**
 * Walk a Python source file for import statements at indent level 0 (we leave
 * conditional / late imports inside functions alone — they're noise for the
 * call-graph view).
 */
function extractImportStatements(source: string): {
  raw: string;
  startLine: number;
}[] {
  const out: { raw: string; startLine: number }[] = [];
  const lines = source.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // Only top-level imports (no leading whitespace).
    if (/^\s+/.test(line)) {
      i++;
      continue;
    }
    const trimmed = line.trim();
    const start = i;
    if (trimmed.startsWith("from ") && trimmed.includes(" import ")) {
      let raw = line;
      // Multi-line `from x import (` form
      if (/\(\s*$/.test(trimmed)) {
        while (i + 1 < lines.length && !/\)/.test(lines[i + 1] ?? "")) {
          i++;
          raw += "\n" + lines[i];
        }
        if (i + 1 < lines.length) {
          i++;
          raw += "\n" + lines[i];
        }
      }
      out.push({ raw, startLine: start + 1 });
    } else if (trimmed.startsWith("import ")) {
      out.push({ raw: line, startLine: start + 1 });
    }
    i++;
  }
  return out;
}

export const pythonResolver: Resolver = {
  language: "python",

  resolveImport(importStmt: string, fromFile: string, repoRoot: string): string | null {
    // Absolute imports are unresolved in v0.5 (footer documents).
    const trimmed = importStmt.trim();
    if (!trimmed.startsWith("from ")) {
      // `import foo[.bar]` — absolute; out of scope.
      return null;
    }
    const parsed = parseFromSpec(trimmed);
    if (parsed === null) return null;
    if (parsed.leadingDots === 0) return null; // absolute
    const fromAbs = resolvePath(repoRoot, fromFile);
    let dir = dirname(fromAbs);
    // `from . import x` → leadingDots=1 means current package dir (no walk-up)
    // `from .. import x` → leadingDots=2 walks up one level
    for (let i = 1; i < parsed.leadingDots; i++) {
      dir = dirname(dir);
    }
    const segments = parsed.module.length > 0 ? parsed.module.split(".") : [];
    const baseAbs = segments.length === 0 ? dir : join(dir, ...segments);
    const probed = probePyTarget(baseAbs);
    if (probed === null) return null;
    const rootPosix = repoRoot.split(/[\\/]/).join(posix.sep);
    const probedPosix = probed.split(/[\\/]/).join(posix.sep);
    if (!probedPosix.startsWith(rootPosix)) return null;
    return probedPosix.slice(rootPosix.length).replace(/^\/+/, "");
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
      if (!PY_EXPORTABLE_NODE_TYPES.has(nodeType)) continue;
      // PEP 8 convention: a leading underscore is a private symbol. Names with
      // a dunder pattern (e.g. `__init__`) are also not part of the public
      // module API.
      if (chunk.symbolName.startsWith("_")) continue;
      exports.push({
        name: chunk.symbolName,
        kind: nodeTypeToExportKind(nodeType),
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        signature: signatureFromChunk(chunk),
      });
    }
    const imports = extractImportStatements(source).map((stmt) => {
      const trimmed = stmt.raw.trim();
      let identifiers: string[] = [];
      if (trimmed.startsWith("from ")) {
        const parsed = parseFromSpec(trimmed);
        if (parsed !== null) identifiers = parsed.identifiers;
      } else {
        const parsed = parseImportSpec(trimmed);
        if (parsed !== null) identifiers = parsed.localNames;
      }
      return { raw: stmt.raw, identifiers };
    });
    void filePath;
    return { exports, imports };
  },
};
