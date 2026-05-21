// Extract @sivru annotation blocks from a source file (DESIGN-0016 §3).
//
// For TS / JS / Java / Go: per-symbol blocks live in the leading
// `/** */` (or `///` / `//` / `# `) doc comment above a declaration.
// For Python: per-symbol blocks live in the function/class body's first
// expression-statement when that statement is a bare string (PEP 257
// docstring). Module-level blocks: Python via PEP 257 module docstring;
// TS via top-of-file `/** */` comment on the package entry point
// (see module-locators). Java and Go module-level are deferred to
// v0.6.x.
//
// Fence detection is line-based: `@sivru` and `@end` must appear on
// their own line after stripping leading whitespace and one comment-
// syntax prefix. This rule keeps `@end` inside a YAML string value
// (e.g., `revisit-if: 'token reaches @end of life'`) safe — the line
// begins with `revisit-if:`, not `@end` alone.
//
// All edge cases are diagnostics, never crashes. Invalid blocks appear
// with `block: null` and `diagnostics: [...]` populated, per the
// project rule on never silently dropping (memory:
// feedback_sivru_no_silent_exclusion).

import { readFile } from "node:fs/promises";

import yaml from "js-yaml";

import { detectLanguage } from "../chunker/language.js";
import { getParser, isChunkableLanguage, type SyntaxNode } from "../chunker/grammars.js";
import { pythonModuleLocator } from "./module-locators/python.js";
import { typescriptModuleLocator } from "./module-locators/typescript.js";
import { RUNAWAY_LINES } from "./config.js";
import type {
  BlockDiagnostic,
  ExtractedBlock,
  ExtractedBlockKind,
  SivruBlock,
  SivruDecision,
  SourceRange,
} from "./types.js";

export type ExtractBlocksOptions = {
  /** Override file content (skip disk read). Useful for fixtures / tests. */
  content?: string;
  /** Override detected language (forces parser selection). */
  language?: string;
};

type Fence = {
  /** Raw YAML body (with original indentation preserved). */
  yamlText: string;
  /** 1-indexed inclusive line of `@sivru` in the file. */
  startLine: number;
  /** 1-indexed inclusive line of `@end` in the file. */
  endLine: number;
  /** True when `@sivru` was seen but no matching `@end`; yamlText is "". */
  unclosed?: true;
};

/**
 * The "@sivru" / "@end" line shape: optional leading whitespace, then
 * one optional comment-syntax prefix (longest first), optional single
 * space, then the literal delimiter, optional trailing whitespace.
 * Anchored on both ends → the "own-line" rule (DESIGN-0016 §3a) is
 * the property of the line, not its content.
 */
