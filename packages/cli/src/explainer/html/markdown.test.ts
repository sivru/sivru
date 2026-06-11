import { describe, expect, it } from "vitest";

import { mdToHtml } from "./markdown.js";

describe("mdToHtml", () => {
  it("renders headings below the page's own h1/h2 (md # → h3)", () => {
    expect(mdToHtml("# Title")).toBe("<h3>Title</h3>");
    expect(mdToHtml("## Sub")).toBe("<h4>Sub</h4>");
  });

  it("renders paragraphs, inline code, bold, and links", () => {
    expect(mdToHtml("a `code` and **bold** word")).toBe(
      "<p>a <code>code</code> and <strong>bold</strong> word</p>",
    );
    expect(mdToHtml("see [docs](https://x.test)")).toBe(
      '<p>see <a href="https://x.test" rel="noopener">docs</a></p>',
    );
  });

  it("keeps fenced code blocks monospaced (ASCII diagrams survive)", () => {
    const out = mdToHtml("```\nA --> B\n```");
    expect(out).toBe("<pre>A --&gt; B</pre>");
  });

  it("renders unordered and ordered lists", () => {
    expect(mdToHtml("- one\n- two")).toBe("<ul>\n<li>one</li>\n<li>two</li>\n</ul>");
    expect(mdToHtml("1. a\n2. b")).toBe("<ol>\n<li>a</li>\n<li>b</li>\n</ol>");
  });

  it("escapes HTML so the narrative cannot inject", () => {
    const out = mdToHtml("text <script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("does not treat fenced content as markdown", () => {
    const out = mdToHtml("```\n# not a heading\n- not a list\n```");
    expect(out).toContain("# not a heading");
    expect(out).not.toContain("<h3>");
    expect(out).not.toContain("<li>");
  });
});
