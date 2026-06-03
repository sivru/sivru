import { describe, expect, it } from "vitest";

import { severityDotClass, severityRank } from "./severity";

describe("severityRank", () => {
  it("orders error < warning < info, unknown last", () => {
    expect(severityRank("error")).toBeLessThan(severityRank("warning"));
    expect(severityRank("warning")).toBeLessThan(severityRank("info"));
    expect(severityRank("bogus")).toBe(9);
  });
});

describe("severityDotClass", () => {
  it("maps severities to the sivru tokens", () => {
    expect(severityDotClass("error")).toBe("bg-sivru-error");
    expect(severityDotClass("warning")).toBe("bg-sivru-warn");
    expect(severityDotClass("info")).toBe("bg-sivru-mute");
    expect(severityDotClass("anything-else")).toBe("bg-sivru-mute");
  });
});
