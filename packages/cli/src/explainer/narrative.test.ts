import { describe, expect, it } from "vitest";

import { resolveNarrative } from "./narrative.js";

/** Build an injected reader over an in-memory {rel: content} map. */
function reader(files: Record<string, string>) {
  return async (_repoRoot: string, rel: string): Promise<string | null> => {
    const text = files[rel];
    return text !== undefined && text.trim().length > 0 ? text : null;
  };
}

describe("resolveNarrative", () => {
  it("prefers .sivru/explainer.md over repo docs", async () => {
    const r = await resolveNarrative("/repo", {
      read: reader({
        ".sivru/explainer.md": "authored narrative",
        "ARCHITECTURE.md": "arch doc",
        "README.md": "readme",
      }),
    });
    expect(r.origin).toBe(".sivru/explainer.md");
    expect(r.text).toBe("authored narrative");
  });

  it("falls back to ARCHITECTURE.md, then README.md", async () => {
    const arch = await resolveNarrative("/repo", {
      read: reader({ "ARCHITECTURE.md": "arch", "README.md": "readme" }),
    });
    expect(arch.origin).toBe("ARCHITECTURE.md");

    const readme = await resolveNarrative("/repo", {
      read: reader({ "README.md": "readme" }),
    });
    expect(readme.origin).toBe("README.md");
  });

  it("emits a stub when no source exists", async () => {
    const r = await resolveNarrative("/repo", { read: reader({}) });
    expect(r.origin).toBe("stub");
    expect(r.text).toMatch(/explainer\.md/);
  });

  it("treats a whitespace-only file as absent", async () => {
    const r = await resolveNarrative("/repo", {
      read: reader({ ".sivru/explainer.md": "   \n  ", "README.md": "real" }),
    });
    expect(r.origin).toBe("README.md");
  });
});
