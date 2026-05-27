// Walk every blocked symbol; for each annotation/decorator the symbol
// carries that maps to a canonical invariant in the per-language
// catalog, verify the block's `invariants` list includes a matching
// rule. Default severity is warning (the author may have rejected the
// suggestion intentionally) — DESIGN-0019 §10b.
//
// SIVRU-E239 bridge-suggestion (warning).
// SIVRU-E260 deprecated-maturity-mismatch (error / warning per direction)
// is computed in deprecated-sync.ts and merged into the result here.

import { readFile } from "node:fs/promises";

import { detectLanguage } from "../chunker/language.js";
import { getParser, isChunkableLanguage, type SyntaxNode } from "../chunker/grammars.js";
import { loadBlockConfig } from "./config.js";
import { declTypesFor } from "./decl-types.js";
import { resolveJavaBridges, type AnnotationBridge } from "./bridges/java.js";
import { resolvePythonBridges } from "./bridges/python.js";
import { checkDeprecatedMaturitySync } from "./deprecated-sync.js";
import type { BlockDiagnostic, ExtractedBlock } from "./types.js";

/**
 * Languages whose source files we open + parse for deprecation/bridge
 * metadata. Java + Python supply annotation catalogs (E239); TS/JS/Go
 * supply doc-text patterns for E260 deprecated-maturity-mismatch.
 */
const METADATA_LANGUAGES = new Set([
  "java",
  "python",
  "javascript",
  "typescript",
  "tsx",
  "jsx",
  "go",
]);

type SymbolMetadata = {
  annotations: Set<string>;
  docText: string;
};

/**
 * Parse a single file once and produce a `symbol → metadata` map for
 * every symbol the file declares. Earlier implementation re-opened
 * + re-parsed the file for every blocked symbol it contained; this
 * version pays one parse cost per file regardless of block count.
 */
