// Fixture-based tests for the agent-task simulation primitives.
//
// The previous test file covered keyword extraction + task picking but
// not the actual cost-computation functions — `simulateGrep`,
// `simulateBaseline`, `simulateSivru`. Those functions produce the
// numbers we publish ("57.7% saved"), so missing tests = the most
// important code path is uncovered.
//
// We build a tiny corpus on disk for each test and exercise the
// simulators against it. mkdtemp + filesystem rather than mocking
// because the simulators legitimately walk + read files; mocking
// would test the mock, not the real code.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  _internals,
  bootstrapPercentiles,
} from "./agent-tasks.js";
import type { RepoSpec, RetrievalResult } from "./types.js";
import type { RetrievalAdapter } from "./runner.js";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "sivru-bench-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function fixtureFile(rel: string, content: string): Promise<void> {
  const path = resolve(scratch, rel);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

// ----- walkText ----------------------------------------------------------

describe("walkText (deterministic ordering)", () => {
  it("returns text files in lexicographic order across recursive calls", async () => {
    // Filenames written in REVERSE order — if walkText didn't sort, the
    // result order would be readdir's default (often insertion / inode
    // order on some filesystems, not lex). We assert lex.
    await fixtureFile("z.ts", "");
    await fixtureFile("a.ts", "");
    await fixtureFile("m/zzz.ts", "");
    await fixtureFile("m/aaa.ts", "");
    await fixtureFile("b/y.ts", "");

    const files = await _internals.walkText(scratch);
    // Lexicographic sort means: a.ts, b/y.ts, m/aaa.ts, m/zzz.ts, z.ts
    expect(files).toEqual([
      "a.ts",
      "b/y.ts",
      "m/aaa.ts",
      "m/zzz.ts",
      "z.ts",
    ]);
  });

  it("skips node_modules and .git", async () => {
    await fixtureFile("src/x.ts", "");
    await fixtureFile("node_modules/dep/y.ts", "");
    await fixtureFile(".git/HEAD", "");
    const files = await _internals.walkText(scratch);
    expect(files).toEqual(["src/x.ts"]);
  });

  it("filters by recognized text extensions", async () => {
    await fixtureFile("a.ts", "");
    await fixtureFile("b.bin", ""); // not a text ext
    await fixtureFile("c.png", "");
    await fixtureFile("d.py", "");
    const files = await _internals.walkText(scratch);
    expect(files).toEqual(["a.ts", "d.py"]);
  });

  it("skips dotfiles like `.bashrc` (no recognized extension)", async () => {
    await fixtureFile(".bashrc", "");
    await fixtureFile("a.ts", "");
    const files = await _internals.walkText(scratch);
    expect(files).toEqual(["a.ts"]);
  });
});

// ----- simulateGrep ------------------------------------------------------

