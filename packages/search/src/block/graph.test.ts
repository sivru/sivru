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

describe("computeBlockGraph — SIVRU-E235 rename-suspect (DESIGN-0019 §3)", () => {
  it("fires when edge.to is unresolved and exactly ONE other node back-references edge.from", async () => {
    // A → "OldName" (doesn't resolve). C → A. Only C lists A, so the
    // rename suggestion picks C as the candidate.
    writeFixture("A.ts", blockYaml("A", ["OldName"]));
    writeFixture("C.ts", blockYaml("C", ["A"]));
    const graph = await computeBlockGraph(tmpDir);
    const e235 = graph.diagnostics.find((d) => d.code === "SIVRU-E235");
    expect(e235).toBeDefined();
    expect(e235?.message).toContain("C");
    expect(e235?.message).toContain("OldName");
  });

  it("does NOT fire when MULTIPLE other nodes back-reference edge.from (ambiguous)", async () => {
    // A → "OldName". Both B and C list A — can't pick a unique winner.
    writeFixture("A.ts", blockYaml("A", ["OldName"]));
    writeFixture("B.ts", blockYaml("B", ["A"]));
    writeFixture("C.ts", blockYaml("C", ["A"]));
    const graph = await computeBlockGraph(tmpDir);
    expect(graph.diagnostics.filter((d) => d.code === "SIVRU-E235")).toHaveLength(0);
  });

  it("falls through to SIVRU-E234 when no rename evidence exists", async () => {
    // A → "OldName" but no other node back-references A.
    writeFixture("A.ts", blockYaml("A", ["OldName"]));
    const graph = await computeBlockGraph(tmpDir);
    expect(graph.diagnostics.find((d) => d.code === "SIVRU-E234")).toBeDefined();
    expect(graph.diagnostics.find((d) => d.code === "SIVRU-E235")).toBeUndefined();
  });
});

describe("computeBlockGraph — SIVRU-E236 ordering-contradiction (DESIGN-0019 §3)", () => {
  const orderingBlock = (sym: string, claim: string): string =>
    `/**
 * @sivru
 * schema: 1
 * role: r
 * responsibility: r${sym}
 * decisions:
 *   - chose: "${claim}"
 *     because: "because"
 *     valid-while: "always"
 *     revisit-if: "always"
 * @end
 */
export class ${sym} {}
`;

  it("opt-in via graph.orderingChecks: detects 'runs after' contradiction", async () => {
    writeFixture("A.ts", orderingBlock("A", "runs after B for correctness"));
    writeFixture("B.ts", orderingBlock("B", "runs after A for correctness"));
    mkdirSync(join(tmpDir, ".sivru"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".sivru", "block.json"),
      JSON.stringify({ graph: { orderingChecks: true } }),
    );
    const graph = await computeBlockGraph(tmpDir);
    expect(graph.diagnostics.find((d) => d.code === "SIVRU-E236")).toBeDefined();
  });

  it("OFF by default (no orderingChecks config)", async () => {
    writeFixture("A.ts", orderingBlock("A", "runs after B"));
    writeFixture("B.ts", orderingBlock("B", "runs after A"));
    const graph = await computeBlockGraph(tmpDir);
    expect(graph.diagnostics.filter((d) => d.code === "SIVRU-E236")).toHaveLength(0);
  });

  it("does NOT fire when only ONE direction declares ordering", async () => {
    writeFixture("A.ts", orderingBlock("A", "runs after B"));
    writeFixture("B.ts", blockYaml("B", []));
    mkdirSync(join(tmpDir, ".sivru"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".sivru", "block.json"),
      JSON.stringify({ graph: { orderingChecks: true } }),
    );
    const graph = await computeBlockGraph(tmpDir);
    expect(graph.diagnostics.filter((d) => d.code === "SIVRU-E236")).toHaveLength(0);
  });
});
