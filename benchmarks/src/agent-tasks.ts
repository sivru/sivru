// Agent-task benchmark — DESIGN.md §20.3 / Issue #9.
//
// Measures the *token economy* of using sivru on a real coding-agent task vs
// the grep+Read baseline that Claude Code falls back to when sivru isn't
// installed. Zero API spend: both sides are simulated deterministically over
// the same pinned corpus that the NDCG@10 benchmark uses.
//
// For each task:
//
//   sivru side:
//     1 search call returning top-K chunks. Tokens = total chunk bytes / 4.
//     Turn count = 1.
//
//   baseline side (no sivru):
//     1 ripgrep-style scan over the repo for the most identifier-shaped
//     keywords in the query, then 1 full-file read for each of the top N
//     unique matched files. Tokens = grep output bytes/4 + file bytes/4.
//     Turn count = 1 + N.
//
// Both sides also report whether the labeled "answer" file appears within
// the top-3 — a sanity check that we're saving cost, not just shrinking
// useful output.

import { readFileSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RepoSpec, Annotation } from "./types.js";
import type { RetrievalAdapter } from "./runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

/** ~4 chars/token is the conventional API-billing approximation. */
const CHARS_PER_TOKEN = 4;

/** How many files Claude would typically read after a grep before declaring "found it". */
const BASELINE_FILES_READ = 3;

/** How many sivru hits we count toward the Claude tool-result payload. */
const SIVRU_TOP_K = 5;

/**
 * Top-K cap for the recall@K probe. Keeping it at 3 keeps the bar honest:
 * a developer who has to scroll past 10 results to find the answer is not
 * having a great time even if NDCG@10 looks fine.
 */
const RECALL_AT = 3;

/** Common English stopwords + question framing — never useful as grep keywords. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from",
  "how", "i", "if", "in", "is", "it", "of", "on", "or", "the", "this", "that",
  "to", "we", "what", "where", "with", "you", "all", "any", "can", "get",
  "has", "have", "into", "like", "made", "make", "many", "such", "than",
  "their", "them", "then", "there", "these", "they", "those", "want", "when",
  "which", "who", "why", "but", "not", "would", "could", "should", "use",
  "used", "using", "across", "against", "back", "between", "during", "more",
  "most", "other", "out", "over", "own", "same", "so", "some", "still", "up",
  "very", "was", "were", "will", "just", "now", "via", "two", "one", "single",
  "multiple", "actually",
]);

/**
 * Pull identifier-ish keywords out of a natural-language query. We weight
 * words that look like code (camelCase, dotted, contains '_' or capitals)
 * over generic English. The baseline gets up to `max` keywords, separated
 * by `|` for the regex grep.
 */
export function extractKeywords(query: string, max = 3): string[] {
  const tokens = query.split(/[^A-Za-z0-9_.]+/).filter((t) => t.length > 0);
  const scored: Array<{ token: string; score: number }> = [];
  for (const t of tokens) {
    if (STOPWORDS.has(t.toLowerCase())) continue;
    if (t.length < 3) continue;
    let score = t.length;
    if (/[A-Z]/.test(t) && /[a-z]/.test(t)) score += 5; // CamelCase
    if (t.includes("_")) score += 4; // snake_case
    if (t.includes(".")) score += 4; // dotted.name
    if (/^[a-z]+$/.test(t) && t.length < 5) score -= 2; // short generic
    scored.push({ token: t, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of scored) {
    const key = s.token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.token);
    if (out.length >= max) break;
  }
  return out;
}

/** File extensions the baseline grep + read step considers. Matches what
 *  Claude Code's Grep / Read tools touch in practice — text source files. */
const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi",
  ".java", ".kt", ".scala",
  ".go", ".rs",
  ".rb", ".php",
  ".c", ".h", ".cpp", ".hpp", ".cc",
  ".cs",
  ".swift",
  ".md", ".rst", ".txt",
  ".json", ".toml", ".yaml", ".yml",
]);

