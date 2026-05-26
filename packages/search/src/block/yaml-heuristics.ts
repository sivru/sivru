// Heuristics for detecting YAML authoring traps in source-embedded
// blocks (DESIGN-0019 §9). Lifted out of `yaml-errors.ts` so callers
// (notably `autofix.ts`) can replay them on a line without relying on
// a `_internal` re-export — that pattern leaks test surface into the
// production API.
//
// Two heuristics:
//   - `unbalancedApostrophes(line)`     — single-quote imbalance hint
//   - `unquotedColonColumnInValue(line)` — column of an unquoted `:`
//                                          inside a value
//
// Both are textual on a single line; both are tolerant of leading
// comment-syntax prefixes the caller has already stripped.

/**
 * True when `line` contains an odd number of unescaped single quotes
 * outside any double-quoted region. Used to wrap js-yaml errors that
 * point at the wrong character (a trailing comma) when the real cause
 * is an unterminated single-quoted string earlier in the line.
 */
export function unbalancedApostrophes(line: string): boolean {
  let inDouble = false;
  let apostrophes = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inDouble && ch === "'") apostrophes += 1;
  }
  return apostrophes % 2 === 1;
}

/**
 * Column (0-indexed) of an unquoted `:` inside the value half of a
 * YAML line, or -1 when no candidate exists. The "value half" is
 * whatever follows the first `: ` mapping separator on a `key: value`
 * line, or whatever follows the leading `- ` on an array item.
 *
 * This is the SECOND colon — the one that triggers the colon-in-prose
 * trap when YAML SUCCESSFULLY parses the line as a nested mapping
 * instead of a string. (The silent-drift case detected by
 * `extract.ts:parseFenceBody` is the more common variant; this
 * heuristic catches the case where YAML actually fails.)
 */
export function unquotedColonColumnInValue(line: string): number {
  const valueStart = line.search(/: \S/);
  if (valueStart === -1) {
    const dashIdx = line.search(/^\s*-\s+/);
    if (dashIdx === -1) return -1;
    const afterDash = line.replace(/^\s*-\s+/, "");
    const colonInValue = afterDash.indexOf(":");
    if (colonInValue === -1) return -1;
    if (afterDash.trim().startsWith('"')) return -1;
    return line.length - afterDash.length + colonInValue;
  }
  const afterKey = line.slice(valueStart + 2);
  if (afterKey.trim().startsWith('"') || afterKey.trim().startsWith("'")) {
    return -1;
  }
  const m = afterKey.match(/[^"]*?(:)(?:\s|$)/);
  if (m === null || m.index === undefined) return -1;
  return valueStart + 2 + m.index + m[0].indexOf(":");
}
