// Shared types for module-level @sivru locators (Python / TypeScript /
// Java). Lifted from `python.ts` so the Java locator does not need to
// import from a sibling python module (a noisy type leak).

import type { BlockDiagnostic } from "../types.js";

export type ModuleCarrier = {
  text: string;
  /** 1-indexed inclusive file line of the carrier's first line. */
  startLine: number;
  /** 1-indexed inclusive file line of the carrier's last line. */
  endLine: number;
};

export type LocatorResult = {
  /** Located carrier; undefined when no module docstring exists at all. */
  carrier?: ModuleCarrier;
  /** Set when the locator could not parse the file structure (SIVRU-E218). */
  diagnostic?: BlockDiagnostic;
};