async function walkText(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = (await readdir(resolve(root, rel), { withFileTypes: true })) as Dirent[];
  } catch {
    return out;
  }
  // CRITICAL determinism: readdir returns entries in OS-dependent order
  // (ext4 ≠ APFS ≠ NTFS, sometimes even varies within a single FS). Without
  // sorting, the same bench corpus on different machines produces different
  // grep walk orders → different "top-3 files" picked → different baseline
  // tokens → different "saved %" numbers. Sort lexicographically so a
  // bench result is reproducible across machines.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      const nested = await walkText(root, childRel);
      out.push(...nested);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".");
      if (dot > 0 && TEXT_EXTS.has(entry.name.slice(dot).toLowerCase())) {
        out.push(childRel);
      }
    }
  }
  return out;
}

/** One line emitted by the simulated grep — `path:lineno:content`. */
type GrepHit = { path: string; line: number; content: string };

/**
 * Simulate `grep -nE '<kw1|kw2|...>'` over the repo. Returns hits in walk
 * order (deterministic), capped at `maxHits` to model how a real grep tool
 * truncates. The cap prevents pathological queries (e.g. a single common
 * word) from tilting the comparison.
 */
async function simulateGrep(
  repoRoot: string,
  keywords: readonly string[],
  maxHits = 100,
): Promise<{ hits: GrepHit[]; truncated: boolean }> {
  if (keywords.length === 0) return { hits: [], truncated: false };
  const pattern = new RegExp(
    keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  );
  const files = await walkText(repoRoot);
  const hits: GrepHit[] = [];
  let truncated = false;
  for (const f of files) {
    let content: string;
    try {
      content = await readFile(resolve(repoRoot, f), "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (pattern.test(line)) {
        hits.push({ path: f, line: i + 1, content: line });
        if (hits.length >= maxHits) {
          truncated = true;
          return { hits, truncated };
        }
      }
    }
  }
  return { hits, truncated };
}

/**
 * Baseline cost: 1 grep + N file reads. The N files are the first N unique
 * paths from the grep output, mirroring how an agent picks "the top hits".
 *
 * `searchRoot` is the absolute path to scan; `pathPrefix` is what to prepend
 * to the results so they align with sivru's repo-root-relative paths.
 */
async function simulateBaseline(
  searchRoot: string,
  pathPrefix: string,
  keywords: readonly string[],
): Promise<{
  tokens: number;
  turns: number;
  filesRead: string[];
  grepHits: number;
  grepTruncated: boolean;
}> {
  const { hits, truncated } = await simulateGrep(searchRoot, keywords);
  const grepBytes = hits.reduce(
    (sum, h) => sum + h.path.length + 1 + String(h.line).length + 1 + h.content.length + 1,
    0,
  );
  const uniqueFiles: string[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (seen.has(h.path)) continue;
    seen.add(h.path);
    uniqueFiles.push(h.path);
    if (uniqueFiles.length >= BASELINE_FILES_READ) break;
  }
  let readBytes = 0;
  for (const f of uniqueFiles) {
    try {
      const content = await readFile(resolve(searchRoot, f), "utf8");
      readBytes += content.length;
    } catch {
      // ignore
    }
  }
  const tokens = Math.round((grepBytes + readBytes) / CHARS_PER_TOKEN);
  return {
    tokens,
    turns: 1 + uniqueFiles.length,
    filesRead: uniqueFiles.map((f) =>
      pathPrefix === "" || pathPrefix === "." ? f : `${pathPrefix.replace(/\/+$/, "")}/${f}`,
    ),
    grepHits: hits.length,
    grepTruncated: truncated,
  };
}

/** What a single sivru search call costs in tokens — sum of chunk bodies.
 *  Adapter results MUST carry startLine + endLine; an adapter that returns
 *  chunks without ranges would silently bias the sivru number lower (we'd
 *  guess at a chunk size). Throw instead so the bench fails loudly on bad
 *  retrieval shapes. */
