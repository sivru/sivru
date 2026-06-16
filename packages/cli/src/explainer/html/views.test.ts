import { describe, expect, it } from "vitest";

import { fixtureModel, singlePackageModel } from "./fixture.js";
import { collapsedRootModule, renderSections } from "./views.js";

const sectionFor = (id: string, narrative?: string): string =>
  renderSections(fixtureModel(narrative !== undefined ? { narrative } : {})).find(
    (s) => s.id === id,
  )!.html;

describe("renderSections", () => {
  it("emits exactly one section per model node", () => {
    expect(renderSections(fixtureModel())).toHaveLength(6);
  });

  it("renders cycle / drift health badges when annotations mark a node", () => {
    const ann = {
      cycleMembers: new Set(["module:packages/a"]),
      brokenLinkages: new Set(["symbol:packages/a/src/x.ts#doThing"]),
    };
    const secs = renderSections(fixtureModel(), ann);
    const mod = secs.find((s) => s.id === "module:packages/a")!.html;
    const sym = secs.find((s) => s.id === "symbol:packages/a/src/x.ts#doThing")!.html;
    expect(mod).toContain("in a cycle");
    expect(mod).toContain("badge cycle");
    expect(sym).toContain("drift");
    expect(sym).toContain("badge drift");
    // a clean symbol carries no badge
    const clean = secs.find((s) => s.id === "symbol:packages/a/src/x.ts#helper")!.html;
    expect(clean).not.toContain("badge drift");
  });

  it("renders no health badges by default (annotations omitted)", () => {
    const mod = renderSections(fixtureModel()).find((s) => s.id === "module:packages/a")!.html;
    expect(mod).not.toContain("badge cycle");
  });

  it("only the system section is visible by default", () => {
    const sections = renderSections(fixtureModel());
    const system = sections.find((s) => s.id === "system")!.html;
    const other = sections.find((s) => s.id !== "system")!.html;
    expect(system).not.toContain("hidden");
    expect(other).toContain('class="view" data-route');
    expect(other).toContain("hidden");
  });
});

describe("symbol view", () => {
  it("renders the @sivru block when present", () => {
    const html = sectionFor("symbol:packages/a/src/x.ts#doThing");
    expect(html).toContain("@sivru block");
    expect(html).toContain("worker"); // role
    expect(html).toContain("do the thing"); // responsibility
  });

  it("renders a structured decision as labelled prose, not raw JSON", () => {
    const html = sectionFor("symbol:packages/a/src/x.ts#doThing");
    // the decision's prose is shown...
    expect(html).toContain("a bounded queue");
    expect(html).toContain("unbounded growth OOMs under load");
    expect(html).toContain("revisit if"); // camelCase key becomes a readable label
    // ...and never as a raw JSON object dump.
    expect(html).not.toContain('{"chose"');
    expect(html).not.toContain("revisitIf");
  });

  it("shows an add-intent affordance with a paste-able stub when no block", () => {
    const html = sectionFor("symbol:packages/a/src/x.ts#helper");
    expect(html).toContain("No @sivru block yet");
    expect(html).toContain("role: helper");
    expect(html).toContain("@end");
  });

  it("renders a collaborator radial only when collaborators exist", () => {
    expect(sectionFor("symbol:packages/a/src/x.ts#doThing")).toContain("Collaborators");
    expect(sectionFor("symbol:packages/a/src/x.ts#helper")).not.toContain("class=\"diagram\"");
  });
});

describe("module view empty states", () => {
  it("says 'no internal dependencies' for a module with none", () => {
    expect(sectionFor("module:packages/b")).toContain("no internal dependencies");
  });

  it("links out-deps and computes in-deps (reverse edges)", () => {
    const a = sectionFor("module:packages/a");
    expect(a).toContain("Depends on:");
    expect(a).toContain("@scope/b");
    const b = sectionFor("module:packages/b");
    expect(b).toContain("Depended on by:");
    expect(b).toContain("@scope/a");
  });
});

describe("system view", () => {
  it("leads with structure: overview + architecture map before the narrative", () => {
    const html = sectionFor("system");
    expect(html).toContain('class="overview"');
    expect(html).toContain("2 modules");
    expect(html).toContain("<h2>Architecture</h2>");
    expect(html).toContain('class="diagram"'); // the layered system map
    // The architecture map appears BEFORE the narrative disclosure.
    expect(html.indexOf("<h2>Architecture</h2>")).toBeLessThan(
      html.indexOf("About this system"),
    );
  });

  it("renders the narrative as markdown inside a collapsed <details>, not raw", () => {
    const html = sectionFor("system", "# Heading\n\nA small system that does **things**.");
    expect(html).toContain("<details");
    expect(html).toContain("About this system");
    expect(html).toContain("<h3>Heading</h3>"); // rendered, not raw "#"
    expect(html).toContain("<strong>things</strong>");
    expect(html).not.toContain("# Heading"); // no raw markdown leaking
  });

  it("shows an add-narrative card when the narrative is the stub", () => {
    const html = sectionFor("system", "No system narrative yet. Add one ...");
    expect(html).toContain("No system narrative yet");
    expect(html).toContain(".sivru/explainer.md");
  });

  it("names the foundation module(s) in the overview", () => {
    // @scope/b has no deps → it's the foundation.
    expect(sectionFor("system")).toMatch(/foundation:.*@scope\/b/);
  });
});

describe("escaping", () => {
  it("escapes a hostile symbol name in the rendered section", () => {
    const model = fixtureModel();
    model.root.children[0]!.name = "<script>x</script>";
    const html = renderSections(model).find((s) => s.id === "module:packages/a")!.html;
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("single-package collapse", () => {
  it("collapsedRootModule returns the lone empty-path module", () => {
    const sys = singlePackageModel().root;
    expect(collapsedRootModule(sys)?.id).toBe("module:.");
  });

  it("returns null for a monorepo (modules have real paths)", () => {
    expect(collapsedRootModule(fixtureModel().root)).toBeNull();
  });

  it("breadcrumb does not repeat the repo name (acme › auth › validateSession)", () => {
    const html = renderSections(singlePackageModel()).find(
      (s) => s.id === "symbol:src/auth/session.ts#validateSession",
    )!.html;
    const nav = /<nav class="breadcrumb">(.*?)<\/nav>/s.exec(html)![1]!;
    // three crumbs (acme, auth, validateSession) → two separators, not three.
    expect(nav.match(/class="sep"/g)).toHaveLength(2);
    expect(nav).toContain(">auth<");
    expect(nav).toContain(">validateSession<");
  });

});
