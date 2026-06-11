// Integration: render the REAL sivru model to HTML — block prose, file paths,
// and symbol names with whatever characters they carry — and assert the result
// is a coherent, self-verified, self-contained document. Catches anything the
// fixture's tidy strings would miss.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { buildExplainerModel } from "../model.js";
import { renderHtml } from "./render.js";
import { selfVerify } from "./routes.js";

const here = dirname(fileURLToPath(import.meta.url)); // …/explainer/html
const repoRoot = resolve(here, "..", "..", "..", "..", ".."); // → repo root

function gitWorks(): boolean {
  try {
    execFileSync("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

describe("renderHtml — integration on the sivru repo", () => {
  it.runIf(gitWorks())(
    "renders a coherent, self-verified, self-contained document",
    async () => {
      const model = await buildExplainerModel(repoRoot, {});
      const html = renderHtml(model); // throws on self-verify failure

      expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
      expect(selfVerify(html, model).ok).toBe(true);

      // Self-contained: no external fetched assets.
      expect(html).not.toContain("<link");
      expect(html).not.toContain("<script src=");
      expect(html).not.toMatch(/src="https?:/);

      // The real model fuses real @sivru blocks and the empty-state nudge.
      expect(html).toContain("block-head");
      expect(html).toContain("No @sivru block yet");
      expect(html).toContain('class="diagram"');
    },
    60_000,
  );
});
