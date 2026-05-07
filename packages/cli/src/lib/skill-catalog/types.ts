// Skill catalog — pluggable database of installable skills / MCP servers
// + a matcher that ranks them against the user's repo + sessions. See
// issue #18.
//
// Three-layer extensibility (CONTRIBUTING.md):
//   1. Built-in catalog at `packages/cli/src/lib/skill-catalog/built-in.ts`
//      — ~30 curated entries covering common stacks.
//   2. Declarative override:
//        `~/.config/sivru/skills.json`  — user-global (personal skills,
//                                          private repos)
//        `.sivru/skills.json`           — per-project (overrides user-global)
//        Or load remote: `--catalog https://internal/skills.json` for
//        company-maintained catalogs (the only network call this feature
//        ever makes; observe boundary unaffected).
//   3. Code-level matchers at `.sivru/skills/*.ts` — full access to
//      repo + session shapes for company-specific recommendation logic.
//
// Implementation lands in v0.2 alongside `sivru recommend skills`.

/**
 * One ranked recommendation candidate. Matcher fires; entry surfaces.
 *
 * Stable shape. New matcher kinds can be added without breaking
 * existing entries.
 */
export type SkillEntry = {
  /** Display name shown to the user. Often matches the npm/HF identifier. */
  name: string;
  /** One-line summary of what the skill does. */
  description: string;
  /**
   * Command the user runs to install. Recommended forms:
   *   - `claude mcp add <name> -s user -- <cmd>`
   *   - `cp <skill>/SKILL.md ~/.claude/skills/<name>/`
   * Plain text; the recommender prints it as-is.
   */
  installCommand: string;
  /**
   * URL the user can visit to read about the skill before installing.
   * Recommended for any non-trivial skill.
   */
  url?: string;
  /**
   * Why this might be a good fit. The recommender uses this to explain
   * the suggestion ("we recommended X because Y").
   */
  reason?: string;
  /**
   * What the skill needs in order to be relevant. Any one match is
   * sufficient; the recommender ranks by total match strength + recency.
   */
  matchers: SkillMatcher[];
  /** Tags for category browsing (e.g., `["testing", "typescript"]`). */
  tags?: string[];
};

/**
 * Discriminated union of matcher kinds. Loader checks each entry's
 * matchers against the user's repo + session history; matches accumulate
 * a score that the ranker sorts on.
 */
export type SkillMatcher =
  | {
      kind: "dep";
      /**
       * Dependency name to look for in package.json (any of:
       * dependencies / devDependencies / peerDependencies).
       */
      name: string;
    }
  | {
      kind: "language";
      /** Primary language: `typescript` | `python` | `go` | … */
      lang: string;
    }
  | {
      kind: "filePresent";
      /** Glob pattern that must match at least one file in the repo. */
      glob: string;
    }
  | {
      kind: "sessionPattern";
      /**
       * Regex that must match against an event's text representation
       * (user_message, tool input, tool output). Used for "agent
       * struggled with X" style suggestions.
       */
      pattern: string; // serialised regex; loader compiles
      /** How many events must match before this fires (default 1). */
      minMatches?: number;
      /** Recency window in days. Default: all sessions on disk. */
      sinceDays?: number;
    }
  | {
      kind: "custom";
      /**
       * Reference to a user-provided custom matcher loaded from
       * `.sivru/skills/<id>.ts`. Loader resolves by id at runtime.
       */
      customMatcherId: string;
    };

/**
 * Top-level catalog. Loader concatenates built-in entries + user JSON +
 * remote catalog (if `--catalog <url>` was passed) and dedupes by name.
 */
export type SkillCatalog = {
  /** Schema version; bump on incompatible changes. */
  formatVersion: 1;
  /** Catalog entries. Order doesn't matter; ranker decides. */
  skills: SkillEntry[];
  /**
   * Optional metadata about the source — useful when surfaced from a
   * URL ("loaded from <company>/skills.json").
   */
  source?: {
    name?: string;
    url?: string;
    fetchedAt?: string;
  };
};

/**
 * Declarative config loaded from `~/.config/sivru/skills.json` and
 * `.sivru/skills.json`. Same shape as a SkillCatalog, plus optional
 * remote-catalog references.
 */
export type SkillsConfig = SkillCatalog & {
  /**
   * Additional remote catalogs to merge into the recommender's view.
   * Fetched once per `recommend skills` invocation (NOT during normal
   * MCP search). The observe layer remains network-free regardless.
   */
  remoteCatalogs?: string[];
};