const FENCE_START_REGEX =
  /^([ \t]*(?:\/\/\/|\/\/|\*|#)?[ \t]*)@sivru[ \t]*$/;

function makeFenceEndRegex(prefix: string): RegExp {
  // `@end` may carry extra indentation relative to the captured prefix
  // (e.g., the @sivru/@end line is itself nested in the body). Tolerate
  // any additional leading whitespace before `@end`.
  return new RegExp(`^${escapeRegex(prefix)}[ \\t]*@end[ \\t]*$`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Best-effort prefix strip used for body lines that drift from prefix. */
function bestEffortStrip(line: string): string {
  return line.replace(/^[ \t]*(?:\/\/\/|\/\/|\*|#)?[ \t]?/, "");
}

/**
 * Scan a multi-line text for @sivru / @end fences. Returns one entry per
 * fence; an unclosed `@sivru` returns one entry with `unclosed: true`
 * (the caller turns that into SIVRU-E215).
 *
 * The `@sivru` line's leading whitespace + comment-syntax prefix is
 * captured and used to strip subsequent body lines uniformly — that way
 * YAML internal indentation is preserved (the alternative — greedy
 * strip per line — collapses meaningful indent like the `decisions: \n
 *   - chose: …` mapping).
 *
 * @param text the (possibly comment-prefixed) text to scan
 * @param baseLine the 1-indexed file line that `text[0]` corresponds to
 */
export function extractFences(text: string, baseLine: number): Fence[] {
  const lines = text.split("\n");
  const fences: Fence[] = [];
  let start: number | null = null;
  let prefix = "";

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (start === null) {
      const m = raw.match(FENCE_START_REGEX);
      if (m !== null) {
        start = i;
        prefix = m[1] ?? "";
      }
      continue;
    }
    if (makeFenceEndRegex(prefix).test(raw)) {
      const bodyLines: string[] = [];
      for (let j = start + 1; j < i; j++) {
        const line = lines[j]!;
        if (line.startsWith(prefix)) {
          bodyLines.push(line.slice(prefix.length));
        } else if (line.trim() === "") {
          bodyLines.push("");
        } else {
          // Drift line: a body line with a non-matching indent. Strip
          // best-effort so YAML parse can still try, but downstream
          // diagnostic may surface a malformed-yaml error.
          bodyLines.push(bestEffortStrip(line));
        }
      }
      fences.push({
        yamlText: bodyLines.join("\n"),
        startLine: baseLine + start,
        endLine: baseLine + i,
      });
      start = null;
      prefix = "";
    }
  }

  if (start !== null) {
    fences.push({
      yamlText: "",
      startLine: baseLine + start,
      endLine: baseLine + lines.length - 1,
      unclosed: true,
    });
  }

  return fences;
}

/** Walk node tree and collect every "comment" / "*_comment" node. */
function collectComments(root: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const visit = (n: SyntaxNode): void => {
    if (n.type === "comment" || n.type.endsWith("_comment")) {
      out.push(n);
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return out;
}

/** Walk node tree and collect declaration-like nodes that can carry symbols. */
function collectDeclarations(root: SyntaxNode, language: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  // Languages where the per-symbol carrier is a *leading* doc comment.
  const declTypes = new Set<string>(
    language === "python"
      ? ["function_definition", "class_definition"]
      : language === "go"
        ? ["function_declaration", "method_declaration", "type_declaration"]
        : language === "java"
          ? [
              "class_declaration",
              "interface_declaration",
              "enum_declaration",
              "method_declaration",
              "constructor_declaration",
            ]
          : [
              // TS / JS / TSX / JSX
              "function_declaration",
              "class_declaration",
              "interface_declaration",
              "method_definition",
              "lexical_declaration",
              "variable_declaration",
            ],
  );
  const visit = (n: SyntaxNode): void => {
    if (declTypes.has(n.type)) out.push(n);
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return out;
}

/** Best-effort symbol name for a declaration node. */
function symbolNameOf(node: SyntaxNode): string | undefined {
  const nameField = node.childForFieldName("name");
  if (nameField !== null) return nameField.text;
  // lexical_declaration / variable_declaration: dig into the declarator
  for (const child of node.namedChildren) {
    if (
      child.type === "variable_declarator" ||
      child.type === "init_declarator"
    ) {
      const n = child.childForFieldName("name");
      if (n !== null) return n.text;
    }
  }
  return undefined;
}

/** Group contiguous own-line comments into blocks. Each block is one carrier. */
type CommentGroup = {
  text: string;
  startLine: number;
  endLine: number;
};

function groupContiguous(
  comments: readonly SyntaxNode[],
  lines: readonly string[],
): CommentGroup[] {
  // Filter to own-line comments only (trailing comments are excluded:
  // `x = 1 // note` should never be mistaken for a doc carrier).
  const own = comments.filter((c) => {
    const startCol = c.startPosition.column;
    const lineText = lines[c.startPosition.row] ?? "";
    return lineText.slice(0, startCol).trim() === "";
  });
  own.sort((a, b) => a.startPosition.row - b.startPosition.row);

  const groups: CommentGroup[] = [];
  for (const c of own) {
    const startLine = c.startPosition.row + 1;
    const endLine =
      c.endPosition.column === 0 ? c.endPosition.row : c.endPosition.row + 1;
    const prev = groups[groups.length - 1];
    if (prev !== undefined && prev.endLine + 1 === startLine) {
      // Contiguous: merge.
      prev.endLine = endLine;
      prev.text += "\n" + sliceLines(lines, startLine, endLine);
    } else {
      groups.push({
        text: sliceLines(lines, startLine, endLine),
        startLine,
        endLine,
      });
    }
  }
  return groups;
}

function sliceLines(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): string {
  return lines.slice(startLine - 1, endLine).join("\n");
}

/** YAML-parse a fence body to a SivruBlock. Diagnostics on failure. */
function parseFenceBody(
  yamlText: string,
  range: SourceRange,
): { block: SivruBlock | null; diagnostics: BlockDiagnostic[] } {
  let parsed: unknown;
  try {
    parsed = yaml.load(yamlText, {
      // Safe schema is the default for yaml.load (FAILSAFE + JSON +
      // CORE); we never call loadAll() or DEFAULT_FULL_SCHEMA.
      schema: yaml.JSON_SCHEMA,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      block: null,
      diagnostics: [
        {
          code: "SIVRU-E216",
          severity: "error",
          message: `yaml-malformed: ${msg}`,
          location: range,
        },
      ],
    };
  }
  if (parsed === null || parsed === undefined) {
    // Empty body. Caller's validate step will fire E217 missing-required.
    return { block: null, diagnostics: [] };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      block: null,
      diagnostics: [
        {
          code: "SIVRU-E216",
          severity: "error",
          message: "yaml-malformed: top-level value must be a mapping",
          location: range,
        },
      ],
    };
  }
  const obj = parsed as Record<string, unknown>;
  // Default schema:1 when omitted; validate.ts will reject anything else.
  const schema =
    typeof obj["schema"] === "number" ? (obj["schema"] as number) : 1;
  const block: SivruBlock = {
    schema,
    role: typeof obj["role"] === "string" ? (obj["role"] as string) : "",
    responsibility:
      typeof obj["responsibility"] === "string"
        ? (obj["responsibility"] as string)
        : "",
  };
  if (Array.isArray(obj["collaborators"])) {
    block.collaborators = (obj["collaborators"] as unknown[]).filter(
      (x): x is string => typeof x === "string",
    );
  }
  if (Array.isArray(obj["invariants"])) {
    block.invariants = (obj["invariants"] as unknown[]).filter(
      (x): x is string => typeof x === "string",
    );
  }
  if (Array.isArray(obj["decisions"])) {
    block.decisions = (obj["decisions"] as unknown[])
      .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x))
      .map((d) => {
        const dec: SivruDecision = {
          chose: typeof d["chose"] === "string" ? d["chose"] : "",
          because: typeof d["because"] === "string" ? d["because"] : "",
          "valid-while":
            typeof d["valid-while"] === "string" ? d["valid-while"] : "",
        };
        if (typeof d["revisit-if"] === "string") {
          dec["revisit-if"] = d["revisit-if"];
        }
        return dec;
      });
  }
  if (typeof obj["maturity"] === "string") {
    block.maturity = obj["maturity"];
  }
  // Missing required fields are validate.ts's job (E217).
  if (typeof obj["role"] !== "string" && typeof obj["responsibility"] !== "string") {
    // Block returned anyway so validate can produce the precise diagnostic.
  }
  return { block, diagnostics: [] };
}

/**
 * Build an ExtractedBlock from a single fence. Applies the runaway
 * ceiling (E212) and the unclosed check (E215) before YAML parse.
 */
function buildExtractedBlock(
  filePath: string,
  kind: ExtractedBlockKind,
  fence: Fence,
  symbolName?: string,
): ExtractedBlock {
  const range: SourceRange = {
    filePath,
    startLine: fence.startLine,
    endLine: fence.endLine,
  };
  const out: ExtractedBlock = {
    filePath,
    kind,
    range,
    block: null,
    diagnostics: [],
  };
  if (symbolName !== undefined) out.symbolName = symbolName;

  if (fence.unclosed === true) {
    out.diagnostics.push({
      code: "SIVRU-E215",
      severity: "error",
      message: "fence-unclosed: `@sivru` without matching `@end`",
      location: range,
    });
    return out;
  }

  const spannedLines = fence.endLine - fence.startLine + 1;
  if (spannedLines > RUNAWAY_LINES) {
    out.diagnostics.push({
      code: "SIVRU-E212",
      severity: "error",
      message: `block-runaway: ${spannedLines} lines exceeds hardcoded ceiling of ${RUNAWAY_LINES}`,
      location: range,
    });
    return out;
  }

  const parsed = parseFenceBody(fence.yamlText, range);
  out.block = parsed.block;
  out.diagnostics.push(...parsed.diagnostics);
  return out;
}

/**
 * For Python, find the first bare-string expression_statement inside a
 * body node (`block` / `suite`). Returns its content + range, or null.
 * Skips f-strings, matching CPython's docstring rule.
 */
function pythonBareStringInBody(
  body: SyntaxNode | null,
  lines: readonly string[],
): { content: string; startLine: number; endLine: number } | null {
  if (body === null) return null;
  for (const child of body.namedChildren) {
    if (child.type !== "expression_statement") continue;
    // Skip `from __future__` etc. (already filtered by node-type), and
    // accept the first expression_statement only.
    const inner = child.namedChildren[0];
    if (inner === undefined) return null;
    if (inner.type !== "string") return null;
    // Reject f-strings: tree-sitter-python tags them as `string` too, but
    // their first child is a `string_start` containing 'f"' / "f'". Look
    // for an interpolation child as a clearer signal.
    for (const sc of inner.namedChildren) {
      if (sc.type === "interpolation") return null;
    }
    // Reject f-strings via the prefix bytes (more robust across grammar revs).
    const startRow = inner.startPosition.row;
    const startCol = inner.startPosition.column;
    const lineText = lines[startRow] ?? "";
    const prefix = lineText.slice(startCol, startCol + 2).toLowerCase();
    if (prefix.startsWith("f")) return null;
    const startLine = startRow + 1;
    const endLine =
      inner.endPosition.column === 0
        ? inner.endPosition.row
        : inner.endPosition.row + 1;
    // Use the raw lines (the string literal text including quotes) and
    // strip just the leading/trailing quote markers. The fence scanner
    // tolerates extra punctuation on its own line by virtue of the
    // trim-after-strip rule.
    const raw = sliceLines(lines, startLine, endLine);
    const content = raw
      .replace(/^[urbURB]?(?:"""|'''|"|')/, "")
      .replace(/(?:"""|'''|"|')$/, "");
    return { content, startLine, endLine };
  }
  return null;
}

/**
 * Per-symbol blocks for Python: walk function_definition / class_definition
 * and look inside the body for a docstring. Skip `#` comments above the
 * symbol — per DESIGN-0016 §3b, Python's per-symbol carrier is the
 * docstring, not the leading `#` comment.
 */
function extractPythonPerSymbolBlocks(
  filePath: string,
  root: SyntaxNode,
  lines: readonly string[],
): ExtractedBlock[] {
  const out: ExtractedBlock[] = [];
  const visit = (n: SyntaxNode): void => {
    if (n.type === "function_definition" || n.type === "class_definition") {
      // Body is the `block` field on tree-sitter-python.
      const body = n.childForFieldName("body");
      const docstring = pythonBareStringInBody(body, lines);
      if (docstring !== null) {
        const fences = extractFences(docstring.content, docstring.startLine);
        for (const fence of fences) {
          out.push(buildExtractedBlock(filePath, "symbol", fence, symbolNameOf(n)));
        }
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return out;
}

/**
 * Per-symbol blocks for non-Python: for each leading own-line comment
 * group whose end line is immediately above a declaration, scan the
 * group's text for fences and attach each to the declaration.
 */
function extractCommentCarriedBlocks(
  filePath: string,
  root: SyntaxNode,
  lines: readonly string[],
  language: string,
): ExtractedBlock[] {
  const out: ExtractedBlock[] = [];
  const comments = collectComments(root);
  const groups = groupContiguous(comments, lines);
  const decls = collectDeclarations(root, language).sort(
    (a, b) => a.startPosition.row - b.startPosition.row,
  );

  for (const group of groups) {
    // Find the first declaration whose start line is exactly group.endLine + 1.
    const decl = decls.find(
      (d) => d.startPosition.row + 1 === group.endLine + 1,
    );
    if (decl === undefined) continue;
    const fences = extractFences(group.text, group.startLine);
    for (const fence of fences) {
      out.push(buildExtractedBlock(filePath, "symbol", fence, symbolNameOf(decl)));
    }
  }
  return out;
}

/**
 * Extract every @sivru block from `filePath`. Returns one ExtractedBlock
 * per fence (invalid blocks appear with `block:null` and `diagnostics`
 * populated; never silently dropped). Other valid blocks in the same
 * file extract normally even when one is malformed (DESIGN-0016 F1).
 *
 * @throws only on tree-sitter parser failure (which the chunker itself
 *   guards against by detectLanguage filtering); callers should treat
 *   unknown-language files as empty.
 */
export async function extractBlocks(
  filePath: string,
  options: ExtractBlocksOptions = {},
): Promise<ExtractedBlock[]> {
  const language = options.language ?? detectLanguage(filePath);
  if (language === null || !isChunkableLanguage(language)) return [];

  const content =
    options.content ?? (await readFile(filePath, "utf8"));
  if (content.length === 0) return [];

  const lines = content.split("\n");

  const parser = await getParser(language);
  const tree = parser.parse(content);
  try {
    if (tree === null) return [];
    const root = tree.rootNode;

    const out: ExtractedBlock[] = [];

    // Per-symbol blocks.
    if (language === "python") {
      out.push(...extractPythonPerSymbolBlocks(filePath, root, lines));
    } else {
      out.push(...extractCommentCarriedBlocks(filePath, root, lines, language));
    }

    // Module-level blocks (Python + TS only at v0.6 per §3).
    if (language === "python") {
      const located = pythonModuleLocator(filePath, root, lines);
      if (located !== null) {
        if (located.diagnostic !== undefined) {
          out.push({
            filePath,
            kind: "module",
            range: { filePath, startLine: 1, endLine: 1 },
            block: null,
            diagnostics: [located.diagnostic],
          });
        } else if (located.carrier !== undefined) {
          const fences = extractFences(located.carrier.text, located.carrier.startLine);
          for (const fence of fences) {
            out.push(buildExtractedBlock(filePath, "module", fence));
          }
        }
      }
    } else if (language === "typescript" || language === "tsx" || language === "javascript" || language === "jsx") {
      const located = typescriptModuleLocator(filePath, root, lines);
      if (located !== null) {
        if (located.diagnostic !== undefined) {
          out.push({
            filePath,
            kind: "module",
            range: { filePath, startLine: 1, endLine: 1 },
            block: null,
            diagnostics: [located.diagnostic],
          });
        } else if (located.carrier !== undefined) {
          const fences = extractFences(located.carrier.text, located.carrier.startLine);
          for (const fence of fences) {
            out.push(buildExtractedBlock(filePath, "module", fence));
          }
        }
      }
    }

    return out;
  } finally {
    if (tree !== null && typeof (tree as { delete?: () => void }).delete === "function") {
      (tree as { delete: () => void }).delete();
    }
  }
}

/**
 * Convenience: extract blocks across many files in parallel. Errors on
 * a single file (e.g., tree-sitter blow-up) become an empty result for
 * THAT file so the batch isn't aborted.
 */
export async function extractBlocksFromFiles(
  filePaths: readonly string[],
): Promise<ExtractedBlock[]> {
  const settled = await Promise.allSettled(
    filePaths.map((p) => extractBlocks(p)),
  );
  const out: ExtractedBlock[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") out.push(...s.value);
  }
  return out;
}
