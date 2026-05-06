# Recipe: add a language to the chunker

Sivru's chunker has two paths: a stable line-fallback (50-line windows,
5-line overlap), and tree-sitter for semantic chunks (queued for v0.2).
This recipe covers the line-fallback path today; the tree-sitter path
follows the same registration pattern with one extra step.

## Where things live

```
packages/search/src/chunker/
├── chunk.ts            — top-level facade: chunkFile()
├── language.ts         — extension → language-id map
├── lineFallback.ts     — 50-line fixed-window chunker (always available)
├── language.test.ts
└── lineFallback.test.ts
```

## The minimum: register a new extension

If your language is *just* a new file extension that should fall through
to line-mode, the change is one line. `packages/search/src/chunker/language.ts`:

```ts
const EXT_TO_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  // ...
  ".zig": "zig",       // ← add me
};
```

Add a test in `language.test.ts` that asserts `detectLanguage("foo.zig")`
returns `"zig"`. Done. The walker will now see `.zig` files and the
line-fallback chunker will produce 50-line chunks for them.

That's enough to get search working over the new language. The cosmetic
gain is that the rendered hits show `language: "zig"` instead of `null`
in the `--json` output, and the ranking signals (which currently read
the language for path-penalty exemptions) can grow language-aware logic.

## The real win: tree-sitter (v0.2 path)

When the tree-sitter chunker lands, the registration shape is:

```ts
// packages/search/src/chunker/treeSitter.ts (v0.2 — not in main yet)

import Parser from "web-tree-sitter";

const GRAMMARS: Record<string, () => Promise<Parser.Language>> = {
  typescript: () => loadGrammar("tree-sitter-typescript"),
  python:     () => loadGrammar("tree-sitter-python"),
  zig:        () => loadGrammar("tree-sitter-zig"),  // ← add me
};

const NODE_TYPES_TO_CHUNK: Record<string, string[]> = {
  zig: ["FnProto", "ContainerDecl", "Statement"],     // ← per-language
  python: ["function_definition", "class_definition"],
  typescript: [
    "function_declaration",
    "class_declaration",
    "method_definition",
    "lexical_declaration",
  ],
};
```

Two pieces per language:

1. **Grammar loader** — `web-tree-sitter` lazy-loads a `.wasm` grammar.
   Either bundle it as an npm dep (e.g. `tree-sitter-zig`) or fetch it
   from a CDN cache at `~/.cache/sivru/grammars/`. The grammar must
   parse via `web-tree-sitter`, not the native bindings.
2. **Node-type whitelist** — the AST node types whose ranges become
   chunks. Top-level definitions and methods are the right grain; loops
   and ifs are too granular.

The dispatcher in `chunk.ts` will try tree-sitter first by extension, fall
through to line-fallback on parse error, and never let a parse failure
break indexing.

Until tree-sitter ships, **stick with the line-fallback registration** —
the extension map alone gets your language searchable.

## Test it

Add a fixture under `packages/search/src/chunker/__fixtures__/<lang>/`
with a small file in your language. Snapshot the chunks:

```ts
// packages/search/src/chunker/lineFallback.test.ts (or a new file)
it("chunks a small Zig file", () => {
  const content = readFileSync("./__fixtures__/zig/sample.zig", "utf8");
  const chunks = chunkFile("sample.zig", content);
  expect(chunks).toHaveLength(2); // file is 60 lines
  expect(chunks[0].language).toBe("zig");
});
```

Then re-run the agent-task benchmark to make sure recall didn't regress:

```bash
pnpm --filter @sivrujs/benchmarks bench:agent
```

Numbers stay comparable for line-fallback registrations; tree-sitter
additions should be a measurable improvement (track the delta in your PR).

## What to think about

- **Stop characters.** The tokenizer (`packages/search/src/bm25/tokenize.ts`)
  splits on punctuation. Languages with significant punctuation (e.g. APL,
  J) need a tokenizer pass before the chunker is useful. Open an issue
  before sending a PR for those.
- **Encoding.** All chunks are UTF-8. Files in non-UTF-8 encodings will
  produce garbage chunks. The walker uses the default Node decoder and
  doesn't sniff BOMs.
- **Comments.** Line-fallback doesn't strip comments. That's fine — comments
  carry signal for natural-language queries. Tree-sitter chunks will
  optionally include leading comments per language.

Tree-sitter integration is tracked on the v0.2.0 milestone — see
[issue #11](https://github.com/sivru/sivru/issues/11). Comment there if
you want to claim a specific language.
