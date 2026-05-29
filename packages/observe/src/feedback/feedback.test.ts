import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acknowledgmentsPath,
  appendAcknowledgment,
  appendFeedback,
  feedbackPath,
  migrateLegacyAcknowledgments,
  readAcknowledgments,
  readFeedback,
  type FeedbackRecord,
} from "./index.js";

function rec(over: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    schema: 1,
    timestamp: "2026-05-29T00:00:00Z",
    kind: "false-positive",
    diagnostic: { code: "SIVRU-E234", filePath: "src/a.ts", symbolName: "A", contentHash: "h1" },
    label: "false-positive",
    actor: "ui",
    ...over,
  };
}

describe("feedback JSONL store", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sivru-fb-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("appends and reads back records (append-only)", async () => {
    await appendFeedback(root, rec({ note: "first" }));
    await appendFeedback(root, rec({ kind: "suggest", note: "second" }));
    const all = await readFeedback(root);
    expect(all).toHaveLength(2);
    expect(all[0]?.note).toBe("first");
    expect(all[1]?.kind).toBe("suggest");
  });

  it("filters by kind and code", async () => {
    await appendFeedback(root, rec({ kind: "false-positive" }));
    await appendFeedback(root, rec({ kind: "suggest" }));
    expect(await readFeedback(root, { kind: "suggest" })).toHaveLength(1);
    expect(await readFeedback(root, { code: "SIVRU-E234" })).toHaveLength(2);
    expect(await readFeedback(root, { code: "SIVRU-E999" })).toHaveLength(0);
  });

  it("missing file reads as empty (no throw)", async () => {
    expect(await readFeedback(root)).toEqual([]);
  });

  it("skips malformed lines + unsupported schema, keeps good ones", async () => {
    await mkdir(join(root, ".sivru"), { recursive: true });
    const good = JSON.stringify(rec());
    const futureSchema = JSON.stringify({ ...rec(), schema: 2 });
    await writeFile(feedbackPath(root), `${good}\nnot json{{{\n${futureSchema}\n${good}\n`);
    const all = await readFeedback(root);
    expect(all).toHaveLength(2); // two good lines; malformed + schema:2 skipped
  });

  it("acknowledgments live in their own file", async () => {
    await appendAcknowledgment(root, rec({ kind: "acknowledge", label: "intentional" }));
    const acks = await readAcknowledgments(root);
    expect(acks).toHaveLength(1);
    expect(acks[0]?.kind).toBe("acknowledge");
    // feedback.jsonl stays empty — separate files.
    expect(await readFeedback(root)).toEqual([]);
    expect(acknowledgmentsPath(root).endsWith("acknowledgments.jsonl")).toBe(true);
  });

  it("migrates legacy block.json acknowledged[] into acknowledgments.jsonl", async () => {
    await mkdir(join(root, ".sivru"), { recursive: true });
    await writeFile(
      join(root, ".sivru", "block.json"),
      JSON.stringify({
        acknowledged: [
          { code: "SIVRU-E234", filePath: "src/a.ts", symbolName: "A" },
          { code: "SIVRU-E234", filePath: "src/b.ts", symbolName: "B" },
        ],
      }),
    );
    const n = await migrateLegacyAcknowledgments(root, "2026-05-29T00:00:00Z");
    expect(n).toBe(2);
    const acks = await readAcknowledgments(root);
    expect(acks).toHaveLength(2);
    expect(acks[0]?.kind).toBe("acknowledge");
    // No legacy field → no-op.
    expect(await migrateLegacyAcknowledgments(`${root}/nope`, "2026-05-29T00:00:00Z")).toBe(0);
  });

  it("concurrent appends do not lose or garble records", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => appendFeedback(root, rec({ note: `n${i}` }))),
    );
    const all = await readFeedback(root);
    expect(all).toHaveLength(20);
    // Every line parsed cleanly (no garbling) — readFeedback skips bad lines,
    // so a length of 20 proves no line was corrupted.
    const raw = await readFile(feedbackPath(root), "utf8");
    expect(raw.trimEnd().split("\n")).toHaveLength(20);
  });
});
