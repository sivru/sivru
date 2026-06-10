// Client-side search index for the explainer (DESIGN-0018 Slice 2).
//
// The index (model → flat entries) is built here in TS and unit-tested; it is
// inlined into the HTML as a JSON island. The client filter is a trivial
// case-insensitive substring match over `name` (fuzzy ranking is a deferred
// enhancement) and lives in the nav shim — too small to share without a
// bundler, covered by the "shim parses as valid JS" test.

import type { ExplainerModel, ExplainerNode } from "../types.js";
import { routeOf } from "./routes.js";

export interface SearchEntry {
  id: string;
  name: string;
  level: string;
  route: string;
}

/** Flatten every node into a searchable entry (system excluded — it's home). */
export function buildSearchIndex(model: ExplainerModel): SearchEntry[] {
  const out: SearchEntry[] = [];
  const walk = (n: ExplainerNode): void => {
    if (n.level !== "system") {
      out.push({ id: n.id, name: n.name, level: n.level, route: routeOf(n.id) });
    }
    n.children.forEach(walk);
  };
  walk(model.root);
  return out;
}
