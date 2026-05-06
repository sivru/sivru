// Tiny dep-free interactive prompts for the CLI. Today: a raw-mode
// checkbox multi-select for `sivru bench personal` when the user
// doesn't pass `--models`. Could expand later to other commands; keep
// the surface small.
//
// Why hand-rolled (not @inquirer/prompts / @clack/prompts / prompts):
// CLAUDE.md "don't do without asking" — new deps need DESIGN.md §7
// sign-off. The raw-mode TTY surface is ~150 LOC and matches the
// polish of the rest of the CLI without an additional dependency.
//
// The state machine + key parser are split out so the actual I/O
// wrapper stays minimal and the logic is unit-tested directly.

import { stdin as input, stdout as output } from "node:process";

export type Choice = {
  value: string;
  /** Short name. Caller is responsible for any padding for column alignment. */
  label: string;
  /** Optional one-line metadata shown in dim text after the label. */
  hint?: string;
};

export type SelectMultipleOptions = {
  prompt: string;
  choices: readonly Choice[];
  /** 0-based indices pre-selected when the prompt opens. */
  defaultIndices?: readonly number[];
};

// ─────────────────────────── pure state ────────────────────────────

export type PromptState = {
  cursor: number;
  selected: ReadonlySet<number>;
  done: boolean;
  cancelled: boolean;
  /** Transient hint shown in the footer (cleared on next keypress). */
  hint: string | null;
};

export type Key =
  | { type: "up" }
  | { type: "down" }
  | { type: "home" }
  | { type: "end" }
  | { type: "space" }
  | { type: "toggleAll" }
  | { type: "enter" }
  | { type: "cancel" }
  | { type: "digit"; n: number };

export function initialState(
  total: number,
  defaultIndices: readonly number[] = [],
): PromptState {
  const selected = new Set<number>();
  for (const i of defaultIndices) {
    if (i >= 0 && i < total) selected.add(i);
  }
  return { cursor: 0, selected, done: false, cancelled: false, hint: null };
}

export function applyKey(
  state: PromptState,
  key: Key,
  total: number,
): PromptState {
  if (total === 0 || state.done || state.cancelled) return state;
  switch (key.type) {
    case "up":
      return { ...state, hint: null, cursor: (state.cursor - 1 + total) % total };
    case "down":
      return { ...state, hint: null, cursor: (state.cursor + 1) % total };
    case "home":
      return { ...state, hint: null, cursor: 0 };
    case "end":
      return { ...state, hint: null, cursor: total - 1 };
    case "space": {
      const next = new Set(state.selected);
      if (next.has(state.cursor)) next.delete(state.cursor);
      else next.add(state.cursor);
      return { ...state, selected: next, hint: null };
    }
    case "toggleAll": {
      const next =
        state.selected.size === total
          ? new Set<number>()
          : new Set(Array.from({ length: total }, (_, i) => i));
      return { ...state, selected: next, hint: null };
    }
    case "digit": {
      if (key.n < 1 || key.n > total) return state;
      const i = key.n - 1;
      const next = new Set(state.selected);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return { ...state, cursor: i, selected: next, hint: null };
    }
    case "enter":
      if (state.selected.size === 0) {
        return {
          ...state,
          hint: "select at least one with space, or press q to cancel",
        };
      }
      return { ...state, done: true, hint: null };
    case "cancel":
      return { ...state, cancelled: true, hint: null };
  }
}

export function parseStdinChunk(buf: string): Key | null {
  // Most multi-byte sequences arrive as a single chunk in raw mode.
  if (buf === "\x1b[A") return { type: "up" };
  if (buf === "\x1b[B") return { type: "down" };
  if (buf === "\x1b[H" || buf === "\x1b[1~") return { type: "home" };
  if (buf === "\x1b[F" || buf === "\x1b[4~") return { type: "end" };
  if (buf === " ") return { type: "space" };
  if (buf === "\r" || buf === "\n") return { type: "enter" };
  // Bare ESC, Ctrl+C, q/Q -> cancel.
  if (buf === "\x03" || buf === "\x1b" || buf === "q" || buf === "Q") {
    return { type: "cancel" };
  }
  if (buf === "a" || buf === "A" || buf === "\x01") {
    return { type: "toggleAll" };
  }
  if (/^[1-9]$/.test(buf)) {
    return { type: "digit", n: Number.parseInt(buf, 10) };
  }
  return null;
}

export function resultFor(
  state: PromptState,
  choices: readonly Choice[],
): string[] | null {
  if (state.cancelled || !state.done) return null;
  const out: string[] = [];
  for (let i = 0; i < choices.length; i++) {
    if (state.selected.has(i)) out.push(choices[i]!.value);
  }
  return out.length > 0 ? out : null;
}

