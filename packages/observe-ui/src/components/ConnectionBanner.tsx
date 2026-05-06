// Connection-lost banner (DESIGN.md §6.2 — UI ↔ observe-server).
// Shown when /api/health probe fails twice in a row. Includes a manual
// [Reconnect now] button that triggers an immediate retry — useful when
// the server was just restarted.

type Props = {
  onReconnect: () => void;
};

export function ConnectionBanner({ onReconnect }: Props): JSX.Element {
  return (
    <div
      role="alert"
      className="flex items-center gap-3 border-b border-red-900/60 bg-red-950/40 px-4 py-1.5 text-[11px]"
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-400"></span>
      <span className="text-red-200">
        Lost connection to <span className="font-mono">sivru observe</span>.
        Retrying…
      </span>
      <button
        type="button"
        onClick={onReconnect}
        className="ml-auto rounded-sivru border border-red-700 bg-red-900/30 px-2 py-0.5 font-mono text-[11px] text-red-100 hover:bg-red-900/60"
      >
        Reconnect now
      </button>
    </div>
  );
}
