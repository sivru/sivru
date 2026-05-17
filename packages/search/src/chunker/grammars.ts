// Tree-sitter grammar registry: which AST node types become chunks, and
// the loader for the bundled grammar WASM. See DESIGN-0001.
//
// The 6 grammar WASM files live in `./grammars/*.wasm` — committed binary
// assets, copied into `dist/` by `scripts/copy-grammars.mjs` at build time.
// `import.meta.url` resolves them whether this module runs from `src/`
// (vitest) or `dist/` (published package). The web-tree-sitter runtime
// WASM rides with the `web-tree-sitter` dependency itself.

import { fileURLToPath } from "node:url";

import Parser from "web-tree-sitter";

/** A loaded tree-sitter syntax node. */
export type SyntaxNode = Parser.SyntaxNode;

/**
 * A rule selecting which AST nodes become their own chunk. Either a bare
 * node-type name, or a typed predicate for node types that need the node
 * inspected — `lexical_declaration` matches every top-level `const`/`let`,
 * but only the ones initialised with a function should be chunked.
 */
export type NodeRule =
  | string
  | { readonly type: string; readonly when: (node: SyntaxNode) => boolean };

/** Value node types that make a `lexical_declaration` worth chunking. */
const FUNCTION_VALUE_TYPES = new Set([
  "arrow_function",
  "function_expression",
  "function",
  "generator_function",
]);

/** True when a `lexical_declaration` declares a function/arrow value. */
function hasFunctionInitializer(node: SyntaxNode): boolean {
  for (const declarator of node.namedChildren) {
    if (declarator.type !== "variable_declarator") continue;
    const value = declarator.childForFieldName("value");
    if (value !== null && FUNCTION_VALUE_TYPES.has(value.type)) return true;
  }
  return false;
}

const TS_RULES: readonly NodeRule[] = [
  "function_declaration",
  "class_declaration",
  "interface_declaration",
  "method_definition",
  { type: "lexical_declaration", when: hasFunctionInitializer },
];

const JS_RULES: readonly NodeRule[] = [
  "function_declaration",
  "class_declaration",
  "method_definition",
  { type: "lexical_declaration", when: hasFunctionInitializer },
];

/**
 * Per-language node-type whitelist. Keyed by the language ids produced by
 * `detectLanguage()`. `jsx` reuses the JavaScript rules; `tsx` the
 * TypeScript ones.
 */
export const NODE_TYPES_TO_CHUNK: Record<string, readonly NodeRule[]> = {
  typescript: TS_RULES,
  tsx: TS_RULES,
  javascript: JS_RULES,
  jsx: JS_RULES,
  python: ["function_definition", "class_definition"],
  go: ["function_declaration", "method_declaration", "type_declaration"],
  java: [
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "method_declaration",
    "constructor_declaration",
  ],
};

/**
 * Container node types: when one of these holds whitelisted descendants
 * (e.g. a class holding methods), the container is NOT chunked whole —
 * the walker descends and chunks the members individually, and the
 * container's own scaffolding (declaration line, fields) becomes gap-fill.
 * A container with no whitelisted members is chunked whole.
 */
export const CONTAINER_TYPES: ReadonlySet<string> = new Set([
  "class_declaration",
  "class_definition",
]);

/** Language id → bundled grammar WASM filename. */
const GRAMMAR_WASM: Record<string, string> = {
  typescript: "typescript.wasm",
  tsx: "tsx.wasm",
  javascript: "javascript.wasm",
  jsx: "javascript.wasm", // jsx is parsed by the JavaScript grammar
  python: "python.wasm",
  go: "go.wasm",
  java: "java.wasm",
};

/** True when `language` has a bundled tree-sitter grammar. */
export function isChunkableLanguage(
  language: string | null,
): language is string {
  return language !== null && language in GRAMMAR_WASM;
}

// --- Memoised loading -------------------------------------------------

let parserInitPromise: Promise<void> | null = null;
let sharedParser: Parser | null = null;
// Keyed by WASM filename so `javascript` and `jsx` share one load.
const grammarCache = new Map<string, Promise<Parser.Language>>();

function initParser(): Promise<void> {
  if (parserInitPromise === null) parserInitPromise = Parser.init();
  return parserInitPromise;
}

/**
 * The process-wide `Parser` instance. One parser, reused with
 * `setLanguage()` per file — `parse()` is synchronous so there is no
 * cross-file interleaving. Created after `Parser.init()` resolves.
 */
export async function getParser(): Promise<Parser> {
  await initParser();
  if (sharedParser === null) sharedParser = new Parser();
  return sharedParser;
}

/**
 * Load the tree-sitter grammar for `language`. Memoised: the first call
 * per grammar loads the bundled WASM; later calls reuse it.
 *
 * @throws if `language` has no bundled grammar (`SIVRU-E1001`) or the
 *   WASM fails to load (`SIVRU-E1002`).
 */
export async function loadGrammar(language: string): Promise<Parser.Language> {
  const wasmFile = GRAMMAR_WASM[language];
  if (wasmFile === undefined) {
    throw new Error(`SIVRU-E1001: no bundled tree-sitter grammar for language "${language}"`);
  }
  let cached = grammarCache.get(wasmFile);
  if (cached === undefined) {
    cached = (async () => {
      await initParser();
      const wasmPath = fileURLToPath(new URL(`./grammars/${wasmFile}`, import.meta.url));
      try {
        return await Parser.Language.load(wasmPath);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`SIVRU-E1002: failed to load grammar "${wasmFile}": ${reason}`);
      }
    })();
    grammarCache.set(wasmFile, cached);
  }
  return cached;
}
