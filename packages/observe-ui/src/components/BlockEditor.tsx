// DESIGN-0021 slot 2 — form-based block editor.
//
// Renders a block's YAML schema as a typed form (collapsible groups), not a raw
// textarea — the whole reason E237/E238 exist is that raw YAML editing in a
// comment fence is error-prone. The form serializes to a server-shaped
// SivruBlock and POSTs it; the server validates + rewrites the fence in place.
// A dirty-state pill + pinned save bar mirror DESIGN-0021 §"The block editor";
// a 409 (FILE-CHANGED) shows a conflict banner with a Reload action.
//
// Decisions are preserved as-authored (passed through unchanged) in v1 — the
// editable surface is role / responsibility / maturity / collaborators /
// invariants, which covers the slot-2 acceptance (bump maturity via the form).

import { useEffect, useMemo, useState } from "react";

import { postBlockEdit } from "../api";
import type { BlockMutationResult, BlockNodeDetail, SivruBlockJSON } from "../api";

const MATURITY_OPTIONS = ["experimental", "stable", "deprecated"];

type FormState = {
  role: string;
  responsibility: string;
  maturity: string;
  collaborators: string; // comma-separated
  invariants: string; // one per line, "rule :: enforced-by" (enforced-by optional)
};

function toForm(b: SivruBlockJSON): FormState {
  return {
    role: b.role,
    responsibility: b.responsibility,
    maturity: b.maturity ?? "",
    collaborators: b.collaborators.join(", "),
    invariants: b.invariantsV2
      .map((inv) => (inv.enforcedBy !== null ? `${inv.rule} :: ${inv.enforcedBy}` : inv.rule))
      .join("\n"),
  };
}

/** Build the server-shaped SivruBlock (hyphenated keys) from the form + the
 *  original block (to preserve decisions unchanged). */
function toServerBlock(form: FormState, original: SivruBlockJSON): Record<string, unknown> {
  const collaborators = form.collaborators
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const invariants = form.invariants
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [rule, enforced] = line.split("::").map((s) => s.trim());
      return { rule: rule ?? line, "enforced-by": enforced && enforced.length > 0 ? enforced : null };
    });
  const decisions = original.decisions.map((d) => ({
    chose: d.chose,
    because: d.because,
    "valid-while": d.validWhile,
    ...(d.revisitIf !== null ? { "revisit-if": d.revisitIf } : {}),
  }));
  return {
    schema: original.schema,
    role: form.role,
    responsibility: form.responsibility,
    ...(collaborators.length > 0 ? { collaborators } : {}),
    ...(invariants.length > 0 ? { invariants } : {}),
    ...(decisions.length > 0 ? { decisions } : {}),
    ...(form.maturity.length > 0 ? { maturity: form.maturity } : {}),
  };
}

export type BlockEditorProps = {
  rootPath: string;
  node: BlockNodeDetail;
  /** Detail-route mtime baseline for the 409 check. */
  mtimeMs: number | undefined;
  onSaved: () => void;
  onClose: () => void;
};

