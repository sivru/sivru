// QA harness for the sivru chunker. Walks real repositories, runs the
// chunker over every text file, and asserts the engine's hard
// invariants. See qa/README.md.
//
//   node qa/chunker-qa.mjs <repo-dir> [<repo-dir> ...]
//
// Exits non-zero if any HARD invariant fails. Parse failures (a covered
// file that tree-sitter could not parse, so the engine line-fell-back)
// are reported prominently but are not a hard gate — the file is still
// fully indexed.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const distEntry = fileURLToPath(
  new URL("../packages/search/dist/index.js", import.meta.url),
);
let walk, chunkFile, treeSitterChunks, detectLanguage, isChunkableLanguage;
try {
  ({ walk, chunkFile, treeSitterChunks, detectLanguage, isChunkableLanguage } =
    await import(distEntry));
} catch (err) {
  console.error(
    `Could not load the built engine at ${distEntry}\n` +
      `Run \`pnpm --filter @sivru/search build\` first.\n${err.message}`,
  );
  process.exit(2);
}

/** Split content into lines the way the chunker does (drop trailing ""). */
function toLines(content) {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** True when the file has indexable content — mirrors the chunker's guard. */
function hasIndexableContent(lines) {
  return lines.length > 0 && !lines.every((l) => l === "");
}

async function qaRepo(root) {
  const s = {
    root,
    files: 0,
    chunkableFiles: 0,
    noAstFiles: 0,
    chunks: 0,
    tsChunks: 0,
    lineChunks: 0,
    namedChunks: 0,
    parseFailures: [],
    failures: [],
  };
  const fail = (file, msg) => s.failures.push(`${file}: ${msg}`);

  for await (const entry of walk(root)) {
    let content;
    try {
      content = readFileSync(entry.absPath, "utf8");
    } catch {
      continue;
    }
    s.files++;

    const lang = detectLanguage(entry.filePath);
    const chunkable = isChunkableLanguage(lang);
    if (chunkable) s.chunkableFiles++;

    // Detect a genuine parse failure: tree-sitter throwing on a covered
    // file. `chunkFile` swallows it (line-fallback), so probe directly.
    if (chunkable && content.length > 0) {
      try {
        await treeSitterChunks(entry.filePath, content, lang);
      } catch (err) {
        s.parseFailures.push(`${entry.filePath}: ${err.message}`);
      }
    }

    // Invariant 1 — chunkFile, the real engine entry point, never throws.
    let chunks;
    try {
      chunks = await chunkFile(entry.filePath, content);
    } catch (err) {
      fail(entry.filePath, `chunkFile threw: ${err.message}`);
      continue;
    }

    const lines = toLines(content);
    const total = lines.length;

    // Invariant 2 — full line coverage (only for files with real content;
    // a whitespace-only file is intentionally indexed as zero chunks).
    if (hasIndexableContent(lines)) {
      const covered = new Set();
      for (const c of chunks) {
        for (let l = c.startLine; l <= c.endLine; l++) covered.add(l);
      }
      for (let l = 1; l <= total; l++) {
        if (!covered.has(l)) {
          fail(entry.filePath, `line ${l}/${total} not covered by any chunk`);
          break;
        }
      }
    }

    for (const c of chunks) {
      // Invariant 4 — valid ranges.
      if (c.startLine < 1 || c.endLine < c.startLine || c.endLine > total) {
        fail(entry.filePath, `invalid range ${c.startLine}-${c.endLine} (file has ${total} lines)`);
        continue;
      }
      // Invariant 3 — content fidelity.
      const expected = lines.slice(c.startLine - 1, c.endLine).join("\n");
      if (c.content !== expected) {
        fail(entry.filePath, `content mismatch at lines ${c.startLine}-${c.endLine}`);
      }
      // Invariant 5 — kind/nodeType consistency.
      if (c.kind === "tree-sitter" && c.nodeType === undefined) {
        fail(entry.filePath, `tree-sitter chunk at ${c.startLine} has no nodeType`);
      }
      if (c.kind === "line" && c.nodeType !== undefined) {
        fail(entry.filePath, `line chunk at ${c.startLine} has a nodeType`);
      }
      if (c.kind === "tree-sitter") s.tsChunks++;
      else s.lineChunks++;
      if (c.symbolName !== undefined) s.namedChunks++;
    }

    s.chunks += chunks.length;
    // A covered file that produced no AST chunk is normal (re-exports,
    // type-only files, scripts) — informational, not a problem.
    if (chunkable && content.length > 0 && !chunks.some((c) => c.kind === "tree-sitter")) {
      s.noAstFiles++;
    }
  }
  return s;
}

function pct(n, d) {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`;
}

function report(s) {
  console.log(`\n${s.root}`);
  console.log(`  files walked        ${s.files}  (chunkable: ${s.chunkableFiles})`);
  console.log(`  chunks              ${s.chunks}  (tree-sitter: ${s.tsChunks}, line: ${s.lineChunks})`);
  console.log(`  symbol coverage     ${pct(s.namedChunks, s.tsChunks)}  of AST chunks named`);
  console.log(`  no-AST files        ${s.noAstFiles}  (covered files with no function/class — normal)`);
  if (s.parseFailures.length === 0) {
    console.log(`  parse failures      0`);
  } else {
    console.log(`  parse failures      ${s.parseFailures.length}  (covered files tree-sitter could not parse):`);
    for (const f of s.parseFailures.slice(0, 15)) console.log(`    ! ${f}`);
    if (s.parseFailures.length > 15) console.log(`    … and ${s.parseFailures.length - 15} more`);
  }
  if (s.failures.length === 0) {
    console.log(`  invariants          PASS`);
  } else {
    console.log(`  invariants          FAIL — ${s.failures.length} violation(s):`);
    for (const f of s.failures.slice(0, 25)) console.log(`    - ${f}`);
    if (s.failures.length > 25) console.log(`    … and ${s.failures.length - 25} more`);
  }
}

async function main() {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    console.error("usage: node qa/chunker-qa.mjs <repo-dir> [<repo-dir> ...]");
    process.exit(2);
  }
  let totalFailures = 0;
  let totalParseFailures = 0;
  for (const root of roots) {
    const s = await qaRepo(resolve(root));
    report(s);
    totalFailures += s.failures.length;
    totalParseFailures += s.parseFailures.length;
  }
  const verdict =
    totalFailures === 0
      ? `QA PASS${totalParseFailures > 0 ? ` (${totalParseFailures} parse failure(s) to review)` : ""}`
      : `QA FAIL — ${totalFailures} invariant violation(s)`;
  console.log(`\n${verdict}`);
  process.exit(totalFailures === 0 ? 0 : 1);
}

await main();
