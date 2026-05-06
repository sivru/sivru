// `sivru bench personal` — benchmark sivru's embedders on YOUR codebase
// and YOUR queries, drawn from your existing Claude Code session history.
//
// Why: the published agent-task suite (BENCHMARKS.md) measures sivru
// against three OSS repos with hand-labeled queries. That answers "how
// does sivru perform on a curated corpus?" but not "how does sivru
// perform on MY corpus?" — a question only the user can answer with
// their own data.
//
// Flow:
//
//   1. Walk ~/.claude/projects/<encoded-cwd>/<id>.jsonl
//   2. Extract user prompts (and any sivru.search queries) per session
//   3. Group by canonical project root (uses the same git-info resolver
//      as observe-ui, so worktrees collapse correctly)
//   4. For each (project, embedder) combo: build the index against the
//      project, run each query through both sivru and a grep+Read
//      simulator, tally tokens-saved
//   5. Output a comparison table with bootstrap 90% CIs
//
// PRIVACY: everything stays local. No queries leave the machine.
// Embedder models are loaded from disk / Hugging Face per the existing
// providers; sivru's privacy boundary at packages/observe/ is unrelated
// — this command lives in cli/.

import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname as pathDirname, resolve } from "node:path";

import { listSessions, readSession } from "@sivru/observe";
import type { Session, SivruEvent } from "@sivru/observe";
import { buildIndex, type CrossEncoder, type SivruIndex } from "@sivru/search";

import {
  listModels,
  resolveModel as resolveCatalogModel,
  resolveReranker,
  type ModelEntry,
} from "../lib/model-catalog.js";
import { saveBenchHistory } from "../lib/bench-history.js";
import {
  extractGroundTruth,
  isEntityShapedQuery,
} from "../lib/ground-truth.js";
import {
  bootstrapCIMean as bootstrapCIShared,
  mean as meanShared,
  median as medianShared,
  mrr as mrrMetric,
  recallAtK,
} from "../lib/metrics.js";
import { createProgressReporter } from "../lib/progress.js";
import { selectMultipleInteractive } from "../lib/prompt.js";
import { SIVRU_VERSION } from "./version.js";

// ----- args --------------------------------------------------------------

type Args = {
  /** When set, only run against this repo. Otherwise auto-discover. */
  repo: string | null;
  /**
   * Comma-separated short names — see lib/model-catalog.ts. Empty array
   * means "the user didn't pass --models" — we'll prompt interactively.
   */
  models: string[];
  /** True iff the user explicitly passed --models (vs. defaulting). */
  modelsExplicit: boolean;
  /** Max queries per repo. Default 10. */
  n: number;
  /** Only sessions newer than N days, when set. */
  sinceDays: number | null;
  /** When true, emit JSON; otherwise text table. */
  json: boolean;
  /** Skip writing the result to ~/.cache/sivru/bench-history/. */
  noHistory: boolean;
  /**
   * Cross-encoder reranker short name (`ms-marco-minilm`,
   * `bge-reranker-base`, `hf:owner/model`) or null to skip rerank.
   * When set, applies to EVERY model in the sweep — re-run with
   * different `--rerank` values to ablate the contribution.
   */
  rerank: string | null;
  /** Top-N candidates fed into the reranker. Default 50. */
  rerankTopN: number | null;
  /** Override projects-root for tests. */
  projectsRoot: string | null;
};

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const out: Args = {
    repo: null,
    models: [],
    modelsExplicit: false,
    n: 10,
    sinceDays: null,
    json: false,
    noHistory: false,
    rerank: null,
    rerankTopN: null,
    projectsRoot: null,
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new Error(`flag ${a} expects a value`);
      }
      i++;
      return v;
    };
    try {
      if (a === "--repo") out.repo = resolve(next());
      else if (a === "--models") {
        out.models = next()
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        out.modelsExplicit = true;
      } else if (a.startsWith("--n=")) {
        const v = Number.parseInt(a.slice("--n=".length), 10);
        if (!Number.isFinite(v) || v <= 0) return { error: `--n must be a positive integer (got ${a})` };
        out.n = v;
      } else if (a === "--n") {
        const v = Number.parseInt(next(), 10);
        if (!Number.isFinite(v) || v <= 0) return { error: `--n must be a positive integer` };
        out.n = v;
      } else if (a.startsWith("--since=")) {
        const v = Number.parseInt(a.slice("--since=".length), 10);
        if (!Number.isFinite(v) || v <= 0) return { error: `--since must be a positive integer of days` };
        out.sinceDays = v;
      } else if (a === "--json") out.json = true;
      else if (a === "--no-history") out.noHistory = true;
      else if (a === "--projects-root") out.projectsRoot = next();
      else if (a.startsWith("--")) return { error: `unknown flag: ${a}` };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }
  return out;
}

