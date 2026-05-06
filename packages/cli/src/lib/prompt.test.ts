import { describe, expect, it } from "vitest";

import {
  applyKey,
  initialState,
  parseStdinChunk,
  resultFor,
  type Choice,
  type Key,
  type PromptState,
} from "./prompt.js";

const choices: Choice[] = [
  { value: "bm25", label: "bm25" },
  { value: "potion", label: "potion" },
  { value: "minilm", label: "minilm" },
  { value: "jina-code", label: "jina-code" },
];
const TOTAL = choices.length;

function reduce(initial: PromptState, keys: Key[]): PromptState {
  return keys.reduce((s, k) => applyKey(s, k, TOTAL), initial);
}

describe("initialState", () => {
  it("starts cursor at 0 with no selection by default", () => {
    const s = initialState(TOTAL);
    expect(s.cursor).toBe(0);
    expect([...s.selected]).toEqual([]);
    expect(s.done).toBe(false);
    expect(s.cancelled).toBe(false);
    expect(s.hint).toBeNull();
  });

  it("pre-selects defaultIndices", () => {
    const s = initialState(TOTAL, [0, 2]);
    expect([...s.selected].sort()).toEqual([0, 2]);
  });

  it("filters out-of-range default indices", () => {
    const s = initialState(TOTAL, [-1, 0, TOTAL, TOTAL + 5, 1]);
    expect([...s.selected].sort()).toEqual([0, 1]);
  });

  it("handles total=0 cleanly", () => {
    const s = initialState(0, [0, 1]);
    expect([...s.selected]).toEqual([]);
  });
});

describe("parseStdinChunk", () => {
  it("recognizes arrow keys", () => {
    expect(parseStdinChunk("\x1b[A")).toEqual({ type: "up" });
    expect(parseStdinChunk("\x1b[B")).toEqual({ type: "down" });
  });

  it("recognizes home/end (both terminfo conventions)", () => {
    expect(parseStdinChunk("\x1b[H")).toEqual({ type: "home" });
    expect(parseStdinChunk("\x1b[1~")).toEqual({ type: "home" });
    expect(parseStdinChunk("\x1b[F")).toEqual({ type: "end" });
    expect(parseStdinChunk("\x1b[4~")).toEqual({ type: "end" });
  });

  it("space toggles, enter confirms", () => {
    expect(parseStdinChunk(" ")).toEqual({ type: "space" });
    expect(parseStdinChunk("\r")).toEqual({ type: "enter" });
    expect(parseStdinChunk("\n")).toEqual({ type: "enter" });
  });

  it("Ctrl+C / esc / q all cancel", () => {
    expect(parseStdinChunk("\x03")).toEqual({ type: "cancel" });
    expect(parseStdinChunk("\x1b")).toEqual({ type: "cancel" });
    expect(parseStdinChunk("q")).toEqual({ type: "cancel" });
    expect(parseStdinChunk("Q")).toEqual({ type: "cancel" });
  });

  it("a / A / Ctrl+A toggle all", () => {
    expect(parseStdinChunk("a")).toEqual({ type: "toggleAll" });
    expect(parseStdinChunk("A")).toEqual({ type: "toggleAll" });
    expect(parseStdinChunk("\x01")).toEqual({ type: "toggleAll" });
  });

  it("digit keys 1-9 are recognized", () => {
    expect(parseStdinChunk("1")).toEqual({ type: "digit", n: 1 });
    expect(parseStdinChunk("9")).toEqual({ type: "digit", n: 9 });
    // 0 is intentionally not a shortcut (can't index choice 0).
    expect(parseStdinChunk("0")).toBeNull();
  });

  it("returns null for unknown sequences", () => {
    expect(parseStdinChunk("z")).toBeNull();
    expect(parseStdinChunk("\x1b[99~")).toBeNull();
  });
});

describe("applyKey — navigation", () => {
  it("up wraps from 0 -> last", () => {
    const s = applyKey(initialState(TOTAL), { type: "up" }, TOTAL);
    expect(s.cursor).toBe(TOTAL - 1);
  });

  it("down wraps from last -> 0", () => {
    const start = { ...initialState(TOTAL), cursor: TOTAL - 1 };
    const s = applyKey(start, { type: "down" }, TOTAL);
    expect(s.cursor).toBe(0);
  });

  it("home jumps to 0, end jumps to last", () => {
    const a = applyKey({ ...initialState(TOTAL), cursor: 2 }, { type: "home" }, TOTAL);
    expect(a.cursor).toBe(0);
    const b = applyKey(initialState(TOTAL), { type: "end" }, TOTAL);
    expect(b.cursor).toBe(TOTAL - 1);
  });
});

