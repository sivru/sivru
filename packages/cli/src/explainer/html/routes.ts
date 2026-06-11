// Hash-route table + self-verify for the explainer (DESIGN-0018 Slice 2).
//
// Every ExplainerNode becomes a pre-rendered <section data-route="<id>">. The
// client nav shim shows the section whose data-route matches location.hash.
// `selfVerify` is a PURE check over the generated HTML + the model — no headless
// browser. It asserts two directions:
//   1. every internal `#/…` link points at a section that exists  (no dead link)
//   2. every model node has a section                              (no missing view)
// The generator runs this BEFORE writing the file and refuses to emit a broken
// artifact; a vitest test runs it over fixtures (and a deliberately-broken one).

import type { ExplainerModel } from "../types.js";

/** The home route renders the system section. */
export const HOME_ROUTE = "#/";

/** The hash route for a node id. System is the home route. */
export function routeOf(id: string): string {
  return id === "system" ? HOME_ROUTE : `#/${encodeURIComponent(id)}`;
}

/** Every node id in the model (depth-first). */
export function allNodeIds(model: ExplainerModel): Set<string> {
  const ids = new Set<string>();
  const walk = (n: { id: string; children: { id: string; children: unknown[] }[] }): void => {
    ids.add(n.id);
    for (const c of n.children) walk(c as typeof n);
  };
  walk(model.root);
  return ids;
}

/** Internal link targets (`href="#/<id>"`), decoded. `#/` yields "". */
export function collectInternalLinks(html: string): string[] {
  const out: string[] = [];
  const re = /href="#\/([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(decodeURIComponent(m[1]!));
  return out;
}

/** Rendered section route keys (`data-route="<id>"`). */
export function collectSectionRoutes(html: string): string[] {
  const out: string[] = [];
  const re = /data-route="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1]!);
  return out;
}

export interface VerifyResult {
  ok: boolean;
  /** Link targets pointing at a section that does not exist. */
  brokenLinks: string[];
  /** Model nodes with no rendered section. */
  missingViews: string[];
  routes: number;
}

/** Verify the rendered HTML against the model. Pure; safe to run at gen time. */
export function selfVerify(html: string, model: ExplainerModel): VerifyResult {
  const nodeIds = allNodeIds(model);
  const sections = new Set(collectSectionRoutes(html));
  const brokenLinks = [
    ...new Set(
      collectInternalLinks(html).filter(
        (t) => t !== "" && t !== "system" && !sections.has(t),
      ),
    ),
  ].sort();
  const missingViews = [...nodeIds]
    .filter((id) => !sections.has(id))
    .sort();
  return {
    ok: brokenLinks.length === 0 && missingViews.length === 0,
    brokenLinks,
    missingViews,
    routes: sections.size,
  };
}
