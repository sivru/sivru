import { describe, expect, it } from "vitest";

import { fixtureModel } from "./fixture.js";
import { renderSections } from "./views.js";
import {
  allNodeIds,
  collectInternalLinks,
  routeOf,
  selfVerify,
} from "./routes.js";

describe("routeOf", () => {
  it("maps system to the home route and others to encoded hashes", () => {
    expect(routeOf("system")).toBe("#/");
    expect(routeOf("module:packages/a")).toBe("#/module%3Apackages%2Fa");
  });
});

describe("allNodeIds", () => {
  it("collects every node in the tree", () => {
    expect(allNodeIds(fixtureModel()).size).toBe(6); // system+2mod+1pkg+2sym
  });
});

describe("selfVerify", () => {
  const model = fixtureModel();
  const html = renderSections(model)
    .map((s) => s.html)
    .join("");

  it("passes on the real rendered HTML (no dead links, no missing views)", () => {
    const r = selfVerify(html, model);
    expect(r.ok).toBe(true);
    expect(r.brokenLinks).toEqual([]);
    expect(r.missingViews).toEqual([]);
    expect(r.routes).toBe(6);
  });

  it("every internal link resolves to a node id (or home)", () => {
    const ids = allNodeIds(model);
    for (const t of collectInternalLinks(html)) {
      if (t === "" || t === "system") continue;
      expect(ids.has(t)).toBe(true);
    }
  });

  it("catches a deliberately-broken link", () => {
    const broken = html + '<a href="#/module%3Apackages%2Fghost">ghost</a>';
    const r = selfVerify(broken, model);
    expect(r.ok).toBe(false);
    expect(r.brokenLinks).toContain("module:packages/ghost");
  });

  it("catches a missing view (a node with no section)", () => {
    // Render only the system section → the modules/packages/symbols are missing.
    const partial = renderSections(model)[0]!.html;
    const r = selfVerify(partial, model);
    expect(r.ok).toBe(false);
    expect(r.missingViews.length).toBeGreaterThan(0);
  });
});
