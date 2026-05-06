// Search → consumer linking. The proof-of-utility layer.
//
// "sivru.search was called" is necessary but not sufficient — the user
// wants to know whether the agent *used* the results. This module walks
// the event stream, indexes each sivru.search response by the file paths
// it returned, and stamps subsequent Read / Edit / MultiEdit / Glob events
// with a back-reference to the search that recommended their target file.
//
// The reverse direction is just as important: when inspecting a search
// result, the user wants to see which chunks "paid off" — which the agent
// actually read or edited later.
//
// Heuristic, not proof: an agent reading a file that sivru happened to
// return doesn't *prove* the search caused the read (the agent might
// have also derived the path from a Grep, or known it from a prior
// turn). We treat the most recent matching search as the cause and
// surface it as evidence, not certainty. The UI labels this as
// "↑ from search" — present tense, suggestive.

import type { SivruEvent } from "./types";
import { parseSearchOutput, type SearchHit } from "./sivru-search";
import { isSivruSearchTool } from "./util";

export type SearchProvenance = {
  /** Event index of the sivru.search tool_use that surfaced this file. */
  searchEventIndex: number;
  /** Position of the matching chunk in the search response (0-based). */
  chunkIndex: number;
  filePath: string;
  startLine?: number;
  endLine?: number;
};

export type ProvenanceResult = {
  /**
   * For each consuming event (Read / Edit / etc.), the search that most
   * recently surfaced its target file. Keyed by event.index.
   */
  consumerByEvent: Map<number, SearchProvenance>;
  /**
   * Reverse map: for each sivru.search tool_use event, the set of
   * downstream consumer event indices that touched a returned file.
   * Keyed by the search tool_use's event.index.
   */
  consumersBySearch: Map<number, number[]>;
  /**
   * For each sivru.search tool_use event, the set of CHUNK indices that
   * were "used" by a downstream consumer. Keyed the same way.
   */
  usedChunksBySearch: Map<number, Set<number>>;
};

const FILE_PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "file",
  "target_file_path",
] as const;

const CONSUMER_TOOLS = new Set([
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
]);

