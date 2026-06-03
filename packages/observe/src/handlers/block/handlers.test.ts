import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  acknowledgeDiagnostic,
  appendFeedbackRecord,
  applyAutofix,
  editBlock,
  readFeedbackRecords,
  type HandlerContext,
} from "./index.js";

const BLOCK_SRC = `/**
 * @sivru
 * schema: 1
 * role: original-role
 * responsibility: the original responsibility
 * maturity: experimental
 * @end
 */
export function thing() {
  return 1;
}
`;

const WRITABLE: Omit<HandlerContext, "rootPath"> = { actor: "ui", writable: true };
const READONLY: Omit<HandlerContext, "rootPath"> = { actor: "ui", writable: false };

describe("block write handlers", () => {
  let root: string;
  beforeEach(async () => {
    // Under homedir so any future containment check passes; handlers use
    // resolveFileWithinRoot (traversal guard) which doesn't need git.
    root = await mkdtemp(join(homedir(), ".sivru-handlers-"));
    await writeFile(join(root, "thing.ts"), BLOCK_SRC);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const ctx = (over: Partial<HandlerContext> = {}): HandlerContext => ({ rootPath: root, ...WRITABLE, ...over });

  // ---- gate ----
  it("every write handler refuses when not writable", async () => {
    const ro = ctx({ ...READONLY });
    const a = await applyAutofix(ro, "thing.ts");
    const e = await editBlock(ro, "thing.ts", "thing", { schema: 1, role: "r", responsibility: "x" });
    const k = await acknowledgeDiagnostic(ro, { code: "SIVRU-E234", filePath: "thing.ts", symbolName: "thing" });
    for (const r of [a, e, k]) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("SIVRU-WRITABLE-DISABLED");
        expect(r.retryable).toBe(false);
      }
    }
  });

  // ---- path safety ----
  it("rejects traversal with PATH-OUTSIDE-ROOT", async () => {
    const r = await applyAutofix(ctx(), "../../etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SIVRU-PATH-OUTSIDE-ROOT");
  });

  it("autofix on a missing file returns FILE-NOT-FOUND", async () => {
    const r = await applyAutofix(ctx(), "nope.ts");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SIVRU-FILE-NOT-FOUND");
  });

  it("rejects a symlink inside root that points OUTSIDE root (no write-through)", async () => {
    // Secret file outside the repo + an in-repo symlink pointing at it.
    const outside = await mkdtemp(join(homedir(), ".sivru-outside-"));
    const secret = join(outside, "secret.ts");
    await writeFile(secret, "export const SECRET = 1;\n");
    try {
      await symlink(secret, join(root, "link.ts"));
      // autofix must NOT follow the symlink out of root.
      const a = await applyAutofix(ctx(), "link.ts");
      expect(a.ok).toBe(false);
      if (!a.ok) expect(a.code).toBe("SIVRU-PATH-OUTSIDE-ROOT");
      // edit must reject it too (and not disclose the target via the 409 body).
      const e = await editBlock(ctx(), "link.ts", "x", { schema: 1, role: "r", responsibility: "x" });
      expect(e.ok).toBe(false);
      if (!e.ok) expect(e.code).toBe("SIVRU-PATH-OUTSIDE-ROOT");
      // The secret file is untouched.
      expect(await readFile(secret, "utf8")).toBe("export const SECRET = 1;\n");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  // ---- applyAutofix happy ----
  it("autofix on a clean file succeeds with zero rewrites", async () => {
    const r = await applyAutofix(ctx(), "thing.ts", "SIVRU-E237");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.rewrites).toBe(0);
  });

  // ---- editBlock happy ----
  it("editBlock rewrites the fence in place and returns a new mtime", async () => {
    const r = await editBlock(ctx(), "thing.ts", "thing", {
      schema: 1,
      role: "new-role",
      responsibility: "now updated",
      maturity: "stable",
    });
    expect(r.ok).toBe(true);
    const after = await readFile(join(root, "thing.ts"), "utf8");
    expect(after).toContain(" * role: new-role");
    expect(after).toContain(" * maturity: stable");
    expect(after).toContain("export function thing()"); // code outside fence preserved
    expect(after).not.toContain("original-role");
    if (r.ok) expect(r.data.mtimeMs).toBeGreaterThan(0);
  });

  // ---- editBlock 409 on stale baseline ----
  it("editBlock returns FILE-CHANGED (409) when expectedMtime is stale", async () => {
    const r = await editBlock(
      ctx(),
      "thing.ts",
      "thing",
      { schema: 1, role: "r", responsibility: "x" },
      1, // clearly-stale mtime
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("SIVRU-FILE-CHANGED");
      expect(r.retryable).toBe(true);
      expect((r.data as { content: string }).content).toContain("@sivru");
    }
  });

  // ---- editBlock validation ----
  it("editBlock rejects an invalid block with VALIDATION-FAILED", async () => {
    const r = await editBlock(ctx(), "thing.ts", "thing", {
      schema: 2, // unsupported → SIVRU-E214 error
      role: "r",
      responsibility: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SIVRU-VALIDATION-FAILED");
  });

  // ---- editBlock symbol gone ----
  it("editBlock returns FILE-CHANGED when the symbol no longer resolves", async () => {
    const r = await editBlock(ctx(), "thing.ts", "ghost", { schema: 1, role: "r", responsibility: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SIVRU-FILE-CHANGED");
  });

  // ---- acknowledge + feedback ----
  it("acknowledge writes to both feedback and acknowledgments with a content hash", async () => {
    const r = await acknowledgeDiagnostic(
      ctx(),
      { code: "SIVRU-E234", filePath: "thing.ts", symbolName: "thing" },
      "leaf utility, intentional",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.contentHash.length).toBeGreaterThan(0);
    const fb = await readFile(join(root, ".sivru", "feedback.jsonl"), "utf8");
    const ack = await readFile(join(root, ".sivru", "acknowledgments.jsonl"), "utf8");
    expect(fb).toContain("acknowledge");
    expect(ack).toContain("acknowledge");
  });

  it("mark false-positive writes feedback only (not acknowledgments)", async () => {
    await appendFeedbackRecord(
      ctx(),
      "false-positive",
      { code: "SIVRU-E235", filePath: "thing.ts", symbolName: "thing" },
      "false-positive",
    );
    const fb = await readFile(join(root, ".sivru", "feedback.jsonl"), "utf8");
    expect(fb).toContain("false-positive");
    await expect(readFile(join(root, ".sivru", "acknowledgments.jsonl"), "utf8")).rejects.toThrow();
  });

  it("readFeedbackRecords works even when read-only (ungated)", async () => {
    await appendFeedbackRecord(ctx(), "suggest", { code: "SIVRU-E234", filePath: "thing.ts", symbolName: "thing" }, "suggested-rewrite", "try X");
    const r = await readFeedbackRecords(ctx({ ...READONLY }), { kind: "suggest" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.records).toHaveLength(1);
      expect(r.data.records[0]?.note).toBe("try X");
    }
  });

  it("writes an audit trail entry per write", async () => {
    await editBlock(ctx(), "thing.ts", "thing", { schema: 1, role: "r2", responsibility: "x2" });
    const auditFiles = await readFile(
      join(root, ".sivru", "audit", `${new Date().toISOString().slice(0, 10)}.jsonl`),
      "utf8",
    ).catch(() => "");
    expect(auditFiles).toContain('"action":"edit"');
  });
});
