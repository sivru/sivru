// DESIGN-0021 slot 1 — diagnostic triage inbox (the DEFAULT Blocks sub-view).
//
// Lists every diagnostic the graph + drift checks emit, grouped by code,
// sorted error-before-warning. Each row: severity glyph · code · file:line ·
// title, with hover actions: Open in editor (vscode://) + Copy CLI fix. No
// write actions in slot 1 (Fix / Acknowledge / Mark-FP land in slot 2 behind
// --writable).

import { useMemo, useState } from "react";

import type { BlockDiagnostic } from "../api";

export type BlockTriageInboxProps = {
  diagnostics: BlockDiagnostic[];
  /** Currently-selected node name (for highlighting the matching rows). */
  selectedNode: string | null;
  /** Resolve a node name from a diagnostic location so a click can select it. */
  nodeNameAt: (filePath: string, line: number) => string | null;
  onSelectNode: (name: string | null) => void;
  /** Filter text from the toolbar (matches code / file / message). */
  filter: string;
};

const SEVERITY_RANK: Record<string, number> = { error: 0, warning: 1, info: 2 };

function rankOf(severity: string): number {
  return SEVERITY_RANK[severity] ?? 9;
}

export type DiagnosticGroup = { code: string; severity: string; diagnostics: BlockDiagnostic[] };

/** Group diagnostics by code; order groups by worst severity then code. */
export function groupDiagnostics(diagnostics: BlockDiagnostic[]): DiagnosticGroup[] {
  const byCode = new Map<string, BlockDiagnostic[]>();
  for (const d of diagnostics) {
    const arr = byCode.get(d.code) ?? [];
    arr.push(d);
    byCode.set(d.code, arr);
  }
  const groups: DiagnosticGroup[] = [];
  for (const [code, diags] of byCode) {
    // Worst severity in the group drives its sort rank + header glyph.
    const worst = diags.reduce(
      (acc, d) => (rankOf(d.severity) < rankOf(acc) ? d.severity : acc),
      "info",
    );
    groups.push({ code, severity: worst, diagnostics: diags });
  }
  groups.sort((a, b) => {
    const s = rankOf(a.severity) - rankOf(b.severity);
    return s !== 0 ? s : a.code.localeCompare(b.code);
  });
  return groups;
}

/**
 * The exact `sivru` command that surfaces or fixes a diagnostic, per the
 * DESIGN-0021 §"Copy CLI button mapping" table. Lives UI-side in slot 1; slot
 * 2 moves it into the shared block-handler module so HTTP + MCP return the
 * same string.
 */
export function cliForDiagnostic(code: string, filePath: string): string {
  const m = /E(\d+)/.exec(code);
  const num = m !== null ? Number.parseInt(m[1]!, 10) : 0;
  const f = filePath.length > 0 ? ` ${filePath}` : "";
  if (num >= 230 && num <= 232) return `sivru block validate${f}`;
  if (num === 233) return `sivru block staleness --since=origin/main`;
  if (num === 234) return `sivru block graph --check${f}`;
  if (num === 235) return `sivru block graph --check --strict${f}`;
  if (num === 236) return `sivru block graph --check${f}`;
  if (num === 237 || num === 238) return `sivru block validate --autofix${f}`;
  if (num >= 220 && num <= 229) return `sivru block check${f}`;
  return `sivru block validate${f}`;
}

function severityGlyph(severity: string): JSX.Element {
  if (severity === "error") {
    return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-sivru-error" aria-hidden />;
  }
  if (severity === "warning") {
    return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-sivru-warn" aria-hidden />;
  }
  return (
    <span className="inline-block h-2 w-2 shrink-0 rounded-full border border-sivru-mute" aria-hidden />
  );
}

function matchesFilter(d: BlockDiagnostic, q: string): boolean {
  if (q.length === 0) return true;
  const hay = `${d.code} ${d.location?.filePath ?? ""} ${d.message}`.toLowerCase();
  return hay.includes(q);
}

