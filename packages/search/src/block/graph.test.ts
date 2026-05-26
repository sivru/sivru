import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeBlockGraph } from "./graph.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sivru-graph-test-"));
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(name: string, content: string): void {
  mkdirSync(join(tmpDir, "src"), { recursive: true });
  writeFileSync(join(tmpDir, "src", name), content);
}

const blockYaml = (sym: string, collabs: string[]): string =>
  `/**
 * @sivru
 * schema: 1
 * role: r
 * responsibility: r${sym}
 * collaborators:
${collabs.map((c) => ` *   - ${c}`).join("\n")}
 * @end
 */
export class ${sym} {}
`;

describe("computeBlockGraph", () => {
  it("emits SIVRU-E234 for asymmetric edges", async () => {
    writeFixture("A.ts", blockYaml("A", ["B"]));
    writeFixture("B.ts", blockYaml("B", ["C"]));
    writeFixture("C.ts", blockYaml("C", []));
    const graph = await computeBlockGraph(tmpDir);
    const codes = graph.diagnostics.map((d) => d.code);
    expect(codes).toContain("SIVRU-E234");
  });

  it("suppresses E234 for `allowedAsymmetric` entries", async () => {
    writeFixture("A.ts", blockYaml("A", ["B"]));
    writeFixture("B.ts", blockYaml("B", []));
    mkdirSync(join(tmpDir, ".sivru"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".sivru", "block.json"),
      JSON.stringify({ graph: { allowedAsymmetric: ["A->B"] } }),
    );
    const graph = await computeBlockGraph(tmpDir);
    expect(graph.diagnostics.filter((d) => d.code === "SIVRU-E234")).toHaveLength(0);
  });

  it("treats reciprocal edges as symmetric", async () => {
    writeFixture("A.ts", blockYaml("A", ["B"]));
    writeFixture("B.ts", blockYaml("B", ["A"]));
    const graph = await computeBlockGraph(tmpDir);
    expect(graph.diagnostics.filter((d) => d.code === "SIVRU-E234")).toHaveLength(0);
  });
});
