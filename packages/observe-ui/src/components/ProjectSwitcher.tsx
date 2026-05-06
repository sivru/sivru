// Sticky project switcher at the top of the sidebar (DESIGN.md §6.1, Pass 1C).
//
// Reads the project list from the same /api/sessions response we already
// fetch — no extra round-trip. Click toggles a dropdown; click an option
// to filter the sidebar to that project. "All projects" sets filter=null.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "../types";
import { basenamePath, isLive } from "../util";

export type ProjectInfo = {
  /** Identity used for filtering sessions. Equal to projectRoot when in a git repo. */
  project: string;
  basename: string;
  sessionCount: number;
  /** Number of distinct worktrees of this project that have sessions. */
  worktreeCount: number;
  hasLive: boolean;
  /**
   * Number of sessions whose projectRoot is *inferred* (deleted worktree
   * matched by path-prefix to this verified root). Driving a small "?"
   * marker in the dropdown when > 0.
   */
  inferredCount: number;
};

type Props = {
  sessions: readonly Session[];
  /** Current project filter — null means "all projects". */
  selected: string | null;
  onSelect: (project: string | null) => void;
  /**
   * Whether to group `inferred-prefix` sessions under their inferred root.
   * False: each deleted worktree shows up as its own project entry.
   * Useful when the user wants raw, no-heuristic grouping.
   */
  groupInferred: boolean;
  onToggleGroupInferred: (next: boolean) => void;
};

/**
 * Effective project-root key for a session, given the user's grouping
 * preference. Sessions with projectRootSource === "inferred-prefix" can
 * be opted out of the inference (treated as their own group) by passing
 * groupInferred=false. Both `projectsFromSessions` and the SessionList
 * filter use this so the two stay consistent.
 */
export function effectiveProjectRoot(
  s: Pick<Session, "project" | "projectRoot" | "projectRootSource">,
  groupInferred: boolean,
): string {
  if (!groupInferred && s.projectRootSource === "inferred-prefix") {
    return s.project;
  }
  return s.projectRoot.length > 0 ? s.projectRoot : s.project;
}

/**
 * Group sessions into project rows. Uses `projectRoot` as the grouping key
 * (server resolves this from `git rev-parse --git-common-dir`), so multiple
 * worktrees of the same repo collapse to a single project entry. When
 * `groupInferred` is false, sessions whose root was *inferred* (deleted
 * worktree matched by path-prefix) are split back into their own entries.
 */
export function projectsFromSessions(
  sessions: readonly Session[],
  groupInferred = true,
): ProjectInfo[] {
  const map = new Map<string, ProjectInfo & { _worktrees: Set<string> }>();
  for (const s of sessions) {
    const key = effectiveProjectRoot(s, groupInferred);
    const existing = map.get(key);
    const live = isLive(s.updatedAt);
    // `inferredCount` counts only sessions where we DID apply inference —
    // when the user has the toggle off, no session is grouped via
    // inference, so the count stays 0.
    const inferred =
      groupInferred && s.projectRootSource === "inferred-prefix" ? 1 : 0;
    if (existing === undefined) {
      map.set(key, {
        project: key,
        basename: basenamePath(key),
        sessionCount: 1,
        worktreeCount: 1,
        hasLive: live,
        inferredCount: inferred,
        _worktrees: new Set([s.project]),
      });
    } else {
      existing.sessionCount += 1;
      existing.hasLive = existing.hasLive || live;
      existing.inferredCount += inferred;
      existing._worktrees.add(s.project);
      existing.worktreeCount = existing._worktrees.size;
    }
  }
  return Array.from(map.values())
    .map(({ _worktrees: _, ...rest }) => rest)
    .sort((a, b) => {
      if (a.hasLive !== b.hasLive) return a.hasLive ? -1 : 1;
      if (a.sessionCount !== b.sessionCount) return b.sessionCount - a.sessionCount;
      return a.basename.localeCompare(b.basename);
    });
}