export function BlockTriageInbox({
  diagnostics,
  selectedNode,
  nodeNameAt,
  onSelectNode,
  filter,
}: BlockTriageInboxProps): JSX.Element {
  const q = filter.trim().toLowerCase();
  const filtered = useMemo(
    () => diagnostics.filter((d) => matchesFilter(d, q)),
    [diagnostics, q],
  );
  const groups = useMemo(() => groupDiagnostics(filtered), [filtered]);

  if (diagnostics.length === 0) {
    return (
      <div className="p-6 text-sm text-sivru-mute" role="status">
        No active diagnostics.
      </div>
    );
  }
  if (filtered.length === 0) {
    return (
      <div className="p-6 text-sm text-sivru-mute" role="status">
        No diagnostics match “{filter}”.
      </div>
    );
  }

  return (
    <div role="list" className="flex flex-col">
      {groups.map((g) => (
        <div key={g.code} role="group" aria-label={g.code}>
          <div className="sticky top-0 flex items-center gap-2 border-b border-sivru-border bg-sivru-panel px-3 py-1.5 text-xs">
            {severityGlyph(g.severity)}
            <span className="font-mono text-sivru-text">{g.code}</span>
            <span className="text-sivru-mute">{g.diagnostics.length}</span>
          </div>
          {g.diagnostics.map((d, i) => (
            <DiagnosticRow
              key={`${g.code}-${d.location?.filePath ?? ""}-${d.location?.startLine ?? i}-${i}`}
              d={d}
              selectedNode={selectedNode}
              nodeNameAt={nodeNameAt}
              onSelectNode={onSelectNode}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function DiagnosticRow({
  d,
  selectedNode,
  nodeNameAt,
  onSelectNode,
}: {
  d: BlockDiagnostic;
  selectedNode: string | null;
  nodeNameAt: (filePath: string, line: number) => string | null;
  onSelectNode: (name: string | null) => void;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const loc = d.location;
  const file = loc?.filePath ?? "";
  const line = loc?.startLine ?? 0;
  const owningNode = loc !== undefined ? nodeNameAt(file, line) : null;
  const isSel = owningNode !== null && owningNode === selectedNode;
  const shortFile = file.length > 0 ? file.split("/").slice(-2).join("/") : "(repo)";

  const onCopy = (): void => {
    const cmd = cliForDiagnostic(d.code, file);
    if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
      void navigator.clipboard.writeText(cmd).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        },
        () => {},
      );
    }
  };

  const editorUrl = file.length > 0 ? `vscode://file/${file}:${line}` : undefined;

  return (
    <div
      role="listitem"
      onClick={() => onSelectNode(owningNode)}
      className={
        "group flex items-center gap-2 border-b border-sivru-border/50 px-3 py-1.5 text-[13px] " +
        (isSel ? "bg-sivru-amber/10" : "hover:bg-sivru-panel/50") +
        (owningNode !== null ? " cursor-pointer" : "")
      }
    >
      {severityGlyph(d.severity)}
      <span className="font-mono text-xs text-sivru-mute">{d.code}</span>
      <span className="truncate font-mono text-xs text-sivru-mute" title={`${file}:${line}`}>
        {shortFile}
        {line > 0 ? `:${line}` : ""}
      </span>
      <span className="min-w-0 flex-1 truncate text-sivru-text" title={d.message}>
        {d.message}
      </span>
      <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {editorUrl !== undefined && (
          <a
            href={editorUrl}
            onClick={(e) => e.stopPropagation()}
            className="rounded-sivru border border-sivru-border px-1.5 py-0.5 text-[11px] text-sivru-mute hover:text-sivru-text"
            title="Open in editor"
          >
            Open
          </a>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCopy();
          }}
          className="rounded-sivru border border-sivru-border px-1.5 py-0.5 text-[11px] text-sivru-mute hover:text-sivru-text"
          title="Copy the sivru CLI command that surfaces or fixes this"
        >
          {copied ? "Copied" : "Copy CLI"}
        </button>
      </span>
    </div>
  );
}