function extractTargetFilePath(input: unknown): string | null {
  if (input === null || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  for (const key of FILE_PATH_KEYS) {
    const v = i[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * Match a consumer's target file path against an indexed search hit.
 * Tolerant: the agent might use an absolute path while the search returned
 * a repo-relative path (or vice versa), so we check suffix overlap. We do
 * NOT match across totally unrelated paths — the suffix has to be at least
 * one full path segment to count.
 */
function pathsMatch(target: string, recommended: string): boolean {
  if (target === recommended) return true;
  const a = target.replace(/\\/g, "/");
  const b = recommended.replace(/\\/g, "/");
  if (a === b) return true;
  const aSegs = a.split("/").filter((s) => s.length > 0);
  const bSegs = b.split("/").filter((s) => s.length > 0);
  // Require at least 2 segments to overlap. Stops basename-only collisions
  // (auth.ts in different packages) from being treated as the same file.
  const shorter = aSegs.length <= bSegs.length ? aSegs : bSegs;
  const longer = aSegs.length <= bSegs.length ? bSegs : aSegs;
  if (shorter.length < 2) return false;
  const offset = longer.length - shorter.length;
  for (let i = 0; i < shorter.length; i++) {
    if (longer[offset + i] !== shorter[i]) return false;
  }
  return true;
}

/**
 * For each consumer event, attribute it to the most recent sivru.search
 * call that returned a chunk for the target file. O(events) — single pass.
 */
export function computeSearchProvenance(
  events: readonly SivruEvent[],
): ProvenanceResult {
  // Most-recent recommendation per file path. Keyed by raw filePath string
  // from the search hit; the lookup at consume time tries fuzzy matching
  // via pathsMatch.
  type Entry = SearchProvenance;
  const recentByExactPath = new Map<string, Entry>();
  // Also keep the full ordered list of search hits so we can do the
  // suffix-match scan when exact lookup misses.
  const allEntries: Entry[] = [];

  // Track tool_use index → tool name so a tool_result with no tool field
  // can still be attributed (Claude Code's older formats omit it).
  const toolUseStack: Array<{ index: number; tool: string }> = [];

  const consumerByEvent = new Map<number, Entry>();
  const consumersBySearch = new Map<number, number[]>();
  const usedChunksBySearch = new Map<number, Set<number>>();

  for (const e of events) {
    if (e.kind === "tool_use") {
      const tool = typeof e.tool === "string" ? e.tool : "";
      if (tool.length > 0) toolUseStack.push({ index: e.index, tool });

      // Consumer side: look up provenance for this tool_use.
      if (CONSUMER_TOOLS.has(tool)) {
        const target = extractTargetFilePath(e.input);
        if (target !== null) {
          const found = lookupProvenance(target, recentByExactPath, allEntries);
          if (found !== null) {
            consumerByEvent.set(e.index, found);
            // Record reverse links.
            const existing = consumersBySearch.get(found.searchEventIndex);
            if (existing === undefined) {
              consumersBySearch.set(found.searchEventIndex, [e.index]);
            } else {
              existing.push(e.index);
            }
            const usedSet = usedChunksBySearch.get(found.searchEventIndex);
            if (usedSet === undefined) {
              usedChunksBySearch.set(
                found.searchEventIndex,
                new Set([found.chunkIndex]),
              );
            } else {
              usedSet.add(found.chunkIndex);
            }
          }
        }
      }
      continue;
    }

    if (e.kind === "tool_result") {
      // Pop the most recent matching tool_use to get the tool name.
      let tool: string | null =
        typeof e.tool === "string" && e.tool.length > 0 ? e.tool : null;
      if (tool === null && toolUseStack.length > 0) {
        const top = toolUseStack.pop();
        if (top !== undefined) tool = top.tool;
      } else if (tool !== null && toolUseStack.length > 0) {
        // Try to drop the matching tool_use from the stack (best-effort
        // pairing; the order is usually preserved).
        for (let i = toolUseStack.length - 1; i >= 0; i--) {
          if (toolUseStack[i]?.tool === tool) {
            toolUseStack.splice(i, 1);
            break;
          }
        }
      }

      if (tool !== null && isSivruSearchTool(tool)) {
        // This is a sivru.search response. Extract chunks and index by
        // file path. The tool_use event index for this search is
        // (e.index - 1) at minimum but we use the most recent paired
        // tool_use index from the stack — actually, since we already
        // popped, the search's tool_use index is just whatever the
        // tool_use loop saw last for this tool. Heuristic: use the
        // immediately prior tool_use's index by scanning back.
        const searchEventIndex = findRecentSearchToolUseIndex(events, e.index);
        const parsed = parseSearchOutput(e.output);
        const hits: SearchHit[] = parsed?.results ?? parsed?.hits ?? [];
        for (let i = 0; i < hits.length; i++) {
          const hit = hits[i];
          if (hit === undefined) continue;
          const entry: Entry = {
            searchEventIndex,
            chunkIndex: i,
            filePath: hit.filePath,
            ...(hit.startLine !== undefined && { startLine: hit.startLine }),
            ...(hit.endLine !== undefined && { endLine: hit.endLine }),
          };
          recentByExactPath.set(hit.filePath, entry);
          allEntries.push(entry);
        }
      }
    }
  }

  return { consumerByEvent, consumersBySearch, usedChunksBySearch };
}

function lookupProvenance(
  target: string,
  exact: Map<string, SearchProvenance>,
  all: readonly SearchProvenance[],
): SearchProvenance | null {
  const direct = exact.get(target);
  if (direct !== undefined) return direct;
  // Fuzzy fallback: walk recently-seen entries, take the latest match.
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (e === undefined) continue;
    if (pathsMatch(target, e.filePath)) return e;
  }
  return null;
}

/** Walk events backwards from `endIdx` to find the most recent
 *  sivru.search tool_use's event index. */
function findRecentSearchToolUseIndex(
  events: readonly SivruEvent[],
  endIdx: number,
): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e === undefined) continue;
    if (e.index >= endIdx) continue;
    if (e.kind === "tool_use" && isSivruSearchTool(e.tool)) return e.index;
  }
  return endIdx; // fallback
}

// Exported for unit tests.
export const _internals = { pathsMatch };