/**
 * When --models wasn't explicitly passed, ask the user to pick from the
 * catalog interactively. Pre-selects bm25 + potion as a sensible default
 * (the same pair the old hardcoded default used). Returns null when the
 * user cancels or stdin isn't a TTY (CI, piped) — caller falls back to
 * the default pair in that case.
 */
async function promptForModels(): Promise<string[] | null> {
  const entries = listModels();
  const defaultPicks = ["bm25", "potion"];
  return selectMultipleInteractive({
    prompt: "Pick models to benchmark:",
    choices: entries.map((e) => {
      const m = e.metadata;
      const hint =
        e.kind === "bm25"
          ? "lexical only · 0 MB · cold-start <1s"
          : `${m.params} · ${m.dim} dim · ${m.diskMB} MB · ~${m.approxColdStartMin} min cold-start${m.codeOptimized ? " · code-tuned" : ""}`;
      return {
        value: e.shortName,
        label: e.shortName.padEnd(12) + ` ${m.label}`,
        hint,
      };
    }),
    defaultIndices: entries
      .map((e, i) => (defaultPicks.includes(e.shortName) ? i : -1))
      .filter((i) => i >= 0),
  });
}

// Model registry now lives in lib/model-catalog.ts so `sivru search`,
// `sivru bench models`, and `sivru config set embedder` all share the
// same set of names + metadata.
const resolveModel = resolveCatalogModel;

// ----- query extraction --------------------------------------------------

const MAX_QUERY_CHARS = 200;
const MIN_QUERY_CHARS = 6;

/**
 * Extract candidate search queries from a single session's events. We
 * prefer real `sivru.search` tool_use queries (highest signal — that's
 * literally what the user wanted searched). When those aren't present
 * (most users today aren't yet wired up), fall back to user_message
 * texts trimmed to a leading sentence.
 */
export function extractQueriesFromEvents(events: readonly SivruEvent[]): string[] {
  const fromSearchCalls: string[] = [];
  const fromUserMessages: string[] = [];

  for (const e of events) {
    if (
      e.kind === "tool_use" &&
      e.tool !== undefined &&
      e.tool.toLowerCase().replace(/[^a-z0-9]/g, "").includes("sivrusearch")
    ) {
      const input = e.input;
      if (input !== null && typeof input === "object") {
        const q = (input as { query?: unknown }).query;
        if (typeof q === "string" && q.length > 0) {
          fromSearchCalls.push(q.trim());
        }
      }
    }
    if (e.kind === "user_message" && typeof e.text === "string") {
      const cleaned = e.text.replace(/\s+/g, " ").trim();
      if (cleaned.length === 0) continue;
      // Skip "[Request interrupted by user]" / system markers.
      if (cleaned.startsWith("[")) continue;
      // Take just the first sentence-ish to keep the query focused.
      const firstSentence = cleaned.match(/^[^.?!]{1,200}[.?!]?/)?.[0] ?? cleaned.slice(0, MAX_QUERY_CHARS);
      const truncated =
        firstSentence.length > MAX_QUERY_CHARS
          ? firstSentence.slice(0, MAX_QUERY_CHARS).trim()
          : firstSentence.trim();
      if (truncated.length >= MIN_QUERY_CHARS) {
        fromUserMessages.push(truncated);
      }
    }
  }

  // Prefer search-call queries when present (highest signal); pad with
  // user-message extracts as needed.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of [fromSearchCalls, fromUserMessages]) {
    for (const q of list) {
      const key = q.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(q);
    }
  }
  return out;
}

// ----- agent-task simulator -------------------------------------------------

// Inlined from `@sivru/benchmarks/src/agent-tasks.ts` — the canonical
// version lives there with full test coverage; this is a self-contained
// copy so the published CLI doesn't need to depend on a workspace-only
// benchmarks package. If you tweak the simulator math, update both.

const CHARS_PER_TOKEN = 4;
const BASELINE_FILES_READ = 3;
const SIVRU_TOP_K = 5;
const GREP_MAX_HITS = 100;

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

