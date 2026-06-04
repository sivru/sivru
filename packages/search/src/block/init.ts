// Block scaffolding (DESIGN-0019 §7). Generates a starter @sivru block
// from:
//   1. Symbol name + existing doc-comment first sentence → responsibility.
//   2. Import graph → top-N candidate collaborators (centrality-ranked).
//   3. Heuristic role from `*Service` / `*Repository` / `*Router` etc.
//   4. Annotation catalog suggestions pre-fill `invariants` when the
//      symbol carries known markers (§10b).
//   5. TODO placeholders for `decisions` and unspecified fields.
//
// Output: a YAML block string. `--write` inserts it at the correct
// per-language attachment point (above the declaration for TS/JS/Java/
// Go; inside the function body as a docstring for Python).
//
// `--symbol=<name>` targets a specific declaration; otherwise the
// largest top-level declaration in the file is chosen.

import { readFile, writeFile } from "node:fs/promises";

import yaml from "js-yaml";

import { detectLanguage } from "../chunker/language.js";
import { getParser, isChunkableLanguage, type SyntaxNode } from "../chunker/grammars.js";
import { extractBlocks } from "./extract.js";
import { resolveJavaBridges } from "./bridges/java.js";
import { resolvePythonBridges } from "./bridges/python.js";
import { loadBlockConfig } from "./config.js";
import { declTypesFor } from "./decl-types.js";

export type InitOptions = {
  targetSymbol?: string | undefined;
  write: boolean;
  force: boolean;
};

export type InitResult =
  | { kind: "ok"; block: string }
  | { kind: "err"; message: string };

const ROLE_SUFFIXES: { suffix: RegExp; role: string }[] = [
  { suffix: /Service$/, role: "service" },
  { suffix: /Repository$/, role: "repository" },
  { suffix: /Router$/, role: "router" },
  { suffix: /Reranker$/, role: "reranker" },
  { suffix: /Controller$/, role: "controller" },
  { suffix: /Provider$/, role: "provider" },
  { suffix: /Resolver$/, role: "resolver" },
  { suffix: /Handler$/, role: "handler" },
  { suffix: /Index$/, role: "index" },
  { suffix: /Store$/, role: "store" },
  { suffix: /Client$/, role: "client" },
];

function inferRole(name: string): string {
  for (const { suffix, role } of ROLE_SUFFIXES) {
    if (suffix.test(name)) return role;
  }
  return "TODO";
}

/**
 * Strip comment-syntax prefixes and return the first sentence of the
 * cleaned text. Returns "" when no usable content survives — caller is
 * responsible for the TODO fallback so it can distinguish "extracted
 * from doc" from "made up the responsibility" (the marker case).
 */
