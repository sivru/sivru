import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditDay, sweepAuditRetention, writeAudit } from "./index.js";

describe("audit trail", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sivru-audit-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes a per-day file named YYYY-MM-DD.jsonl", async () => {
    await writeAudit(root, {
      schema: 1,
      timestamp: "2026-05-29T14:00:00Z",
      action: "edit",
      actor: "ui",
      filePath: "src/a.ts",
    });
    const files = await readdir(join(root, ".sivru", "audit"));
    expect(files).toContain("2026-05-29.jsonl");
    expect(auditDay("2026-05-29T14:00:00Z")).toBe("2026-05-29");
  });

  it("sweep deletes files older than retentionDays, keeps recent", async () => {
    const dir = join(root, ".sivru", "audit");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-05-01.jsonl"), "{}\n"); // old
    await writeFile(join(dir, "2026-05-29.jsonl"), "{}\n"); // recent
    await writeFile(join(dir, "notes.txt"), "ignore me"); // non-audit file
    const now = Date.parse("2026-05-29T00:00:00Z");
    const removed = await sweepAuditRetention(root, 7, now);
    expect(removed).toBe(1);
    const left = await readdir(dir);
    expect(left).toContain("2026-05-29.jsonl");
    expect(left).not.toContain("2026-05-01.jsonl");
    expect(left).toContain("notes.txt"); // untouched
  });

  it("sweep on a missing dir is a no-op", async () => {
    expect(await sweepAuditRetention(root, 7, Date.now())).toBe(0);
  });
});
