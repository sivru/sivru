// Java annotation → canonical invariant catalog (DESIGN-0019 §10a).
// Seed list lifted directly from the design table; projects extend via
// `.sivru/block.json` `bridges.java` or via the layer-3 customization
// shape (`AnnotationBridge`).
//
// Catalog keys are the annotation name WITHOUT the leading `@`. Matching
// is whole-word; arguments inside `()` are not interpreted (the bridge
// only sees the annotation marker).
//
// Two surfaces consume this catalog:
//   - `sivru block init` pre-fills the suggested invariant in the
//     generated block (slot 3 §10b).
//   - `sivru block check-bridges` flags annotations whose canonical
//     invariant is missing from the block (SIVRU-E239 warning).

export type AnnotationBridge = {
  /** Annotation marker, no leading `@` (e.g., "ApplicationScoped"). */
  marker: string;
  /** Canonical invariant string to inject / require. */
  invariant: string;
};

export const JAVA_BRIDGES: readonly AnnotationBridge[] = [
  {
    marker: "ApplicationScoped",
    invariant: "thread-safe; no instance state",
  },
  {
    marker: "Singleton",
    invariant: "thread-safe; no instance state",
  },
  {
    marker: "RequestScoped",
    invariant: "one instance per HTTP request",
  },
  {
    marker: "Transactional",
    invariant: "must be called via CDI proxy; never `this.method()`",
  },
  {
    marker: "Filter",
    invariant: "tenant-scoped; JPQL only",
  },
  {
    marker: "Audited",
    invariant: "every call writes an audit row",
  },
  {
    marker: "SecurityChecked",
    invariant: "RBAC enforced at entry",
  },
  {
    marker: "Retryable",
    invariant: "idempotent; safe to re-run on failure",
  },
];

/**
 * Resolve the effective Java bridge list. Layered merge: user / project
 * overrides REPLACE the seed entry for the same marker; disabled markers
 * are dropped entirely.
 */
export function resolveJavaBridges(
  override?: Record<string, string>,
  disable?: readonly string[],
): AnnotationBridge[] {
  const seen = new Map<string, string>();
  for (const b of JAVA_BRIDGES) seen.set(b.marker, b.invariant);
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