function firstSentence(docText: string): string {
  const cleaned = docText
    .replace(/^\s*\/\*\*?/, "")
    .replace(/\*\/\s*$/, "")
    .replace(/^\s*\*\s?/gm, "")
    .replace(/^\s*\/\/\s?/gm, "")
    .replace(/^\s*#\s?/gm, "")
    .replace(/^\s*"""/gm, "")
    .replace(/"""\s*$/gm, "")
    .trim();
  if (cleaned.length === 0) return "";
  const match = cleaned.match(/^(.+?[.!?])\s/);
  if (match !== null) return match[1]!.trim();
  return cleaned.split("\n")[0]?.trim() ?? "";
}

function listImports(content: string, language: string): string[] {
  const out = new Set<string>();
  // Helper: record the LOCAL identifier the file uses, not the source
  // export name. `import { X as L }` puts L in scope; the file's
  // collaborator graph should reference L (matches the rename
  // heuristic + graph reciprocity check).
  const localName = (raw: string): string => {
    const parts = raw.trim().split(/\s+as\s+/);
    if (parts.length >= 2 && parts[1] !== undefined) return parts[1]!.trim();
    return parts[0]!.trim();
  };

  if (language === "typescript" || language === "javascript" || language === "tsx" || language === "jsx") {
    for (const m of content.matchAll(/import\s+(?:\{([^}]+)\}|(\w+))(?:\s*,\s*\{([^}]+)\})?\s+from/g)) {
      const blocks = [m[1], m[3]].filter((s): s is string => typeof s === "string");
      for (const b of blocks) {
        for (const name of b.split(",")) {
          const trimmed = localName(name);
          if (trimmed.length > 0) out.add(trimmed);
        }
      }
      const dflt = m[2];
      if (dflt !== undefined && dflt.length > 0) out.add(dflt);
    }
  } else if (language === "python") {
    for (const m of content.matchAll(/(?:^|\n)\s*from\s+\S+\s+import\s+([^\n]+)/g)) {
      for (const name of m[1]!.split(",")) {
        const trimmed = localName(name);
        if (trimmed.length > 0) out.add(trimmed);
      }
    }
  } else if (language === "java") {
    for (const m of content.matchAll(/import\s+([\w.]+);/g)) {
      const parts = m[1]!.split(".");
      const tail = parts[parts.length - 1]!;
      if (tail.length > 0 && tail !== "*") out.add(tail);
    }
  } else if (language === "go") {
    // Go imports live in either a single-line `import "path/to/pkg"`
    // or a parenthesised block `import ( ... )`. Scoping the regex
    // here is critical — a bare `/"[\w./]+"/g` would also match
    // error messages, struct tags, and format strings.
    const blockMatch = content.match(/import\s*\(([\s\S]*?)\)/);
    if (blockMatch !== null) {
      for (const m of blockMatch[1]!.matchAll(/"([\w./]+)"/g)) {
        const parts = m[1]!.split("/");
        out.add(parts[parts.length - 1]!);
      }
    }
    for (const m of content.matchAll(/^\s*import\s+"([^"]+)"/gm)) {
      const parts = m[1]!.split("/");
      out.add(parts[parts.length - 1]!);
    }
  }
  // De-prioritise common module / stdlib names; the user can edit later.
  const STDLIB = new Set([
    "type",
    "Object",
    "string",
    "number",
    "boolean",
    "fmt",
    "os",
    "sys",
    "io",
  ]);
  return [...out].filter((s) => !STDLIB.has(s)).slice(0, 5);
}

