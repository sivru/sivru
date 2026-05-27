// Single source of truth for "which tree-sitter declaration kinds host
// a `@sivru` block carrier per language" (DESIGN-0019 §8 / slot 4).
//
// Three call sites consumed copies of this set before the refactor:
//   - extract.ts (where blocks attach to declarations)
//   - enforcement.ts (where `enforced-by` symbol-form resolves)
//   - init.ts (where scaffolding picks a target symbol)
//
// Keeping them in lockstep matters because the chunker tree-sitter
// grammar exposes a fixed set of node types per language — when slot 4
// added Java `record_declaration` / `enum_declaration` /
// `annotation_type_declaration`, the other two consumers needed the
// same change or scaffolding would silently fail on records.

export type LanguageId =
  | "typescript"
  | "javascript"
  | "tsx"
  | "jsx"
  | "python"
  | "go"
  | "java"
  | "rust";

const TS_LIKE: readonly string[] = [
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "method_definition",
  "lexical_declaration",
  "variable_declaration",
  "type_alias_declaration",
  "enum_declaration",
];

const PYTHON: readonly string[] = [
  "function_definition",
  "class_definition",
];

const GO: readonly string[] = [
  "function_declaration",
  "method_declaration",
  "type_declaration",
  // Patch series: top-level `var`/`const` carry doc comments too.
  "var_declaration",
  "const_declaration",
];

const JAVA: readonly string[] = [
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "annotation_type_declaration",
  "method_declaration",
  "constructor_declaration",
];

const BY_LANGUAGE: Record<string, readonly string[]> = {
  typescript: TS_LIKE,
  javascript: TS_LIKE,
  tsx: TS_LIKE,
  jsx: TS_LIKE,
  python: PYTHON,
  go: GO,
  java: JAVA,
};

/**
 * Set of declaration node-type names that host a per-symbol `@sivru`
 * block in the given language. Unknown / unsupported languages return
 * an empty set — callers should fall back to "no per-symbol blocks."
 */
export function declTypesFor(language: string): ReadonlySet<string> {
  const list = BY_LANGUAGE[language];
  if (list === undefined) return new Set();
  return new Set(list);
}

/**
 * Used by tests + bridges that need to enumerate every supported
 * language. Adding a new language to BY_LANGUAGE is enough — callers
 * don't need to be updated.
 */
export const SUPPORTED_LANGUAGES: readonly string[] = Object.keys(BY_LANGUAGE);
