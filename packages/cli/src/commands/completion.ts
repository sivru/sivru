// `sivru completion` — generate shell autocompletion script (bash, zsh, fish).
//
// Usage: sivru completion <shell>
// Outputs the completion script to stdout so users can source it.
//
// DESIGN-0021 §CLI: completion scripts are generated from a typed spec so
// adding a flag to a command updates all three shells at once. The spec is
// the single source of truth — keep it in sync with the argv parsers in
// sibling command files (search.ts, observe.ts, block.ts, …).
//
// @sivru
// schema: 1
// role: shell-completion-generator
// responsibility: emit bash/zsh/fish completion scripts derived from a canonical command spec
// collaborators: [help.ts, index.ts]
// invariants:
//   - rule: "every command exported from index.ts has a spec entry"
//     enforced-by: completion.test.ts — "spec covers every Command union member"
//   - rule: "flag descriptions stay within 60 chars so terminal columns don't wrap"
//     enforced-by: manual review
// maturity: stable
// @end

export type Shell = "bash" | "zsh" | "fish";

export type CompletionOption = {
  /** One or more flag spellings, e.g. `["-p", "--port"]` or `["--json"]` */
  flags: string[];
  description: string;
  /** When true, the flag expects a value (e.g. `--port 7676`). */
  takesValue?: boolean;
};

export type CompletionSubcommand = {
  name: string;
  description: string;
  options: CompletionOption[];
};

export type CompletionCommand = {
  name: string;
  description: string;
  options: CompletionOption[];
  subcommands?: CompletionSubcommand[];
};

export type CompletionSpec = {
  commands: CompletionCommand[];
};

// ---------------------------------------------------------------------------
// Canonical command spec — single source of truth for all three shells.
// When a new flag or subcommand lands in the CLI, add it here and the
// generators below stay correct automatically.
// ---------------------------------------------------------------------------