export function ProjectSwitcher({
  sessions,
  selected,
  onSelect,
  groupInferred,
  onToggleGroupInferred,
}: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (containerRef.current === null) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Memoize the heavy derivations — projectsFromSessions + the inferable
  // count both walk all sessions. Without these, the dropdown renders
  // on every parent App render (which fires on every SSE batch flush
  // during live tail), even though `sessions` hasn't changed.
  const projects = useMemo(
    () => projectsFromSessions(sessions, groupInferred),
    [sessions, groupInferred],
  );
  const inferableCount = useMemo(
    () =>
      sessions.filter((s) => s.projectRootSource === "inferred-prefix").length,
    [sessions],
  );
  const currentLabel =
    selected === null
      ? "all projects"
      : (projects.find((p) => p.project === selected)?.basename ?? basenamePath(selected));
  const currentSessionCount =
    selected === null
      ? sessions.length
      : (projects.find((p) => p.project === selected)?.sessionCount ?? 0);

  return (
    <div
      ref={containerRef}
      className="relative border-b border-sivru-border bg-sivru-panel"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-sivru-panel/80"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="text-sivru-amber">sivru</span>
        <span className="text-sivru-mute">/</span>
        <span className="min-w-0 flex-1 truncate text-sivru-text">
          {currentLabel}
        </span>
        <span className="font-mono text-[10px] text-sivru-mute">
          {currentSessionCount}
        </span>
        <span
          className={
            "select-none font-mono text-sivru-mute transition-transform " +
            (open ? "rotate-180" : "")
          }
          aria-hidden
        >
          ▾
        </span>
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 top-full z-30 max-h-72 overflow-y-auto border border-sivru-border bg-sivru-panel shadow-lg"
          role="listbox"
        >
          {/* Inferred-grouping toggle: only render when there are sessions
              that COULD be inferred. Hidden completely when no signal exists
              so it doesn't add noise to clean setups. */}
          {inferableCount > 0 && (
            <div className="flex items-center gap-2 border-b border-sivru-border bg-sivru-panel/60 px-3 py-2 text-[11px]">
              <input
                id="group-inferred-toggle"
                type="checkbox"
                checked={groupInferred}
                onChange={(e) => onToggleGroupInferred(e.target.checked)}
                className="h-3 w-3 cursor-pointer accent-sivru-amber"
              />
              <label
                htmlFor="group-inferred-toggle"
                className="cursor-pointer flex-1 text-sivru-text"
              >
                Group {inferableCount} inferred worktree
                {inferableCount === 1 ? "" : "s"}
              </label>
              <span
                className="select-none font-mono text-[10px] text-sivru-mute"
                title="When ON, sessions whose worktree dir was deleted but whose path matches an existing repo are grouped under that repo. When OFF, each shows as its own project entry."
              >
                ⓘ
              </span>
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              onSelect(null);
              setOpen(false);
            }}
            className={
              "flex w-full items-center gap-2 border-b border-sivru-border/60 px-3 py-1.5 text-left text-[11px] " +
              (selected === null
                ? "bg-sivru-amber/15 text-sivru-amber"
                : "text-sivru-text hover:bg-sivru-panel/40")
            }
            role="option"
            aria-selected={selected === null}
          >
            <span className="flex-1">all projects</span>
            <span className="font-mono text-[10px] text-sivru-mute">
              {sessions.length}
            </span>
          </button>
          {projects.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-sivru-mute">
              no projects yet
            </div>
          ) : (
            projects.map((p) => (
              <button
                key={p.project}
                type="button"
                onClick={() => {
                  onSelect(p.project);
                  setOpen(false);
                }}
                className={
                  "flex w-full items-center gap-2 border-b border-sivru-border/60 px-3 py-1.5 text-left text-[11px] " +
                  (selected === p.project
                    ? "bg-sivru-amber/15 text-sivru-amber"
                    : "text-sivru-text hover:bg-sivru-panel/40")
                }
                role="option"
                aria-selected={selected === p.project}
                title={p.project}
              >
                {p.hasLive && (
                  <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
                    <span className="absolute inset-0 animate-ping rounded-full bg-sivru-amber opacity-50"></span>
                    <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-sivru-amber"></span>
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{p.basename}</span>
                {p.inferredCount > 0 && (
                  <span
                    className="font-mono text-[10px] text-sivru-mute"
                    title={`${p.inferredCount} session${p.inferredCount === 1 ? "" : "s"} grouped here by path-prefix match (their worktree dir was deleted) — confidence is best-effort, not git-verified`}
                  >
                    +{p.inferredCount}?
                  </span>
                )}
                {p.worktreeCount > 1 && (
                  <span
                    className="font-mono text-[10px] text-sivru-mute"
                    title={`${p.worktreeCount} worktrees`}
                  >
                    {p.worktreeCount}wt
                  </span>
                )}
                <span className="font-mono text-[10px] text-sivru-mute">
                  {p.sessionCount}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
