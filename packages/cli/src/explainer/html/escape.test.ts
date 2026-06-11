import { describe, expect, it } from "vitest";

import { escapeHtml, jsonIsland } from "./escape.js";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("renders an injection attempt inert", () => {
    const out = escapeHtml(`<img src=x onerror="alert(1)">`);
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).toContain("&quot;");
  });

  it("leaves safe text untouched", () => {
    expect(escapeHtml("buildExplainerModel")).toBe("buildExplainerModel");
  });
});

describe("jsonIsland", () => {
  it("escapes < so a </script> in a value cannot close the tag", () => {
    const model = { name: "weird</script><script>alert(1)</script>" };
    const island = jsonIsland(model);
    expect(island).not.toContain("</script>");
    expect(island).toContain("\\u003c/script>");
  });

  it("round-trips through JSON.parse unchanged", () => {
    const model = { a: "x </script> y", b: ["<", "&", '"'], n: 5 };
    expect(JSON.parse(jsonIsland(model))).toEqual(model);
  });
});
