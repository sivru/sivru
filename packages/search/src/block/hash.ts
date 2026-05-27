// Shared content-hash helper for @sivru blocks (DESIGN-0019 §2).
//
// staleness.ts and block-cache.ts previously each carried a private
// 16-char-sha256-prefix wrapper around `JSON.stringify(block)`. Two
// copies, same shape — exactly the DRY pattern the code-review
// flagged.
//
// `JSON.stringify` defaults to insertion order; for hash stability
// across small parser refactors we sort the top-level keys before
// stringifying. The block shape has no nested objects whose key
// order could vary (decisions / invariants are arrays; sub-object
// fields are fixed at construction), so a single-level sort is
// sufficient. If we ever ship a block with nested freeform mappings,
// upgrade to a deep canonical-JSON helper.

import { createHash } from "node:crypto";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
      .join(",") +
    "}"
  );
}

/**
 * 16-char sha256 prefix over a canonical stringification of `block`.
 * Stable across field-insertion-order changes — two blocks with the
 * same field values hash identically regardless of construction order.
 */
export function hashBlockContent(block: unknown): string {
  return createHash("sha256")
    .update(stableStringify(block))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Sentinel `symbolName` for module-level blocks. The same string
 * literal `"(module)"` was duplicated in block-cache.ts, staleness.ts,
 * and graph.ts — centralised here so a rename doesn't have to chase
 * three copies.
 */
export const MODULE_SYMBOL_NAME = "(module)";
