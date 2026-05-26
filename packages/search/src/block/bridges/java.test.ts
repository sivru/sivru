import { describe, it, expect } from "vitest";

import { JAVA_BRIDGES, resolveJavaBridges } from "./java.js";

describe("JAVA_BRIDGES catalog", () => {
  it("includes the 8 seed markers from DESIGN-0019 §10a", () => {
    const markers = JAVA_BRIDGES.map((b) => b.marker);
    for (const m of [
      "ApplicationScoped",
      "Singleton",
      "RequestScoped",
      "Transactional",
      "Filter",
      "Audited",
      "SecurityChecked",
      "Retryable",
    ]) {
      expect(markers).toContain(m);
    }
  });

  it("@ApplicationScoped maps to thread-safe; no instance state", () => {
    const entry = JAVA_BRIDGES.find((b) => b.marker === "ApplicationScoped");
    expect(entry?.invariant).toBe("thread-safe; no instance state");
  });
});

describe("resolveJavaBridges merge", () => {
  it("project override replaces a seed entry", () => {
    const merged = resolveJavaBridges({ Transactional: "custom invariant" });
    const txEntry = merged.find((b) => b.marker === "Transactional");
    expect(txEntry?.invariant).toBe("custom invariant");
  });

  it("disable drops a marker entirely", () => {
    const merged = resolveJavaBridges(undefined, ["RequestScoped"]);
    expect(merged.find((b) => b.marker === "RequestScoped")).toBeUndefined();
  });

  it("user override may use the @-prefixed form", () => {
    const merged = resolveJavaBridges({ "@Audited": "audit override" });
    const entry = merged.find((b) => b.marker === "Audited");
    expect(entry?.invariant).toBe("audit override");
  });
});
