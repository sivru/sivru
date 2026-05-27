import { describe, it, expect } from "vitest";

import { PYTHON_BRIDGES, resolvePythonBridges } from "./python.js";

describe("PYTHON_BRIDGES catalog", () => {
  it("contains the seed entries", () => {
    const markers = PYTHON_BRIDGES.map((b) => b.marker);
    expect(markers).toContain("dataclass(frozen=True)");
    expect(markers).toContain("pytest.fixture");
  });
});

describe("resolvePythonBridges merge", () => {
  it("respects disable", () => {
    const out = resolvePythonBridges(undefined, ["pytest.fixture"]);
    expect(out.find((b) => b.marker === "pytest.fixture")).toBeUndefined();
  });

  it("respects user overrides", () => {
    const out = resolvePythonBridges({ "app.route": "custom route invariant" });
    const entry = out.find((b) => b.marker === "app.route");
    expect(entry?.invariant).toBe("custom route invariant");
  });
});
