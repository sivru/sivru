// Resolver registry (DESIGN-0004 §3b). Each language's resolver is a
// thin module satisfying the shared `Resolver` interface; this file is the
// dispatch table the symbol-index core uses.
//
// As of v0.5 only the TypeScript / JavaScript resolver is wired in; the
// Python (T3), Go (T4), and Java (T5) resolvers add entries here.

import type { Resolver } from "../types.js";
import { goResolver } from "./go.js";
import { pythonResolver } from "./python.js";
import { typescriptResolver } from "./typescript.js";

const REGISTRY = new Map<string, Resolver>();

function register(languages: readonly string[], resolver: Resolver): void {
  for (const lang of languages) REGISTRY.set(lang, resolver);
}

register(["typescript", "tsx", "javascript", "jsx"], typescriptResolver);
register(["python"], pythonResolver);
register(["go"], goResolver);

/** Look up the resolver for a given language id. `null` when unsupported. */
export function resolverFor(language: string | null): Resolver | null {
  if (language === null) return null;
  return REGISTRY.get(language) ?? null;
}

/** All language ids the explain module currently resolves. */
export function supportedLanguages(): readonly string[] {
  return Array.from(REGISTRY.keys());
}
