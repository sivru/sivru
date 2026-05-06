// Inspector special-case for sivru.search events (DESIGN.md §6.1).
//
// Renders the value-prop inspector view:
//   line 1:  "<query>"  ·  hybrid|bm25  ·  N.N ms  ·  K results
//   then for each result chunk:
//     ① path:line_start-line_end  ·  score   <-- amber mono header
//     <preview text>                          <-- 3-4 line code preview
//
// Falls back to a generic "result will appear" hint if the data shape
// doesn't match what we expect.

import type { SivruEvent } from "../types";
import { truncate } from "../util";
import {
  getHits,
  parseSearchInput,
  parseSearchOutput,
  type SearchHit,
} from "../sivru-search";
import type { ProvenanceResult } from "../search-provenance";

type Props = {
  event: SivruEvent;
  /**
   * Search → consumer linking, computed once in App. Used to mark which
   * chunks the agent actually read/edited downstream — the proof-of-utility
   * marker on the inspector view.
   */
  provenance: ProvenanceResult;
};

/**
 * For a tool_result event, find the matching tool_use's event index by
 * scanning the provenance map's known search events. The closest one
 * with index < event.index is the search this result belongs to.
 *
 * KNOWN LIMITATION (intentional): we only enumerate searches that HAD
 * downstream consumers (the keys of `consumersBySearch`). For a search
 * that returned zero useful results — none of its files were touched
 * downstream — this returns null and the inspector skips the "used by N"
 * line entirely. That's the correct UX: there's no "0 used" badge to
 * show because the proof-of-utility metric only matters when there's
 * something to count. If we ever want to render "0 used" explicitly,
 * compute provenance entries even for empty searches and key the maps
 * by tool_use index unconditionally.
 */
function findSearchEventIndexFor(
  event: SivruEvent,
  provenance: ProvenanceResult,
): number | null {
  let best: number | null = null;
  for (const searchIdx of provenance.consumersBySearch.keys()) {
    if (searchIdx < event.index && (best === null || searchIdx > best)) {
      best = searchIdx;
    }
  }
  return best;
}

function circledNumber(n: number): string {
  // Real circled digits 1-20; fall back to (N) past that.
  const map = [
    "①", "②", "③", "④", "⑤",
    "⑥", "⑦", "⑧", "⑨", "⑩",
    "⑪", "⑫", "⑬", "⑭", "⑮",
    "⑯", "⑰", "⑱", "⑲", "⑳",
  ];
  return map[n - 1] ?? `(${n})`;
}

function previewLines(hit: SearchHit, maxLines = 4): string[] {
  const text = hit.preview ?? hit.text ?? "";
  if (text.length === 0) return [];
  const lines = text.split("\n");
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
  return lines.slice(0, maxLines);
}

