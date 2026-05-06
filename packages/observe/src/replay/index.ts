// Offline counterfactual replay — DESIGN.md §20.3 reframed.
//
// The original §20.3 spec spawned Claude Code headless via @anthropic-ai/sdk
// to compare a task with vs without sivru. That's expensive and depends on a
// live API key, so it can't run in CI. The replacement default is a static
// analysis: walk an existing session event-by-event, mark which tool calls
// would have been replaced by sivru.search if it had been available, and
// compute the token delta. Zero API cost, fully deterministic, works offline
// on the user's existing ~/.claude/projects/ history.
//
// Real-agent replay is preserved as an opt-in deeper benchmark for pre-
// release validation only. It's not part of the W8 default flow.

import type { SivruEvent } from "../types.js";

export type ReplayOptions = {
  /**
   * Counterfactual K — how many full files an agent would have grep+read'd
   * for each search-replaceable call. Default 5 (matches Layer 1 §20.1).
   */
  baselineFilesPerSearch?: number;
  /** Avg tokens per source file. Default 1500. */
  avgFileTokens?: number;
  /** Avg tokens per chunk returned by sivru.search. Default 300. */
  avgChunkTokens?: number;
  /**
   * Tool names that count as "search-replaceable" — i.e. if sivru had been
   * available, the agent would have used `sivru.search` instead of this
   * tool. Defaults are the bash + read + grep family in Claude Code.
   */
  searchReplaceableTools?: readonly string[];
  /**
   * For Bash specifically, only treat the call as replaceable when the
   * command line matches one of these prefixes — so `Bash: ls` doesn't
   * count, but `Bash: grep foo .` does. Default matches grep / rg / find /
   * fd / cat / head / tail invocations.
   */
  bashReplaceablePatterns?: readonly RegExp[];
};

export type ReplayedEventKind =
  | "user_message"
  | "assistant_message"
  | "tool_use"
  | "tool_result"
  | "system"
  | "unknown";

export type ReplayedEvent = {
  /** Original event index in the session stream. */
  index: number;
  kind: ReplayedEventKind;
  /** Tool name when kind is `tool_use` / `tool_result`. */
  tool?: string;
  /** True for tool_use calls the counterfactual replaces with sivru.search. */
  replaceableBySivru: boolean;
  /** Tokens this event actually consumed (assistant_messages + tool_results). */
  actualTokens: number;
  /** Counterfactual tokens — same as actual unless we replace it. */
  counterfactualTokens: number;
  /** ISO timestamp from the source event. */
  ts?: string;
  /** Text snippet from messages, for the CLI replay view. */
  textSnippet?: string;
};

export type ReplayTotals = {
  actualTokens: number;
  counterfactualTokens: number;
  tokensSaved: number;
  /** `tokensSaved / actualTokens`, in [0, 1]. 0 when actualTokens is 0. */
  percentSaved: number;
  /** Number of tool_use calls flagged as search-replaceable. */
  replaceableCallCount: number;
};

export type ReplayResult = {
  events: ReplayedEvent[];
  totals: ReplayTotals;
};

const DEFAULT_OPTIONS: Required<Omit<ReplayOptions, "searchReplaceableTools" | "bashReplaceablePatterns">> & {
  searchReplaceableTools: readonly string[];
  bashReplaceablePatterns: readonly RegExp[];
} = {
  baselineFilesPerSearch: 5,
  avgFileTokens: 1500,
  avgChunkTokens: 300,
  searchReplaceableTools: ["Read", "Grep", "Glob"],
  bashReplaceablePatterns: [
    /^\s*(grep|rg|ag)\b/i,
    /^\s*(find|fd)\b/i,
    /^\s*(cat|head|tail|less|more)\b/i,
    /^\s*sed\s+-n\b/i,
  ],
};

