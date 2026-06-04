// `sivru completion` — generate shell autocompletion script (bash, zsh, fish).
//
// Usage: sivru completion <shell>
// Outputs the completion script to stdout so users can source it.

const ZSH_COMPLETION = `#compdef sivru

_sivru() {
  local -a commands
  commands=(
    'search:Index path and print top-k matches'
    'index:Walk + chunk + index without searching, print stats'
    'mcp:Run as a stdio MCP server'
    'from-git:Clone url at depth=1, cache, and index'
    'session:Claude Code sessions subcommands'
    'observe:Local web UI + HTTP API'
    'doctor:Preflight + diagnostic checks'
    'bench:Benchmarking subcommands'
    'config:Manage persistent CLI settings'
    'skill:Install/remove Claude Code routing skill'
    'explain:Public API, callers, callees, churn & ownership'
    'block:Lint/extract @sivru annotation blocks'
    'checkup:Run coach loop checks'
    'completion:Generate shell autocompletion script'
    'version:Print the version'
    'help:Print help text'
  )

  _arguments -C \\
    '1: :->command' \
    '*:: :->args'

  case $state in
    command)
      _describe -t commands 'sivru command' commands
      ;;
    args)
      case $line[1] in
        search)
          _arguments \\
            '--top=[Number of results (default 10)]' \\
            '--bm25[BM25-only (faster cold start, no model download)]' \\
            '--hybrid[Explicit hybrid]' \\
            '--json[Emit results as a JSON array on a single line]' \\
            '*:Directory:_files -/'
          ;;
        index)
          _arguments \\
            '--json[Emit stats as a JSON object on a single line]' \\
            '*:Directory:_files -/'
          ;;
        from-git)
          _arguments \\
            '(-r --ref)'{-r,--ref}'[Branch / tag / commit to check out (default HEAD)]' \\
            '--allow-private-urls[Skip the SSRF guard]' \\
            '--json[Emit a JSON object on a single line]'
          ;;
        session)
          local -a session_cmds
          session_cmds=(
            'list:List Claude Code sessions'
            'show:Stream events for one session'
          )
          if (( CURRENT == 2 )); then
            _describe -t session_cmds 'session subcommand' session_cmds
          else
            shift words
            (( CURRENT-- ))
            case $words[1] in
              list)
                _arguments \\
                  '--all[Include older sessions beyond the default 20]' \\
                  '--json[Emit JSON instead of a text table]' \\
                  '--projects-root=[Override projects directory]'
                ;;
              show)
                _arguments \\
                  '--limit=[Cap events streamed]' \\
                  '--projects-root=[Override projects directory]'
                ;;
            esac
          fi
          ;;
        observe)
          local -a observe_cmds
          observe_cmds=(
            'init:One-shot setup: register MCP + write CLAUDE.md'
            'replay:Static counterfactual replay for one session'
            'costs:Aggregate counterfactual rollup across sessions'
          )
          if (( CURRENT == 2 )); then
            _describe -t observe_cmds 'observe subcommand' observe_cmds
          else
            shift words
            (( CURRENT-- ))
            case $words[1] in
              init)
                _arguments \\
                  '--dry-run[Show changes without writing]' \\
                  '--skip-mcp[Disable MCP registration]' \\
                  '--skip-claude-md[Disable writing CLAUDE.md]' \\
                  '--skip-subagent[Disable writing subagent file]' \\
                  '--cwd=[Override the project directory]'
                ;;
              replay|costs)
                _arguments \\
                  '--json[Emit JSON instead of text]' \\
                  '--since=[Only include sessions updated in last N days]' \\
                  '--projects-root=[Override projects directory]'
                ;;
            esac
          fi
          ;;
        doctor)
          _arguments \\
            '--json[Emit a structured JSON report]'
          ;;
        bench)
          local -a bench_cmds
          bench_cmds=(
            'personal:Benchmark sivru on YOUR sessions + repos'
            'models:List registered embedding models'
          )
          if (( CURRENT == 2 )); then
            _describe -t bench_cmds 'bench subcommand' bench_cmds
          else
            shift words
            (( CURRENT-- ))
            case $words[1] in
              personal)
                _arguments \\
                  '--models=[Comma-separated short names]' \\
                  '--n=[Max queries per repo]' \\
                  '--since=[Only include sessions in the last N days]' \\
                  '--repo=[Restrict to one repo]' \\
                  '--json[Emit a structured JSON report]'
                ;;
            esac
          fi
          ;;
        config)
          local -a config_cmds
          config_cmds=(
            'get:Get config value'
            'set:Set config value'
            'unset:Unset config value'
            'list:List config values'
          )
          _describe -t config_cmds 'config subcommand' config_cmds
          ;;
        skill)
          local -a skill_cmds
          skill_cmds=(
            'install:Install the Claude Code routing skill'
            'uninstall:Remove the Claude Code routing skill'
          )
          if (( CURRENT == 2 )); then
            _describe -t skill_cmds 'skill subcommand' skill_cmds
          else
            _arguments \\
              '--project[Install into <git repo root>/.claude/skills/]' \\
              '--force[Overwrite even a non-sivru file]' \\
              '--cwd=[Directory to resolve git root from]'
          fi
          ;;
        explain)
          _arguments \\
            '--json[Emit ExplainArtifact JSON]' \\
            '--since=[Churn window in days]' \\
            '--depth=[Call-graph depth]' \\
            '--repo=[Repo root to resolve path against]'
          ;;
        block)
          local -a block_cmds
          block_cmds=(
            'validate:Lint @sivru annotation blocks'
            'extract:Emit every block + diagnostics as JSON'
          )
          if (( CURRENT == 2 )); then
            _describe -t block_cmds 'block subcommand' block_cmds
          else
            _arguments \\
              '--json[Emit output as JSON]'
          fi
          ;;
        checkup)
          _arguments \\
            '--json[Emit output as JSON]' \\
            '--check=[Run specific check by ID]' \\
            '--no-git[Skip git checks]'
          ;;
      esac
      ;;
  esac
}
compdef _sivru sivru
`;