async function buildFileMetadata(
  filePath: string,
): Promise<Map<string, SymbolMetadata> | null> {
  const language = detectLanguage(filePath);
  if (language === null || !isChunkableLanguage(language)) return null;
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  let parser;
  try {
    parser = await getParser(language);
  } catch {
    return null;
  }
  const tree = parser.parse(content);
  try {
    if (tree === null) return null;
    const out = new Map<string, SymbolMetadata>();
    const lines = content.split("\n");

    const recordSymbol = (
      symbolName: string,
      annotations: ReadonlySet<string>,
      declLineIdx: number,
    ): void => {
      let docText = "";
      let i = declLineIdx - 1;
      while (i >= 0 && /^\s*(?:\/\/|\*|#|\/\*|@)/.test(lines[i]!)) {
        docText = lines[i]! + "\n" + docText;
        i -= 1;
      }
      out.set(symbolName, { annotations: new Set(annotations), docText });
    };

    // Declaration kinds that host a block per language — shared with
    // extract / enforcement / init via decl-types.ts.
    const declTypes = declTypesFor(language);

    const visit = (n: SyntaxNode): void => {
      if (language === "java" && declTypes.has(n.type)) {
        const nameNode = n.childForFieldName("name");
        if (nameNode !== null) {
          const annotations = new Set<string>();
          for (const child of n.children) {
            if (child.type === "modifiers") {
              for (const m of child.text.matchAll(/@(\w+)/g)) {
                annotations.add(m[1]!);
              }
            }
          }
          recordSymbol(nameNode.text, annotations, n.startPosition.row);
        }
      } else if (language === "python" && n.type === "decorated_definition") {
        const def = n.namedChildren.find(
          (c) => c.type === "function_definition" || c.type === "class_definition",
        );
        const defName = def === undefined ? null : def.childForFieldName("name");
        if (defName !== null) {
          const annotations = new Set<string>();
          for (const dec of n.namedChildren) {
            if (dec.type !== "decorator") continue;
            const callForm = dec.text.replace(/^@/, "");
            annotations.add(callForm.replace(/\(.*$/, ""));
            annotations.add(callForm);
          }
          recordSymbol(defName.text, annotations, n.startPosition.row);
        }
      } else if (language === "python" && declTypes.has(n.type)) {
        // Bare def/class with no decorators — still record so doc-text
        // is available for E260 detection.
        const nameNode = n.childForFieldName("name");
        if (nameNode !== null) {
          recordSymbol(nameNode.text, new Set(), n.startPosition.row);
        }
      } else if (
        // TS / JS / TSX / JSX / Go: no annotation catalog (those are
        // Java+Python), but we still need to record symbols so doc-text
        // extraction feeds E260 deprecated-maturity-mismatch detection.
        declTypes.has(n.type) &&
        (language === "typescript" ||
          language === "javascript" ||
          language === "tsx" ||
          language === "jsx" ||
          language === "go")
      ) {
        const nameNode = n.childForFieldName("name");
        if (nameNode !== null && nameNode.text.length > 0) {
          recordSymbol(nameNode.text, new Set(), n.startPosition.row);
        }
      }
      for (const c of n.namedChildren) visit(c);
    };
    visit(tree.rootNode);
    return out;
  } finally {
    if (tree !== null && typeof (tree as { delete?: () => void }).delete === "function") {
      (tree as { delete: () => void }).delete();
    }
  }
}

function invariantRules(block: NonNullable<ExtractedBlock["block"]>): string[] {
  return (block.invariants ?? []).map((inv) =>
    typeof inv === "string" ? inv : inv.rule,
  );
}

function bridgesForLanguage(
  language: string,
  override: Record<string, string> | undefined,
  disable: readonly string[] | undefined,
): AnnotationBridge[] {
  if (language === "java") return resolveJavaBridges(override, disable);
  if (language === "python") return resolvePythonBridges(override, disable);
  return [];
}

/**
 * @sivru
 * schema: 1
 * role: bridge-checker
 * responsibility: walk every blocked symbol; emit SIVRU-E239 when an annotation's canonical invariant is missing from the block
 * collaborators: [resolveJavaBridges, resolvePythonBridges, checkDeprecatedMaturitySync]
 * invariants:
 *   - rule: matching is substring on invariant prose (the canonical string must appear inside an invariant.rule)
 *     enforced-by: null
 *   - rule: catalog merge gives user/project overrides priority over seeds; disabled markers are dropped entirely
 *     enforced-by: null
 *   - rule: each source file is parsed once regardless of how many blocked symbols it contains
 *     enforced-by: null
 * decisions:
 *   - chose: substring match rather than exact equality
 *     because: authors paraphrase canonical invariants in the wild; exact match would surface noise on every block
 *     valid-while: canonical strings stay short and unambiguous
 *     revisit-if: false-positives swamp the slot 3 dogfood pass
 * maturity: experimental
 * @end
 */
export async function checkBridges(
  blocks: readonly ExtractedBlock[],
  repoRoot: string,
): Promise<BlockDiagnostic[]> {
  const cfg = loadBlockConfig(repoRoot);
  const diagnostics: BlockDiagnostic[] = [];

  // Group blocks by file so each file is parsed once.
  const blocksByFile = new Map<string, ExtractedBlock[]>();
  for (const eb of blocks) {
    if (eb.block === null || eb.symbolName === undefined) continue;
    const arr = blocksByFile.get(eb.filePath);
    if (arr === undefined) blocksByFile.set(eb.filePath, [eb]);
    else arr.push(eb);
  }

  for (const [filePath, fileBlocks] of blocksByFile.entries()) {
    const language = detectLanguage(filePath);
    if (language === null) continue;
    const bridges = bridgesForLanguage(
      language,
      cfg.bridges?.[language as "java" | "python"],
      cfg.bridges?.disable,
    );

    // Even when there are no bridges for the language, we still need
    // file metadata for SIVRU-E260 detection (`@deprecated` ↔ block
    // maturity). Skip the file only when neither check applies.
    if (bridges.length === 0 && !METADATA_LANGUAGES.has(language)) {
      continue;
    }

    const meta = await buildFileMetadata(filePath);
    if (meta === null) continue;

    for (const eb of fileBlocks) {
      const symMeta = meta.get(eb.symbolName!);
      if (symMeta === undefined) continue;
      const rules = invariantRules(eb.block!);
      for (const b of bridges) {
        const hasAnnotation =
          symMeta.annotations.has(b.marker) ||
          [...symMeta.annotations].some((a) => a.startsWith(b.marker));
        if (!hasAnnotation) continue;
        const hasInvariant = rules.some((r) => r.includes(b.invariant));
        if (!hasInvariant) {
          diagnostics.push({
            code: "SIVRU-E239",
            severity: "warning",
            message: `bridge-suggestion: @${b.marker} suggests invariant "${b.invariant}" — not present in the block`,
            location: eb.range,
          });
        }
      }

      const e260 = checkDeprecatedMaturitySync({
        docText: symMeta.docText,
        maturity: eb.block!.maturity,
        range: eb.range,
        language,
      });
      if (e260 !== null) diagnostics.push(e260);
    }
  }

  return diagnostics;
}
