// Layer 1 savings estimator — DESIGN.md §20.1.
//
// Pure function over a stream of normalized SivruEvents. No filesystem reads,
// no network. The estimator approximates the counterfactual cost of an agent
// using `grep + read` instead of `sivru.search` for the same questions, then
// reports the delta.
//
// PRIVACY GUARANTEE (DESIGN.md §5.5): observe never makes network calls.
// This file consumes already-normalized events and produces numbers — nothing
// here reaches out.

import type { SivruEvent } from "../types.js";
import { blendedRateUsdPerMTok, turnCostUsd } from "./pricing.js";

const DEFAULT_BASELINE_FILES_PER_SEARCH = 5;
const DEFAULT_AVG_FILE_TOKENS = 1500;
const DEFAULT_AVG_CHUNK_TOKENS = 300;
// Claude Code namespaces MCP tools as `mcp__<server>__<tool>`, so when a
// session calls our MCP `search` tool it lands in the jsonl as
// `mcp__sivru__search`. Other agent hosts may use the dotted/underscored
// names directly. Cover all the shapes we've seen in the wild.
const DEFAULT_SEARCH_TOOL_NAMES = [
  "mcp__sivru__search",
  "sivru.search",
  "sivru_search",
] as const;
// Rough chars-per-token heuristic when the source line did not carry usage
// numbers. ~4 chars/token is the OpenAI/Anthropic ballpark for English text.
const CHARS_PER_TOKEN = 4;

export type SavingsOptions = {
  /** Files an agent would have grep+read'd per search. Default 5. */
  baselineFilesPerSearch?: number;
  /** Avg tokens per source file. Default 1500. */
  avgFileTokens?: number;
  /** Avg tokens per chunk returned by sivru.search. Default 300. */
  avgChunkTokens?: number;
  /**
   * Names that count as a sivru search call. Default ["sivru.search", "sivru_search"].
   * The MCP tool the W4 commit advertised is named `search` — but in tool_use
   * events the tool ends up as `sivru.search` after server-side namespacing
   * in some Claude Code versions, so we accept aliases.
   */
  searchToolNames?: readonly string[];
};

export type SavingsEstimate = {
  /** Total savings across the session, in tokens. Always >= 0. */
  tokensSaved: number;
  /** Approximate tokens actually consumed by the assistant. */
  tokensConsumed: number;
  /** `tokensSaved / (tokensSaved + tokensConsumed)`, in [0, 1]. 0 when both are 0. */
  percentSaved: number;
  /** Number of sivru.search calls observed. */
  searchCallCount: number;
  /** Sum of "chunks returned" across all calls. */
  chunksReturnedTotal: number;
  /** Sum of USD cost across priceable assistant turns. 0 when no priceable turns. */
  dollarsConsumed: number;
  /**
   * Estimated USD saved = tokensSaved * blendedRateUsd / 1e6.
   * `null` when no priceable turns exist (the table didn't recognize any model
   * the session used) — surface honestly rather than blending in a default.
   */
  dollarsSaved: number | null;
  /**
   * dollarsSaved / (dollarsSaved + dollarsConsumed). `null` when dollarsSaved
   * is null OR when the denominator is 0.
   */
  percentDollars: number | null;
  /**
   * Per-turn breakdown — one entry per assistant_message with usage info,
   * skipping turns without `tokensIn/tokensOut` AND without a fallback. The
   * UI uses this to render the inspector "tokens 4,210 · cost $0.012 · sonnet-4-6"
   * line per DESIGN.md §22.2.
   */
  turns: TurnCost[];
  /** Echo of the inputs that produced this estimate. */
  config: Required<
    Pick<SavingsOptions, "baselineFilesPerSearch" | "avgFileTokens" | "avgChunkTokens">
  >;
};

/** Per-turn cost entry, surfaced by `estimateSavings.turns`. See DESIGN.md §22.2. */
export type TurnCost = {
  /** index of the assistant_message event in the SivruEvent stream. */
  index: number;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  /** USD cost, null when model unknown. */
  usd: number | null;
};

/** Per-event aggregates the UI/CLI can render alongside the headline. */
export type EventSummary = {
  totalEvents: number;
  byKind: Record<string, number>;
  /** True when the session has at least one sivru.search call. Drives the W6 zero-search nudge. */
  hasSivruSearch: boolean;
};

type ResolvedConfig = {
  baselineFilesPerSearch: number;
  avgFileTokens: number;
  avgChunkTokens: number;
  searchToolNames: readonly string[];
};

function resolveConfig(options: SavingsOptions | undefined): ResolvedConfig {
  return {
    baselineFilesPerSearch:
      options?.baselineFilesPerSearch ?? DEFAULT_BASELINE_FILES_PER_SEARCH,
    avgFileTokens: options?.avgFileTokens ?? DEFAULT_AVG_FILE_TOKENS,
    avgChunkTokens: options?.avgChunkTokens ?? DEFAULT_AVG_CHUNK_TOKENS,
    searchToolNames: options?.searchToolNames ?? DEFAULT_SEARCH_TOOL_NAMES,
  };
}

