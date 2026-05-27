import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractBlocksFromFiles } from "./extract.js";
import { checkEnforcement, parseEnforcedBy, resolveEnforcement } from "./enforcement.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sivru-enforce-test-"));
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseEnforcedBy", () => {
  it("recognises the file-anchored form", () => {
    expect(parseEnforcedBy("path/foo.test.ts::clears tenant context")).toEqual({
      kind: "file-anchored",
      path: "path/foo.test.ts",
      name: "clears tenant context",
    });
  });

  it("recognises the symbol form with qualifier", () => {
    expect(parseEnforcedBy("TenantContextLeakTest.testClearsAfterException")).toEqual({
      kind: "symbol",
      qualifier: "TenantContextLeakTest",
      name: "testClearsAfterException",
    });
  });

  it("recognises bare symbol form", () => {
    expect(parseEnforcedBy("clearsAfterException")).toEqual({
      kind: "symbol",
      qualifier: null,
      name: "clearsAfterException",
    });
  });

  it("returns null for malformed input", () => {
    expect(parseEnforcedBy("")).toBeNull();
    expect(parseEnforcedBy("::no-path")).toBeNull();
    expect(parseEnforcedBy("Foo.")).toBeNull();
  });
});

describe("resolveEnforcement file-anchored", () => {
  it("finds an it() callsite by name", async () => {
    const testFile = join(tmpDir, "foo.test.ts");
    writeFileSync(
      testFile,
      `import { it } from "vitest";\nit("clears tenant context", () => {});\n`,
    );
    const result = await resolveEnforcement(
      { kind: "file-anchored", path: testFile, name: "clears tenant context" },
      tmpDir,
    );
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.skipped).toBe(false);
  });

  it("detects an it.skip() as skipped", async () => {
    const testFile = join(tmpDir, "foo.test.ts");
    writeFileSync(
      testFile,
      `it.skip("clears tenant context", () => {});\n`,
    );
    const result = await resolveEnforcement(
      { kind: "file-anchored", path: testFile, name: "clears tenant context" },
      tmpDir,
    );
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.skipped).toBe(true);
  });

  it("returns missing when no it() matches", async () => {
    const testFile = join(tmpDir, "foo.test.ts");
    writeFileSync(testFile, `it("something else", () => {});\n`);
    const result = await resolveEnforcement(
      { kind: "file-anchored", path: testFile, name: "clears tenant context" },
      tmpDir,
    );
    expect(result.kind).toBe("missing");
  });

  it("returns missing when the file doesn't exist", async () => {
    const result = await resolveEnforcement(
      { kind: "file-anchored", path: "/no/such/file.ts", name: "x" },
      tmpDir,
    );
    expect(result.kind).toBe("missing");
  });
});

describe("resolveEnforcement symbol form", () => {
  it("resolves to a top-level function declaration", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "math.ts"),
      `export function addsTwo(a: number, b: number) { return a + b; }\n`,
    );
    const result = await resolveEnforcement(
      { kind: "symbol", qualifier: null, name: "addsTwo" },
      tmpDir,
    );
    expect(result.kind).toBe("found");
  });

  it("misses when no declaration exists", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "math.ts"), `export const PI = 3.14;\n`);
    const result = await resolveEnforcement(
      { kind: "symbol", qualifier: null, name: "missingSymbol" },
      tmpDir,
    );
    expect(result.kind).toBe("missing");
  });

  it("detects JUnit @Disabled on a Java test method (skipped)", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "FooTest.java"),
      `import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;
class FooTest {
  @Test
  @Disabled
  void clearsTenantContext() {}
}
`,
    );
    const result = await resolveEnforcement(
      { kind: "symbol", qualifier: null, name: "clearsTenantContext" },
      tmpDir,
    );
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.skipped).toBe(true);
  });

  it("detects pytest.mark.skip decorator on a Python test (skipped)", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "test_foo.py"),
      `import pytest

@pytest.mark.skip(reason="WIP")
def test_clears_tenant_context():
    assert True
`,
    );
    const result = await resolveEnforcement(
      { kind: "symbol", qualifier: null, name: "test_clears_tenant_context" },
      tmpDir,
    );
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.skipped).toBe(true);
  });

  it("detects t.Skip() in a Go test (skipped)", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "foo_test.go"),
      `package foo
import "testing"
func TestClearsTenantContext(t *testing.T) {
  t.Skip("WIP")
  // body
}
`,
    );
    const result = await resolveEnforcement(
      { kind: "symbol", qualifier: null, name: "TestClearsTenantContext" },
      tmpDir,
    );
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.skipped).toBe(true);
  });

  it("does NOT mark a Go test as skipped when t.Skip appears in a comment only", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "foo_test.go"),
      `package foo
import "testing"
func TestClearsTenantContext(t *testing.T) {
  // Note: we used to t.Skip() here but no longer.
  if true {}
}
`,
    );
    const result = await resolveEnforcement(
      { kind: "symbol", qualifier: null, name: "TestClearsTenantContext" },
      tmpDir,
    );
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.skipped).toBe(false);
  });
});

