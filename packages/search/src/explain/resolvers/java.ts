// Java file-level resolver (DESIGN-0004 §3b / T5).
//
// Scope (v0.5):
//   - imports: every `import` line is captured. Resolution targets only the
//     same compilation source root — the dir that satisfies
//     `<source-root>/<package-path>/<File>.java`. Stdlib (java.*) and
//     third-party packages return null.
//   - exports: top-level type declarations (class / interface / enum) plus
//     `public` method/constructor declarations inside them. The signature
//     line is the chunk's first non-empty line, which is enough for an
//     agent to read off public-API surface.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, resolve as resolvePath } from "node:path";

import type { Chunk } from "../../types.js";
import type { Export, ImportEdge, Resolver } from "../types.js";
import { codeHead } from "./chunk-head.js";

const JAVA_TYPE_NODE_TYPES = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
]);

const JAVA_METHOD_NODE_TYPES = new Set([
  "method_declaration",
  "constructor_declaration",
]);

function nodeTypeToExportKind(nodeType: string): Export["kind"] {
  if (nodeType === "class_declaration") return "class";
  if (nodeType === "interface_declaration") return "type";
  if (nodeType === "enum_declaration") return "type";
  if (nodeType === "method_declaration") return "method";
  if (nodeType === "constructor_declaration") return "method";
  return "other";
}

function signatureFromChunk(chunk: Chunk): string {
  // Past any leading Javadoc / `@sivru` block, not the comment's first line.
  const firstLine = codeHead(chunk.content, 1).split(/\r?\n/)[0];
  if (firstLine === undefined || firstLine.trim().length === 0) return "";
  const trimmed = firstLine.trim();
  return trimmed.length > 200 ? trimmed.slice(0, 197) + "..." : trimmed;
}

function chunkLooksPublic(chunk: Chunk): boolean {
  // Cheap visibility heuristic: scan the first ~3 lines of the chunk content
  // for an explicit access modifier. Lack of any modifier = package-private
  // in Java; we treat that as "not exported" for the public-API view.
  // `codeHead` skips the leading comment carrier first, so a multi-line
  // `@sivru` Javadoc no longer pushes `public` out of the window (which used
  // to drop annotated public members from the index — same bug as TS export).
  const head = codeHead(chunk.content, 3).replace(/\r?\n/g, " ");
  if (/\b(private|protected)\b/.test(head)) return false;
  return /\bpublic\b/.test(head);
}

/**
 * Parse the `package x.y.z;` declaration from a Java source file. Returns the
 * package path as `["x", "y", "z"]`, or `[]` for the default package.
 */
export function parseJavaPackage(source: string): readonly string[] {
  const m = source.match(/^\s*package\s+([\w.]+)\s*;/m);
  if (m === null) return [];
  return m[1]!.split(".");
}

/**
 * Find the compilation source root for `fromFile`. The source root is the
 * directory such that `<source-root>/<package-segments>/<file>` is the file's
 * absolute path. Returns null if the directory layout doesn't match the
 * declared package (which happens for tests with intentionally-misnamed
 * files, or for files in the default package whose location is ambiguous).
 */
export function findJavaSourceRoot(
  fromAbs: string,
  packageSegments: readonly string[],
): string | null {
  if (packageSegments.length === 0) {
    // Default package — the source root is just the file's directory.
    return dirname(fromAbs);
  }
  let dir = dirname(fromAbs);
  for (let i = packageSegments.length - 1; i >= 0; i--) {
    const expected = packageSegments[i]!;
    const base = dir.split(/[\\/]/).pop() ?? "";
    if (base !== expected) return null;
    dir = dirname(dir);
  }
  return dir;
}

/** Capture every top-level `import` statement (single line). */
function extractImportLines(source: string): { raw: string; startLine: number }[] {
  const out: { raw: string; startLine: number }[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*import\s+/.test(line)) {
      out.push({ raw: line.trim(), startLine: i + 1 });
    }
  }
  return out;
}