export function SivruSearchView({ event, provenance }: Props): JSX.Element {
  const isToolUse = event.kind === "tool_use";
  const input = isToolUse
    ? parseSearchInput(event.input)
    : parseSearchInput((event.raw as { input?: unknown })?.input ?? null);
  const output = parseSearchOutput(event.output);
  const hits = getHits(output);
  const mode = output?.mode ?? (input?.hybrid === false ? "bm25" : "hybrid");
  const query = output?.query ?? input?.query ?? "(unknown query)";
  const top = input?.top;
  const latency = output?.latencyMs ?? null;

  // Resolve which sivru.search tool_use this event corresponds to. For
  // tool_use itself: that's just `event.index`. For tool_result: the
  // immediately preceding tool_use (provenance is keyed by tool_use index,
  // not tool_result, so we have to look it up via the consumersBySearch
  // map whose keys ARE tool_use indices).
  const searchEventIndex = isToolUse
    ? event.index
    : findSearchEventIndexFor(event, provenance);
  const usedChunks =
    searchEventIndex !== null
      ? (provenance.usedChunksBySearch.get(searchEventIndex) ?? new Set())
      : new Set<number>();
  const consumerCount =
    searchEventIndex !== null
      ? (provenance.consumersBySearch.get(searchEventIndex)?.length ?? 0)
      : 0;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-sivru-amber">
          sivru.search
        </div>
        <div className="font-mono text-[13px] text-sivru-text">
          <span className="text-sivru-mute">"</span>
          <span>{query}</span>
          <span className="text-sivru-mute">"</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-sivru-mute">
          <span>{mode}</span>
          {latency !== null && (
            <>
              <span>·</span>
              <span>{latency.toFixed(1)} ms</span>
            </>
          )}
          {top !== undefined && (
            <>
              <span>·</span>
              <span>top={top}</span>
            </>
          )}
          <span>·</span>
          <span className="text-sivru-amber">
            {hits.length} result{hits.length === 1 ? "" : "s"}
          </span>
          {consumerCount > 0 && (
            <>
              <span>·</span>
              <span
                className="text-sivru-amber"
                title="Downstream events that touched a file from this search"
              >
                used by {consumerCount}
              </span>
            </>
          )}
        </div>
      </div>

      {isToolUse && hits.length === 0 && (
        <div className="rounded-sivru border border-sivru-border bg-sivru-panel/40 p-3 text-[12px] text-sivru-mute">
          Result will appear when the matching{" "}
          <span className="font-mono">tool_result</span> event arrives.
        </div>
      )}

      {!isToolUse && hits.length === 0 && (
        <div className="rounded-sivru border border-sivru-border bg-sivru-panel/40 p-3 text-[12px] text-sivru-mute">
          <div>No chunks scored above the BM25 threshold.</div>
          <div className="mt-1 text-[11px]">
            The agent might already have tried a more specific query — check
            the next event.
          </div>
        </div>
      )}

      {hits.length > 0 && (
        <div className="space-y-3">
          {hits.map((hit, i) => {
            const lineRange =
              hit.startLine !== undefined && hit.endLine !== undefined
                ? `${hit.startLine}-${hit.endLine}`
                : "";
            const score =
              typeof hit.score === "number" ? hit.score.toFixed(3) : "";
            const lines = previewLines(hit);
            const startLine = hit.startLine ?? 1;
            const wasUsed = usedChunks.has(i);
            return (
              <div
                key={`${hit.filePath}-${i}`}
                className={
                  "rounded-sivru border bg-sivru-panel/30 " +
                  (wasUsed
                    ? "border-sivru-amber/60"
                    : "border-sivru-border")
                }
              >
                <div className="flex flex-wrap items-baseline gap-2 border-b border-sivru-border/60 px-2 py-1.5 font-mono text-[11px]">
                  <span className="text-sivru-amber">{circledNumber(i + 1)}</span>
                  <span className="break-all text-sivru-amber">
                    {hit.filePath}
                    {lineRange !== "" && (
                      <span className="text-sivru-amber/70">:{lineRange}</span>
                    )}
                  </span>
                  {score !== "" && (
                    <>
                      <span className="text-sivru-mute">·</span>
                      <span className="text-sivru-mute">{score}</span>
                    </>
                  )}
                  {wasUsed && (
                    <span
                      className="ml-1 rounded border border-sivru-amber/40 bg-sivru-amber/10 px-1 py-px text-[10px] text-sivru-amber"
                      title="The agent read or edited this file downstream — this chunk paid off"
                    >
                      ✓ used
                    </span>
                  )}
                  {hit.source !== undefined && (
                    <span className="ml-auto rounded border border-sivru-border bg-sivru-panel px-1 py-px text-[10px] text-sivru-mute">
                      {hit.source}
                    </span>
                  )}
                </div>
                {lines.length > 0 && (
                  <div className="px-2 py-1.5">
                    <pre className="overflow-hidden whitespace-pre font-mono text-[11px] leading-relaxed text-sivru-text">
                      {lines.map((line, li) => (
                        <div key={li} className="flex">
                          <span
                            className="w-8 shrink-0 select-none pr-2 text-right text-sivru-mute/70"
                            aria-hidden
                          >
                            {startLine + li}
                          </span>
                          <span className="min-w-0 flex-1">
                            {truncate(line, 200)}
                          </span>
                        </div>
                      ))}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