describe("checkEnforcement", () => {
  it("emits SIVRU-E230 when the reference doesn't resolve", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    const src = `/**
 * @sivru
 * schema: 1
 * role: r
 * responsibility: r
 * invariants:
 *   - rule: "always y"
 *     enforced-by: missingTestThatDoesntExistAnywhere
 * @end
 */
export function foo() {}
`;
    writeFileSync(join(tmpDir, "src", "subject.ts"), src);
    const blocks = await extractBlocksFromFiles([join(tmpDir, "src", "subject.ts")]);
    const diagnostics = await checkEnforcement(blocks, tmpDir);
    const codes = diagnostics.map((d) => d.code);
    expect(codes).toContain("SIVRU-E230");
  });

  it("emits SIVRU-E231 when the test is skipped", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    const subject = `/**
 * @sivru
 * schema: 1
 * role: r
 * responsibility: r
 * invariants:
 *   - rule: "always y"
 *     enforced-by: "${join(tmpDir, "src", "subject.test.ts")}::clears state"
 * @end
 */
export function foo() {}
`;
    writeFileSync(join(tmpDir, "src", "subject.ts"), subject);
    writeFileSync(
      join(tmpDir, "src", "subject.test.ts"),
      `it.skip("clears state", () => {});\n`,
    );
    const blocks = await extractBlocksFromFiles([join(tmpDir, "src", "subject.ts")]);
    const diagnostics = await checkEnforcement(blocks, tmpDir);
    const codes = diagnostics.map((d) => d.code);
    expect(codes).toContain("SIVRU-E231");
  });

  it("clears when the test exists and is not skipped", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    const subject = `/**
 * @sivru
 * schema: 1
 * role: r
 * responsibility: r
 * invariants:
 *   - rule: "always y"
 *     enforced-by: "${join(tmpDir, "src", "subject.test.ts")}::clears state"
 * @end
 */
export function foo() {}
`;
    writeFileSync(join(tmpDir, "src", "subject.ts"), subject);
    writeFileSync(
      join(tmpDir, "src", "subject.test.ts"),
      `it("clears state", () => {});\n`,
    );
    const blocks = await extractBlocksFromFiles([join(tmpDir, "src", "subject.ts")]);
    const diagnostics = await checkEnforcement(blocks, tmpDir);
    expect(diagnostics).toHaveLength(0);
  });

  it("skips invariants with enforced-by:null (validate.ts handles E232)", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    const subject = `/**
 * @sivru
 * schema: 1
 * role: r
 * responsibility: r
 * invariants:
 *   - rule: "untested invariant"
 *     enforced-by: null
 * @end
 */
export function foo() {}
`;
    writeFileSync(join(tmpDir, "src", "subject.ts"), subject);
    const blocks = await extractBlocksFromFiles([join(tmpDir, "src", "subject.ts")]);
    const diagnostics = await checkEnforcement(blocks, tmpDir);
    // checkEnforcement does NOT emit E232 — that's validate.ts's job.
    expect(diagnostics.filter((d) => d.code === "SIVRU-E232")).toHaveLength(0);
  });
});
