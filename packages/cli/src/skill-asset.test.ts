import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  looksLikeSivruSkill,
  readBundledSkill,
  resolveSkillAssetPath,
} from "./skill-asset.js";

describe("skill-asset", () => {
  it("resolves the bundled SKILL.md to a file that exists", () => {
    // This is the packaging-resolution guard (DESIGN-0003 test gap 1):
    // the asset must be resolvable from this module's location.
    const path = resolveSkillAssetPath();
    expect(path.endsWith("SKILL.md")).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it("reads the bundled skill and it carries sivru frontmatter", () => {
    const content = readBundledSkill();
    expect(content.startsWith("---")).toBe(true);
    expect(looksLikeSivruSkill(content)).toBe(true);
  });

  it("looksLikeSivruSkill rejects unrelated content", () => {
    expect(looksLikeSivruSkill("just some notes\n")).toBe(false);
    expect(looksLikeSivruSkill("# a heading\n\nbody\n")).toBe(false);
    expect(looksLikeSivruSkill("---\nname: other-skill\n---\nbody")).toBe(
      false,
    );
    expect(looksLikeSivruSkill("")).toBe(false);
  });

  it("looksLikeSivruSkill accepts quoted and CRLF frontmatter", () => {
    expect(looksLikeSivruSkill('---\nname: "sivru"\n---\nx')).toBe(true);
    expect(looksLikeSivruSkill("---\nname: 'sivru'\n---\nx")).toBe(true);
    expect(looksLikeSivruSkill("---\r\nname: sivru\r\n---\r\nx")).toBe(true);
  });
});