const BASH_COMPLETION = `_sivru_completions() {
  local cur prev opts
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  local commands="search index mcp from-git session observe doctor bench config skill explain block checkup completion version help"

  if [ \$COMP_CWORD -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "\${commands}" -- \${cur}) )
    return 0
  fi

  case "\${COMP_WORDS[1]}" in
    search)
      COMPREPLY=( \$(compgen -W "--top --bm25 --hybrid --json" -- \${cur}) )
      ;;
    index)
      COMPREPLY=( \$(compgen -W "--json" -- \${cur}) )
      ;;
    from-git)
      COMPREPLY=( \$(compgen -W "-r --ref --allow-private-urls --json" -- \${cur}) )
      ;;
    session)
      if [ \$COMP_CWORD -eq 2 ]; then
        COMPREPLY=( \$(compgen -W "list show" -- \${cur}) )
      else
        case "\${COMP_WORDS[2]}" in
          list) COMPREPLY=( \$(compgen -W "--all --json --projects-root" -- \${cur}) ) ;;
          show) COMPREPLY=( \$(compgen -W "--limit --projects-root" -- \${cur}) ) ;;
        esac
      fi
      ;;
    observe)
      if [ \$COMP_CWORD -eq 2 ]; then
        COMPREPLY=( \$(compgen -W "init replay costs" -- \${cur}) )
      else
        case "\${COMP_WORDS[2]}" in
          init) COMPREPLY=( \$(compgen -W "--dry-run --skip-mcp --skip-claude-md --skip-subagent --cwd" -- \${cur}) ) ;;
          replay|costs) COMPREPLY=( \$(compgen -W "--json --since --projects-root" -- \${cur}) ) ;;
        esac
      fi
      ;;
    doctor)
      COMPREPLY=( \$(compgen -W "--json" -- \${cur}) )
      ;;
    bench)
      if [ \$COMP_CWORD -eq 2 ]; then
        COMPREPLY=( \$(compgen -W "personal models" -- \${cur}) )
      else
        case "\${COMP_WORDS[2]}" in
          personal) COMPREPLY=( \$(compgen -W "--models --n --since --repo --json" -- \${cur}) ) ;;
        esac
      fi
      ;;
    config)
      if [ \$COMP_CWORD -eq 2 ]; then
        COMPREPLY=( \$(compgen -W "get set unset list" -- \${cur}) )
      fi
      ;;
    skill)
      if [ \$COMP_CWORD -eq 2 ]; then
        COMPREPLY=( \$(compgen -W "install uninstall" -- \${cur}) )
      else
        COMPREPLY=( \$(compgen -W "--project --force --cwd" -- \${cur}) )
      fi
      ;;
    explain)
      COMPREPLY=( \$(compgen -W "--json --since --depth --repo" -- \${cur}) )
      ;;
    block)
      if [ \$COMP_CWORD -eq 2 ]; then
        COMPREPLY=( \$(compgen -W "validate extract" -- \${cur}) )
      else
        COMPREPLY=( \$(compgen -W "--json" -- \${cur}) )
      fi
      ;;
    checkup)
      COMPREPLY=( \$(compgen -W "--json --check --no-git" -- \${cur}) )
      ;;
  esac
}
complete -F _sivru_completions sivru
`;