describe("applyKey — selection", () => {
  it("space toggles cursor row", () => {
    const s = reduce(initialState(TOTAL), [
      { type: "space" }, // toggle 0 on
      { type: "down" },
      { type: "space" }, // toggle 1 on
    ]);
    expect([...s.selected].sort()).toEqual([0, 1]);
  });

  it("space again toggles off", () => {
    const s = reduce(initialState(TOTAL, [0]), [{ type: "space" }]);
    expect([...s.selected]).toEqual([]);
  });

  it("toggleAll selects all when partially selected, clears when fully", () => {
    const partial = initialState(TOTAL, [0, 2]);
    const all = applyKey(partial, { type: "toggleAll" }, TOTAL);
    expect([...all.selected].sort()).toEqual([0, 1, 2, 3]);

    const cleared = applyKey(all, { type: "toggleAll" }, TOTAL);
    expect([...cleared.selected]).toEqual([]);
  });

  it("digit key toggles AND moves cursor", () => {
    const s = applyKey(initialState(TOTAL), { type: "digit", n: 3 }, TOTAL);
    expect(s.cursor).toBe(2);
    expect([...s.selected]).toEqual([2]);
  });

  it("digit out of range is a no-op", () => {
    const s0 = initialState(TOTAL);
    const s1 = applyKey(s0, { type: "digit", n: 99 }, TOTAL);
    expect(s1).toEqual(s0);
  });
});

describe("applyKey — terminal states", () => {
  it("enter on empty selection sets hint, doesn't confirm", () => {
    const s = applyKey(initialState(TOTAL), { type: "enter" }, TOTAL);
    expect(s.done).toBe(false);
    expect(s.hint).toMatch(/select at least one/);
  });

  it("enter on non-empty selection sets done", () => {
    const s = applyKey(initialState(TOTAL, [1]), { type: "enter" }, TOTAL);
    expect(s.done).toBe(true);
    expect(s.cancelled).toBe(false);
  });

  it("cancel sets cancelled regardless of selection", () => {
    const s = applyKey(initialState(TOTAL, [0]), { type: "cancel" }, TOTAL);
    expect(s.cancelled).toBe(true);
    expect(s.done).toBe(false);
  });

  it("subsequent keys are ignored after done", () => {
    const done = applyKey(initialState(TOTAL, [0]), { type: "enter" }, TOTAL);
    const after = applyKey(done, { type: "down" }, TOTAL);
    expect(after).toBe(done);
  });

  it("subsequent keys are ignored after cancel", () => {
    const cancelled = applyKey(initialState(TOTAL), { type: "cancel" }, TOTAL);
    const after = applyKey(cancelled, { type: "space" }, TOTAL);
    expect(after).toBe(cancelled);
  });

  it("any non-cancel key clears the transient hint", () => {
    const withHint = applyKey(initialState(TOTAL), { type: "enter" }, TOTAL);
    expect(withHint.hint).not.toBeNull();
    const cleared = applyKey(withHint, { type: "down" }, TOTAL);
    expect(cleared.hint).toBeNull();
  });
});

describe("resultFor", () => {
  it("returns null while not done", () => {
    expect(resultFor(initialState(TOTAL, [0]), choices)).toBeNull();
  });

  it("returns null when cancelled", () => {
    const s = applyKey(initialState(TOTAL, [0, 1]), { type: "cancel" }, TOTAL);
    expect(resultFor(s, choices)).toBeNull();
  });

  it("returns selected values in catalog order on done", () => {
    // Pick 2 then 0 — result should still be [bm25, minilm], not [minilm, bm25].
    const s = reduce(initialState(TOTAL), [
      { type: "down" },
      { type: "down" },
      { type: "space" }, // toggle 2
      { type: "home" },
      { type: "space" }, // toggle 0
      { type: "enter" },
    ]);
    expect(resultFor(s, choices)).toEqual(["bm25", "minilm"]);
  });
});
