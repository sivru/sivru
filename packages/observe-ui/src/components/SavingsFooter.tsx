import type { SessionSavings } from "../types";

type Props = {
  savings: SessionSavings | null;
  loading: boolean;
};

function formatTokens(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

/** One-line footer that sits below the events feed. Drives the §20.1 + §22.2 numbers. */
export function SavingsFooter({ savings, loading }: Props): JSX.Element | null {
  if (loading || savings === null) return null;
  const {
    tokensSaved,
    tokensConsumed,
    percentSaved,
    searchCallCount,
    dollarsConsumed,
    dollarsSaved,
    percentDollars,
  } = savings;
  const sign = tokensSaved >= 0 ? "+" : "";

  // When the session has no sivru.search calls there's nothing to estimate;
  // the parent shows the zero-search nudge instead of this footer.
  if (searchCallCount === 0) return null;

  return (
    <div className="flex h-8 shrink-0 items-center gap-4 border-t border-sivru-border bg-sivru-panel px-4 text-xs text-sivru-text">
      <span>
        <span className="text-sivru-mute">tokens</span>{" "}
        <span className="font-mono">{formatTokens(tokensConsumed)} used</span>
        <span className="text-sivru-mute"> · </span>
        <span
          className={`font-mono ${tokensSaved > 0 ? "text-sivru-amber" : "text-sivru-mute"}`}
        >
          {sign}
          {formatTokens(tokensSaved)} saved
        </span>
        <span className="text-sivru-mute">
          {" "}
          ({(percentSaved * 100).toFixed(1)}%)
        </span>
      </span>
      <span className="text-sivru-mute">·</span>
      <span>
        <span className="text-sivru-mute">$</span>{" "}
        <span className="font-mono">{formatUsd(dollarsConsumed)} used</span>
        {dollarsSaved !== null && (
          <>
            <span className="text-sivru-mute"> · </span>
            <span
              className={`font-mono ${dollarsSaved > 0 ? "text-sivru-amber" : "text-sivru-mute"}`}
            >
              {sign}
              {formatUsd(dollarsSaved)} saved
            </span>
            {percentDollars !== null && (
              <span className="text-sivru-mute">
                {" "}
                ({(percentDollars * 100).toFixed(1)}%)
              </span>
            )}
          </>
        )}
        {dollarsSaved === null && (
          <span className="text-sivru-mute"> · saved $— (unknown model)</span>
        )}
      </span>
      <span className="ml-auto text-sivru-mute">
        {searchCallCount} sivru.search call{searchCallCount === 1 ? "" : "s"}
      </span>
    </div>
  );
}
