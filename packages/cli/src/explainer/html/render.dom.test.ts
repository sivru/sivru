// @vitest-environment node
//
// Drives the REAL in-HTML feedback shim in a headless DOM: render the page,
// execute CLIENT_JS, simulate the edit / create / note / narrative clicks, then
// Export — and assert the captured patch.json round-trips through parsePatch.
// This is the seam structural tests can't reach: a wrong data-attribute name or
// a broken export split would fail here, not just in a browser.
//
// Each test gets a FRESH happy-dom Window (one shim instance, no stacked
// listeners), so the suite stays isolated regardless of click order.

import { Window } from "happy-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { parsePatch } from "../../feedback/patch.js";
import { fixtureModel } from "./fixture.js";
import { CLIENT_JS, renderHtml } from "./render.js";

describe("feedback shim — real DOM round-trip", () => {
  let win: Window;
  let doc: Document;
  let captured: { text(): Promise<string> } | null;

  function load(): void {
    win = new Window({ url: "https://sivru.test/" });
    doc = win.document as unknown as Document;
    doc.body.innerHTML = renderHtml(fixtureModel()).match(/<body[^>]*>([\s\S]*?)<\/body>/)![1]!;
    captured = null;
    // window.prompt isn't implemented — always answer non-empty
    (win as unknown as { prompt: () => string }).prompt = () => "EDITED";
    // capture the exported blob instead of triggering a download
    (win.URL as unknown as { createObjectURL: (b: typeof captured) => string }).createObjectURL = (b) => {
      captured = b;
      return "blob:x";
    };
    (win.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    win.eval(CLIENT_JS); // run the shim in THIS window's scope
  }

  function setFeedback(on: boolean): void {
    const t = doc.getElementById("fb-mode") as HTMLInputElement;
    t.checked = on;
    t.dispatchEvent(new win.Event("change", { bubbles: true }));
  }

  function click(sel: string): void {
    (doc.querySelector(sel) as HTMLElement).click();
  }

  async function exportPatch(): Promise<ReturnType<typeof parsePatch>> {
    (doc.getElementById("fb-export") as HTMLButtonElement).click();
    return parsePatch(await captured!.text());
  }

  beforeEach(() => {
    load();
    setFeedback(true);
  });

  it("an edited field exports as a valid block edit", async () => {
    click('[data-edit-field="responsibility"]');
    const patch = await exportPatch();
    expect(patch.edits).toHaveLength(1);
    expect(patch.edits[0]!.edit).toMatchObject({ field: "responsibility", op: "set", value: "EDITED" });
    expect(patch.edits[0]!.blockContentHash.length).toBeGreaterThan(0);
  });

  it("authoring an un-annotated symbol exports as a create", async () => {
    click(".fb-create");
    const patch = await exportPatch();
    expect(patch.creates).toHaveLength(1);
    expect(patch.creates![0]).toMatchObject({ blockSymbolName: "helper", declLine: 12, role: "EDITED" });
  });

  it("a note and a narrative export into their arrays", async () => {
    click(".fb-note");
    click(".fb-narrative");
    const patch = await exportPatch();
    expect(patch.notes).toHaveLength(1);
    expect(patch.notes![0]!.note).toBe("EDITED");
    expect(patch.narrative).toHaveLength(1);
    expect(patch.narrative![0]!.value).toBe("EDITED");
  });

  it("does nothing when feedback mode is off", () => {
    setFeedback(false);
    win.localStorage.clear();
    click('[data-edit-field="responsibility"]');
    expect(win.localStorage.length).toBe(0); // the handler returned early — nothing stored
  });
});
