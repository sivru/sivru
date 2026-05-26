// Python decorator → canonical invariant catalog (DESIGN-0019 §10a).
// Seed list per the design discussion; the same merge / disable rules
// as the Java catalog apply.

import type { AnnotationBridge } from "./java.js";

export const PYTHON_BRIDGES: readonly AnnotationBridge[] = [
  {
    marker: "dataclass(frozen=True)",
    invariant: "immutable; equality by field",
  },
  {
    marker: "app.route",
    invariant: "HTTP entry point",
  },
  {
    marker: "pytest.fixture",
    invariant: "test-only construction",
  },
  {
    marker: "functools.cache",
    invariant: "memoised; safe to call repeatedly",
  },
];

/**
 * Same merge semantics as `resolveJavaBridges`; the leading `@` is
 * optional in user config.
 */
export function resolvePythonBridges(
  override?: Record<string, string>,
  disable?: readonly string[],
): AnnotationBridge[] {
  const seen = new Map<string, string>();
  for (const b of PYTHON_BRIDGES) seen.set(b.marker, b.invariant);
  if (override !== undefined) {
    for (const [k, v] of Object.entries(override)) {
      const marker = k.startsWith("@") ? k.slice(1) : k;
      if (typeof v === "string") seen.set(marker, v);
    }
  }
  if (disable !== undefined) {
    for (const k of disable) {
      const marker = k.startsWith("@") ? k.slice(1) : k;
      seen.delete(marker);
    }
  }
  return [...seen.entries()].map(([marker, invariant]) => ({
    marker,
    invariant,
  }));
}