function isAsyncIterable<T>(
  value: AsyncIterable<T> | Iterable<T>,
): value is AsyncIterable<T> {
  return typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function";
}

async function* toAsyncIterable<T>(
  value: AsyncIterable<T> | Iterable<T>,
): AsyncIterable<T> {
  if (isAsyncIterable(value)) {
    for await (const item of value) yield item;
    return;
  }
  for (const item of value) yield item;
}

/**
 * Approximate the chunk count from a tool_result `output` payload.
 *
 * Heuristics, in priority order:
 *   1. array → `output.length`
 *   2. `{ chunks: [...] }` → inner array length
 *   3. string with `^## ` markdown headers (W4 MCP server format) → header count
 *   4. fallback: 1
 */
function chunksReturnedFromOutput(output: unknown): number {
  if (Array.isArray(output)) return output.length;
  if (output !== null && typeof output === "object") {
    const inner = (output as { chunks?: unknown }).chunks;
    if (Array.isArray(inner)) return inner.length;
  }
  if (typeof output === "string") {
    // Count lines starting with `## ` — the W4 search MCP renders one per chunk.
    const matches = output.match(/^## /gm);
    if (matches && matches.length > 0) return matches.length;
  }
  return 1;
}

/**
 * Token cost of an assistant_message event. Prefers usage numbers carried on
 * the raw event (`tokensIn` + `tokensOut`, anywhere on the message object) and
 * falls back to a length-based estimate over `text`.
 */
function assistantTokens(event: SivruEvent): number {
  const usage = readUsageTokens(event.raw);
  if (usage !== null) return usage;
  if (typeof event.text === "string" && event.text.length > 0) {
    return Math.ceil(event.text.length / CHARS_PER_TOKEN);
  }
  return 0;
}

/**
 * Structured `{ tokensIn, tokensOut }` from a raw assistant message line, or
 * null when no usage numbers are present. Same source-of-truth as
 * `readUsageTokens` but preserves the in/out split required for pricing.
 */
function readUsageSplit(
  raw: unknown,
): { tokensIn: number; tokensOut: number } | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const directIn = numericField(obj, "tokensIn");
  const directOut = numericField(obj, "tokensOut");
  if (directIn !== null || directOut !== null) {
    return { tokensIn: directIn ?? 0, tokensOut: directOut ?? 0 };
  }

  const usage = nestedUsage(obj);
  if (usage !== null) {
    const u = usage as Record<string, unknown>;
    const inTokens =
      numericField(u, "input_tokens") ?? numericField(u, "inputTokens");
    const outTokens =
      numericField(u, "output_tokens") ?? numericField(u, "outputTokens");
    if (inTokens !== null || outTokens !== null) {
      return { tokensIn: inTokens ?? 0, tokensOut: outTokens ?? 0 };
    }
  }

  return null;
}

/**
 * Best-effort model id extraction from a raw assistant message. Claude Code
 * jsonl carries the model on `message.model`; some shapes put it at the top
 * level. Returns null when not present.
 */
function readModelId(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const top = obj["model"];
  if (typeof top === "string" && top.length > 0) return top;
  const message = obj["message"];
  if (message !== null && typeof message === "object") {
    const inner = (message as Record<string, unknown>)["model"];
    if (typeof inner === "string" && inner.length > 0) return inner;
  }
  return null;
}

/**
 * Best-effort extraction of `tokensIn + tokensOut` from a raw assistant message
 * line. Claude Code's jsonl carries usage under `message.usage.{input_tokens,
 * output_tokens}`; older shapes used `tokensIn` / `tokensOut`. We accept both.
 * Returns null when no usage numbers are present.
 */
function readUsageTokens(raw: unknown): number | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const directIn = numericField(obj, "tokensIn");
  const directOut = numericField(obj, "tokensOut");
  if (directIn !== null || directOut !== null) {
    return (directIn ?? 0) + (directOut ?? 0);
  }

  const usage = nestedUsage(obj);
  if (usage !== null) {
    const u = usage as Record<string, unknown>;
    const inTokens =
      numericField(u, "input_tokens") ?? numericField(u, "inputTokens");
    const outTokens =
      numericField(u, "output_tokens") ?? numericField(u, "outputTokens");
    if (inTokens !== null || outTokens !== null) {
      return (inTokens ?? 0) + (outTokens ?? 0);
    }
  }

  return null;
}

