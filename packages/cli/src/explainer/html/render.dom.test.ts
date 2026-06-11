// @vitest-environment happy-dom
//
// Drives the REAL in-HTML feedback shim in a headless DOM: render the page,
// execute CLIENT_JS, simulate the edit / create / note / narrative clicks, then
// Export — and assert the captured patch.json round-trips through parsePatch.
// This is the seam structural tests can't reach: a wrong data-attribute name or
// a broken export split would fail here, not just in a browser.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { parsePatch } from "../../feedback/patch.js";
import { fixtureModel } from "./fixture.js";
import { CLIENT_JS, renderHtml } from "./render.js";

function loadPage(): void {
  const html = renderHtml(fixtureModel());
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)![1]!;
  document.body.innerHTML = body;
  // execute the shim against this DOM (innerHTML doesn't run <script>)
  new Function(CLIENT_JS)();
}

function enableFeedback(): void {
  const toggle = document.getElementById("fb-mode") as HTMLInputElement;
  toggle.checked = true;
  toggle.dispatchEvent(new window.Event("change", { bubbles: true }));
}

describe("feedback shim — real DOM round-trip", () => {
  let captured: string | null;

  beforeEach(() => {
    localStorage.clear();
    captured = null;
    // window.prompt isn't implemented in happy-dom — always answer non-empty
    window.prompt = vi.fn(() => "EDITED") as unknown as typeof window.prompt;
    // capture the exported blob instead of triggering a download
    (window.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
      // Blob#text is async; stash the blob and resolve in the test
      (captured as unknown) = b;
      return "blob:x";
    };
    (window.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    loadPage();
    enableFeedback();
  });

  async function exportPatch(): Promise<ReturnType<typeof parsePatch>> {
    (document.getElementById("fb-export") as HTMLButtonElement).click();
    const text = await (captured as unknown as Blob).text();
    return parsePatch(text);
  }

  it("an edited field exports as a valid block edit", async () => {
    (document.querySelector('[data-edit-field="responsibility"]') as HTMLElement).click();
    const patch = await exportPatch();
    expect(patch.edits).toHaveLength(1);
    expect(patch.edits[0]!.edit).toMatchObject({ field: "responsibility", op: "set", value: "EDITED" });
    expect(patch.edits[0]!.blockContentHash.length).toBeGreaterThan(0);
  });

  it("authoring an un-annotated symbol exports as a create", async () => {
    (document.querySelector(".fb-create") as HTMLElement).click();
    const patch = await exportPatch();
    expect(patch.creates).toHaveLength(1);
    expect(patch.creates![0]).toMatchObject({ blockSymbolName: "helper", declLine: 12, role: "EDITED" });
  });

  it("a note and a narrative export into their arrays", async () => {
    (document.querySelector(".fb-note") as HTMLElement).click();
    (document.querySelector(".fb-narrative") as HTMLElement).click();
    const patch = await exportPatch();
    expect(patch.notes).toHaveLength(1);
    expect(patch.notes![0]!.note).toBe("EDITED");
    expect(patch.narrative).toHaveLength(1);
    expect(patch.narrative![0]!.value).toBe("EDITED");
  });

  it("does nothing when feedback mode is off", () => {
    const toggle = document.getElementById("fb-mode") as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new window.Event("change", { bubbles: true })); // removes feedback-on
    localStorage.clear();
    (document.querySelector('[data-edit-field="responsibility"]') as HTMLElement).click();
    expect(localStorage.length).toBe(0); // the handler returned early — nothing stored
  });
});
