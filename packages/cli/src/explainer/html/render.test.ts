import { describe, expect, it } from "vitest";

import { fixtureModel } from "./fixture.js";
import { CLIENT_JS, renderHtml } from "./render.js";

describe("renderHtml", () => {
  const html = renderHtml(fixtureModel());

  it("emits one self-contained HTML document", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("</html>");
    expect(html).toContain('<script type="application/json" id="model-island">');
    expect(html).toContain('<script type="application/json" id="search-index">');
  });

  it("does not leak the author's absolute repo path (island carries the basename)", () => {
    const island = JSON.parse(html.match(/id="model-island">([^<]*)</)![1]!.replace(/\\u003c/g, "<"));
    expect(island.repoPath).toBe("repo"); // basename of the fixture's "/repo"
    expect(island.repoPath.startsWith("/")).toBe(false);
  });

  it("is offline: no external assets (no fetched src/href, no <link>)", () => {
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<script src=");
    expect(html).not.toMatch(/src="https?:/);
    // The only http(s) reference allowed is the SVG xmlns namespace.
    const externalHrefs = html.match(/href="https?:[^"]*"/g) ?? [];
    expect(externalHrefs).toEqual([]);
  });

  it("does not throw self-verify on a coherent model", () => {
    expect(() => renderHtml(fixtureModel())).not.toThrow();
  });

  it("neutralizes a </script> inside repo-derived strings (XSS)", () => {
    const model = fixtureModel();
    model.root.children[0]!.children[0]!.children[0]!.name =
      "evil</script><script>alert(1)</script>";
    const out = renderHtml(model);
    // The JSON island escapes < so the injected </script> cannot close the tag.
    expect(out).toContain("\\u003c/script>");
    // The section text escapes it to entities, never a raw executable tag.
    expect(out).not.toContain("<script>alert(1)</script>");
  });

  it("the inlined nav shim is syntactically valid JavaScript", () => {
    expect(() => new Function(CLIENT_JS)).not.toThrow();
  });

  it("ships the Slice 3 feedback scaffolding (toggle, export, editable fields)", () => {
    expect(html).toContain('id="fb-mode"');
    expect(html).toContain('id="fb-export"');
    expect(html).toMatch(/class="block" data-node-id="[^"]+" data-path="[^"]+" data-symbol="[^"]+" data-hash="[^"]*"/);
    expect(html).toContain('data-editable data-edit-field="responsibility"');
    expect(html).toContain('data-editable data-edit-field="collaborators"');
  });

  it("offers the create-block + narrative + note affordances (closing the un-annotated path)", () => {
    expect(html).toMatch(/class="fb-create"[^>]*data-symbol="helper"[^>]*data-decl="12"/);
    expect(html).toContain('class="fb-narrative"');
    expect(html).toContain('class="fb-note"');
  });

  it("renders the sidebar tree to package level", () => {
    expect(html).toContain('class="tree"');
    expect(html).toContain("@scope/a"); // module
    expect(html).toContain(">src<"); // package name in the tree
  });
});
