// First-run empty state (DESIGN.md §6.2). Three checklist rows:
//   ✓  sivru installed                    — always green if we're rendering
//   …  hooks / MCP wired up                — heuristic; we link to docs
//   …  start a Claude Code session         — instructive
//
// Replaces the bare "no sessions yet" string when the API returns 0 sessions.

import type { HealthResponse } from "../api";

type Props = {
  health: HealthResponse | null;
};

const HOWTO_URL = "https://github.com/sivru/sivru#hook-into-claude-code";
const REPO_URL = "https://github.com/sivru/sivru";

export function SetupChecklist({ health }: Props): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center px-4 py-8">
      <div className="w-[480px] max-w-full rounded-sivru border border-sivru-border bg-sivru-panel/40 p-6">
        <div className="mb-4 flex items-center gap-2">
          <span className="text-sm font-semibold text-sivru-amber">sivru</span>
          <span className="text-sm text-sivru-mute">/</span>
          <span className="text-sm">setup</span>
        </div>

        <ol className="space-y-3 text-[12px]">
          <ChecklistRow
            done
            label={
              <>
                <span className="font-mono">sivru</span> installed
              </>
            }
            detail={
              health !== null ? (
                <span className="font-mono text-[11px]">v{health.version}</span>
              ) : null
            }
          />
          <ChecklistRow
            done={false}
            label={
              <>
                Register the MCP server with Claude Code
              </>
            }
            detail={
              <code className="block break-all rounded-sivru border border-sivru-border bg-sivru-bg px-2 py-1 font-mono text-[10px] text-sivru-text">
                sivru observe init
              </code>
            }
          />
          <ChecklistRow
            done={false}
            label={
              <>Open Claude Code in a project and run a turn</>
            }
            detail={
              <span className="text-[11px] text-sivru-mute">
                Sessions show up here in real time as you go.
              </span>
            }
          />
        </ol>

        <div className="mt-6 flex items-center gap-3 text-[11px]">
          <a
            href={HOWTO_URL}
            target="_blank"
            rel="noopener"
            className="text-sivru-amber hover:underline"
          >
            How-to →
          </a>
          <span className="text-sivru-mute">·</span>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener"
            className="text-sivru-mute hover:text-sivru-text"
          >
            github.com/sivru/sivru
          </a>
        </div>
      </div>
    </div>
  );
}

function ChecklistRow({
  done,
  label,
  detail,
}: {
  done: boolean;
  label: React.ReactNode;
  detail?: React.ReactNode;
}): JSX.Element {
  return (
    <li className="flex items-start gap-3">
      <span
        className={
          "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border " +
          (done
            ? "border-sivru-amber bg-sivru-amber/10 text-sivru-amber"
            : "border-sivru-mute text-sivru-mute")
        }
        aria-hidden
      >
        {done ? "✓" : "·"}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="text-sivru-text">{label}</div>
        {detail !== undefined && detail !== null && (
          <div>{detail}</div>
        )}
      </div>
    </li>
  );
}
