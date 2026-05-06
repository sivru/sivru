import { memo, useCallback, useMemo } from "react";
import type { Session } from "../types";
import { basenamePath, isLive } from "../util";
import { ProjectSwitcher, effectiveProjectRoot } from "./ProjectSwitcher";

type LoadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

type Props = {
  state: LoadState<Session[]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  selectedProject: string | null;
  onSelectProject: (project: string | null) => void;
  groupInferred: boolean;
  onToggleGroupInferred: (next: boolean) => void;
};

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function formatTs(ts: string | null): string {
  if (ts === null) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function SessionList({
  state,
  selectedId,
  onSelect,
  selectedProject,
  onSelectProject,
  groupInferred,
  onToggleGroupInferred,
}: Props): JSX.Element {
  const sessions = state.status === "ready" ? state.data : [];
  // Filtering uses the SAME effective root as the dropdown so the two stay
  // consistent when the toggle changes. Memoized — sidebar re-renders on
  // every App render, but `sessions` only changes when /api/sessions
  // returns a new payload.
  const filtered = useMemo(
    () =>
      selectedProject === null
        ? sessions
        : sessions.filter(
            (s) => effectiveProjectRoot(s, groupInferred) === selectedProject,
          ),
    [sessions, selectedProject, groupInferred],
  );

  return (
    <div className="flex h-full flex-col">
      <ProjectSwitcher
        sessions={sessions}
        selected={selectedProject}
        onSelect={onSelectProject}
        groupInferred={groupInferred}
        onToggleGroupInferred={onToggleGroupInferred}
      />
      <div className="sticky top-0 z-10 flex h-9 shrink-0 items-center justify-between border-b border-sivru-border bg-sivru-panel px-3 text-xs uppercase tracking-wider text-sivru-mute">
        <span>Sessions</span>
        {state.status === "ready" && (
          <span className="font-mono text-[10px] normal-case tracking-normal">
            {filtered.length}
            {selectedProject !== null && filtered.length !== sessions.length
              ? `/${sessions.length}`
              : ""}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.status === "loading" && (
          <div className="px-3 py-2 text-xs text-sivru-mute">loading…</div>
        )}
        {state.status === "error" && (
          <div className="px-3 py-2 text-xs text-red-400">
            couldn't reach the observe server at /api — is{" "}
            <span className="font-mono">sivru observe</span> running?
          </div>
        )}
        {state.status === "ready" && filtered.length === 0 && (
          <div className="px-3 py-2 text-xs text-sivru-mute">
            {selectedProject === null
              ? "no sessions yet"
              : "no sessions in this project"}
          </div>
        )}
        {state.status === "ready" &&
          filtered.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              isSelected={s.id === selectedId}
              onSelect={onSelect}
            />
          ))}
      </div>
    </div>
  );
}

// Memoized row — sidebar has up to ~150 sessions × N re-renders per second
// during live tail. Without memo, every App re-render redoes 150 row
// renders even though selection rarely changes. With memo, only the
// previously-selected row + the newly-selected row reconcile when the
// user clicks a different session.
type SessionRowProps = {
  session: Session;
  isSelected: boolean;
  onSelect: (id: string) => void;
};

const SessionRow = memo(function SessionRowInner({
  session: s,
  isSelected,
  onSelect,
}: SessionRowProps): JSX.Element {
  const handleClick = useCallback(() => onSelect(s.id), [onSelect, s.id]);
  const live = isLive(s.updatedAt);
  const selectedCls = isSelected
    ? "bg-sivru-amber/15 border-l-2 border-sivru-amber pl-[10px]"
    : "border-l-2 border-transparent pl-[10px] hover:bg-sivru-panel";
  return (
    <button
      type="button"
      onClick={handleClick}
      className={
        "flex w-full flex-col gap-0.5 border-b border-sivru-border pr-3 py-2 text-left text-xs transition-colors text-sivru-text " +
        selectedCls
      }
    >
      <div className="flex items-center gap-2">
        {live ? (
          <span className="relative inline-flex h-1.5 w-1.5">
            <span className="absolute inset-0 animate-ping rounded-full bg-sivru-amber opacity-50"></span>
            <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-sivru-amber"></span>
          </span>
        ) : (
          <span
            className={
              "inline-block h-1.5 w-1.5 rounded-full " +
              (isSelected ? "bg-sivru-amber" : "bg-sivru-mute")
            }
          />
        )}
        <span className="font-mono text-[11px]">{shortId(s.id)}</span>
        <span className="ml-auto text-[10px] text-sivru-mute">
          {formatTs(s.updatedAt)}
        </span>
      </div>
      <div className="truncate text-[11px] text-sivru-mute">
        {basenamePath(s.projectRoot.length > 0 ? s.projectRoot : s.project)}
      </div>
      <div className="flex items-center gap-2 text-[10px] text-sivru-mute">
        <span>
          {s.eventCount} event{s.eventCount === 1 ? "" : "s"}
        </span>
        {(s.branch !== null || s.isWorktree) && (
          <>
            <span>·</span>
            <span
              className="truncate font-mono"
              title={
                s.projectRootSource === "inferred-prefix"
                  ? `inferred worktree at ${s.project} (the dir is gone; grouped by path-prefix match)`
                  : s.isWorktree
                    ? `worktree at ${s.project}`
                    : "main checkout"
              }
            >
              {s.isWorktree && <span className="text-sivru-amber/70">⎇ </span>}
              {s.branch ?? "—"}
              {s.projectRootSource === "inferred-prefix" && (
                <span className="ml-1 text-sivru-mute/60">?</span>
              )}
            </span>
          </>
        )}
      </div>
    </button>
  );
});
