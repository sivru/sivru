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

import { detectLanguage } from "../chunker/language.js";
import { getParser, isChunkableLanguage, type SyntaxNode } from "../chunker/grammars.js";
import { extractBlocks } from "./extract.js";
import { resolveJavaBridges } from "./bridges/java.js";
import { resolvePythonBridges } from "./bridges/python.js";
import { loadBlockConfig } from "./config.js";

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
  const match = cleaned.match(/^(.+?[.!?])\s/);
  if (match !== null) return match[1]!.trim();
  return cleaned.split("\n")[0]?.trim() ?? "TODO: one-sentence role in the system";
}

function listImports(content: string, language: string): string[] {
  const out = new Set<string>();
  if (language === "typescript" || language === "javascript" || language === "tsx" || language === "jsx") {
    for (const m of content.matchAll(/import\s+(?:\{([^}]+)\}|(\w+))(?:\s*,\s*\{([^}]+)\})?\s+from/g)) {
      const blocks = [m[1], m[3]].filter((s): s is string => typeof s === "string");
      for (const b of blocks) {
        for (const name of b.split(",")) {
          const trimmed = name.trim().split(/\s+as\s+/)[0]!.trim();
          if (trimmed.length > 0) out.add(trimmed);
        }
      }
      const dflt = m[2];
      if (dflt !== undefined && dflt.length > 0) out.add(dflt);
    }
  } else if (language === "python") {
    for (const m of content.matchAll(/(?:^|\n)\s*from\s+\S+\s+import\s+([^\n]+)/g)) {
      for (const name of m[1]!.split(",")) {
        const trimmed = name.trim().split(/\s+as\s+/)[0]!.trim();
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
    for (const m of content.matchAll(/"([\w./]+)"/g)) {
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
  const declTypes: ReadonlySet<string> =
    language === "python"
      ? new Set(["function_definition", "class_definition"])
      : language === "go"
        ? new Set(["function_declaration", "method_declaration", "type_declaration"])
        : language === "java"
          ? new Set([
              "class_declaration",
              "interface_declaration",
              "enum_declaration",
              "record_declaration",
              "method_declaration",
            ])
          : new Set([
              "function_declaration",
              "class_declaration",
              "interface_declaration",
              "type_alias_declaration",
              "lexical_declaration",
            ]);

  let best: { node: SyntaxNode; name: string; size: number } | null = null;
  const visit = (n: SyntaxNode): void => {
    if (declTypes.has(n.type)) {
      const nameNode = n.childForFieldName("name");
      const name = nameNode?.text ?? null;
      if (name !== null) {
        if (targetSymbol !== undefined && name === targetSymbol) {
          best = { node: n, name, size: n.endIndex - n.startIndex };
          return;
        }
        if (targetSymbol === undefined) {
          const size = n.endIndex - n.startIndex;
          if (best === null || size > best.size) {
            best = { node: n, name, size };
          }
        }
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  if (best === null) return null;
  const { node, name } = best;
  return { node, name };
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

function generateBlock(opts: {
  name: string;
  role: string;
  responsibility: string;
  collaborators: string[];
  invariants: string[];
}): string {
  const lines = [
    "@sivru",
    "schema: 1",
    `role: ${opts.role}`,
    `responsibility: "${opts.responsibility}"`,
    `collaborators:`,
    ...opts.collaborators.map((c) => `  - ${c}`),
    `invariants:`,
    ...opts.invariants.map((inv) => `  - rule: "${inv}"\n    enforced-by: null`),
    `decisions:`,
    `  - chose: "TODO"`,
    `    because: "TODO"`,
    `    valid-while: "TODO"`,
    `    revisit-if: "TODO"`,
    `maturity: experimental`,
    "@end",
  ];
  return lines.join("\n");
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
    const responsibility = firstSentence(doc) || "TODO: one-sentence role in the system";

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
      collaborators,
      invariants: seedInvariants,
    });

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