async function simulateSivru(
  adapter: RetrievalAdapter,
  repo: RepoSpec,
  query: string,
  expectedFiles: readonly string[],
  corpusDir: string,
): Promise<{
  tokens: number;
  turns: number;
  recallAt3: boolean;
  topFiles: string[];
}> {
  const results = await adapter(repo, query, SIVRU_TOP_K);
  let totalChars = 0;
  for (const r of results) {
    if (r.startLine === undefined || r.endLine === undefined) {
      throw new Error(
        `simulateSivru: result for ${r.filePath} is missing startLine/endLine. ` +
          `The adapter must return ranged chunks; otherwise the token count is a guess. ` +
          `If you genuinely need to support range-less results, plumb a real chunk-size ` +
          `field through the adapter contract.`,
      );
    }
    const repoRoot = resolve(corpusDir, repo.name);
    const path = resolve(repoRoot, r.filePath);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (err) {
      throw new Error(
        `simulateSivru: could not read ${path} for chunk content (${(err as Error).message}). ` +
          `Make sure the corpus is fetched and the adapter's filePath aligns with the on-disk layout.`,
      );
    }
    const lines = content.split("\n");
    const slice = lines.slice(r.startLine - 1, r.endLine).join("\n");
    totalChars += slice.length;
  }
  const tokens = Math.round(totalChars / CHARS_PER_TOKEN);
  const top3Files = new Set(results.slice(0, RECALL_AT).map((r) => r.filePath));
  const recallAt3 = expectedFiles.some((f) => top3Files.has(f));
  return {
    tokens,
    turns: 1,
    recallAt3,
    topFiles: results.slice(0, RECALL_AT).map((r) => r.filePath),
  };
}

export type AgentTaskResult = {
  taskId: string;
  repo: string;
  query: string;
  expectedFiles: string[];
  baselineKeywords: string[];
  sivru: {
    tokens: number;
    turns: number;
    recallAt3: boolean;
    topFiles: string[];
  };
  baseline: {
    tokens: number;
    turns: number;
    filesRead: string[];
    grepHits: number;
    grepTruncated: boolean;
    /** Did the baseline's first 3 file-reads include any expected file? */
    recallAt3: boolean;
  };
  tokensSaved: number;
  pctTokensSaved: number;
};

export type AgentTaskReport = {
  adapter: string;
  tasks: AgentTaskResult[];
  summary: {
    totalTasks: number;
    sivruTokensTotal: number;
    baselineTokensTotal: number;
    tokensSavedTotal: number;
    pctTokensSavedMean: number;
    pctTokensSavedMedian: number;
    sivruRecallAt3: number; // fraction of tasks where sivru hit the answer in top-3
    baselineRecallAt3: number; // fraction where baseline grep hit the answer in top-3
    avgSivruTurns: number;
    avgBaselineTurns: number;
    /**
     * Bootstrap 90% confidence intervals (5th/95th percentile via
     * resample-with-replacement, deterministic seed). Tells the reader
     * how much the headline numbers actually move under sample noise —
     * crucial for honest model-vs-model comparisons where a 2pp delta
     * could be signal or noise.
     */
    bootstrap?: {
      iterations: number;
      seed: number;
      pctTokensSavedMean: { p05: number; p50: number; p95: number };
      pctTokensSavedMedian: { p05: number; p50: number; p95: number };
      sivruRecallAt3: { p05: number; p50: number; p95: number };
      baselineRecallAt3: { p05: number; p50: number; p95: number };
    };
  };
};

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  const lo = sorted[mid - 1] ?? 0;
  const hi = sorted[mid] ?? 0;
  return (lo + hi) / 2;
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * Mulberry32 PRNG — deterministic so bootstrap intervals don't jitter
 * between runs. Same seed → same percentiles, batch after batch.
 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Default seed + iteration count for bootstrap percentiles. The
 *  iteration count balances stability (more is better) vs runtime
 *  (we're computing 4 stats over ~20 task samples — 2k resamples each
 *  is ~80k floats per call, fast). */
const BOOTSTRAP_SEED = 0xb7c8d9e1;
const BOOTSTRAP_ITERATIONS = 2000;

/**
 * Bootstrap percentiles for a sample statistic. Resamples the input with
 * replacement `iterations` times, applies `stat`, returns the 5th and
 * 95th percentile of the resulting distribution. Deterministic via
 * a seeded PRNG.
 *
 * Crucial for honest comparison: with N=20 the sample mean has real
 * uncertainty. "57.7% saved" reads more precise than it is — the 90%
 * CI is roughly 50–65%. Without this, comparisons between embedders or
 * methodology variants can mistake noise for signal.
 */
