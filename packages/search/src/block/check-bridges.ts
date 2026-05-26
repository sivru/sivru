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
import { resolveJavaBridges, type AnnotationBridge } from "./bridges/java.js";
import { resolvePythonBridges } from "./bridges/python.js";
import { checkDeprecatedMaturitySync } from "./deprecated-sync.js";
import type { BlockDiagnostic, ExtractedBlock } from "./types.js";

/**
 * Find the leading annotations / decorators attached to a symbol named
 * `symbolName` in the file. Returns the set of annotation markers
 * (without the leading `@`) and the surrounding JavaDoc/JSDoc text.
 */
async function symbolMetadata(
  filePath: string,
  symbolName: string,
): Promise<{ annotations: Set<string>; docText: string } | null> {
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
    const annotations = new Set<string>();
    let docText = "";

    const visit = (n: SyntaxNode): boolean => {
      const nameNode = n.childForFieldName?.("name");
      if (nameNode !== null && nameNode?.text === symbolName) {
        // Java: leading modifiers contain annotations.
        if (language === "java") {
          for (const child of n.children) {
            if (child.type === "modifiers") {
              for (const m of child.text.matchAll(/@(\w+)/g)) {
                annotations.add(m[1]!);
              }
            }
          }
        }
        // Python: decorated_definition is the PARENT — already handled
        // above. Skip.
        return true;
      }
      // Python decorators sit on the parent decorated_definition.
      if (language === "python" && n.type === "decorated_definition") {
        const def = n.namedChildren.find(
          (c) => c.type === "function_definition" || c.type === "class_definition",
        );
        const defName = def?.childForFieldName("name");
        if (defName?.text === symbolName) {
          for (const dec of n.namedChildren) {
            if (dec.type !== "decorator") continue;
            const text = dec.text.replace(/^@/, "").replace(/\(.*$/, "");
            annotations.add(text);
            // Also keep the call form (e.g. `dataclass(frozen=True)`).
            annotations.add(dec.text.replace(/^@/, ""));
          }
          return true;
        }
      }
      for (const c of n.namedChildren) {
        if (visit(c)) return true;
      }
      return false;
    };
    visit(tree.rootNode);

    // Doc text: best-effort — find the comment immediately above the
    // declaration line. Used by deprecated-sync.ts.
    const lines = content.split("\n");
    const declLineIdx = lines.findIndex(
      (l) => new RegExp(`\\b${symbolName}\\b`).test(l),
    );
    if (declLineIdx > 0) {
      let i = declLineIdx - 1;
      while (i >= 0 && /^\s*(?:\/\/|\*|#|\/\*|@)/.test(lines[i]!)) {
        docText = lines[i]! + "\n" + docText;
        i -= 1;
      }
    }
    return { annotations, docText };
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

  for (const eb of blocks) {
    if (eb.block === null || eb.symbolName === undefined) continue;
    const language = detectLanguage(eb.filePath);
    if (language === null) continue;
    const bridges = bridgesForLanguage(
      language,
      cfg.bridges?.[language as "java" | "python"],
      cfg.bridges?.disable,
    );
    if (bridges.length === 0) continue;

    const meta = await symbolMetadata(eb.filePath, eb.symbolName);
    if (meta === null) continue;

    const rules = invariantRules(eb.block);
    for (const b of bridges) {
      const hasAnnotation =
        meta.annotations.has(b.marker) ||
        // Allow short-form match for python decorators that include args.
        [...meta.annotations].some((a) => a.startsWith(b.marker));
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

    // SIVRU-E260: JavaDoc / docstring @deprecated ↔ block.maturity.
    const e260 = checkDeprecatedMaturitySync({
      docText: meta.docText,
      maturity: eb.block.maturity,
      range: eb.range,
      language,
    });
    if (e260 !== null) diagnostics.push(e260);
  }

  return diagnostics;
}