export const SIVRU_SPEC: CompletionSpec = {
  commands: [
    {
      name: "search",
      description: "Index path and print top-k matches",
      options: [
        { flags: ["--top"], description: "Number of results (default 10)", takesValue: true },
        { flags: ["--bm25"], description: "BM25-only (faster cold start, no model download)" },
        { flags: ["--hybrid"], description: "Explicit hybrid (default — kept for back-compat)" },
        { flags: ["--embed"], description: "Embedder short name or hf:owner/model", takesValue: true },
        { flags: ["--rerank"], description: "Cross-encoder reranker short name", takesValue: true },
        { flags: ["--rerank-top-n"], description: "Top-N candidates fed to reranker", takesValue: true },
        { flags: ["--json"], description: "Emit results as a JSON array on a single line" },
      ],
    },
    {
      name: "index",
      description: "Walk + chunk + index without searching, print stats",
      options: [
        { flags: ["--json"], description: "Emit stats as a JSON object on a single line" },
      ],
    },
    {
      name: "mcp",
      description: "Run as a stdio MCP server (used by Claude Code)",
      options: [],
    },
    {
      name: "from-git",
      description: "Clone url at depth=1, cache, and index",
      options: [
        { flags: ["-r", "--ref"], description: "Branch / tag / commit to check out", takesValue: true },
        { flags: ["--allow-private-urls"], description: "Skip the SSRF guard" },
        { flags: ["--json"], description: "Emit a JSON object on a single line" },
      ],
    },
    {
      name: "session",
      description: "Claude Code sessions subcommands",
      options: [],
      subcommands: [
        {
          name: "list",
          description: "List Claude Code sessions",
          options: [
            { flags: ["--all"], description: "Include older sessions beyond the default 20" },
            { flags: ["--json"], description: "Emit JSON instead of a text table" },
            { flags: ["--projects-root"], description: "Override projects directory", takesValue: true },
          ],
        },
        {
          name: "show",
          description: "Stream events for one session",
          options: [
            { flags: ["--limit"], description: "Cap events streamed", takesValue: true },
            { flags: ["--projects-root"], description: "Override projects directory", takesValue: true },
          ],
        },
      ],
    },
    {
      name: "observe",
      description: "Local web UI + HTTP API",
      options: [
        { flags: ["-p", "--port"], description: "Server port (default 7676)", takesValue: true },
        { flags: ["--host"], description: "Listen host (default 127.0.0.1)", takesValue: true },
        { flags: ["--no-ui"], description: "Skip mounting the observe-ui dist" },
        { flags: ["--writable"], description: "Enable mutation routes (loopback only)" },
        { flags: ["--log-json"], description: "Emit structured JSON logs" },
      ],
      subcommands: [
        {
          name: "init",
          description: "One-shot setup: register MCP + write CLAUDE.md + subagent",
          options: [
            { flags: ["--dry-run"], description: "Show changes without writing" },
            { flags: ["--skip-mcp"], description: "Disable MCP registration" },
            { flags: ["--skip-claude-md"], description: "Disable writing CLAUDE.md" },
            { flags: ["--skip-subagent"], description: "Disable writing subagent file" },
            { flags: ["--cwd"], description: "Override the project directory", takesValue: true },
          ],
        },
        {
          name: "replay",
          description: "Static counterfactual replay for one session",
          options: [
            { flags: ["--json"], description: "Emit JSON instead of text" },
            { flags: ["--since"], description: "Only include sessions updated in last N days", takesValue: true },
            { flags: ["--projects-root"], description: "Override projects directory", takesValue: true },
          ],
        },
        {
          name: "costs",
          description: "Aggregate counterfactual rollup across sessions",
          options: [
            { flags: ["--json"], description: "Emit JSON instead of text" },
            { flags: ["--since"], description: "Only include sessions updated in last N days", takesValue: true },
            { flags: ["--projects-root"], description: "Override projects directory", takesValue: true },
          ],
        },
      ],
    },
    {
      name: "doctor",
      description: "Preflight + diagnostic checks",
      options: [
        { flags: ["--json"], description: "Emit a structured JSON report" },
      ],
    },
    {
      name: "bench",
      description: "Benchmarking subcommands",
      options: [],
      subcommands: [
        {
          name: "personal",
          description: "Benchmark sivru on YOUR sessions + repos",
          options: [
            { flags: ["--models"], description: "Comma-separated model short names", takesValue: true },
            { flags: ["--n"], description: "Max queries per repo", takesValue: true },
            { flags: ["--since"], description: "Only include sessions in the last N days", takesValue: true },
            { flags: ["--repo"], description: "Restrict to one repo", takesValue: true },
            { flags: ["--json"], description: "Emit a structured JSON report" },
          ],
        },
        {
          name: "models",
          description: "List registered embedding models with metadata",
          options: [],
        },
      ],
    },
    {
      name: "config",
      description: "Manage persistent CLI settings",
      options: [],
      subcommands: [
        { name: "get", description: "Get config value", options: [] },
        { name: "set", description: "Set config value", options: [] },
        { name: "unset", description: "Unset config value", options: [] },
        { name: "list", description: "List config values", options: [] },
      ],
    },
    {
      name: "skill",
      description: "Install/remove Claude Code routing skill",
      options: [],
      subcommands: [
        {
          name: "install",
          description: "Install the Claude Code routing skill",
          options: [
            { flags: ["--project"], description: "Install into project skills dir" },
            { flags: ["--force"], description: "Overwrite even a non-sivru file" },
            { flags: ["--cwd"], description: "Directory to resolve git root from", takesValue: true },
          ],
        },
        {
          name: "uninstall",
          description: "Remove the Claude Code routing skill",
          options: [
            { flags: ["--project"], description: "Remove from project skills dir" },
            { flags: ["--cwd"], description: "Directory to resolve git root from", takesValue: true },
          ],
        },
      ],
    },
    {
      name: "explain",
      description: "Public API, callers, callees, churn & ownership",
      options: [
        { flags: ["--json"], description: "Emit ExplainArtifact JSON" },
        { flags: ["--since"], description: "Churn window in days", takesValue: true },
        { flags: ["--depth"], description: "Call-graph depth", takesValue: true },
        { flags: ["--repo"], description: "Repo root to resolve path against", takesValue: true },
      ],
    },
    {
      name: "block",
      description: "Lint/extract @sivru annotation blocks",
      options: [],
      subcommands: [
        {
          name: "validate",
          description: "Lint every @sivru block under path",
          options: [
            { flags: ["--json"], description: "Emit output as JSON" },
            { flags: ["--autofix"], description: "Apply autofixes to source files" },
            { flags: ["--allow-dirty"], description: "Allow autofix on files with uncommitted changes" },
            { flags: ["--changed-since"], description: "Git ref to diff against", takesValue: true },
          ],
        },
        {
          name: "extract",
          description: "Emit every block + diagnostics as JSON",
          options: [
            { flags: ["--json"], description: "Emit output as JSON" },
          ],
        },
        {
          name: "check-enforcement",
          description: "Walk enforced-by references and report gaps",
          options: [
            { flags: ["--changed-since"], description: "Git ref to diff against", takesValue: true },
          ],
        },
        {
          name: "staleness",
          description: "Diff-aware staleness check",
          options: [
            { flags: ["--since"], description: "Git ref to diff against", takesValue: true },
            { flags: ["--strict"], description: "Fail on warnings as well as errors" },
            { flags: ["--json"], description: "Emit output as JSON" },
          ],
        },
        {
          name: "graph",
          description: "Cross-block consistency graph",
          options: [
            { flags: ["--check"], description: "Exit non-zero on any diagnostic" },
            { flags: ["--json"], description: "Emit output as JSON" },
            { flags: ["--changed-since"], description: "Git ref to diff against", takesValue: true },
          ],
        },
        {
          name: "init",
          description: "Scaffold a starter @sivru block",
          options: [
            { flags: ["--write"], description: "Write the block to the file (default: preview)" },
            { flags: ["--symbol"], description: "Target symbol name", takesValue: true },
            { flags: ["--force"], description: "Overwrite an existing block" },
          ],
        },
        {
          name: "check-bridges",
          description: "Annotation→invariant bridge audit",
          options: [
            { flags: ["--changed-since"], description: "Git ref to diff against", takesValue: true },
          ],
        },
      ],
    },
    {
      name: "checkup",
      description: "Run coach loop checks",
      options: [
        { flags: ["--json"], description: "Emit output as JSON" },
        { flags: ["--check"], description: "Run specific check by ID", takesValue: true },
        { flags: ["--no-git"], description: "Skip git checks" },
      ],
    },
    {
      name: "completion",
      description: "Generate shell autocompletion script",
      options: [],
    },
    {
      name: "version",
      description: "Print the version",
      options: [],
    },
    {
      name: "help",
      description: "Print help text",
      options: [],
    },
  ],
};