const FISH_COMPLETION = `# Disable file completion by default
complete -c sivru -f

# Main commands
complete -c sivru -n "not __fish_use_subcommand" -a search -d "Index path and print top-k matches"
complete -c sivru -n "not __fish_use_subcommand" -a index -d "Walk + chunk + index without searching"
complete -c sivru -n "not __fish_use_subcommand" -a mcp -d "Run as a stdio MCP server"
complete -c sivru -n "not __fish_use_subcommand" -a from-git -d "Clone url at depth=1, cache, and index"
complete -c sivru -n "not __fish_use_subcommand" -a session -d "Claude Code sessions subcommands"
complete -c sivru -n "not __fish_use_subcommand" -a observe -d "Local web UI + HTTP API"
complete -c sivru -n "not __fish_use_subcommand" -a doctor -d "Preflight + diagnostic checks"
complete -c sivru -n "not __fish_use_subcommand" -a bench -d "Benchmarking subcommands"
complete -c sivru -n "not __fish_use_subcommand" -a config -d "Manage persistent CLI settings"
complete -c sivru -n "not __fish_use_subcommand" -a skill -d "Install/remove Claude Code routing skill"
complete -c sivru -n "not __fish_use_subcommand" -a explain -d "Public API, callers, callees, churn & ownership"
complete -c sivru -n "not __fish_use_subcommand" -a block -d "Lint/extract @sivru annotation blocks"
complete -c sivru -n "not __fish_use_subcommand" -a checkup -d "Run coach loop checks"
complete -c sivru -n "not __fish_use_subcommand" -a completion -d "Generate shell autocompletion script"
complete -c sivru -n "not __fish_use_subcommand" -a version -d "Print the version"
complete -c sivru -n "not __fish_use_subcommand" -a help -d "Print help text"

# Option completions
# search
complete -c sivru -n "__fish_seen_subcommand_from search" -l top -d "Number of results"
complete -c sivru -n "__fish_seen_subcommand_from search" -l bm25 -d "BM25-only"
complete -c sivru -n "__fish_seen_subcommand_from search" -l hybrid -d "Explicit hybrid"
complete -c sivru -n "__fish_seen_subcommand_from search" -l json -d "Emit results as a JSON array"

# index
complete -c sivru -n "__fish_seen_subcommand_from index" -l json -d "Emit stats as a JSON object"

# from-git
complete -c sivru -n "__fish_seen_subcommand_from from-git" -s r -l ref -d "Branch/tag/commit to check out"
complete -c sivru -n "__fish_seen_subcommand_from from-git" -l allow-private-urls -d "Skip SSRF guard"
complete -c sivru -n "__fish_seen_subcommand_from from-git" -l json -d "Emit JSON on a single line"

# session
complete -c sivru -n "__fish_seen_subcommand_from session" -a "list show"
complete -c sivru -n "__fish_seen_subcommand_from session; and __fish_seen_subcommand_from list" -l all -d "Include older sessions"
complete -c sivru -n "__fish_seen_subcommand_from session; and __fish_seen_subcommand_from list" -l json -d "Emit JSON instead of text"
complete -c sivru -n "__fish_seen_subcommand_from session" -l projects-root -d "Override projects directory"
complete -c sivru -n "__fish_seen_subcommand_from session; and __fish_seen_subcommand_from show" -l limit -d "Cap events streamed"

# observe
complete -c sivru -n "__fish_seen_subcommand_from observe" -a "init replay costs"
complete -c sivru -n "__fish_seen_subcommand_from observe; and __fish_seen_subcommand_from init" -l dry-run -d "Show changes without writing"
complete -c sivru -n "__fish_seen_subcommand_from observe; and __fish_seen_subcommand_from init" -l skip-mcp -d "Disable MCP registration"
complete -c sivru -n "__fish_seen_subcommand_from observe; and __fish_seen_subcommand_from init" -l skip-claude-md -d "Disable writing CLAUDE.md"
complete -c sivru -n "__fish_seen_subcommand_from observe; and __fish_seen_subcommand_from init" -l skip-subagent -d "Disable writing subagent file"
complete -c sivru -n "__fish_seen_subcommand_from observe; and __fish_seen_subcommand_from init" -l cwd -d "Override project directory"
complete -c sivru -n "__fish_seen_subcommand_from observe" -s p -l port -d "Server port"
complete -c sivru -n "__fish_seen_subcommand_from observe" -l host -d "Listen host"
complete -c sivru -n "__fish_seen_subcommand_from observe" -l no-ui -d "Skip mounting observe-ui"
complete -c sivru -n "__fish_seen_subcommand_from observe; and __fish_seen_subcommand_from replay costs" -l json -d "Emit JSON"
complete -c sivru -n "__fish_seen_subcommand_from observe; and __fish_seen_subcommand_from replay costs" -l since -d "Include sessions updated in last N days"
complete -c sivru -n "__fish_seen_subcommand_from observe; and __fish_seen_subcommand_from replay costs" -l projects-root -d "Override projects directory"

# doctor
complete -c sivru -n "__fish_seen_subcommand_from doctor" -l json -d "Emit structured JSON report"

# bench
complete -c sivru -n "__fish_seen_subcommand_from bench" -a "personal models"
complete -c sivru -n "__fish_seen_subcommand_from bench; and __fish_seen_subcommand_from personal" -l models -d "Comma-separated model names"
complete -c sivru -n "__fish_seen_subcommand_from bench; and __fish_seen_subcommand_from personal" -l n -d "Max queries per repo"
complete -c sivru -n "__fish_seen_subcommand_from bench; and __fish_seen_subcommand_from personal" -l since -d "Only include sessions in last N days"
complete -c sivru -n "__fish_seen_subcommand_from bench; and __fish_seen_subcommand_from personal" -l repo -d "Restrict to one repo"
complete -c sivru -n "__fish_seen_subcommand_from bench; and __fish_seen_subcommand_from personal" -l json -d "Emit JSON report"

# config
complete -c sivru -n "__fish_seen_subcommand_from config" -a "get set unset list"

# skill
complete -c sivru -n "__fish_seen_subcommand_from skill" -a "install uninstall"
complete -c sivru -n "__fish_seen_subcommand_from skill" -l project -d "Install into project skills dir"
complete -c sivru -n "__fish_seen_subcommand_from skill" -l force -d "Overwrite non-sivru file"
complete -c sivru -n "__fish_seen_subcommand_from skill" -l cwd -d "Resolve git root from directory"

# explain
complete -c sivru -n "__fish_seen_subcommand_from explain" -l json -d "Emit ExplainArtifact JSON"
complete -c sivru -n "__fish_seen_subcommand_from explain" -l since -d "Churn window in days"
complete -c sivru -n "__fish_seen_subcommand_from explain" -l depth -d "Call-graph depth"
complete -c sivru -n "__fish_seen_subcommand_from explain" -l repo -d "Repo root"

# block
complete -c sivru -n "__fish_seen_subcommand_from block" -a "validate extract"
complete -c sivru -n "__fish_seen_subcommand_from block" -l json -d "Emit output as JSON"

# checkup
complete -c sivru -n "__fish_seen_subcommand_from checkup" -l json -d "Emit output as JSON"
complete -c sivru -n "__fish_seen_subcommand_from checkup" -l check -d "Run specific check by ID"
complete -c sivru -n "__fish_seen_subcommand_from checkup" -l no-git -d "Skip git checks"
`;

export async function runCompletion(argv: readonly string[]): Promise<number> {
  const shell = argv[1];

  if (!shell) {
    process.stderr.write(
      "sivru completion: missing shell argument. Available: bash, zsh, fish\n" +
        "Usage:\n" +
        "  source <(sivru completion zsh)  # zsh\n" +
        "  source <(sivru completion bash) # bash\n" +
        "  sivru completion fish | source  # fish\n"
    );
    return 2;
  }

  switch (shell.toLowerCase()) {
    case "zsh":
      process.stdout.write(ZSH_COMPLETION + "\n");
      return 0;
    case "bash":
      process.stdout.write(BASH_COMPLETION + "\n");
      return 0;
    case "fish":
      process.stdout.write(FISH_COMPLETION + "\n");
      return 0;
    default:
      process.stderr.write(
        `sivru completion: unknown shell "${shell}". Available: bash, zsh, fish\n`
      );
      return 2;
  }
}