function resolveOptions(o: ReplayOptions = {}): typeof DEFAULT_OPTIONS {
  return {
    baselineFilesPerSearch: o.baselineFilesPerSearch ?? DEFAULT_OPTIONS.baselineFilesPerSearch,
    avgFileTokens: o.avgFileTokens ?? DEFAULT_OPTIONS.avgFileTokens,
    avgChunkTokens: o.avgChunkTokens ?? DEFAULT_OPTIONS.avgChunkTokens,
    searchReplaceableTools: o.searchReplaceableTools ?? DEFAULT_OPTIONS.searchReplaceableTools,
    bashReplaceablePatterns: o.bashReplaceablePatterns ?? DEFAULT_OPTIONS.bashReplaceablePatterns,
  };
}

function isReplaceableTool(
  tool: string | undefined,
  input: unknown,
  cfg: typeof DEFAULT_OPTIONS,
): boolean {
  if (tool === undefined) return false;
  if (cfg.searchReplaceableTools.includes(tool)) return true;
  if (tool === "Bash") {
    const cmd = extractBashCommand(input);
    if (cmd === null) return false;
    return cfg.bashReplaceablePatterns.some((re) => re.test(cmd));
  }
  return false;
}

function extractBashCommand(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (typeof input === "object" && input !== null) {
    const cmd = (input as Record<string, unknown>)["command"];
    if (typeof cmd === "string") return cmd;
  }
  return null;
}