export function bootstrapPercentiles(
  values: readonly number[],
  stat: (sample: readonly number[]) => number,
  iterations: number = BOOTSTRAP_ITERATIONS,
  seed: number = BOOTSTRAP_SEED,
): { p05: number; p50: number; p95: number } {
  if (values.length === 0) return { p05: 0, p50: 0, p95: 0 };
  const rng = makeRng(seed);
  const stats: number[] = new Array(iterations);
  const buf: number[] = new Array(values.length);
  for (let i = 0; i < iterations; i++) {
    for (let j = 0; j < values.length; j++) {
      buf[j] = values[Math.floor(rng() * values.length)] ?? 0;
    }
    stats[i] = stat(buf);
  }
  stats.sort((a, b) => a - b);
  const p05Idx = Math.floor(iterations * 0.05);
  const p50Idx = Math.floor(iterations * 0.5);
  const p95Idx = Math.floor(iterations * 0.95);
  return {
    p05: stats[p05Idx] ?? 0,
    p50: stats[p50Idx] ?? 0,
    p95: stats[p95Idx] ?? 0,
  };
}

/**
 * Pick `n` annotations across the given repos as agent tasks. Round-robin
 * by repo so we get balanced coverage even when n isn't divisible by the
 * repo count. Always deterministic: same input → same selection.
 */
export function pickAgentTasks(
  byRepo: ReadonlyMap<string, readonly Annotation[]>,
  n: number,
): Array<{ repo: string; index: number; annotation: Annotation }> {
  const repos = Array.from(byRepo.keys()).sort();
  const out: Array<{ repo: string; index: number; annotation: Annotation }> = [];
  let cursor = 0;
  while (out.length < n) {
    const repo = repos[cursor % repos.length];
    if (repo === undefined) break;
    const list = byRepo.get(repo);
    if (list === undefined || list.length === 0) {
      cursor++;
      continue;
    }
    const perRepoTaken = out.filter((t) => t.repo === repo).length;
    if (perRepoTaken >= list.length) {
      cursor++;
      continue;
    }
    const annotation = list[perRepoTaken];
    if (annotation === undefined) {
      cursor++;
      continue;
    }
    out.push({ repo, index: perRepoTaken, annotation });
    cursor++;
    // Safety: prevent infinite loop if every repo is exhausted
    if (out.length === n) break;
    const totalAvailable = repos.reduce(
      (sum, r) => sum + (byRepo.get(r)?.length ?? 0),
      0,
    );
    if (out.length >= totalAvailable) break;
  }
  return out;
}

export type AgentTaskRunOptions = {
  /** Where the corpus lives — usually `benchmarks/corpus`. */
  corpusDir: string;
  /** How many tasks to run. Default 20. */
  n?: number;
};

