// Enforcement resolver (DESIGN-0019 §1). Walks every invariant whose
// `enforced-by` is non-null and verifies:
//   1. The referenced test exists (symbol-form via tree-sitter walk;
//      file-anchored form via leaf `it()` / `test()` / `TestX` name).
//   2. The test is not marked skipped:
//        - vitest/jest: `it.skip`, `xit`, `test.skip`, `xtest`,
//          `it.todo`, `test.todo`, `describe.skip` wrapping.
//        - JUnit: `@Disabled` / `@Ignore` annotation.
//        - pytest: `@pytest.mark.skip` / `skipif` decorator.
//        - Go: `t.Skip()` / `t.SkipNow()` call inside the test body.
//
// Out of scope (per design §1): verifying the test actually asserts
// the invariant. Sivru gives the agent inputs; the agent makes the
// judgment.
//
// Diagnostics: SIVRU-E230 (missing), SIVRU-E231 (skipped).
// SIVRU-E232 (unset, the "null" form) is emitted by validate.ts since
// it's a per-block property, not a resolver result.

import { readFile } from "node:fs/promises";

import { detectLanguage } from "../chunker/language.js";
import { getParser, isChunkableLanguage, type SyntaxNode } from "../chunker/grammars.js";
import { walk } from "../walker/walk.js";
import { declTypesFor } from "./decl-types.js";
import type { BlockDiagnostic, ExtractedBlock } from "./types.js";

/**
 * Parsed shape of an `enforced-by` reference. The string form is one of:
 *   - `path/to/file.ts::test-name`      → kind: "file-anchored"
 *   - `ClassName.methodName`            → kind: "symbol"
 *   - `bareSymbol`                      → kind: "symbol"
 * Whitespace is trimmed; anything else is a parse error and the caller
 * emits SIVRU-E230 with a "malformed reference" message.
 */
export type ParsedReference =
  | { kind: "file-anchored"; path: string; name: string }
  | { kind: "symbol"; qualifier: string | null; name: string };

/**
 * Parse the user-authored `enforced-by` string into a ParsedReference,
 * or null for malformed input.
 */
export function parseEnforcedBy(ref: string): ParsedReference | null {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return null;
  const colonColon = trimmed.indexOf("::");
  if (colonColon !== -1) {
    const path = trimmed.slice(0, colonColon).trim();
    const name = trimmed.slice(colonColon + 2).trim();
    if (path.length === 0 || name.length === 0) return null;
    return { kind: "file-anchored", path, name };
  }
  const dot = trimmed.lastIndexOf(".");
  if (dot !== -1) {
    const qualifier = trimmed.slice(0, dot).trim();
    const name = trimmed.slice(dot + 1).trim();
    if (qualifier.length === 0 || name.length === 0) return null;
    return { kind: "symbol", qualifier, name };
  }
  return { kind: "symbol", qualifier: null, name: trimmed };
}

type ResolveResult =
  | { kind: "found"; skipped: boolean; reason?: string }
  | { kind: "missing"; reason: string };

/**
 * Detect skip markers on a declaration node. The check is per-language
 * and reads either:
 *   - the leading-annotations region (Java)
 *   - the leading decorators (Python)
 *   - the call-expression callee shape (vitest/jest)
 *   - the function body for an early `t.Skip()` (Go)
 */