export function BlockEditor({ rootPath, node, mtimeMs, onSaved, onClose }: BlockEditorProps): JSX.Element {
  const original = node.block;
  const initial = useMemo<FormState | null>(() => (original !== null ? toForm(original) : null), [original]);
  const [form, setForm] = useState<FormState | null>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    identity: true,
    invariants: true,
    collaborators: false,
  });

  useEffect(() => {
    setForm(initial);
    setError(null);
    setConflict(null);
  }, [initial]);

  if (form === null || initial === null || original === null) {
    return (
      <div className="p-4 text-sm text-sivru-error">
        This block could not be parsed, so it can't be edited as a form.
      </div>
    );
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((f) => (f === null ? f : { ...f, [key]: value }));
    setError(null);
  };
  const toggle = (g: string): void => setOpenGroups((s) => ({ ...s, [g]: !s[g] }));

  const handleResult = (r: BlockMutationResult): void => {
    if (r.ok) {
      onSaved();
      return;
    }
    if (r.code === "SIVRU-FILE-CHANGED") {
      setConflict("The file was modified externally. Reload latest before saving.");
      return;
    }
    if (r.code === "SIVRU-VALIDATION-FAILED") {
      const diags = (r.data as { diagnostics?: Array<{ code: string; message: string }> })?.diagnostics ?? [];
      setError(`Validation failed: ${diags.map((d) => `${d.code} ${d.message}`).join("; ") || r.message}`);
      return;
    }
    setError(`${r.code}: ${r.message}`);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const block = toServerBlock(form, original);
      const r = await postBlockEdit(rootPath, node.filePath, node.name, block, mtimeMs);
      handleResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Cmd/Ctrl+S to save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty && !saving) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, saving, form]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-sivru-border px-4 py-2">
        <span className="font-mono text-sm text-sivru-text">{node.name}</span>
        {dirty && <span className="rounded-sivru bg-sivru-amber/15 px-1.5 py-0.5 text-[11px] text-sivru-amber">● Unsaved changes</span>}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-sivru border border-sivru-border px-2 py-0.5 text-[11px] text-sivru-mute hover:text-sivru-text"
        >
          Close
        </button>
      </div>

      {conflict !== null && (
        <div className="flex items-center gap-3 border-b border-sivru-error/40 bg-sivru-error/10 px-4 py-2 text-xs text-sivru-error">
          <span>{conflict}</span>
          <button
            type="button"
            onClick={onSaved}
            className="rounded-sivru border border-sivru-error/40 px-2 py-0.5 hover:bg-sivru-error/20"
          >
            Reload latest
          </button>
        </div>
      )}
      {error !== null && (
        <div className="border-b border-sivru-error/40 bg-sivru-error/10 px-4 py-2 text-xs text-sivru-error">{error}</div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">
        <Group title="Identity" open={openGroups["identity"] ?? false} onToggle={() => toggle("identity")}>
          <Field label="role">
            <input className={inputCls} value={form.role} onChange={(e) => set("role", e.target.value)} />
          </Field>
          <Field label="responsibility">
            <textarea
              className={`${inputCls} min-h-[3rem]`}
              value={form.responsibility}
              onChange={(e) => set("responsibility", e.target.value)}
            />
          </Field>
          <Field label="maturity">
            <select className={inputCls} value={form.maturity} onChange={(e) => set("maturity", e.target.value)}>
              <option value="">(none)</option>
              {MATURITY_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
        </Group>

        <Group title="Invariants" open={openGroups["invariants"] ?? false} onToggle={() => toggle("invariants")}>
          <Field label='one per line — "rule :: enforced-by" (enforced-by optional)'>
            <textarea
              className={`${inputCls} min-h-[4rem] font-mono`}
              value={form.invariants}
              onChange={(e) => set("invariants", e.target.value)}
            />
          </Field>
        </Group>

        <Group title="Collaborators" open={openGroups["collaborators"] ?? false} onToggle={() => toggle("collaborators")}>
          <Field label="comma-separated symbol names">
            <input
              className={`${inputCls} font-mono`}
              value={form.collaborators}
              onChange={(e) => set("collaborators", e.target.value)}
            />
          </Field>
        </Group>

        <div className="mt-2 text-[11px] text-sivru-mute">
          Source: <span className="font-mono">{node.filePath}:{node.range.startLine}</span> · decisions
          preserved as authored.
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-sivru-border bg-sivru-panel px-4 py-2">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => void save()}
          className="rounded-sivru border border-sivru-amber/40 bg-sivru-amber/10 px-3 py-1 text-xs text-sivru-amber disabled:opacity-40 hover:bg-sivru-amber/20"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => setForm(initial)}
          className="rounded-sivru border border-sivru-border px-3 py-1 text-xs text-sivru-mute disabled:opacity-40 hover:text-sivru-text"
        >
          Discard
        </button>
        <span className="ml-auto text-[11px] text-sivru-mute">⌘S / Ctrl+S to save</span>
      </div>
    </div>
  );
}

const inputCls =
  "mt-0.5 w-full rounded-sivru border border-sivru-border bg-sivru-bg px-2 py-1 text-[13px] text-sivru-text focus-visible:ring-2 focus-visible:ring-sivru-amber";

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wide text-sivru-mute">{label}</span>
      {children}
    </label>
  );
}

function Group({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="mb-3 rounded border border-sivru-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between bg-sivru-panel px-3 py-1.5 text-xs text-sivru-text"
      >
        <span>{title}</span>
        <span>{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="space-y-2 p-3">{children}</div>}
    </div>
  );
}