function numericField(
  obj: Record<string, unknown>,
  key: string,
): number | null {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nestedUsage(obj: Record<string, unknown>): unknown {
  const direct = obj["usage"];
  if (direct !== undefined && direct !== null && typeof direct === "object") {
    return direct;
  }
  const message = obj["message"];
  if (message !== null && typeof message === "object") {
    const inner = (message as Record<string, unknown>)["usage"];
    if (inner !== null && typeof inner === "object") return inner;
  }
  return null;
}

/** Run the counterfactual over a stream of events. */
export async function estimateSavings(
  events: AsyncIterable<SivruEvent> | Iterable<SivruEvent>,
  options?: SavingsOptions,
): Promise<SavingsEstimate> {
  const config = resolveConfig(options);
  const searchToolSet = new Set(config.searchToolNames);

  // We pair tool_use → next tool_result by stream order. A tool_use that
  // matched a search tool waits in `pendingSearch` until either:
  //   (a) the next tool_result arrives → use its chunk count, or
  //   (b) another search tool_use lands first → flush the prior with 0 chunks
  //       (the prior call was interrupted; it still counts as a baseline-vs-
  //       nothing save), or
  //   (c) the stream ends → flush remaining as 0 chunks.
  let pendingSearch = false;
  let searchCallCount = 0;
  let chunksReturnedTotal = 0;
  let tokensSaved = 0;
  let tokensConsumed = 0;
  const turns: TurnCost[] = [];

  const baselineTokensPerCall =
    config.baselineFilesPerSearch * config.avgFileTokens;

  function recordSearchCall(rawChunks: number): void {
    const chunks = Math.max(0, Math.min(rawChunks, config.baselineFilesPerSearch));
    const saved = baselineTokensPerCall - chunks * config.avgChunkTokens;
    tokensSaved += Math.max(0, saved);
    chunksReturnedTotal += chunks;
    searchCallCount += 1;
  }

  for await (const event of toAsyncIterable(events)) {
    if (event.kind === "assistant_message") {
      tokensConsumed += assistantTokens(event);
      const split = readUsageSplit(event.raw);
      if (split !== null) {
        const model = readModelId(event.raw);
        const cost = turnCostUsd({
          model: model ?? undefined,
          tokensIn: split.tokensIn,
          tokensOut: split.tokensOut,
        });
        turns.push({
          index: event.index,
          model,
          tokensIn: split.tokensIn,
          tokensOut: split.tokensOut,
          usd: cost === null ? null : cost.usd,
        });
      }
      continue;
    }
    if (event.kind === "tool_use") {
      if (pendingSearch) {
        // Previous search never got a tool_result. Treat as 0 chunks returned.
        recordSearchCall(0);
        pendingSearch = false;
      }
      if (typeof event.tool === "string" && searchToolSet.has(event.tool)) {
        pendingSearch = true;
      }
      continue;
    }
    if (event.kind === "tool_result") {
      if (pendingSearch) {
        const chunks = event.isError === true
          ? 0
          : chunksReturnedFromOutput(event.output);
        recordSearchCall(chunks);
        pendingSearch = false;
      }
      continue;
    }
  }

  if (pendingSearch) {
    recordSearchCall(0);
    pendingSearch = false;
  }

  const denom = tokensSaved + tokensConsumed;
  const percentSaved = denom > 0 ? tokensSaved / denom : 0;

  // Dollar layer (DESIGN.md §22.2). Sum priceable turn costs for consumed,
  // project saved via the volume-weighted blended rate over the same turns.
  let dollarsConsumed = 0;
  for (const turn of turns) {
    if (turn.usd !== null) dollarsConsumed += turn.usd;
  }
  const blendedRate = blendedRateUsdPerMTok(
    turns.map((t) => ({
      model: t.model ?? undefined,
      tokensIn: t.tokensIn,
      tokensOut: t.tokensOut,
    })),
  );
  const dollarsSaved =
    blendedRate === null ? null : (tokensSaved * blendedRate) / 1_000_000;
  let percentDollars: number | null;
  if (dollarsSaved === null) {
    percentDollars = null;
  } else {
    const dDenom = dollarsSaved + dollarsConsumed;
    percentDollars = dDenom > 0 ? dollarsSaved / dDenom : null;
  }

  return {
    tokensSaved,
    tokensConsumed,
    percentSaved,
    searchCallCount,
    chunksReturnedTotal,
    dollarsConsumed,
    dollarsSaved,
    percentDollars,
    turns,
    config: {
      baselineFilesPerSearch: config.baselineFilesPerSearch,
      avgFileTokens: config.avgFileTokens,
      avgChunkTokens: config.avgChunkTokens,
    },
  };
}

/** Lightweight aggregation for sidebar display. */
export async function summarizeEvents(
  events: AsyncIterable<SivruEvent> | Iterable<SivruEvent>,
): Promise<EventSummary> {
  const byKind: Record<string, number> = {};
  let totalEvents = 0;
  let hasSivruSearch = false;
  const searchToolSet = new Set<string>(DEFAULT_SEARCH_TOOL_NAMES);

  for await (const event of toAsyncIterable(events)) {
    totalEvents += 1;
    byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
    if (
      event.kind === "tool_use" &&
      typeof event.tool === "string" &&
      searchToolSet.has(event.tool)
    ) {
      hasSivruSearch = true;
    }
  }

  return { totalEvents, byKind, hasSivruSearch };
}
