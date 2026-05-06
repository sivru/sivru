import { useEffect, useMemo, useRef, useState } from "react";
import type { SivruEvent, TurnCost } from "../types";
import { formatTimestamp, isSivruSearchTool } from "../util";
import { KindBadge } from "./KindBadge";
import { SivruSearchView } from "./SivruSearchView";
import type { ProvenanceResult } from "../search-provenance";

type Props = {
  event: SivruEvent | null;
  totalEvents: number;
  /** Per-turn cost rows from the savings estimator, when known. */
  turns?: TurnCost[];
  /** sivru.search → consumer linking, computed once in App. */
  provenance: ProvenanceResult;
};

function formatTokens(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function findTurn(turns: TurnCost[] | undefined, eventIndex: number): TurnCost | null {
  if (turns === undefined) return null;
  for (const t of turns) {
    if (t.index === eventIndex) return t;
  }
  return null;
}

const TEXT_TRUNCATE_LIMIT = 10_000;
/** Hard cap for any pre-block content rendered in the inspector — applies
 *  to tool_use input, tool_result output, and the raw fallback. Without
 *  this, a Bash tool_result with megabytes of stdout (test runs that
 *  print thousands of lines) freezes the inspector pane. The "show raw"
 *  toggle still gives the user access to the full payload via JSON
 *  serialization, but the user has to opt in. */
const PRE_BLOCK_CAP = 50_000;

/**
 * Format an event payload for an inspector pre block, with an early-out
 * for already-string payloads. Critical for Bash tool_results: the output
 * is often a multi-megabyte string of stdout. JSON.stringifying that
 * before capping does megabytes of work + allocates a megabyte-sized
 * intermediate string that we then truncate. By short-circuiting on
 * `typeof === "string"` we slice the original buffer directly.
 */
function formatPreBlock(value: unknown): {
  text: string;
  truncated: number;
} {
  if (value === undefined) return { text: "undefined", truncated: 0 };
  if (typeof value === "string") {
    if (value.length <= PRE_BLOCK_CAP) return { text: value, truncated: 0 };
    return {
      text: value.slice(0, PRE_BLOCK_CAP),
      truncated: value.length - PRE_BLOCK_CAP,
    };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch {
    serialized = String(value);
  }
  if (serialized.length <= PRE_BLOCK_CAP) {
    return { text: serialized, truncated: 0 };
  }
  return {
    text: serialized.slice(0, PRE_BLOCK_CAP),
    truncated: serialized.length - PRE_BLOCK_CAP,
  };
}

function looksCodey(text: string): boolean {
  // Crude heuristic: lots of leading whitespace lines, fenced blocks, or
  // common code punctuation density. We use this to pick a monospace font
  // for what's almost certainly a code paste.
  if (/```/.test(text)) return true;
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return false;
  let indented = 0;
  for (const line of lines) {
    if (/^[\t ]{2,}/.test(line)) indented += 1;
  }
  return indented / lines.length > 0.3;
}

export function Inspector({ event, totalEvents, turns, provenance }: Props): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [expandText, setExpandText] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  // Reset internal toggles when the selected event changes, and pop scroll
  // back to the top so users don't land mid-blob on a fresh selection.
  useEffect(() => {
    setExpandText(false);
    setShowRaw(false);
    if (scrollRef.current !== null) scrollRef.current.scrollTop = 0;
  }, [event?.sessionId, event?.index]);

  const turnCost =
    event !== null && event.kind === "assistant_message"
      ? findTurn(turns, event.index)
      : null;

  if (event === null) {
    return (
      <div className="flex h-full flex-col">
        <div className="sticky top-0 z-10 flex h-9 shrink-0 items-center border-b border-sivru-border bg-sivru-panel px-3 text-xs uppercase tracking-wider text-sivru-mute">
          Inspector
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-sivru-mute">
          select an event to inspect
        </div>
      </div>
    );
  }

  const oneBased = event.index + 1;
  const total = totalEvents > 0 ? totalEvents : oneBased;

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-10 flex h-9 shrink-0 items-center gap-2 border-b border-sivru-border bg-sivru-panel px-3 text-xs">
        <KindBadge kind={event.kind} size="md" />
        <span className="font-mono text-[11px] text-sivru-mute">
          {oneBased}/{total}
        </span>
        <span className="ml-auto font-mono text-[11px] text-sivru-mute">
          {formatTimestamp(event.ts)}
        </span>
      </div>
      {turnCost !== null && (
        <div className="flex h-7 shrink-0 items-center gap-3 border-b border-sivru-border bg-sivru-panel/60 px-3 text-[11px]">
          <span className="text-sivru-mute">tokens</span>
          <span className="font-mono">
            {formatTokens(turnCost.tokensIn)} in
            <span className="text-sivru-mute"> · </span>
            {formatTokens(turnCost.tokensOut)} out
          </span>
          <span className="text-sivru-mute">·</span>
          <span className="text-sivru-mute">cost</span>
          <span className="font-mono text-sivru-amber">
            {turnCost.usd !== null ? formatUsd(turnCost.usd) : "$—"}
          </span>
          {turnCost.model !== null ? (
            <span className="ml-auto font-mono text-sivru-mute">
              {turnCost.model}
            </span>
          ) : (
            <span className="ml-auto font-mono text-sivru-mute italic">
              unknown model
            </span>
          )}
        </div>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <InspectorBody
          event={event}
          provenance={provenance}
          expandText={expandText}
          onExpandText={() => setExpandText(true)}
        />
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            className="text-[11px] uppercase tracking-wider text-sivru-mute hover:text-sivru-text"
          >
            {showRaw ? "hide raw" : "show raw"}
          </button>
          {showRaw && <RawPayload value={event.raw} />}
        </div>
      </div>
    </div>
  );
}

type BodyProps = {
  event: SivruEvent;
  provenance: ProvenanceResult;
  expandText: boolean;
  onExpandText: () => void;
};

function InspectorBody({ event, provenance, expandText, onExpandText }: BodyProps): JSX.Element {
  // sivru.search special-case: a custom view for both tool_use and tool_result
  // events that match the search tool. Falls through to the generic renderer
  // if for some reason `SivruSearchView` can't make sense of the payload —
  // its own internal fallback is a pre block.
  if (
    (event.kind === "tool_use" || event.kind === "tool_result") &&
    isSivruSearchTool(event.tool)
  ) {
    return <SivruSearchView event={event} provenance={provenance} />;
  }
  switch (event.kind) {
    case "user_message":
    case "assistant_message": {
      const full = event.text ?? "";
      const truncated =
        !expandText && full.length > TEXT_TRUNCATE_LIMIT
          ? full.slice(0, TEXT_TRUNCATE_LIMIT)
          : full;
      const mono = looksCodey(full);
      return (
        <div className="space-y-2">
          <SectionLabel>text</SectionLabel>
          <div
            className={
              "whitespace-pre-wrap break-words text-[12px] leading-relaxed " +
              (mono ? "font-mono" : "")
            }
          >
            {truncated.length === 0 ? (
              <span className="text-sivru-mute">(empty)</span>
            ) : (
              truncated
            )}
          </div>
          {!expandText && full.length > TEXT_TRUNCATE_LIMIT && (
            <button
              type="button"
              onClick={onExpandText}
              className="text-[11px] text-sivru-amber hover:underline"
            >
              [truncated, view raw]
            </button>
          )}
        </div>
      );
    }
    case "tool_use": {
      const capped = formatPreBlock(event.input ?? null);
      return (
        <div className="space-y-3">
          <SectionLabel>tool</SectionLabel>
          <div className="font-mono text-sm text-sivru-text">
            {event.tool ?? "(unknown)"}
          </div>
          <SectionLabel>input</SectionLabel>
          <pre className="overflow-auto whitespace-pre-wrap break-words rounded-sivru border border-sivru-border bg-sivru-panel p-2 font-mono text-[11px] text-sivru-text">
            {capped.text}
          </pre>
          {capped.truncated > 0 && (
            <TruncatedNotice charsHidden={capped.truncated} />
          )}
        </div>
      );
    }
    case "tool_result": {
      const errorBorder =
        event.isError === true
          ? "border-red-500/60 bg-red-950/20"
          : "border-sivru-border bg-sivru-panel";
      const capped = formatPreBlock(event.output ?? null);
      return (
        <div className="space-y-3">
          <SectionLabel>tool</SectionLabel>
          <div className="font-mono text-sm text-sivru-text">
            {event.tool ?? "(unknown)"}
            {event.isError === true && (
              <span className="ml-2 text-[11px] text-red-400">[error]</span>
            )}
          </div>
          <SectionLabel>output</SectionLabel>
          <pre
            className={
              "overflow-auto whitespace-pre-wrap break-words rounded-sivru border p-2 font-mono text-[11px] text-sivru-text " +
              errorBorder
            }
          >
            {capped.text}
          </pre>
          {capped.truncated > 0 && (
            <TruncatedNotice charsHidden={capped.truncated} />
          )}
        </div>
      );
    }
    case "system":
    case "unknown":
    default: {
      const capped = formatPreBlock(event.raw);
      return (
        <div className="space-y-2">
          <SectionLabel>raw</SectionLabel>
          <pre className="overflow-auto whitespace-pre-wrap break-words rounded-sivru border border-sivru-border bg-sivru-panel p-2 font-mono text-[11px] text-sivru-text">
            {capped.text}
          </pre>
          {capped.truncated > 0 && (
            <TruncatedNotice charsHidden={capped.truncated} />
          )}
        </div>
      );
    }
  }
}

/**
 * Renders the "show raw" toggle's pre-block. Memoized + value-keyed so we
 * only re-serialize the payload when the inspected event actually changes,
 * not on every parent render. Caps even the raw view via formatPreBlock —
 * the user has opted into "show me everything" but shouldn't get a frozen
 * panel for a megabyte-sized Bash output.
 */
function RawPayload({ value }: { value: unknown }): JSX.Element {
  const capped = useMemo(() => formatPreBlock(value), [value]);
  return (
    <>
      <pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-sivru border border-sivru-border bg-sivru-panel p-2 font-mono text-[11px] text-sivru-text">
        {capped.text}
      </pre>
      {capped.truncated > 0 && (
        <div className="mt-1">
          <TruncatedNotice charsHidden={capped.truncated} />
        </div>
      )}
    </>
  );
}

function TruncatedNotice({ charsHidden }: { charsHidden: number }): JSX.Element {
  const tokens = Math.round(charsHidden / 4);
  const formatted =
    tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
  return (
    <div
      className="rounded-sivru border border-sivru-border bg-sivru-panel/40 px-2 py-1 text-[11px] text-sivru-mute"
      title={`Inspector cap kicks in at 50k chars to keep the pane snappy. Use "show raw" below to dump the full payload as serialized JSON, or click into the source jsonl directly.`}
    >
      …{charsHidden.toLocaleString()} more chars truncated (~{formatted}{" "}
      tokens). Use the "show raw" toggle for the full payload.
    </div>
  );
}

function SectionLabel({ children }: { children: string }): JSX.Element {
  return (
    <div className="text-[10px] uppercase tracking-wider text-sivru-mute">
      {children}
    </div>
  );
}
