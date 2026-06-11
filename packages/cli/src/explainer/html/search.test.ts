import { describe, expect, it } from "vitest";

import { fixtureModel } from "./fixture.js";
import { buildSearchIndex } from "./search.js";

describe("buildSearchIndex", () => {
  const index = buildSearchIndex(fixtureModel());

  it("excludes the system node (it's the home route)", () => {
    expect(index.some((e) => e.level === "system")).toBe(false);
  });

  it("includes modules, packages, and symbols with routes", () => {
    expect(index).toHaveLength(5); // 2 mod + 1 pkg + 2 sym
    const sym = index.find((e) => e.name === "doThing")!;
    expect(sym.level).toBe("symbol");
    expect(sym.route).toBe("#/symbol%3Apackages%2Fa%2Fsrc%2Fx.ts%23doThing");
  });

  it("a substring query matches by name (the client filter contract)", () => {
    const q = "thing";
    const hits = index.filter((e) => e.name.toLowerCase().includes(q));
    expect(hits.map((e) => e.name)).toContain("doThing");
  });
});
