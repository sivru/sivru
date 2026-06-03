// DESIGN-0021 slot 2 — `pnpm bench feedback`.
//
// Per-diagnostic PRECISION against a user-labeled set: of the findings sivru
// emitted for each code, how many did the user later label intentional /
// false-positive (i.e. NOT real)? precision = real / total.
//
// This is REPO-LOCAL tuning data, not a generalizable benchmark — it measures
// sivru's false-positive rate on ONE repo's labels. The cross-repo story is the
// separately-installable sivru-analytics package (design Alternatives).
//
// Runs against a generated fixture with a seeded .sivru/feedback.jsonl so the
// number is reproducible; point it at a real repo by passing a path argument.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeBlockGraph } from "@sivru/search";

type FeedbackLine = { kind?: string; diagnostic?: { code?: string } };

const NOT_REAL_KINDS = new Set(["acknowledge", "false-positive"]);

function blockYaml(sym: string, collabs: string[]): string {
  return `/**
 * @sivru
 * schema: 1
 * role: r
 * responsibility: r-${sym}
 * collaborators: [${collabs.join(", ")}]
 * maturity: stable
 * @end
 */
export function ${sym}() {}
`;
}

/** A fixture: A<->B reciprocal; C,D,E -> B asymmetric (3× E234). Seed feedback
 *  labeling C and D as false-positive (so E234 precision should be 1/3). */
function generateFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "sivru-fb-bench-"));
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "A.ts"), blockYaml("A", ["B"]));
  writeFileSync(join(src, "B.ts"), blockYaml("B", ["A"]));
  for (const s of ["C", "D", "E"]) writeFileSync(join(src, `${s}.ts`), blockYaml(s, ["B"]));
  mkdirSync(join(root, ".sivru"), { recursive: true });
  const seed = [
    { schema: 1, timestamp: "2026-05-29T00:00:00Z", kind: "false-positive", diagnostic: { code: "SIVRU-E234", filePath: "src/C.ts", symbolName: "C", contentHash: "" }, label: "false-positive", actor: "ui" },
    { schema: 1, timestamp: "2026-05-29T00:00:01Z", kind: "false-positive", diagnostic: { code: "SIVRU-E234", filePath: "src/D.ts", symbolName: "D", contentHash: "" }, label: "false-positive", actor: "ui" },
  ];
  writeFileSync(join(root, ".sivru", "feedback.jsonl"), seed.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return root;
}

function readLabeledNotReal(root: string): Map<string, number> {
  const counts = new Map<string, number>();
  const path = join(root, ".sivru", "feedback.jsonl");
  if (!existsSync(path)) return counts;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    let parsed: FeedbackLine;
    try {
      parsed = JSON.parse(t) as FeedbackLine;
    } catch {
      continue;
    }
    if (parsed.kind !== undefined && NOT_REAL_KINDS.has(parsed.kind) && parsed.diagnostic?.code !== undefined) {
      const code = parsed.diagnostic.code;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return counts;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const ephemeral = arg === undefined;
  const root = ephemeral ? generateFixture() : arg;
  try {
    const graph = await computeBlockGraph(root);
    const total = new Map<string, number>();
    for (const d of graph.diagnostics) total.set(d.code, (total.get(d.code) ?? 0) + 1);
    const notReal = readLabeledNotReal(root);

    process.stdout.write(`feedback precision — ${ephemeral ? "seeded fixture" : root}\n`);
    process.stdout.write("REPO-LOCAL tuning data (this repo's labels), not a generalizable benchmark.\n\n");
    process.stdout.write(`  ${"code".padEnd(14)} ${"total".padStart(6)} ${"labeled".padStart(8)} ${"precision".padStart(10)}\n`);
    const codes = [...total.keys()].sort();
    if (codes.length === 0) process.stdout.write("  (no diagnostics)\n");
    for (const code of codes) {
      const t = total.get(code) ?? 0;
      const nr = notReal.get(code) ?? 0;
      const precision = t > 0 ? (t - nr) / t : 1;
      process.stdout.write(`  ${code.padEnd(14)} ${String(t).padStart(6)} ${String(nr).padStart(8)} ${precision.toFixed(2).padStart(10)}\n`);
    }
  } finally {
    if (ephemeral) rmSync(root, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1]?.endsWith("feedback-bench.ts") === true;
if (invokedDirectly) {
  void main();
}

export { readLabeledNotReal, generateFixture };