// ---------------------------------------------------------------------------
// Shell generators
// ---------------------------------------------------------------------------

function zshQuote(s: string): string {
  return s.replace(/'/g, "'\\''");
}

function bashQuote(s: string): string {
  return s.replace(/"/g, '\\"');
}

function fishQuote(s: string): string {
  return s.replace(/"/g, '\\"');
}

function zshOptSpec(opt: CompletionOption): string {
  const desc = zshQuote(opt.description);
  const flagSpec = opt.flags.map((f) => f.replace(/^--/, "").replace(/^-/, "")).join(" ");
  const flagExpr = opt.flags.length === 1
    ? opt.flags[0]!
    : `(${opt.flags.join(" ")}){${opt.flags.join(",")}}`;
  if (opt.takesValue) {
    return `'${flagExpr}[${desc}]:${flagSpec}:'`;
  }
  return `'${flagExpr}[${desc}]'`;
}

export function generateZsh(spec: CompletionSpec): string {
  const commandEntries = spec.commands
    .map((c) => `    '${zshQuote(c.name)}:${zshQuote(c.description)}'`)
    .join("\n");

  let body = `#compdef sivru

_sivru() {
  local -a commands
  commands=(
${commandEntries}
  )

  _arguments -C \\
    '1: :->command' \\
    '*:: :->args'

  case \$state in
    command)
      _describe -t commands 'sivru command' commands
      ;;
    args)
      case \$line[1] in
`;

  for (const cmd of spec.commands) {
    body += `        ${cmd.name})\n`;

    const hasTopLevelOpts = cmd.options.length > 0;
    const hasSubcommands = cmd.subcommands && cmd.subcommands.length > 0;

    if (hasSubcommands) {
      // Commands with subcommands: use _arguments for top-level opts, then
      // branch into subcommands.
      if (hasTopLevelOpts) {
        body += `          _arguments \\
`;
        for (const opt of cmd.options) {
          body += `            ${zshOptSpec(opt)} \\
`;
        }
        body += `            '1: :->subcmd' \\
            '*:: :->subargs'\n`;
        body += `          case \$state in\n            subcmd)\n`;
      } else {
        body += `          if (( CURRENT == 2 )); then\n`;
      }

      const subList = cmd.subcommands!
        .map((s) => `            '${zshQuote(s.name)}:${zshQuote(s.description)}'`)
        .join("\n");
      body += `              local -a ${cmd.name}_cmds\n              ${cmd.name}_cmds=(\n${subList}\n              )\n              _describe -t ${cmd.name}_cmds '${cmd.name} subcommand' ${cmd.name}_cmds\n`;

      if (hasTopLevelOpts) {
        body += `              ;;\n            subargs)\n              shift words\n              (( CURRENT-- ))\n              case \$words[1] in\n`;
      } else {
        body += `          else\n            shift words\n            (( CURRENT-- ))\n            case \$words[1] in\n`;
      }

      for (const sub of cmd.subcommands!) {
        body += `                ${sub.name})\n                  _arguments \\
`;
        for (const opt of sub.options) {
          body += `                    ${zshOptSpec(opt)} \\
`;
        }
        body += `                  ;;\n`;
      }

      if (hasTopLevelOpts) {
        body += `              esac\n              ;;\n          esac\n`;
      } else {
        body += `            esac\n          fi\n`;
      }
    } else if (hasTopLevelOpts) {
      body += `          _arguments \\
`;
      for (const opt of cmd.options) {
        body += `            ${zshOptSpec(opt)} \\
`;
      }
      // Directory completion for commands that take a path.
      if (cmd.name === "search" || cmd.name === "index") {
        body += `            '*:Directory:_files -/'\n`;
      } else {
        body += `            '*:File:_files'\n`;
      }
    }

    body += `          ;;\n`;
  }

  body += `      esac\n      ;;\n  esac\n}\ncompdef _sivru sivru\n`;
  return body;
}

export function generateBash(spec: CompletionSpec): string {
  const commandList = spec.commands.map((c) => c.name).join(" ");

  let body = `_sivru_completions() {
  local cur prev opts
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  local commands="${commandList}"

  if [ \$COMP_CWORD -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "\${commands}" -- \${cur}) )
    return 0
  fi

  case "\${COMP_WORDS[1]}" in
`;

  for (const cmd of spec.commands) {
    body += `    ${cmd.name})\n`;

    const hasSubcommands = cmd.subcommands && cmd.subcommands.length > 0;
    const allTopWords = [
      ...(cmd.subcommands?.map((s) => s.name) ?? []),
      ...cmd.options.flatMap((o) => o.flags),
    ].join(" ");

    if (hasSubcommands) {
      body += `      if [ \$COMP_CWORD -eq 2 ]; then\n        COMPREPLY=( \$(compgen -W "${allTopWords}" -- \${cur}) )\n      else\n        case "\${COMP_WORDS[2]}" in\n`;
      for (const sub of cmd.subcommands!) {
        const subOpts = sub.options.flatMap((o) => o.flags).join(" ");
        body += `          ${sub.name}) COMPREPLY=( \$(compgen -W "${subOpts}" -- \${cur}) ) ;;\n`;
      }
      // If the second word is a flag (e.g. --port), offer no further completions.
      body += `          *) COMPREPLY=() ;;\n`;
      body += `        esac\n      fi\n`;
    } else if (cmd.options.length > 0) {
      const opts = cmd.options.flatMap((o) => o.flags).join(" ");
      body += `      COMPREPLY=( \$(compgen -W "${opts}" -- \${cur}) )\n`;
    }

    body += `      ;;\n`;
  }

  body += `  esac\n}\ncomplete -F _sivru_completions sivru\n`;
  return body;
}

export function generateFish(spec: CompletionSpec): string {
  let body = `# Disable file completion by default
complete -c sivru -f

`;

  for (const cmd of spec.commands) {
    const desc = fishQuote(cmd.description);
    body += `complete -c sivru -n "not __fish_use_subcommand" -a ${cmd.name} -d "${desc}"\n`;
  }

  body += `\n`;

  for (const cmd of spec.commands) {
    for (const opt of cmd.options) {
      const desc = fishQuote(opt.description);
      const cond = `__fish_seen_subcommand_from ${cmd.name}`;
      for (const flag of opt.flags) {
        if (flag.startsWith("--")) {
          body += `complete -c sivru -n "${cond}" -l ${flag.slice(2)} -d "${desc}"\n`;
        } else if (flag.startsWith("-")) {
          body += `complete -c sivru -n "${cond}" -s ${flag.slice(1)} -l ${opt.flags.find((f) => f.startsWith("--"))?.slice(2) ?? ""} -d "${desc}"\n`;
        }
      }
    }

    if (cmd.subcommands) {
      for (const sub of cmd.subcommands) {
        const subCond = `__fish_seen_subcommand_from ${cmd.name}`;
        body += `complete -c sivru -n "${subCond}" -a ${sub.name} -d "${fishQuote(sub.description)}"\n`;

        for (const opt of sub.options) {
          const desc = fishQuote(opt.description);
          const fullCond = `${subCond}; and __fish_seen_subcommand_from ${sub.name}`;
          for (const flag of opt.flags) {
            if (flag.startsWith("--")) {
              body += `complete -c sivru -n "${fullCond}" -l ${flag.slice(2)} -d "${desc}"\n`;
            } else if (flag.startsWith("-")) {
              body += `complete -c sivru -n "${fullCond}" -s ${flag.slice(1)} -l ${opt.flags.find((f) => f.startsWith("--"))?.slice(2) ?? ""} -d "${desc}"\n`;
            }
          }
        }
      }
    }
  }

  return body;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runCompletion(argv: readonly string[]): Promise<number> {
  const shell = argv[1];

  if (!shell) {
    process.stderr.write(
      "sivru completion: missing shell argument. Available: bash, zsh, fish\n" +
        "Usage:\n" +
        "  source <(sivru completion zsh)   # zsh\n" +
        "  source <(sivru completion bash)  # bash\n" +
        "  sivru completion fish | source   # fish\n",
    );
    return 2;
  }

  const normalized = shell.toLowerCase();
  if (normalized === "zsh" || normalized === "bash" || normalized === "fish") {
    const script = normalized === "zsh"
      ? generateZsh(SIVRU_SPEC)
      : normalized === "bash"
        ? generateBash(SIVRU_SPEC)
        : generateFish(SIVRU_SPEC);
    process.stdout.write(script + "\n");
    return 0;
  }

  process.stderr.write(
    `sivru completion: unknown shell "${shell}". Available: bash, zsh, fish\n`,
  );
  return 2;
}