describe("simulateGrep", () => {
  it("returns hits with path / line / content and the truncated flag", async () => {
    await fixtureFile("a.ts", "function authMiddleware() {}\nconst x = 1;\n");
    await fixtureFile("b.ts", "// just a comment\nconst authToken = '';\n");
    const { hits, truncated } = await _internals.simulateGrep(scratch, [
      "auth",
    ]);
    expect(truncated).toBe(false);
    expect(hits).toEqual([
      { path: "a.ts", line: 1, content: "function authMiddleware() {}" },
      { path: "b.ts", line: 2, content: "const authToken = '';" },
    ]);
  });

  it("alternates keywords via |-disjunction", async () => {
    await fixtureFile("a.ts", "import zod from 'zod'\n");
    await fixtureFile("b.ts", "import { request } from 'axios'\n");
    await fixtureFile("c.ts", "// nothing relevant\n");
    const { hits } = await _internals.simulateGrep(scratch, ["zod", "request"]);
    expect(hits.map((h) => h.path).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("escapes regex specials in keywords (no injection)", async () => {
    await fixtureFile("a.ts", "const x = `${a}`;\n");
    // `.` and `${}` are regex specials; must match literally
    const { hits } = await _internals.simulateGrep(scratch, ["${a}"]);
    expect(hits.length).toBe(1);
  });

  it("respects the maxHits cap", async () => {
    let body = "";
    for (let i = 0; i < 50; i++) body += `match line ${i}\n`;
    await fixtureFile("a.ts", body);
    const { hits, truncated } = await _internals.simulateGrep(
      scratch,
      ["match"],
      10,
    );
    expect(hits.length).toBe(10);
    expect(truncated).toBe(true);
  });

  it("returns empty on no keywords", async () => {
    await fixtureFile("a.ts", "anything\n");
    const { hits } = await _internals.simulateGrep(scratch, []);
    expect(hits).toEqual([]);
  });
});

// ----- simulateBaseline --------------------------------------------------

describe("simulateBaseline", () => {
  it("counts grep output bytes + top-N file bytes; turn count = 1 + filesRead", async () => {
    // Hits in a.ts and b.ts; top-3 cap should still let both through.
    await fixtureFile("a.ts", "const auth = 1;\nconst x = 2;\n"); // 30 chars
    await fixtureFile("b.ts", "const auth = 'token';\n");
    const baseline = await _internals.simulateBaseline(scratch, ".", ["auth"]);
    // 2 unique files matched → 1 grep + 2 reads = 3 turns
    expect(baseline.turns).toBe(3);
    expect(baseline.filesRead).toEqual(["a.ts", "b.ts"]);
    expect(baseline.tokens).toBeGreaterThan(0);
    expect(baseline.grepHits).toBe(2);
    expect(baseline.grepTruncated).toBe(false);
  });

  it("caps filesRead at 3 even when more hit", async () => {
    for (const name of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) {
      await fixtureFile(name, "const auth = 1;\n");
    }
    const baseline = await _internals.simulateBaseline(scratch, ".", ["auth"]);
    expect(baseline.filesRead.length).toBe(3);
    expect(baseline.filesRead).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(baseline.turns).toBe(4); // 1 grep + 3 reads
  });

  it("dedupes — multiple hits in one file count it once", async () => {
    await fixtureFile("a.ts", "auth\nauth\nauth\n");
    const baseline = await _internals.simulateBaseline(scratch, ".", ["auth"]);
    expect(baseline.filesRead).toEqual(["a.ts"]);
    expect(baseline.turns).toBe(2);
  });

  it("prefixes filesRead with pathPrefix when non-empty", async () => {
    await fixtureFile("src/auth.ts", "auth\n");
    const subRoot = resolve(scratch);
    const baseline = await _internals.simulateBaseline(
      subRoot,
      "myrepo/path",
      ["auth"],
    );
    expect(baseline.filesRead).toEqual(["myrepo/path/src/auth.ts"]);
  });

  it("token count proportional to bytes read", async () => {
    // 4000 chars total ≈ 1000 tokens
    const long = "x".repeat(4000) + "\nauth\n";
    await fixtureFile("a.ts", long);
    const baseline = await _internals.simulateBaseline(scratch, ".", ["auth"]);
    // grep output is small; the file read dominates
    expect(baseline.tokens).toBeGreaterThan(900);
    expect(baseline.tokens).toBeLessThan(1100);
  });

  it("returns 0 tokens / 1 turn / no files when no keywords match", async () => {
    await fixtureFile("a.ts", "no match here\n");
    const baseline = await _internals.simulateBaseline(scratch, ".", [
      "nonexistent",
    ]);
    expect(baseline.tokens).toBe(0);
    expect(baseline.filesRead).toEqual([]);
    expect(baseline.turns).toBe(1); // just the grep
  });
});

// ----- simulateSivru -----------------------------------------------------

function stubAdapter(results: RetrievalResult[]): RetrievalAdapter {
  return async () => results;
}

const FAKE_REPO: RepoSpec = {
  name: "fake",
  language: "typescript",
  url: "n/a",
  revision: "HEAD",
  benchmark_root: "src",
};

describe("simulateSivru", () => {
  it("counts chunk content bytes (line-range slice of the source file)", async () => {
    // Build the corpus dir = scratch/fake/src/foo.ts
    await fixtureFile(
      "fake/src/foo.ts",
      "line1\nline2\nline3\nline4\nline5\n",
    );
    const adapter = stubAdapter([
      { filePath: "src/foo.ts", startLine: 2, endLine: 4, score: 0.9 },
    ]);
    const result = await _internals.simulateSivru(
      adapter,
      FAKE_REPO,
      "any query",
      ["src/foo.ts"],
      scratch,
    );
    // Lines 2..4 = "line2\nline3\nline4" = 17 chars → 4 tokens
    expect(result.tokens).toBe(Math.round(17 / 4));
    expect(result.turns).toBe(1);
    expect(result.recallAt3).toBe(true);
    expect(result.topFiles).toEqual(["src/foo.ts"]);
  });

  it("reports recallAt3=false when none of the top-3 results match expected", async () => {
    await fixtureFile("fake/src/a.ts", "x\n");
    await fixtureFile("fake/src/b.ts", "y\n");
    const adapter = stubAdapter([
      { filePath: "src/a.ts", startLine: 1, endLine: 1, score: 0.9 },
    ]);
    const result = await _internals.simulateSivru(
      adapter,
      FAKE_REPO,
      "q",
      ["src/c.ts"], // expected file NOT in returned hits
      scratch,
    );
    expect(result.recallAt3).toBe(false);
  });

  it("uses only the first RECALL_AT (3) hits for recall judgment", async () => {
    for (let i = 0; i < 5; i++) {
      await fixtureFile(`fake/src/h${i}.ts`, "x\n");
    }
    // The expected file is at rank 4 (index 3) — beyond RECALL_AT.
    const adapter = stubAdapter([
      { filePath: "src/h0.ts", startLine: 1, endLine: 1, score: 0.9 },
      { filePath: "src/h1.ts", startLine: 1, endLine: 1, score: 0.8 },
      { filePath: "src/h2.ts", startLine: 1, endLine: 1, score: 0.7 },
      { filePath: "src/h3.ts", startLine: 1, endLine: 1, score: 0.6 },
    ]);
    const result = await _internals.simulateSivru(
      adapter,
      FAKE_REPO,
      "q",
      ["src/h3.ts"],
      scratch,
    );
    expect(result.recallAt3).toBe(false);
  });

  // CRITICAL: previously the function silently returned a fabricated
  // 1500-char estimate when chunks lacked line ranges, biasing sivru's
  // numbers favorably. Now it throws so a broken adapter is loud.
  it("THROWS when an adapter result is missing startLine/endLine", async () => {
    await fixtureFile("fake/src/a.ts", "x\n");
    const adapter = stubAdapter([
      // Deliberately omit startLine/endLine
      { filePath: "src/a.ts", score: 0.9 } as RetrievalResult,
    ]);
    await expect(
      _internals.simulateSivru(adapter, FAKE_REPO, "q", [], scratch),
    ).rejects.toThrow(/missing startLine\/endLine/);
  });

  it("THROWS when the chunk's source file isn't readable", async () => {
    // Don't write the file — adapter claims it exists.
    const adapter = stubAdapter([
      { filePath: "src/missing.ts", startLine: 1, endLine: 5, score: 0.9 },
    ]);
    await expect(
      _internals.simulateSivru(adapter, FAKE_REPO, "q", [], scratch),
    ).rejects.toThrow(/could not read/);
  });
});

// ----- bootstrapPercentiles ---------------------------------------------

describe("bootstrapPercentiles", () => {
  it("returns 0,0,0 for empty input", () => {
    const r = bootstrapPercentiles([], _internals.mean);
    expect(r).toEqual({ p05: 0, p50: 0, p95: 0 });
  });

  it("recovers a sample's mean within tight bounds for a constant input", () => {
    // All values 50 → mean is always 50, percentiles all 50.
    const r = bootstrapPercentiles([50, 50, 50, 50, 50], _internals.mean);
    expect(r.p05).toBe(50);
    expect(r.p50).toBe(50);
    expect(r.p95).toBe(50);
  });

  it("widens the CI for noisy inputs", () => {
    // Range [0, 100] — mean is 50 but bootstrap CI should span notably.
    const xs = [0, 25, 50, 75, 100];
    const r = bootstrapPercentiles(xs, _internals.mean);
    // p05 should be well below the median, p95 well above.
    expect(r.p05).toBeLessThan(45);
    expect(r.p95).toBeGreaterThan(55);
    expect(r.p05).toBeLessThan(r.p50);
    expect(r.p50).toBeLessThan(r.p95);
  });

  it("is deterministic across calls (same seed)", () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80];
    const a = bootstrapPercentiles(xs, _internals.mean);
    const b = bootstrapPercentiles(xs, _internals.mean);
    expect(a).toEqual(b);
  });

  it("a different seed produces a different (but still bracketing) interval", () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80];
    const a = bootstrapPercentiles(xs, _internals.mean, 1000, 1);
    const b = bootstrapPercentiles(xs, _internals.mean, 1000, 2);
    // Both should bracket the true mean (45) but the exact endpoints differ.
    expect(a).not.toEqual(b);
    expect(a.p05).toBeLessThan(_internals.mean(xs));
    expect(a.p95).toBeGreaterThan(_internals.mean(xs));
  });
});
