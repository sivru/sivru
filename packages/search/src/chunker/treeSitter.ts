// Tree-sitter chunker. Parses a file, emits one chunk per top-level
// definition (function / class / method), and gap-fills every line range
// no node covers so the file is always indexed in full. See DESIGN-0001.
//
// Coverage invariant: every source line lands in exactly one chunk.
//   - Whitelisted AST nodes (grammars.ts) → `kind: "tree-sitter"` chunks,
//     carrying `nodeType` + `symbolName`, with the leading doc comment
//     attached.
//   - A container (class) holding members is not chunked whole — its
//     members become chunks, its scaffolding becomes gap-fill.
//   - An oversized node is line-windowed over its own range (D5).
//   - Lines outside every node chunk → `kind: "line"` gap chunks (D3).

import type { Chunk, ChunkOptions } from "../types.js";
import {
  CONTAINER_TYPES,
  NODE_TYPES_TO_CHUNK,
  getParser,
  loadGrammar,
  type NodeRule,
  type SyntaxNode,
} from "./grammars.js";
import { windowLines } from "./lineFallback.js";

const DEFAULT_MAX_LINES = 50;
const DEFAULT_OVERLAP_LINES = 5;

/**
 * A whitelisted node spanning more lines than this is line-windowed over
 * its own range rather than emitted as one chunk (DESIGN-0001 D5). A
 * generous fixed cap for v0.2; v0.3 (per-model chunk-windowing) refines
 * it to the embedder's context window.
 */
const MAX_NODE_LINES = 200;

/** True when `node`'s type satisfies any rule (predicate rules included). */
function matchesAnyRule(node: SyntaxNode, rules: readonly NodeRule[]): boolean {
  for (const rule of rules) {
    if (typeof rule === "string") {
      if (node.type === rule) return true;
    } else if (node.type === rule.type && rule.when(node)) {
      return true;
    }
  }
  return false;
}

/** True when any *descendant* of `node` (not `node` itself) is whitelisted. */
function hasWhitelistedDescendant(
  node: SyntaxNode,
  rules: readonly NodeRule[],
): boolean {
  for (const child of node.namedChildren) {
    if (matchesAnyRule(child, rules)) return true;
    if (hasWhitelistedDescendant(child, rules)) return true;
  }
  return false;
}

/**
 * Walk the tree collecting the nodes that become chunks. A whitelisted
 * container with whitelisted members is descended into (members chunked
 * individually); every other whitelisted node is chunked whole and not
 * descended into (so a function's inner functions stay in one chunk).
 */
function collectChunkNodes(
  node: SyntaxNode,
  rules: readonly NodeRule[],
  out: SyntaxNode[],
): void {
  if (matchesAnyRule(node, rules)) {
    if (CONTAINER_TYPES.has(node.type) && hasWhitelistedDescendant(node, rules)) {
      for (const child of node.namedChildren) collectChunkNodes(child, rules, out);
    } else {
      out.push(node);
    }
    return;
  }
  for (const child of node.namedChildren) collectChunkNodes(child, rules, out);
}

/** Symbol name from a node's identifier, with per-type fallbacks. */
function symbolNameOf(node: SyntaxNode): string | undefined {
  const direct = node.childForFieldName("name");
  if (direct !== null) return direct.text;
  // `lexical_declaration` / `type_declaration` carry the name one level
  // down, on the declarator / spec.
  if (node.type === "lexical_declaration") {
    for (const d of node.namedChildren) {
      if (d.type !== "variable_declarator") continue;
      const n = d.childForFieldName("name");
      if (n !== null) return n.text;
    }
  }
  if (node.type === "type_declaration") {
    for (const s of node.namedChildren) {
      const n = s.childForFieldName("name");
      if (n !== null) return n.text;
    }
  }
  return undefined;
}

type CommentRange = { startLine: number; endLine: number };

/**
 * Index of own-line comment ranges by the line they END on. "Own-line"
 * means nothing but whitespace precedes the comment on its first line —
 * trailing comments (`x = 1 // note`) are excluded so they are never
 * mistaken for a doc comment.
 */
function indexComments(node: SyntaxNode, lines: readonly string[]): Map<number, CommentRange> {
  const byEndLine = new Map<number, CommentRange>();
  const visit = (n: SyntaxNode): void => {
    if (n.type === "comment" || n.type.endsWith("_comment")) {
      const startLine = n.startPosition.row + 1;
      const endLine = n.endPosition.column === 0 ? n.endPosition.row : n.endPosition.row + 1;
      const before = lines[startLine - 1]?.slice(0, n.startPosition.column) ?? "";
      if (before.trim() === "") byEndLine.set(endLine, { startLine, endLine });
    }
    for (const child of n.namedChildren) visit(child);
  };
  visit(node);
  return byEndLine;
}