function findDeclarationNode(
  root: SyntaxNode,
  language: string,
  targetSymbol: string | undefined,
): { node: SyntaxNode; name: string } | null {
  const declTypes = declTypesFor(language);

  // When no `--symbol` is given, prefer the FIRST top-level declaration
  // we see (typically the file's primary export). "Largest by char
  // count" — the previous default — surprised users with multi-export
  // files where a small `Foo` export was overshadowed by a sprawling
  // helper. First-encountered matches what an author would expect when
  // they say "scaffold a block for this file."
  let firstMatch: { node: SyntaxNode; name: string } | null = null;
  let targetMatch: { node: SyntaxNode; name: string } | null = null;
  const visit = (n: SyntaxNode): void => {
    if (targetMatch !== null) return;
    if (declTypes.has(n.type)) {
      const nameNode = n.childForFieldName("name");
      const name = nameNode?.text;
      if (typeof name === "string" && name.length > 0) {
        if (targetSymbol !== undefined && name === targetSymbol) {
          targetMatch = { node: n, name };
          return;
        }
        if (targetSymbol === undefined && firstMatch === null) {
          firstMatch = { node: n, name };
        }
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return targetMatch ?? firstMatch;
}

function leadingDocText(
  content: string,
  decl: SyntaxNode,
  language: string,
): string {
  const lines = content.split("\n");
  const declLine = decl.startPosition.row; // 0-indexed
  if (language === "python") {
    // Look INSIDE the body for the first bare-string expression.
    const body = decl.childForFieldName("body");
    if (body === null) return "";
    for (const child of body.namedChildren) {
      if (child.type !== "expression_statement") continue;
      const inner = child.namedChildren[0];
      if (inner?.type !== "string") return "";
      return inner.text;
    }
    return "";
  }
  // For Java/TS/JS/Go: walk upwards collecting contiguous comment lines.
  let i = declLine - 1;
  const collected: string[] = [];
  while (i >= 0 && /^\s*(?:\/\/|\*|\/\*)/.test(lines[i]!)) {
    collected.unshift(lines[i]!);
    i -= 1;
  }
  return collected.join("\n");
}

function collectAnnotations(
  decl: SyntaxNode,
  language: string,
  content: string,
): Set<string> {
  const out = new Set<string>();
  if (language === "java") {
    for (const child of decl.children) {
      if (child.type === "modifiers") {
        for (const m of child.text.matchAll(/@(\w+)/g)) {
          out.add(m[1]!);
        }
      }
    }
  } else if (language === "python") {
    // Python decorators live on the parent `decorated_definition`.
    const parent = decl.parent;
    if (parent !== null && parent.type === "decorated_definition") {
      for (const dec of parent.namedChildren) {
        if (dec.type !== "decorator") continue;
        const text = dec.text.replace(/^@/, "").replace(/\(.*$/, "");
        out.add(text);
      }
    }
  }
  void content;
  return out;
}

/**
 * Generate the block body via js-yaml's `dump` so quote-escaping is
 * handled correctly. `responsibility` carries a leading "auto-generated,
 * replace" marker (DESIGN-0019 §"Acceptance criteria — Slot 3") so
 * reviewers catch the auto-pull.
 *
 * The output is wrapped in `@sivru` / `@end` fences; the YAML body
 * between them is whatever js-yaml emits, guaranteeing it round-trips
 * through `extractBlocks` / `parseFenceBody` cleanly.
 */
function generateBlock(opts: {
  name: string;
  role: string;
  responsibility: string;
  collaborators: string[];
  invariants: string[];
  responsibilitySource: "doc-comment" | "todo";
}): string {
  const responsibilityValue =
    opts.responsibilitySource === "doc-comment"
      ? `${opts.responsibility} # auto-generated, replace`
      : opts.responsibility;
  const body: Record<string, unknown> = {
    schema: 1,
    role: opts.role,
    responsibility: responsibilityValue,
  };
  if (opts.collaborators.length > 0) {
    body["collaborators"] = opts.collaborators;
  }
  body["invariants"] = opts.invariants.map((rule) => ({
    rule,
    "enforced-by": null,
  }));
  body["decisions"] = [
    {
      chose: "TODO",
      because: "TODO",
      "valid-while": "TODO",
      "revisit-if": "TODO",
    },
  ];
  body["maturity"] = "experimental";
  // `lineWidth: -1` disables line-folding so long invariant prose stays
  // on one line and survives autofix's per-line rewriter contract.
  const yamlBody = yaml.dump(body, { lineWidth: -1, noRefs: true, quotingType: '"' });
  return ["@sivru", yamlBody.trimEnd(), "@end"].join("\n");
}

/**
 * @sivru
 * schema: 1
 * role: block-scaffolder
 * responsibility: emit a starter @sivru block for a target symbol, optionally inserting it into source
 * collaborators: [extractBlocks, resolveJavaBridges, resolvePythonBridges, loadBlockConfig]
 * invariants:
 *   - rule: refuses to overwrite an existing block on the target symbol without --force
 *     enforced-by: null
 *   - rule: collaborators list is capped at 5 entries from the file's import graph (centrality-ranked)
 *     enforced-by: null
 * decisions:
 *   - chose: TODO placeholders for decisions rather than blank fields
 *     because: a blank decisions:[] passes validation; TODO makes the author's missing work explicit
 *     valid-while: scaffolding is opt-in
 *     revisit-if: a user reports that TODO placeholders survive into shipped code
 * maturity: experimental
 * @end
 */
export async function initBlock(
  filePath: string,
  opts: InitOptions,
): Promise<InitResult> {
  const language = detectLanguage(filePath);
  if (language === null || !isChunkableLanguage(language)) {
    return { kind: "err", message: `unsupported language for ${filePath}` };
  }
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err) {
    return { kind: "err", message: `cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}` };
  }

  const existing = await extractBlocks(filePath, { content });
  if (!opts.force) {
    const collidesWith = (sym?: string): boolean =>
      existing.some(
        (eb) => eb.block !== null && (sym === undefined || eb.symbolName === sym),
      );
    if (collidesWith(opts.targetSymbol)) {
      return {
        kind: "err",
        message: `existing block found on ${opts.targetSymbol ?? "target symbol"} — pass --force to overwrite`,
      };
    }
  }

  const parser = await getParser(language);
  const tree = parser.parse(content);
  try {
    if (tree === null) return { kind: "err", message: `tree-sitter parse failed for ${filePath}` };
    const decl = findDeclarationNode(tree.rootNode, language, opts.targetSymbol);
    if (decl === null) {
      return { kind: "err", message: `no declaration found in ${filePath}` };
    }

    const doc = leadingDocText(content, decl.node, language);
    const docFirst = firstSentence(doc);
    const responsibility = docFirst !== "" ? docFirst : "TODO: one-sentence role in the system";
    const responsibilitySource: "doc-comment" | "todo" =
      docFirst !== "" ? "doc-comment" : "todo";

    const collaborators = listImports(content, language);

    const cfg = loadBlockConfig(filePath);
    const annotations = collectAnnotations(decl.node, language, content);
    const bridges =
      language === "java"
        ? resolveJavaBridges(cfg.bridges?.java, cfg.bridges?.disable)
        : language === "python"
          ? resolvePythonBridges(cfg.bridges?.python, cfg.bridges?.disable)
          : [];
    const seedInvariants: string[] = [];
    for (const b of bridges) {
      const hit =
        annotations.has(b.marker) || [...annotations].some((a) => a.startsWith(b.marker));
      if (hit) seedInvariants.push(b.invariant);
    }
    if (seedInvariants.length === 0) {
      seedInvariants.push("TODO: claim that must hold");
    }

    const block = generateBlock({
      name: decl.name,
      role: inferRole(decl.name),
      responsibility,
      responsibilitySource,
      collaborators,
      invariants: seedInvariants,
    });

    if (responsibilitySource === "todo" || seedInvariants.some((i) => i.startsWith("TODO"))) {
      process.stderr.write(
        `sivru-block-init: generated block for ${decl.name} contains TODO placeholders — ` +
          "review and replace before committing.\n",
      );
    }

    if (!opts.write) {
      return { kind: "ok", block };
    }

    // Write: insert above the declaration as a `/** ... */` doc comment
    // for TS/JS/Java/Go; for Python, insert inside the body as a triple-
    // quoted docstring.
    const lines = content.split("\n");
    const declLine = decl.node.startPosition.row; // 0-indexed
    const indent = (lines[declLine]?.match(/^\s*/)?.[0]) ?? "";
    if (language === "python") {
      const body = decl.node.childForFieldName("body");
      const bodyStart = body?.startPosition.row ?? declLine + 1;
      const docLines = [
        `${indent}    """`,
        ...block.split("\n").map((l) => `${indent}    ${l}`),
        `${indent}    """`,
      ];
      lines.splice(bodyStart, 0, ...docLines);
    } else {
      const docLines = [
        `${indent}/**`,
        ...block.split("\n").map((l) => `${indent} * ${l}`),
        `${indent} */`,
      ];
      lines.splice(declLine, 0, ...docLines);
    }
    await writeFile(filePath, lines.join("\n"));
    return { kind: "ok", block };
  } finally {
    if (tree !== null && typeof (tree as { delete?: () => void }).delete === "function") {
      (tree as { delete: () => void }).delete();
    }
  }
}