// ─────────────────── ANSI + render helpers ─────────────────────────

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLR_EOL = "\x1b[K";
const moveUp = (n: number): string => (n > 0 ? `\x1b[${n}A` : "");

const dim = (s: string): string => `\x1b[2m${s}\x1b[22m`;
const cyan = (s: string): string => `\x1b[36m${s}\x1b[39m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[39m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[39m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[22m`;

function renderFrame(
  state: PromptState,
  options: SelectMultipleOptions,
  cols: number,
): { text: string; lines: number } {
  const lines: string[] = [];
  lines.push(`  ${bold(options.prompt)}`);
  lines.push(
    `  ${dim("↑↓ move · space toggle · a all · 1-9 quick · enter confirm · esc cancel")}`,
  );
  lines.push("");
  for (let i = 0; i < options.choices.length; i++) {
    const c = options.choices[i]!;
    const isCursor = i === state.cursor;
    const isChecked = state.selected.has(i);
    const cursorMark = isCursor ? cyan("❯") : " ";
    const boxMark = isChecked ? green("◉") : dim("◯");
    const numLabel = `${(i + 1).toString().padStart(2)}.`;
    const hint =
      c.hint !== undefined && c.hint.length > 0 ? `  ${dim(c.hint)}` : "";
    let line = `${cursorMark} ${boxMark} ${dim(numLabel)} ${c.label}${hint}`;
    line = truncateAnsi(line, cols);
    lines.push(line);
  }
  lines.push("");
  const sel = `${state.selected.size}/${options.choices.length} selected`;
  const footer =
    state.hint !== null ? `${dim(sel)}  ${red(state.hint)}` : dim(sel);
  lines.push(`  ${footer}`);
  // Emit each line with CLR_EOL so a shrunk hint clears leftover chars.
  const text = lines.map((l) => l + CLR_EOL).join("\n") + "\n";
  return { text, lines: lines.length };
}

/** Visible-length-aware truncation that preserves ANSI escape sequences. */
function truncateAnsi(line: string, maxCols: number): string {
  const visibleLen = line.replace(/\x1b\[[0-9;]*m/g, "").length;
  if (visibleLen <= maxCols) return line;
  let out = "";
  let visLen = 0;
  let i = 0;
  while (i < line.length && visLen < maxCols - 1) {
    if (line[i] === "\x1b" && line[i + 1] === "[") {
      const end = line.indexOf("m", i + 2);
      if (end !== -1) {
        out += line.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    out += line[i];
    visLen++;
    i++;
  }
  return out + dim("…");
}

// ─────────────────────── runner (impure) ───────────────────────────

/**
 * Render an interactive multi-select prompt and resolve to the selected
 * values (in catalog order). Returns null if the user cancels (esc / q /
 * Ctrl+C) or stdin/stdout aren't TTYs (CI / piped). Empty array when the
 * choices list itself is empty.
 *
 * The terminal is restored on every exit path: cursor shown, raw mode
 * dropped, listeners removed. A `process.once("exit")` belt-and-braces
 * shows the cursor again if the process is killed mid-prompt.
 */
export async function selectMultipleInteractive(
  options: SelectMultipleOptions,
): Promise<string[] | null> {
  if (!input.isTTY || !output.isTTY) return null;
  if (options.choices.length === 0) return [];

  let state = initialState(options.choices.length, options.defaultIndices);
  const cols = output.columns ?? 80;

  output.write(HIDE_CURSOR);
  let frame = renderFrame(state, options, cols);
  output.write(frame.text);

  let onData!: (chunk: string) => void;

  const restore = (): void => {
    try {
      input.setRawMode(false);
    } catch {
      // best-effort
    }
    input.removeListener("data", onData);
    input.pause();
    output.write(SHOW_CURSOR);
  };

  const onExit = (): void => {
    output.write(SHOW_CURSOR);
  };
  process.once("exit", onExit);

  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  return new Promise<string[] | null>((resolveFn) => {
    onData = (chunk: string): void => {
      const key = parseStdinChunk(chunk);
      if (key === null) return;
      const next = applyKey(state, key, options.choices.length);

      // Always redraw — hint changes happen on enter-with-empty too.
      output.write(moveUp(frame.lines));
      const newFrame = renderFrame(next, options, cols);
      output.write(newFrame.text);
      state = next;
      frame = newFrame;

      if (state.done || state.cancelled) {
        restore();
        process.removeListener("exit", onExit);
        resolveFn(resultFor(state, options.choices));
      }
    };
    input.on("data", onData);
  });
}