/** Walk contiguous own-line comments upward from `startLine`. */
function attachLeadingComment(
  startLine: number,
  comments: Map<number, CommentRange>,
): number {
  let s = startLine;
  for (;;) {
    const c = comments.get(s - 1);
    if (c === undefined) break;
    s = c.startLine;
  }
  return s;
}

function lineContent(lines: readonly string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join("\n");
}

/**
 * Chunk `content` with tree-sitter. `language` must have a bundled
 * grammar (`isChunkableLanguage`). Always returns full line coverage.
 *
 * @throws if the grammar fails to load or the parser fails — the
 *   `chunkFile` facade catches this and falls back to line chunks.
 */
export async function treeSitterChunks(
  filePath: string,
  content: string,
  language: string,
  options: ChunkOptions = {},
): Promise<Chunk[]> {
  if (content.length === 0) return [];

  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0 || lines.every((l) => l === "")) return [];
  const totalLines = lines.length;

  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const overlap = options.overlapLines ?? DEFAULT_OVERLAP_LINES;

  const rules = NODE_TYPES_TO_CHUNK[language];
  if (rules === undefined) {
    throw new Error(`SIVRU-E1001: no node-type whitelist for language "${language}"`);
  }

  const parser = await getParser();
  parser.setLanguage(await loadGrammar(language));

  const tree = parser.parse(content);
  try {
    const nodes: SyntaxNode[] = [];
    collectChunkNodes(tree.rootNode, rules, nodes);
    const comments = indexComments(tree.rootNode, lines);

    // Resolve each node to an attached, clamped line range. Sort by start
    // so gap computation and the final merge are straightforward.
    const ranges = nodes
      .map((node) => {
        const rawStart = node.startPosition.row + 1;
        const endLine = Math.min(
          Math.max(
            node.endPosition.column === 0
              ? node.endPosition.row
              : node.endPosition.row + 1,
            rawStart,
          ),
          totalLines,
        );
        const startLine = Math.max(1, attachLeadingComment(rawStart, comments));
        return { startLine, endLine, nodeType: node.type, symbolName: symbolNameOf(node) };
      })
      .sort((a, b) => a.startLine - b.startLine);

    const chunks: Chunk[] = [];

    const pushNodeChunk = (
      startLine: number,
      endLine: number,
      nodeType: string,
      symbolName: string | undefined,
    ): void => {
      const extra = {
        ...(nodeType !== undefined ? { nodeType } : {}),
        ...(symbolName !== undefined ? { symbolName } : {}),
      };
      if (endLine - startLine + 1 > MAX_NODE_LINES) {
        // Oversized node (D5): line-window its own range; sub-chunks keep
        // node identity.
        for (const piece of windowLines(
          lines,
          filePath,
          language,
          startLine,
          endLine,
          maxLines,
          overlap,
        )) {
          chunks.push({ ...piece, kind: "tree-sitter", ...extra });
        }
        return;
      }
      chunks.push({
        filePath,
        startLine,
        endLine,
        language,
        content: lineContent(lines, startLine, endLine),
        kind: "tree-sitter",
        ...extra,
      });
    };

    // Emit node chunks and gap-fill the line ranges between them. `cursor`
    // is the next uncovered line; any range below a node's start is a gap.
    let cursor = 1;
    for (const r of ranges) {
      // Comment attachment can pull a later node's start above an earlier
      // node's end only via overlapping ranges, which the container logic
      // prevents — but clamp defensively so coverage never double-counts.
      const startLine = Math.max(r.startLine, cursor);
      if (startLine > cursor) {
        chunks.push(
          ...windowLines(lines, filePath, language, cursor, startLine - 1, maxLines, overlap),
        );
      }
      if (r.endLine >= startLine) {
        pushNodeChunk(startLine, r.endLine, r.nodeType, r.symbolName);
        cursor = r.endLine + 1;
      }
    }
    if (cursor <= totalLines) {
      chunks.push(
        ...windowLines(lines, filePath, language, cursor, totalLines, maxLines, overlap),
      );
    }

    chunks.sort((a, b) => a.startLine - b.startLine);
    return chunks;
  } finally {
    tree.delete();
  }
}
