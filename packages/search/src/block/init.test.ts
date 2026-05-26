import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initBlock } from "./init.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sivru-init-test-"));
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("initBlock", () => {
  it("scaffolds a TS block with collaborators + heuristic role", async () => {
    const path = join(tmpDir, "FooService.ts");
    writeFileSync(
      path,
      `import { Logger } from "./logger";\nimport { Storage } from "./storage";\n\nexport class FooService {\n  doThing() {}\n}\n`,
    );
    const result = await initBlock(path, { write: false, force: false });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.block).toContain("role: service");
      expect(result.block).toContain("Logger");
      expect(result.block).toContain("Storage");
      expect(result.block).toContain("maturity: experimental");
    }
  });

  it("refuses to scaffold over an existing block without --force", async () => {
    const path = join(tmpDir, "FooService.ts");
    writeFileSync(
      path,
      `/**\n * @sivru\n * schema: 1\n * role: r\n * responsibility: r\n * @end\n */\nexport class FooService {}\n`,
    );
    const result = await initBlock(path, { write: false, force: false });
    expect(result.kind).toBe("err");
  });

  it("--write inserts the block above the declaration", async () => {
    const path = join(tmpDir, "FooService.ts");
    writeFileSync(
      path,
      `import { Logger } from "./logger";\n\nexport class FooService {\n}\n`,
    );
    const result = await initBlock(path, { write: true, force: false });
    expect(result.kind).toBe("ok");
    const after = readFileSync(path, "utf8");
    expect(after).toContain("@sivru");
    expect(after).toContain("@end");
    // Insertion happened above the class declaration.
    const sivruIdx = after.indexOf("@sivru");
    const classIdx = after.indexOf("class FooService");
    expect(sivruIdx).toBeGreaterThan(0);
    expect(classIdx).toBeGreaterThan(sivruIdx);
  });
});
