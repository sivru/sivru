import { describe, it, expect } from "vitest";

import { checkDeprecatedMaturitySync } from "./deprecated-sync.js";

const RANGE = { filePath: "fixture.java", startLine: 1, endLine: 10 };

describe("checkDeprecatedMaturitySync", () => {
  it("direction A — JavaDoc @deprecated + stable maturity → error", () => {
    const d = checkDeprecatedMaturitySync({
      docText: "/** @deprecated use the new API */",
      maturity: "stable",
      range: RANGE,
      language: "java",
    });
    expect(d?.code).toBe("SIVRU-E260");
    expect(d?.severity).toBe("error");
  });

  it("direction B — block deprecated + JavaDoc silent → warning", () => {
    const d = checkDeprecatedMaturitySync({
      docText: "/** old method */",
      maturity: "deprecated",
      range: RANGE,
      language: "java",
    });
    expect(d?.code).toBe("SIVRU-E260");
    expect(d?.severity).toBe("warning");
  });

  it("both agreeing → no diagnostic", () => {
    const d = checkDeprecatedMaturitySync({
      docText: "/** @deprecated */",
      maturity: "deprecated",
      range: RANGE,
      language: "java",
    });
    expect(d).toBeNull();
  });

  it("Go uses `// Deprecated:` convention", () => {
    const d = checkDeprecatedMaturitySync({
      docText: "// Deprecated: use Bar.",
      maturity: "stable",
      range: RANGE,
      language: "go",
    });
    expect(d?.code).toBe("SIVRU-E260");
  });
});