function detectSkip(node: SyntaxNode, language: string, source: string): boolean {
  if (language === "java") {
    // Walk leading modifiers / annotations: tree-sitter-java exposes
    // them as siblings before the `class_declaration` / `method_declaration`.
    let cursor: SyntaxNode | null = node;
    // Each declaration's first child is the modifiers node when present.
    for (const child of cursor.children) {
      if (child.type === "modifiers") {
        const text = child.text;
        if (text.includes("@Disabled") || text.includes("@Ignore")) return true;
      }
    }
    return false;
  }
  if (language === "python") {
    // Decorators sit ABOVE the function_definition in tree-sitter-python
    // via the `decorated_definition` parent node. The caller passes the
    // `decorated_definition` (when present) so we just check its decorator
    // children.
    if (node.type === "decorated_definition") {
      for (const child of node.children) {
        if (child.type === "decorator") {
          const text = child.text;
          if (text.includes("skip") || text.includes("skipif")) return true;
        }
      }
    }
    return false;
  }
  if (language === "go") {
    // For a Go test, look for an actual `t.Skip(` / `t.SkipNow(` call
    // expression inside the function body — not just any textual match
    // (which would false-positive on comments, strings, sub-tests, etc.).
    const body = node.childForFieldName("body");
    if (body === null) return false;
    let skipped = false;
    const visit = (n: SyntaxNode): void => {
      if (skipped) return;
      if (n.type === "call_expression") {
        const callee = n.childForFieldName("function");
        if (callee !== null) {
          const text = callee.text;
          if (text === "t.Skip" || text === "t.SkipNow") {
            skipped = true;
            return;
          }
        }
      }
      for (const c of n.namedChildren) visit(c);
    };
    visit(body);
    return skipped;
  }
  // TS / JS / TSX / JSX: handled by the caller (it()/test() resolution
  // path); declarations passed here are top-level functions which don't
  // carry skip markers in the v0.6 vitest/jest convention.
  void source;
  return false;
}

/**
 * Walk a tree-sitter root for a top-level declaration whose name matches
 * `name`. Returns the matching node + its skip status, or null when no
 * match exists in the file.
 */