export async function runAgentTasks(
  adapter: RetrievalAdapter,
  adapterName: string,
  repos: readonly RepoSpec[],
  loadAnnotations: (repoName: string) => Annotation[],
  options: AgentTaskRunOptions,
): Promise<AgentTaskReport> {
  const n = options.n ?? 20;

  const byRepo = new Map<string, Annotation[]>();
  for (const repo of repos) {
    const annotations = loadAnnotations(repo.name);
    byRepo.set(repo.name, annotations);
  }
  const picked = pickAgentTasks(byRepo, n);

  const results: AgentTaskResult[] = [];
  for (let i = 0; i < picked.length; i++) {
    const entry = picked[i];
    if (entry === undefined) continue;
    const { repo: repoName, index, annotation } = entry;
    const repo = repos.find((r) => r.name === repoName);
    if (repo === undefined) continue;

    const repoRoot = resolve(options.corpusDir, repo.name);
    const benchRoot = resolve(repoRoot, repo.benchmark_root);
    try {
      statSync(benchRoot);
    } catch {
      process.stderr.write(
        `  ${repo.name}: corpus missing (${benchRoot}) — run \`pnpm --filter @sivrujs/benchmarks fetch-corpus\`\n`,
      );
      continue;
    }

    const keywords = extractKeywords(annotation.query);
    process.stderr.write(`  [${i + 1}/${picked.length}] ${repo.name}: "${annotation.query.slice(0, 60)}..."\n`);

    const [sivruRes, baselineRes] = await Promise.all([
      simulateSivru(adapter, repo, annotation.query, annotation.relevant, options.corpusDir),
      simulateBaseline(benchRoot, repo.benchmark_root, keywords),
    ]);

    const baselineRecallAt3 = annotation.relevant.some((rel) =>
      baselineRes.filesRead.includes(rel),
    );

    const tokensSaved = baselineRes.tokens - sivruRes.tokens;
    const pctTokensSaved =
      baselineRes.tokens > 0 ? (tokensSaved / baselineRes.tokens) * 100 : 0;

    results.push({
      taskId: `${repo.name}-${index + 1}`,
      repo: repo.name,
      query: annotation.query,
      expectedFiles: [...annotation.relevant],
      baselineKeywords: keywords,
      sivru: sivruRes,
      baseline: { ...baselineRes, recallAt3: baselineRecallAt3 },
      tokensSaved,
      pctTokensSaved,
    });
  }

  const sivruTokensTotal = results.reduce((s, r) => s + r.sivru.tokens, 0);
  const baselineTokensTotal = results.reduce((s, r) => s + r.baseline.tokens, 0);
  const tokensSavedTotal = baselineTokensTotal - sivruTokensTotal;
  const pcts = results.map((r) => r.pctTokensSaved);
  const pctMean = mean(pcts);
  const pctMedian = median(pcts);
  // Binary 0/1 samples for the recall stats — bootstrap on these gives
  // a Wilson-like interval for the proportion.
  const sivruHitFlags = results.map((r) => (r.sivru.recallAt3 ? 1 : 0));
  const baselineHitFlags = results.map((r) => (r.baseline.recallAt3 ? 1 : 0));
  const sivruRecall = mean(sivruHitFlags);
  const baselineRecall = mean(baselineHitFlags);
  const avgSivruTurns = mean(results.map((r) => r.sivru.turns));
  const avgBaselineTurns = mean(results.map((r) => r.baseline.turns));

  // Bootstrap 90% CIs for the four headline stats. Skipped for n=0
  // (returns all-zeros) so callers don't get NaN.
  const bootstrap =
    results.length > 0
      ? {
          iterations: BOOTSTRAP_ITERATIONS,
          seed: BOOTSTRAP_SEED,
          pctTokensSavedMean: bootstrapPercentiles(pcts, mean),
          pctTokensSavedMedian: bootstrapPercentiles(pcts, median),
          sivruRecallAt3: bootstrapPercentiles(sivruHitFlags, mean),
          baselineRecallAt3: bootstrapPercentiles(baselineHitFlags, mean),
        }
      : undefined;

  const summary: AgentTaskReport["summary"] = {
    totalTasks: results.length,
    sivruTokensTotal,
    baselineTokensTotal,
    tokensSavedTotal,
    pctTokensSavedMean: pctMean,
    pctTokensSavedMedian: pctMedian,
    sivruRecallAt3: sivruRecall,
    baselineRecallAt3: baselineRecall,
    avgSivruTurns,
    avgBaselineTurns,
  };
  if (bootstrap !== undefined) summary.bootstrap = bootstrap;

  return {
    adapter: adapterName,
    tasks: results,
    summary,
  };
}

export function loadDefaults(): {
  repos: RepoSpec[];
  loadAnnotations: (n: string) => Annotation[];
} {
  const repos = JSON.parse(
    readFileSync(resolve(ROOT, "benchmarks", "repos.json"), "utf8"),
  ) as RepoSpec[];
  const loadAnnotations = (name: string): Annotation[] => {
    const path = resolve(ROOT, "benchmarks", "annotations", `${name}.json`);
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Annotation[];
    } catch (err) {
      // Loud warn instead of silent [] — a typo in repos.json shouldn't
      // silently produce 0 tasks for that repo. Still return [] so a
      // partial-corpus run can complete.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        process.stderr.write(
          `  ⚠ missing annotations file for repo "${name}" (expected at ${path}); ` +
            `running with 0 tasks for this repo\n`,
        );
      } else {
        process.stderr.write(
          `  ⚠ couldn't load annotations for repo "${name}": ${(err as Error).message}\n`,
        );
      }
      return [];
    }
  };
  return { repos, loadAnnotations };
}