function extractKeywords(query: string, max = 3): string[] {
  const tokens = query.split(/[^A-Za-z0-9_.]+/).filter((t) => t.length > 0);
  const scored: Array<{ token: string; score: number }> = [];
  for (const t of tokens) {
    if (STOPWORDS.has(t.toLowerCase())) continue;
    if (t.length < 3) continue;
    let score = t.length;
    if (/[A-Z]/.test(t) && /[a-z]/.test(t)) score += 5;
    if (t.includes("_")) score += 4;
    if (t.includes(".")) score += 4;
    if (/^[a-z]+$/.test(t) && t.length < 5) score -= 2;
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

async function simulateGrepHits(
  searchRoot: string,
  keywords: readonly string[],
): Promise<Array<{ path: string; line: number; content: string }>> {
  if (keywords.length === 0) return [];
  const pattern = new RegExp(
    keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  );
  const files = await walkText(searchRoot);
  const hits: Array<{ path: string; line: number; content: string }> = [];
  for (const f of files) {
    let content: string;
    try {
      content = await readFile(resolve(searchRoot, f), "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (pattern.test(line)) {
        hits.push({ path: f, line: i + 1, content: line });
        if (hits.length >= GREP_MAX_HITS) return hits;
      }
    }
  }
  return hits;
}

/** Lines of context window read around each hit in the honest baseline. */
const BASELINE_WINDOW_LINES = 30;

async function simulateBaseline(
  searchRoot: string,
  keywords: readonly string[],
): Promise<{ tokens: number; turns: number; filesRead: string[] }> {
  // "Honest" baseline: real Claude Code with grep does NOT read whole
  // files — it `Grep`s, then `Read`s a window around the most relevant
  // hit (offset/limit, ~30 lines). The original implementation read 3
  // FULL files which inflated baseline_tokens by 5–10× on average and
  // baked an artificial 30–40 percentage point savings into every
  // result. Switching to windowed reads gives a defensible "% saved"
  // headline.
  const hits = await simulateGrepHits(searchRoot, keywords);
  const grepBytes = hits.reduce(
    (s, h) =>
      s + h.path.length + 1 + String(h.line).length + 1 + h.content.length + 1,
    0,
  );

  // First-hit line per unique file, capped at BASELINE_FILES_READ.
  const firstHitByFile = new Map<string, number>();
  for (const h of hits) {
    if (!firstHitByFile.has(h.path)) firstHitByFile.set(h.path, h.line);
    if (firstHitByFile.size >= BASELINE_FILES_READ) break;
  }

  const filesRead: string[] = [];
  let readBytes = 0;
  for (const [path, hitLine] of firstHitByFile) {
    try {
      const content = await readFile(resolve(searchRoot, path), "utf8");
      const lines = content.split("\n");
      const half = Math.floor(BASELINE_WINDOW_LINES / 2);
      const start = Math.max(0, hitLine - 1 - half);
      const end = Math.min(lines.length, hitLine - 1 + half + 1);
      readBytes += lines.slice(start, end).join("\n").length;
      filesRead.push(path);
    } catch {
      // unreadable file — skip; keeps the baseline measurable
    }
  }

  return {
    tokens: Math.round((grepBytes + readBytes) / CHARS_PER_TOKEN),
    turns: 1 + filesRead.length,
    filesRead,
  };
}

type SivruSimResult = {
  tokens: number;
  turns: number;
  /** Project-root-relative file paths in rank order; deduped while preserving order. */
  retrievedFiles: string[];
};

async function simulateSivru(
  index: SivruIndex,
  query: string,
  hybrid: boolean,
  repoRoot: string,
): Promise<SivruSimResult> {
  const hits = await (hybrid
    ? index.searchHybrid(query, SIVRU_TOP_K)
    : index.searchBM25(query, SIVRU_TOP_K));
  let totalChars = 0;
  for (const h of hits) {
    if (h.chunk.startLine === undefined || h.chunk.endLine === undefined) {
      totalChars += h.chunk.content.length;
      continue;
    }
    try {
      const path = resolve(repoRoot, h.chunk.filePath);
      const content = await readFile(path, "utf8");
      const lines = content.split("\n");
      const slice = lines.slice(h.chunk.startLine - 1, h.chunk.endLine).join("\n");
      totalChars += slice.length;
    } catch {
      totalChars += h.chunk.content.length;
    }
  }
  // Retain rank order, dedupe — recall@k is computed against the unique
  // file set in this exact order.
  const retrievedFiles: string[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const fp = h.chunk.filePath;
    if (seen.has(fp)) continue;
    seen.add(fp);
    retrievedFiles.push(fp);
  }

  return {
    tokens: Math.round(totalChars / CHARS_PER_TOKEN),
    turns: 1,
    retrievedFiles,
  };
}

// ----- bootstrap CIs ------------------------------------------------------

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

function meanArr(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function bootstrapCI(values: readonly number[]): {
  p05: number;
  p50: number;
  p95: number;
} {
  if (values.length === 0) return { p05: 0, p50: 0, p95: 0 };
  const rng = makeRng(0xb7c8d9e1);
  const iterations = 2000;
  const stats: number[] = new Array(iterations);
  const buf: number[] = new Array(values.length);
  for (let i = 0; i < iterations; i++) {
    for (let j = 0; j < values.length; j++) {
      buf[j] = values[Math.floor(rng() * values.length)] ?? 0;
    }
    stats[i] = meanArr(buf);
  }
  stats.sort((a, b) => a - b);
  return {
    p05: stats[Math.floor(iterations * 0.05)] ?? 0,
    p50: stats[Math.floor(iterations * 0.5)] ?? 0,
    p95: stats[Math.floor(iterations * 0.95)] ?? 0,
  };
}

// ----- session discovery -------------------------------------------------

/**
 * One entry per deduped query. `relevantFiles` is the ground-truth file
 * set the agent actually edited / read across sessions where this query
 * appeared — used to compute recall@k and MRR.
 */
type QueryEntry = {
  query: string;
  source: "search_call" | "user_message";
  /** Project-root-relative paths. May be empty when the query had no follow-up edits. */
  relevantFiles: string[];
};

type RepoQuerySet = {
  /** Canonical project root (resolved by observe's git-info via Session.projectRoot). */
  projectRoot: string;
  /** Display-friendly basename for the row. */
  basename: string;
  /** Deduped queries with ground-truth file sets. */
  queries: QueryEntry[];
  /** Number of sessions contributing. */
  sessionCount: number;
};

async function discoverRepos(args: Args): Promise<RepoQuerySet[]> {
  const sessions: Session[] = await listSessions(
    args.projectsRoot !== null ? { projectsRoot: args.projectsRoot } : undefined,
  );

  const cutoff =
    args.sinceDays !== null
      ? Date.now() - args.sinceDays * 86_400_000
      : null;

  // If --repo was passed, narrow before extracting queries (saves IO).
  const filteredSessions = sessions.filter((s) => {
    if (cutoff !== null) {
      if (s.updatedAt === null) return false;
      if (Date.parse(s.updatedAt) < cutoff) return false;
    }
    if (args.repo !== null) {
      // Accept either project (raw cwd) or projectRoot (canonical).
      return s.project === args.repo || s.projectRoot === args.repo;
    }
    return true;
  });

  // Group by canonical projectRoot. Extract queries per group.
  const byRoot = new Map<string, RepoQuerySet>();
  for (const s of filteredSessions) {
    const key = s.projectRoot.length > 0 ? s.projectRoot : s.project;
    let group = byRoot.get(key);
    if (group === undefined) {
      group = {
        projectRoot: key,
        basename: basenamePath(key),
        queries: [],
        sessionCount: 0,
      };
      byRoot.set(key, group);
    }
    group.sessionCount += 1;
    // Read the session's events lazily, then derive ground-truth pairs.
    // Each pair carries the query string AND the files the agent
    // actually edited / read between this query and the next — that's
    // the relevance set used downstream for recall@5 / MRR.
    const events: SivruEvent[] = [];
    for await (const event of readSession(s.path)) {
      events.push(event);
    }
    const gtList = extractGroundTruth(events, group.projectRoot);
    // Dedupe within the group (sessions in the same project often share
    // prompts). When the same query appears across multiple sessions,
    // union the relevantFiles sets — the agent may have touched
    // different files in different runs.
    const byQuery = new Map<string, QueryEntry>();
    for (const existing of group.queries) {
      byQuery.set(existing.query.toLowerCase(), existing);
    }
    for (const gt of gtList) {
      const key = gt.query.toLowerCase();
      const existing = byQuery.get(key);
      if (existing !== undefined) {
        const seenFiles = new Set(existing.relevantFiles);
        for (const f of gt.relevantFiles) {
          if (!seenFiles.has(f)) {
            seenFiles.add(f);
            existing.relevantFiles.push(f);
          }
        }
        // Promote source to "search_call" if any session had it as one.
        if (existing.source !== "search_call" && gt.source === "search_call") {
          existing.source = "search_call";
        }
      } else {
        const entry: QueryEntry = {
          query: gt.query,
          source: gt.source,
          relevantFiles: [...gt.relevantFiles],
        };
        byQuery.set(key, entry);
        group.queries.push(entry);
      }
    }
  }

  // Cap query count per repo and require the projectRoot to actually
  // exist on disk.
  const result: RepoQuerySet[] = [];
  for (const group of byRoot.values()) {
    if (!existsSync(group.projectRoot)) continue;
    try {
      if (!statSync(group.projectRoot).isDirectory()) continue;
    } catch {
      continue;
    }
    if (group.queries.length === 0) continue;

    // Ranking before slicing: prefer real `sivru.search` calls (highest
    // signal — explicit user search intent) over user_message extracts.
    // Within each group, prefer queries that have ground-truth files
    // (they're scoreable for recall@k / MRR; queries without any GT
    // can only be scored on token-savings, which is the weaker metric).
    group.queries.sort((a, b) => {
      const sa = a.source === "search_call" ? 0 : 1;
      const sb = b.source === "search_call" ? 0 : 1;
      if (sa !== sb) return sa - sb;
      const ga = a.relevantFiles.length > 0 ? 0 : 1;
      const gb = b.relevantFiles.length > 0 ? 0 : 1;
      return ga - gb;
    });

    // Drop user_message queries that aren't entity-shaped AND have no
    // ground truth — those are vague continuations like "yes go ahead"
    // or "now do that for the other module" that don't make meaningful
    // search queries. Search-call queries are always kept (the user
    // asked for them by name). Queries with ground truth are kept
    // regardless — even a vague message is scoreable if we can see
    // what the agent did about it.
    group.queries = group.queries.filter(
      (q) =>
        q.source === "search_call" ||
        q.relevantFiles.length > 0 ||
        isEntityShapedQuery(q.query),
    );
    if (group.queries.length === 0) continue;

    group.queries = group.queries.slice(0, args.n);
    result.push(group);
  }
  result.sort((a, b) => b.sessionCount - a.sessionCount);
  return result;
}

function basenamePath(p: string): string {
  if (p.length === 0) return "";
  const parts = p.split(/[\\/]/).filter((s) => s.length > 0);
  return parts.length > 0 ? (parts[parts.length - 1] ?? p) : p;
}

// ----- runner ------------------------------------------------------------

type ModelResult = {
  model: string;
  label: string;

  /** Per-query token-savings %. One entry per query, in the order they were run. */
  perQuerySaved: number[];
  /** Per-query recall@5 (file-level). Indexed parallel to `scoreableQueryIndices`. */
  perQueryRecallAt5: number[];
  /** Per-query MRR (file-level). Indexed parallel to `scoreableQueryIndices`. */
  perQueryMRR: number[];
  /** Indices into perQuerySaved for queries that had non-empty ground truth. */
  scoreableQueryIndices: number[];

  meanSavedPct: number;
  medianSavedPct: number;
  meanRecallAt5: number;
  medianRecallAt5: number;
  meanMRR: number;
  medianMRR: number;

  /** Bootstrap 90% CI on the mean of perQuerySaved (back-compat field name). */
  ci: { p05: number; p50: number; p95: number };
  /** Bootstrap 90% CI on the mean of perQueryRecallAt5. */
  recallCI: { p05: number; p50: number; p95: number };
  /** Bootstrap 90% CI on the mean of perQueryMRR. */
  mrrCI: { p05: number; p50: number; p95: number };

  /** How many queries contributed to recall/MRR (relevantFiles.length > 0). */
  queriesScoredForRecall: number;

  buildMs: number;
  searchMs: number;
};

async function runForRepo(
  group: RepoQuerySet,
  args: Args,
  rerankerProvider: CrossEncoder | null,
): Promise<ModelResult[]> {
  const out: ModelResult[] = [];

  for (const modelName of args.models) {
    const entry = resolveModel(modelName);
    if (entry === null) {
      process.stderr.write(`  skipping unknown model: ${modelName}\n`);
      continue;
    }

    process.stderr.write(`\n  ${entry.metadata.label}: building index…\n`);
    const t0 = performance.now();
    const reporter = createProgressReporter({
      label: entry.metadata.label,
      coldStartMin: entry.metadata.approxColdStartMin,
    });
    // Hold ranking pipeline constant across models: `signals: false`
    // for both BM25 and hybrid runs. Production defaults differ
    // (signals on for BM25, off for hybrid) which makes the bench's
    // bm25-vs-hybrid comparison apples-to-oranges. Setting `false`
    // here measures the raw retrievers; reranking is a separate
    // dimension users can compare with `--bm25 vs --hybrid` against
    // the live `sivru search` command.
    const rerankPart =
      rerankerProvider !== null
        ? {
            rerank: {
              provider: rerankerProvider,
              ...(args.rerankTopN !== null ? { topN: args.rerankTopN } : {}),
            },
          }
        : {};
    const buildOpts: Parameters<typeof buildIndex>[1] =
      entry.kind === "embed"
        ? {
            embed: { provider: entry.build() },
            signals: false,
            onProgress: reporter.onEvent,
            ...rerankPart,
          }
        : { signals: false, onProgress: reporter.onEvent, ...rerankPart };
    let index: SivruIndex;
    try {
      index = await buildIndex(group.projectRoot, buildOpts);
    } finally {
      reporter.finish();
    }
    const t1 = performance.now();
    process.stderr.write(
      `  ${entry.metadata.label}: indexed ${index.size()} chunks in ${Math.round(t1 - t0)} ms\n`,
    );

    const perQuerySaved: number[] = [];
    const perQueryRecallAt5: number[] = [];
    const perQueryMRR: number[] = [];
    const scoreableQueryIndices: number[] = [];

    const tSearch0 = performance.now();
    for (let i = 0; i < group.queries.length; i++) {
      const q = group.queries[i]!;
      const keywords = extractKeywords(q.query);
      const [sivruRes, baselineRes] = await Promise.all([
        simulateSivru(index, q.query, entry.kind === "embed", group.projectRoot),
        simulateBaseline(group.projectRoot, keywords),
      ]);
      const tokensSaved = baselineRes.tokens - sivruRes.tokens;
      const pct =
        baselineRes.tokens > 0 ? (tokensSaved / baselineRes.tokens) * 100 : 0;
      perQuerySaved.push(pct);

      let recallSuffix = "";
      if (q.relevantFiles.length > 0) {
        // Score against the ground-truth set. Wrap each retrieved file
        // path as a SearchHitLike so recallAtK / mrr can consume them.
        const hitLike = sivruRes.retrievedFiles.map((fp) => ({
          chunk: { filePath: fp },
        }));
        const r5 = recallAtK(hitLike, q.relevantFiles, 5);
        const m = mrrMetric(hitLike, q.relevantFiles, 5);
        perQueryRecallAt5.push(r5);
        perQueryMRR.push(m);
        scoreableQueryIndices.push(i);
        recallSuffix = ` · recall@5 ${r5.toFixed(2)} · MRR ${m.toFixed(2)}`;
      }

      process.stderr.write(
        `  ${entry.metadata.label}: [${i + 1}/${group.queries.length}] sivru=${sivruRes.tokens} vs baseline=${baselineRes.tokens} → ${pct.toFixed(0)}% saved${recallSuffix}\n`,
      );
    }
    const tSearch1 = performance.now();

    out.push({
      model: modelName,
      label: entry.metadata.label,
      perQuerySaved,
      perQueryRecallAt5,
      perQueryMRR,
      scoreableQueryIndices,
      meanSavedPct: meanShared(perQuerySaved),
      medianSavedPct: medianShared(perQuerySaved),
      meanRecallAt5: meanShared(perQueryRecallAt5),
      medianRecallAt5: medianShared(perQueryRecallAt5),
      meanMRR: meanShared(perQueryMRR),
      medianMRR: medianShared(perQueryMRR),
      ci: bootstrapCIShared(perQuerySaved),
      recallCI: bootstrapCIShared(perQueryRecallAt5),
      mrrCI: bootstrapCIShared(perQueryMRR),
      queriesScoredForRecall: scoreableQueryIndices.length,
      buildMs: Math.round(t1 - t0),
      searchMs: Math.round(tSearch1 - tSearch0),
    });
  }
  return out;
}

// ----- entry -------------------------------------------------------------

export async function runBenchPersonal(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`sivru bench personal: ${parsed.error}\n`);
    return 2;
  }

  // Resolve --models. Three regimes:
  //   1. user passed --models a,b,c            → use as-is
  //   2. didn't pass, TTY                      → interactive prompt
  //   3. didn't pass, non-TTY (CI/pipe)        → default to bm25,potion
  if (!parsed.modelsExplicit) {
    if (parsed.json || !process.stdin.isTTY) {
      // Non-interactive: keep behavior predictable.
      parsed.models = ["bm25", "potion"];
    } else {
      const picked = await promptForModels();
      if (picked === null || picked.length === 0) {
        process.stderr.write(
          "sivru bench personal: no models selected — pass --models or press Enter to accept the default pair (bm25,potion).\n",
        );
        return 1;
      }
      parsed.models = picked;
    }
  }

  const startedAt = new Date().toISOString();
  process.stderr.write("sivru bench personal\n");
  process.stderr.write(`  models: ${parsed.models.join(", ")}\n`);
  process.stderr.write(
    `  queries per repo: ${parsed.n}${parsed.sinceDays !== null ? `; since ${parsed.sinceDays}d` : ""}\n`,
  );

  const repos = await discoverRepos(parsed);
  if (repos.length === 0) {
    process.stderr.write(
      `\n  No usable session/repo combinations found.\n` +
        `  - Make sure you have Claude Code sessions in ~/.claude/projects/\n` +
        `  - The session's repo must still exist on disk\n` +
        `  - Try passing --repo /path/to/repo to skip discovery\n`,
    );
    return 1;
  }

  const fullReport: Array<{
    project: string;
    basename: string;
    sessionCount: number;
    queries: string[];
    /**
     * Per-query metadata (source + ground-truth file count). Persisted so
     * the observe-ui Bench tab can show "scored on N/M queries" and the
     * source mix without needing to re-parse session jsonls.
     */
    queryDetails: Array<{
      query: string;
      source: "search_call" | "user_message";
      relevantFiles: string[];
    }>;
    models: ModelResult[];
  }> = [];

  // Resolve + build the reranker ONCE outside the per-repo loop so the
  // model isn't re-loaded for every repo. The cross-encoder pipeline
  // is internally lazy-loaded on the first .score() call.
  let rerankerProvider: CrossEncoder | null = null;
  let rerankerLabel: string | null = null;
  if (parsed.rerank !== null) {
    const entry = resolveReranker(parsed.rerank);
    if (entry === null) {
      process.stderr.write(
        `sivru bench personal: unknown reranker "${parsed.rerank}". Run \`sivru bench models\` for the list, or use \`hf:owner/model-name\`.\n`,
      );
      return 2;
    }
    rerankerProvider = entry.build();
    rerankerLabel = entry.metadata.label;
    process.stderr.write(
      `  rerank: ${entry.metadata.label} (~${entry.metadata.approxMsPerQueryAt50} ms / 50 pairs CPU)\n`,
    );
  }

  for (const group of repos) {
    const withGT = group.queries.filter((q) => q.relevantFiles.length > 0).length;
    const fromSearch = group.queries.filter(
      (q) => q.source === "search_call",
    ).length;
    process.stderr.write(
      `\n─ ${group.projectRoot} · ${group.sessionCount} sessions · ${group.queries.length} queries (${fromSearch} from sivru.search, ${withGT} with ground truth)\n`,
    );
    const models = await runForRepo(group, parsed, rerankerProvider);
    fullReport.push({
      project: group.projectRoot,
      basename: group.basename,
      sessionCount: group.sessionCount,
      queries: group.queries.map((q) => q.query),
      queryDetails: group.queries.map((q) => ({
        query: q.query,
        source: q.source,
        relevantFiles: q.relevantFiles,
      })),
      models,
    });
  }
  // Used in the saved-history block below.
  void rerankerLabel;

  // Persist the run to ~/.cache/sivru/bench-history/ so the observe-ui
  // Bench tab can render it later. Skipped under --no-history (and for
  // empty result sets, since there's nothing meaningful to look back at).
  if (!parsed.noHistory && fullReport.length > 0) {
    try {
      const path = saveBenchHistory({
        startedAt,
        sivruVersion: SIVRU_VERSION,
        node: process.versions.node,
        platform: process.platform,
        argv: [...argv],
        repos: fullReport,
        ...(rerankerLabel !== null && parsed.rerank !== null
          ? {
              rerank: {
                shortName: parsed.rerank,
                label: rerankerLabel,
              },
            }
          : {}),
      });
      process.stderr.write(`\n  saved bench run → ${path}\n`);
    } catch (err) {
      process.stderr.write(
        `  ⚠ couldn't save bench history: ${(err as Error).message}\n`,
      );
    }
  }

  if (parsed.json) {
    process.stdout.write(JSON.stringify(fullReport, null, 2) + "\n");
    return 0;
  }

  // Text output: one block per repo. Recall@5 / MRR are the IR-correct
  // metrics; "% saved" is a secondary efficiency stat. We report median
  // alongside mean because the per-query distribution is heavy-tailed
  // (one outlier query can dominate the mean).
  for (const repo of fullReport) {
    process.stdout.write("\n");
    const gtCount = repo.queryDetails.filter(
      (d) => d.relevantFiles.length > 0,
    ).length;
    process.stdout.write(
      `${repo.basename}  (${repo.sessionCount} sessions · ${repo.queries.length} queries · ${gtCount} with ground truth)\n`,
    );
    process.stdout.write("─".repeat(96) + "\n");
    process.stdout.write(
      "  model".padEnd(36) +
        "recall@5".padStart(11) +
        "MRR".padStart(8) +
        "saved (med)".padStart(13) +
        "saved (mean)".padStart(14) +
        "build".padStart(11) +
        "\n",
    );
    process.stdout.write("  " + "─".repeat(94) + "\n");
    for (const m of repo.models) {
      const recallCell =
        m.queriesScoredForRecall > 0
          ? `${m.medianRecallAt5.toFixed(2)}`
          : "—";
      const mrrCell =
        m.queriesScoredForRecall > 0 ? `${m.medianMRR.toFixed(2)}` : "—";
      process.stdout.write(
        "  " +
          m.label.padEnd(34) +
          ` ${recallCell}`.padStart(11) +
          ` ${mrrCell}`.padStart(8) +
          ` ${m.medianSavedPct.toFixed(1)}%`.padStart(13) +
          ` ${m.meanSavedPct.toFixed(1)}%`.padStart(14) +
          ` ${(m.buildMs / 1000).toFixed(1)} s`.padStart(11) +
          "\n",
      );
    }

    // Recommendation: pick the model with the highest median recall@5
    // when ground truth exists. Fall back to the savings-CI heuristic
    // when no query in this repo had ground-truth files.
    if (repo.models.length > 1) {
      const haveRecall = repo.models.some((m) => m.queriesScoredForRecall > 0);
      const ranked = haveRecall
        ? [...repo.models].sort((a, b) => b.medianRecallAt5 - a.medianRecallAt5)
        : [...repo.models].sort((a, b) => b.ci.p05 - a.ci.p05);
      const best = ranked[0]!;
      const baseline = ranked.find((m) => m.model === "potion") ?? ranked[1]!;
      process.stdout.write("\n");
      if (best.model === baseline.model) {
        process.stdout.write(
          `  ${best.label} is your strongest result on this repo's queries${haveRecall ? " (highest recall@5)" : ""}.\n`,
        );
      } else if (haveRecall) {
        const overlap =
          best.recallCI.p05 < baseline.recallCI.p95 &&
          baseline.recallCI.p05 < best.recallCI.p95;
        const delta = best.medianRecallAt5 - baseline.medianRecallAt5;
        if (overlap) {
          process.stdout.write(
            `  ${best.label} edges out ${baseline.label} (recall@5 +${delta.toFixed(2)}), but their 90% CIs overlap — treat as a tie.\n`,
          );
        } else {
          process.stdout.write(
            `  ${best.label} clearly beats ${baseline.label} on recall@5 (CIs don't overlap). Switch to it for ${repo.basename}.\n`,
          );
        }
      } else {
        const overlap =
          best.ci.p05 < baseline.ci.p95 && baseline.ci.p05 < best.ci.p95;
        if (overlap) {
          process.stdout.write(
            `  ${best.label} edges out ${baseline.label} on tokens-saved, but CIs overlap — treat as a tie. Run more sessions for stronger signal.\n`,
          );
        } else {
          process.stdout.write(
            `  ${best.label} beats ${baseline.label} on tokens-saved. Note: no queries had ground-truth files in this repo, so retrieval quality wasn't measured.\n`,
          );
        }
      }
    }
  }
  process.stdout.write("\n");
  return 0;
}

// Sentinel used by the CLI dispatcher (not strictly necessary, but
// matches the `_internal` pattern other commands use).
export const _internal = {
  parseArgs,
  resolveModel,
  basenamePath,
  bootstrapCI,
  simulateBaseline,
  simulateSivru,
};

// Touch potentially-unused imports so the bundler keeps them around. The
// path module is used in the basenamePath polyfill above; pathDirname is
// kept for future extension.
void pathDirname;
void homedir;
