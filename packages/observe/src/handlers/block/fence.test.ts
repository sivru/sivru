import { describe, expect, it } from "vitest";

import { detectFencePrefix, rewriteFence } from "./fence.js";

// Body the editor would produce (serializeBlock output — no comment markers).
const NEW_BODY = `@sivru
schema: 1
role: updated
responsibility: now does more
maturity: stable
@end`;

describe("rewriteFence", () => {
  it("rewrites a JSDoc fence, preserving /** */ and the ' * ' prefix", () => {
    const src = `/**
 * @sivru
 * schema: 1
 * role: old
 * @end
 */
export function f() {}
`;
    // @sivru is line 2, @end is line 5 (1-indexed).
    const r = rewriteFence(src, { startLine: 2, endLine: 5 }, NEW_BODY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toContain("/**");
    expect(r.content).toContain(" * @sivru");
    expect(r.content).toContain(" * role: updated");
    expect(r.content).toContain(" * maturity: stable");
    expect(r.content).toContain(" */");
    expect(r.content).toContain("export function f() {}");
    // The /** opener and */ closer survive.
    expect(r.content.startsWith("/**\n")).toBe(true);
  });

  it("handles the new body being LONGER than the original (splice N for M)", () => {
    const src = `/**
 * @sivru
 * role: old
 * @end
 */
const x = 1;
`;
    const r = rewriteFence(src, { startLine: 2, endLine: 4 }, NEW_BODY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 5-line body replaced a 3-line fence; everything after still intact.
    expect(r.content).toContain("const x = 1;");
    expect(r.content).toContain(" * responsibility: now does more");
    expect(r.content.match(/@sivru/g)).toHaveLength(1);
    expect(r.content.match(/@end/g)).toHaveLength(1);
  });

  it("handles the new body being SHORTER than the original", () => {
    const src = `/**
 * @sivru
 * schema: 1
 * role: old
 * responsibility: long
 * collaborators: [a, b, c]
 * maturity: experimental
 * @end
 */
const y = 2;
`;
    const short = `@sivru
schema: 1
role: tiny
@end`;
    const r = rewriteFence(src, { startLine: 2, endLine: 8 }, short);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toContain(" * role: tiny");
    expect(r.content).not.toContain("collaborators");
    expect(r.content).toContain("const y = 2;");
  });

  it("rewrites a // line-comment fence", () => {
    const src = `// @sivru
// schema: 1
// role: old
// @end
fn main() {}
`;
    const r = rewriteFence(src, { startLine: 1, endLine: 4 }, NEW_BODY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toContain("// @sivru");
    expect(r.content).toContain("// role: updated");
    expect(r.content).toContain("fn main() {}");
  });

  it("rewrites a Python docstring fence (indentation-only prefix)", () => {
    const src = `def thing():
    """
    @sivru
    schema: 1
    role: old
    @end
    """
    return 1
`;
    // @sivru line 3, @end line 6.
    const r = rewriteFence(src, { startLine: 3, endLine: 6 }, NEW_BODY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toContain('    """');
    expect(r.content).toContain("    @sivru");
    expect(r.content).toContain("    role: updated");
    expect(r.content).toContain("    return 1");
  });

  it("blank body lines get a trimmed prefix (no trailing whitespace)", () => {
    const src = `/**
 * @sivru
 * role: old
 * @end
 */
`;
    const bodyWithBlank = "@sivru\nrole: updated\n\n@end";
    const r = rewriteFence(src, { startLine: 2, endLine: 4 }, bodyWithBlank);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toContain(" *\n"); // trimmed, not " * \n"
  });

  it("rejects an out-of-bounds range", () => {
    const r = rewriteFence("a\nb\n", { startLine: 5, endLine: 9 }, NEW_BODY);
    expect(r.ok).toBe(false);
  });

  it("rejects when the recorded start line no longer holds @sivru (file moved)", () => {
    const src = "const z = 3;\nmore();\n";
    const r = rewriteFence(src, { startLine: 1, endLine: 2 }, NEW_BODY);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/@sivru/);
  });
});

describe("detectFencePrefix", () => {
  it("returns the prefix for JSDoc and null when absent", () => {
    const src = " /**\n  * @sivru\n  * @end\n  */\n";
    expect(detectFencePrefix(src, { startLine: 2, endLine: 3 })).toBe("  * ");
    expect(detectFencePrefix("nope\n", { startLine: 1, endLine: 1 })).toBeNull();
  });
});