export function formatAgentTaskReport(report: AgentTaskReport): string {
  const lines: string[] = [];
  const s = report.summary;
  lines.push(`Adapter: ${report.adapter}`);
  lines.push("");
  lines.push("agent-task token economy");
  lines.push("─".repeat(60));
  lines.push(`  tasks                 ${s.totalTasks}`);
  lines.push(`  sivru   tokens total  ${s.sivruTokensTotal.toLocaleString()}`);
  lines.push(`  baseline tokens total ${s.baselineTokensTotal.toLocaleString()}`);
  lines.push(`  saved                 ${s.tokensSavedTotal.toLocaleString()}  (${s.pctTokensSavedMean.toFixed(1)}% mean / ${s.pctTokensSavedMedian.toFixed(1)}% median)`);
  if (s.bootstrap !== undefined) {
    const bm = s.bootstrap.pctTokensSavedMean;
    const bmd = s.bootstrap.pctTokensSavedMedian;
    lines.push(
      `  90% CI (mean)         [${bm.p05.toFixed(1)}%, ${bm.p95.toFixed(1)}%]  ` +
        `· median [${bmd.p05.toFixed(1)}%, ${bmd.p95.toFixed(1)}%]`,
    );
  }
  lines.push(`  recall@3              ${(s.sivruRecallAt3 * 100).toFixed(1)}% (sivru) vs ${(s.baselineRecallAt3 * 100).toFixed(1)}% (baseline)`);
  if (s.bootstrap !== undefined) {
    const bs = s.bootstrap.sivruRecallAt3;
    const bb = s.bootstrap.baselineRecallAt3;
    lines.push(
      `  90% CI (recall@3)     sivru [${(bs.p05 * 100).toFixed(1)}%, ${(bs.p95 * 100).toFixed(1)}%]  ` +
        `· baseline [${(bb.p05 * 100).toFixed(1)}%, ${(bb.p95 * 100).toFixed(1)}%]`,
    );
  }
  lines.push(`  avg turns             ${s.avgSivruTurns.toFixed(1)} (sivru) vs ${s.avgBaselineTurns.toFixed(1)} (baseline)`);
  lines.push("");
  lines.push("per-task (top 10 by savings)");
  lines.push("─".repeat(60));
  const sorted = [...report.tasks].sort((a, b) => b.tokensSaved - a.tokensSaved);
  for (const r of sorted.slice(0, 10)) {
    const q = r.query.length > 50 ? r.query.slice(0, 47) + "..." : r.query;
    lines.push(
      `  ${r.taskId.padEnd(12)} ${r.sivru.tokens.toString().padStart(7)} → ${r.baseline.tokens.toString().padStart(7)} tok ` +
        `(${r.pctTokensSaved.toFixed(0).padStart(3)}%${r.sivru.recallAt3 ? " hit" : "    "})  ${q}`,
    );
  }
  return lines.join("\n");
}

// CLI entry — `pnpm --filter @sivrujs/benchmarks bench:agent`
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const hybrid = argv.includes("--hybrid");
  const nFlag = argv.find((a) => a.startsWith("--n="));
  const n = nFlag !== undefined ? Number.parseInt(nFlag.slice(4), 10) : 20;

  const { repos, loadAnnotations } = loadDefaults();
  const corpusDir = resolve(ROOT, "benchmarks", "corpus");

  const { createSivruAdapter } = await import("./sivru-adapter.js");
  const adapter = hybrid
    ? createSivruAdapter({
        corpusDir,
        mode: "hybrid",
        embed: (await import("@sivrujs/search")).createPotionProvider(),
      })
    : createSivruAdapter({ corpusDir });
  const adapterName = hybrid ? "sivru-hybrid" : "sivru-bm25";

  process.stderr.write(`agent-task benchmark — ${adapterName}, n=${n}\n`);
  const report = await runAgentTasks(adapter, adapterName, repos, loadAnnotations, {
    corpusDir,
    n,
  });

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatAgentTaskReport(report) + "\n");
  }
}

/** Test-only seam — exposes the internal simulation primitives so the
 *  unit tests can exercise them with a fixture corpus instead of the
 *  130 MB pinned-SHA repos. Not part of the public API; do not import
 *  outside of tests. */
export const _internals = {
  walkText,
  simulateGrep,
  simulateBaseline,
  simulateSivru,
  median,
  mean,
};

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`agent-task benchmark failed: ${(err as Error).message}\n`);
    if ((err as Error).stack !== undefined) {
      process.stderr.write((err as Error).stack + "\n");
    }
    process.exit(1);
  });
}