function findDeclaration(
  root: SyntaxNode,
  name: string,
  language: string,
  source: string,
): { node: SyntaxNode; skipped: boolean } | null {
  // Pull from the shared decl-types module + augment with Python's
  // `decorated_definition` (used to surface decorators around test
  // functions for skip detection — not a block-carrier kind, but a
  // wrapper enforcement needs to traverse).
  const shared = declTypesFor(language);
  const declTypes: ReadonlySet<string> =
    language === "python"
      ? new Set([...shared, "decorated_definition"])
      : shared;

  let found: { node: SyntaxNode; skipped: boolean } | null = null;
  const visit = (n: SyntaxNode): void => {
    if (found !== null) return;
    if (declTypes.has(n.type)) {
      const inner = n.type === "decorated_definition" ? n.namedChildren.find((c) => c.type === "function_definition" || c.type === "class_definition") ?? n : n;
      const nameNode = inner.childForFieldName("name");
      if (nameNode !== null && nameNode.text === name) {
        const decorated = n.type === "decorated_definition" ? n : inner;
        found = { node: inner, skipped: detectSkip(decorated, language, source) };
        return;
      }
      for (const child of inner.namedChildren) {
        if (child.type === "variable_declarator" || child.type === "init_declarator") {
          const n2 = child.childForFieldName("name");
          if (n2 !== null && n2.text === name) {
            found = { node: inner, skipped: false };
            return;
          }
        }
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return found;
}

/**
 * Find a `it("name", ...)` / `test("name", ...)` / `it.skip("name", ...)`
 * callsite by its string literal. Returns the call-expression node + skip
 * status, or null when no match. Handles `xit`, `xtest`, `it.skip`,
 * `test.skip`, `it.todo`, `test.todo`, and the `describe.skip` wrapper.
 */
function findTestCallByName(
  root: SyntaxNode,
  name: string,
): { node: SyntaxNode; skipped: boolean } | null {
  let found: { node: SyntaxNode; skipped: boolean } | null = null;
  let describeSkipDepth = 0;
  const isSkipCallee = (callee: string): boolean =>
    /^(?:xit|xtest)$/.test(callee) ||
    /\.(skip|todo)$/.test(callee);
  const isDescribeSkip = (callee: string): boolean =>
    /^describe\.(skip|todo)$/.test(callee);
  const isTestCallee = (callee: string): boolean =>
    /^(?:it|test|xit|xtest|fit|ftest)(?:\.(?:skip|todo|only|concurrent|sequential))?$/.test(callee);
  const isDescribeCallee = (callee: string): boolean =>
    /^describe(?:\.(?:skip|todo|only))?$/.test(callee);

  const visit = (n: SyntaxNode): void => {
    if (found !== null) return;
    if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      const args = n.childForFieldName("arguments");
      const callee = fn?.text ?? "";
      const firstArg = args?.namedChildren[0];
      const argText = firstArg?.text ?? "";
      const unquoted = argText.replace(/^['"`]|['"`]$/g, "");

      const wrapsDescribe = isDescribeSkip(callee);
      if (wrapsDescribe) describeSkipDepth += 1;

      if (isTestCallee(callee) && unquoted === name) {
        const skipped = isSkipCallee(callee) || describeSkipDepth > 0;
        found = { node: n, skipped };
        if (wrapsDescribe) describeSkipDepth -= 1;
        return;
      }
      if (isDescribeCallee(callee) || wrapsDescribe) {
        for (const c of n.namedChildren) visit(c);
        if (wrapsDescribe) describeSkipDepth -= 1;
        return;
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return found;
}

async function resolveFileAnchored(
  ref: { kind: "file-anchored"; path: string; name: string },
  repoRoot: string,
): Promise<ResolveResult> {
  // Path is resolved relative to repoRoot when not absolute.
  const path = ref.path.startsWith("/") ? ref.path : `${repoRoot.replace(/\/$/, "")}/${ref.path}`;
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return { kind: "missing", reason: `file not found: ${ref.path}` };
  }
  const language = detectLanguage(path);
  if (language === null || !isChunkableLanguage(language)) {
    return { kind: "missing", reason: `unsupported language for ${ref.path}` };
  }
  const parser = await getParser(language);
  const tree = parser.parse(content);
  try {
    if (tree === null) return { kind: "missing", reason: `failed to parse ${ref.path}` };
    if (language === "go") {
      const found = findDeclaration(tree.rootNode, ref.name, language, content);
      if (found === null) return { kind: "missing", reason: `no \`${ref.name}\` in ${ref.path}` };
      return { kind: "found", skipped: found.skipped };
    }
    // vitest / jest / mocha leaf-name path.
    const callFound = findTestCallByName(tree.rootNode, ref.name);
    if (callFound !== null) {
      return { kind: "found", skipped: callFound.skipped };
    }
    // Fall back to a declaration with that name (covers `function testFoo`).
    const declFound = findDeclaration(tree.rootNode, ref.name, language, content);
    if (declFound !== null) {
      return { kind: "found", skipped: declFound.skipped };
    }
    return { kind: "missing", reason: `no \`it("${ref.name}", ...)\` or declaration in ${ref.path}` };
  } finally {
    if (tree !== null && typeof (tree as { delete?: () => void }).delete === "function") {
      (tree as { delete: () => void }).delete();
    }
  }
}

/**
 * Single-symbol fallback (one-off `resolveEnforcement` API path).
 * Walks the repo once, builds the symbol map, and resolves one ref.
 * Kept for the public `resolveEnforcement` entry point + the targeted
 * test path; the bulk entry point (`checkEnforcement`) shares one
 * cached map across all references.
 */
async function resolveSymbol(
  ref: { kind: "symbol"; qualifier: string | null; name: string },
  repoRoot: string,
): Promise<ResolveResult> {
  const index = await buildSymbolMap(repoRoot);
  return lookupSymbol(index, ref);
}

/**
 * Pre-built name → match[] index for batch resolution. A single repo
 * walk + parse populates this; subsequent lookups are O(1) amortised.
 */
export type EnforcementIndex = ReadonlyMap<
  string,
  ReadonlyArray<{ filePath: string; skipped: boolean }>
>;

/**
 * Walk the repo once, parse each chunkable file, and collect every
 * top-level declaration name into a map. Used by `checkEnforcement`
 * to amortise the parse cost across all `enforced-by` references in
 * a single invocation.
 *
 * Sequential per-language because tree-sitter parsers are shared and
 * concurrent `parse()` invocations can leave overlapping tree
 * lifetimes invalid (same constraint as `extractBlocksFromFiles`).
 */
export async function buildSymbolMap(repoRoot: string): Promise<EnforcementIndex> {
  const map = new Map<string, Array<{ filePath: string; skipped: boolean }>>();
  for await (const entry of walk(repoRoot)) {
    const language = detectLanguage(entry.absPath);
    if (language === null || !isChunkableLanguage(language)) continue;
    let content: string;
    try {
      content = await readFile(entry.absPath, "utf8");
    } catch {
      continue;
    }
    let parser;
    try {
      parser = await getParser(language);
    } catch {
      continue;
    }
    const tree = parser.parse(content);
    try {
      if (tree === null) continue;
      // Walk every declaration, not just the named-target — one parse
      // per file feeds every later lookup.
      collectAllDeclarations(tree.rootNode, language, content, entry.absPath, map);
    } finally {
      if (tree !== null && typeof (tree as { delete?: () => void }).delete === "function") {
        (tree as { delete: () => void }).delete();
      }
    }
  }
  return map;
}

function collectAllDeclarations(
  root: SyntaxNode,
  language: string,
  source: string,
  filePath: string,
  out: Map<string, Array<{ filePath: string; skipped: boolean }>>,
): void {
  const shared = declTypesFor(language);
  const declTypes =
    language === "python"
      ? new Set([...shared, "decorated_definition"])
      : shared;
  const visit = (n: SyntaxNode): void => {
    if (declTypes.has(n.type)) {
      const inner =
        n.type === "decorated_definition"
          ? n.namedChildren.find(
              (c) => c.type === "function_definition" || c.type === "class_definition",
            ) ?? n
          : n;
      const nameNode = inner.childForFieldName("name");
      if (nameNode !== null && nameNode.text.length > 0) {
        const skipped = detectSkip(
          n.type === "decorated_definition" ? n : inner,
          language,
          source,
        );
        const arr = out.get(nameNode.text);
        const entry = { filePath, skipped };
        if (arr === undefined) out.set(nameNode.text, [entry]);
        else arr.push(entry);
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
}

function lookupSymbol(
  index: EnforcementIndex,
  ref: { kind: "symbol"; qualifier: string | null; name: string },
): ResolveResult {
  const matches = index.get(ref.name) ?? [];
  if (matches.length === 0) {
    const label = ref.qualifier !== null ? `${ref.qualifier}.${ref.name}` : ref.name;
    return { kind: "missing", reason: `no declaration \`${label}\`` };
  }
  if (ref.qualifier !== null) {
    const qualified = matches.find((m) => m.filePath.includes(ref.qualifier!));
    if (qualified !== undefined) {
      return { kind: "found", skipped: qualified.skipped };
    }
  }
  const first = matches[0]!;
  return { kind: "found", skipped: first.skipped };
}

/**
 * Resolve one `enforced-by` reference against `repoRoot`. Public for
 * targeted tests; `checkEnforcement` is the bulk entry point.
 */
export async function resolveEnforcement(
  ref: ParsedReference,
  repoRoot: string,
): Promise<ResolveResult> {
  if (ref.kind === "file-anchored") return resolveFileAnchored(ref, repoRoot);
  return resolveSymbol(ref, repoRoot);
}

/**
 * Walk every extracted block, find invariants with a non-null
 * `enforced-by`, and emit SIVRU-E230 / E231 diagnostics for each
 * failure. SIVRU-E232 is left to `validateBlock` because it's a
 * per-block property (no resolution needed).
 *
 * @sivru
 * schema: 1
 * role: enforcement-resolver
 * responsibility: verify every invariant.enforced-by resolves to a real, non-skipped test
 * collaborators: [extractBlocks, getParser, walk]
 * invariants:
 *   - rule: file-anchored references resolve by leaf it()/test() name; describe path is informative only
 *     enforced-by: "packages/search/src/block/enforcement.test.ts::finds an it() callsite by name"
 *   - rule: symbol-form prefers a file whose path contains the qualifier; otherwise first match wins
 *     enforced-by: null
 *   - rule: SIVRU-E231 skipped detection covers vitest at minimum (Java/Python/Go covered by integration fixtures)
 *     enforced-by: "packages/search/src/block/enforcement.test.ts::detects an it.skip() as skipped"
 * decisions:
 *   - chose: tree-sitter walk per candidate file rather than reusing buildSymbolIndex
 *     because: the symbol index carries chunk metadata sivru doesn't need here; a direct walk keeps enforcement.ts free of the index dependency
 *     valid-while: the chunkable file set fits a linear walk at repo scale (10s of thousands of files)
 *     revisit-if: enforcement.ts becomes a per-PR hot path and the linear walk dominates
 * maturity: experimental
 * @end
 */
export async function checkEnforcement(
  blocks: readonly ExtractedBlock[],
  repoRoot: string,
): Promise<BlockDiagnostic[]> {
  // First pass: collect every distinct enforced-by reference up front
  // so we know whether we need the symbol map at all. Build it lazily
  // (a `check-enforcement` run with only null/file-anchored refs
  // should never walk the repo).
  //
  // `ref: null` represents a malformed `enforced-by` string — keeping
  // it as a discriminated `ParsedReference | null` (rather than a
  // sentinel `{ name: "" }`) means the malformed-check below is an
  // honest null-check, not a magic empty-string comparison.
  type Ref = { ref: ParsedReference | null; raw: string; block: ExtractedBlock };
  const refs: Ref[] = [];
  for (const eb of blocks) {
    if (eb.block === null || eb.block.invariants === undefined) continue;
    for (const inv of eb.block.invariants) {
      if (typeof inv === "string") continue;
      const enforcedBy = inv["enforced-by"];
      if (enforcedBy === null) continue;
      refs.push({
        ref: parseEnforcedBy(enforcedBy),
        raw: enforcedBy,
        block: eb,
      });
    }
  }

  // Lazy symbol-map build. One repo walk + parse for the whole batch.
  let symbolIndex: EnforcementIndex | null = null;
  const needsSymbolMap = refs.some((r) => r.ref !== null && r.ref.kind === "symbol");
  if (needsSymbolMap) {
    symbolIndex = await buildSymbolMap(repoRoot);
  }

  const diagnostics: BlockDiagnostic[] = [];
  for (const { ref, raw, block: eb } of refs) {
    if (ref === null) {
      diagnostics.push({
        code: "SIVRU-E230",
        severity: "error",
        message: `enforcement-missing: malformed \`enforced-by\` reference "${raw}" — expected \`Class.method\` or \`path::name\``,
        location: eb.range,
      });
      continue;
    }
    let result: ResolveResult;
    if (ref.kind === "file-anchored") {
      result = await resolveFileAnchored(ref, repoRoot);
    } else {
      // The needsSymbolMap predicate above guarantees symbolIndex is
      // populated whenever we reach this branch with a symbol-form ref.
      // Guard it explicitly so a future refactor can't break the
      // invariant silently.
      if (symbolIndex === null) {
        throw new Error(
          "enforcement: symbolIndex was expected to be built — bug in needsSymbolMap predicate",
        );
      }
      result = lookupSymbol(symbolIndex, ref);
    }
    if (result.kind === "missing") {
      diagnostics.push({
        code: "SIVRU-E230",
        severity: "error",
        message: `enforcement-missing: \`${raw}\` — ${result.reason}`,
        location: eb.range,
      });
    } else if (result.skipped) {
      diagnostics.push({
        code: "SIVRU-E231",
        severity: "error",
        message: `enforcement-skipped: \`${raw}\` resolves to a test marked skipped/disabled`,
        location: eb.range,
      });
    }
  }
  return diagnostics;
}

// Internal type export for tests.
export type { ResolveResult };