/** Cheap heuristic, mirrors the savings estimator's fallback. */
function approxTokens(text: string | undefined): number {
  if (text === undefined || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

function readUsageTokens(event: SivruEvent): number {
  const e = event as SivruEvent & { tokensIn?: number; tokensOut?: number };
  if (typeof e.tokensIn === "number" || typeof e.tokensOut === "number") {
    return (e.tokensIn ?? 0) + (e.tokensOut ?? 0);
  }
  const raw = event.raw as { message?: { usage?: { input_tokens?: number; output_tokens?: number } } } | null;
  const usage = raw?.message?.usage;
  if (usage && (typeof usage.input_tokens === "number" || typeof usage.output_tokens === "number")) {
    return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  }
  return approxTokens(event.text);
}

function tokensForToolResult(event: SivruEvent): number {
  // tool_result text/output isn't in usage records — use length heuristic.
  if (event.text !== undefined) return approxTokens(event.text);
  if (typeof event.output === "string") return approxTokens(event.output);
  if (event.output !== undefined) return approxTokens(JSON.stringify(event.output));
  return 0;
}

function snippetOf(event: SivruEvent): string | undefined {
  if (event.text !== undefined) {
    const flat = event.text.replace(/\s+/g, " ").trim();
    return flat.length > 80 ? flat.slice(0, 79) + "…" : flat;
  }
  return undefined;
}

async function* normalize(
  events: AsyncIterable<SivruEvent> | Iterable<SivruEvent>,
): AsyncGenerator<SivruEvent> {
  if (Symbol.asyncIterator in events) {
    for await (const e of events as AsyncIterable<SivruEvent>) yield e;
  } else {
    for (const e of events as Iterable<SivruEvent>) yield e;
  }
}

/**
 * Walk a session event stream, marking tool_use calls that would have been
 * replaced by sivru.search in the counterfactual. Returns per-event details
 * + aggregate totals. Pure: no I/O, no API calls.
 */
export async function replaySession(
  events: AsyncIterable<SivruEvent> | Iterable<SivruEvent>,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const cfg = resolveOptions(options);
  const out: ReplayedEvent[] = [];

  // Pending replaceable tool_use IDs — when the matching tool_result lands,
  // we substitute its actual token cost for the counterfactual chunk cost.
  let pendingReplaceable = false;
  let actualTokens = 0;
  let counterfactualTokens = 0;
  let replaceableCallCount = 0;

  for await (const event of normalize(events)) {
    const replayed: ReplayedEvent = {
      index: event.index,
      kind: event.kind,
      replaceableBySivru: false,
      actualTokens: 0,
      counterfactualTokens: 0,
    };
    if (event.tool !== undefined) replayed.tool = event.tool;
    if (event.ts !== undefined) replayed.ts = event.ts;
    const snippet = snippetOf(event);
    if (snippet !== undefined) replayed.textSnippet = snippet;

    if (event.kind === "assistant_message") {
      const t = readUsageTokens(event);
      replayed.actualTokens = t;
      replayed.counterfactualTokens = t;
    } else if (event.kind === "tool_use") {
      if (isReplaceableTool(event.tool, event.input, cfg)) {
        replayed.replaceableBySivru = true;
        replaceableCallCount += 1;
        pendingReplaceable = true;
      }
      // tool_use itself doesn't consume noteworthy tokens — the result does.
    } else if (event.kind === "tool_result") {
      const actual = tokensForToolResult(event);
      replayed.actualTokens = actual;
      if (pendingReplaceable) {
        // Replace this tool_result's contribution with sivru.search's:
        // K chunks * AVG_CHUNK_TOKENS.
        replayed.counterfactualTokens = cfg.baselineFilesPerSearch * cfg.avgChunkTokens;
        replayed.replaceableBySivru = true;
        pendingReplaceable = false;
      } else {
        replayed.counterfactualTokens = actual;
      }
    } else {
      // user / system / unknown — count actual tokens (e.g. user typed a long
      // prompt) but don't differentiate counterfactual.
      replayed.actualTokens = approxTokens(event.text);
      replayed.counterfactualTokens = replayed.actualTokens;
    }

    actualTokens += replayed.actualTokens;
    counterfactualTokens += replayed.counterfactualTokens;
    out.push(replayed);
  }

  const tokensSaved = actualTokens - counterfactualTokens;
  const percentSaved = actualTokens > 0 ? tokensSaved / actualTokens : 0;

  return {
    events: out,
    totals: {
      actualTokens,
      counterfactualTokens,
      // Signed: positive = sivru saves tokens, negative = sivru is a net loss
      // for this session shape. UI clamps for display; aggregate is honest.
      tokensSaved,
      percentSaved,
      replaceableCallCount,
    },
  };
}

export type AggregateSession = {
  id: string;
  events: AsyncIterable<SivruEvent> | Iterable<SivruEvent>;
};

export type AggregateSessionResult = {
  id: string;
  actualTokens: number;
  counterfactualTokens: number;
  tokensSaved: number;
  replaceableCallCount: number;
};

export type AggregateReport = {
  sessions: AggregateSessionResult[];
  totals: {
    sessionCount: number;
    actualTokens: number;
    counterfactualTokens: number;
    tokensSaved: number;
    percentSaved: number;
    replaceableCallCount: number;
  };
};

/** Roll up `replaySession` across many sessions. Used by `sivru observe costs`. */
export async function aggregateReplay(
  sessions: AsyncIterable<AggregateSession> | Iterable<AggregateSession>,
  options: ReplayOptions = {},
): Promise<AggregateReport> {
  const out: AggregateSessionResult[] = [];
  let totalActual = 0;
  let totalCounter = 0;
  let totalReplaceable = 0;

  const stream: AsyncIterable<AggregateSession> =
    Symbol.asyncIterator in sessions
      ? (sessions as AsyncIterable<AggregateSession>)
      : (async function* () {
          for (const s of sessions as Iterable<AggregateSession>) yield s;
        })();

  for await (const s of stream) {
    const r = await replaySession(s.events, options);
    out.push({
      id: s.id,
      actualTokens: r.totals.actualTokens,
      counterfactualTokens: r.totals.counterfactualTokens,
      tokensSaved: r.totals.tokensSaved,
      replaceableCallCount: r.totals.replaceableCallCount,
    });
    totalActual += r.totals.actualTokens;
    totalCounter += r.totals.counterfactualTokens;
    totalReplaceable += r.totals.replaceableCallCount;
  }

  const totalSaved = totalActual - totalCounter;

  return {
    sessions: out,
    totals: {
      sessionCount: out.length,
      actualTokens: totalActual,
      counterfactualTokens: totalCounter,
      tokensSaved: totalSaved,
      percentSaved: totalActual > 0 ? totalSaved / totalActual : 0,
      replaceableCallCount: totalReplaceable,
    },
  };
}