/** Pull `com.foo.Bar` out of `import com.foo.Bar;` (also handles `import static` / `*`). */
export function extractJavaImportPath(line: string): {
  path: string;
  isWildcard: boolean;
  isStatic: boolean;
} | null {
  const m = line.match(/^\s*import\s+(static\s+)?([\w.]+)(\s*\.\s*\*)?\s*;/);
  if (m === null) return null;
  return {
    path: m[2]!,
    isWildcard: m[3] !== undefined,
    isStatic: m[1] !== undefined,
  };
}

/**
 * Resolve a Java import to a repo-relative `.java` file inside the same
 * source root as the importing file. Wildcard imports resolve to the package
 * *directory* (so the artifact layer can list its files); a non-wildcard
 * import resolves to the specific `.java` file.
 */
export function resolveJavaImport(
  importLine: string,
  fromFile: string,
  repoRoot: string,
  source?: string,
): string | null {
  const parsed = extractJavaImportPath(importLine);
  if (parsed === null) return null;
  const fromAbs = resolvePath(repoRoot, fromFile);
  let src = source;
  if (src === undefined) {
    try {
      src = readFileSync(fromAbs, "utf8");
    } catch {
      return null;
    }
  }
  const pkg = parseJavaPackage(src);
  const srcRoot = findJavaSourceRoot(fromAbs, pkg);
  if (srcRoot === null) return null;

  if (parsed.isWildcard) {
    const pkgDir = join(srcRoot, ...parsed.path.split("."));
    if (!existsSync(pkgDir)) return null;
    try {
      if (!statSync(pkgDir).isDirectory()) return null;
    } catch {
      return null;
    }
    return repoRelative(pkgDir, repoRoot);
  }

  // Non-wildcard: the last segment is normally the class name. For `import
  // static foo.Bar.method` the class is the *second-to-last* segment; we try
  // both shapes.
  const segs = parsed.path.split(".");
  if (segs.length === 0) return null;

  const tryFile = (segments: string[]): string | null => {
    const cls = segments[segments.length - 1]!;
    const dirSegs = segments.slice(0, -1);
    const target = join(srcRoot, ...dirSegs, cls + ".java");
    if (existsSync(target)) {
      try {
        if (statSync(target).isFile()) return repoRelative(target, repoRoot);
      } catch {
        return null;
      }
    }
    return null;
  };

  // Try class-as-last first
  const direct = tryFile(segs);
  if (direct !== null) return direct;

  // Static-member import? Drop the final segment and retry.
  if (parsed.isStatic && segs.length >= 2) {
    return tryFile(segs.slice(0, -1));
  }
  return null;
}

function repoRelative(absPath: string, repoRoot: string): string | null {
  const rootPosix = repoRoot.split(/[\\/]/).join(posix.sep);
  const targetPosix = absPath.split(/[\\/]/).join(posix.sep);
  if (!targetPosix.startsWith(rootPosix)) return null;
  return targetPosix.slice(rootPosix.length).replace(/^\/+/, "");
}

export const javaResolver: Resolver = {
  language: "java",

  resolveImport(
    importStmt: string,
    fromFile: string,
    repoRoot: string,
    source?: string,
  ): string | null {
    return resolveJavaImport(importStmt, fromFile, repoRoot, source);
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
      const isType = JAVA_TYPE_NODE_TYPES.has(nodeType);
      const isMethod = JAVA_METHOD_NODE_TYPES.has(nodeType);
      if (!isType && !isMethod) continue;
      // Methods must be public; top-level type declarations we surface even
      // when package-private — they're still a useful API hint.
      if (isMethod && !chunkLooksPublic(chunk)) continue;
      exports.push({
        name: chunk.symbolName,
        kind: nodeTypeToExportKind(nodeType),
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        signature: signatureFromChunk(chunk),
      });
    }
    const imports = extractImportLines(source).map((stmt) => {
      const parsed = extractJavaImportPath(stmt.raw);
      const identifiers: string[] = [];
      if (parsed !== null && !parsed.isWildcard) {
        const segs = parsed.path.split(".");
        const last = segs[segs.length - 1];
        if (last !== undefined) identifiers.push(last);
      }
      return { raw: stmt.raw, identifiers };
    });
    void filePath;
    return { exports, imports };
  },
};
