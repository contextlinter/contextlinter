![ContextLinter](./assets/logo.svg)

![CI](https://github.com/contextlinter/contextlinter/actions/workflows/ci.yml/badge.svg)
![npm](https://img.shields.io/npm/v/contextlinter)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node](https://img.shields.io/node/v/contextlinter)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)

---

ContextLinter reads your Claude Code session history, finds patterns in how you correct the AI, and turns them into CLAUDE.md rules. You review every suggestion before it's applied.

<p align="center">
  <img src="assets/demo.gif" alt="ContextLinter demo" width="720" />
</p>

## Quick start

```bash
cd your-project
npx contextlinter analyze
```

No config files, no API keys. It uses your existing Claude Code CLI to call the LLM.

## What it actually does

Every time you correct Claude Code — "no, use pnpm not npm", "we don't put tests there", "I told you to use the existing helper" — that's a rule waiting to be written. ContextLinter finds those patterns automatically:

1. **Reads** session transcripts from `~/.claude/projects/`
2. **Analyzes** each conversation for corrections, rejected approaches, repeated clarifications, and established conventions (up to 3 sessions in parallel)
3. **Generates** rule suggestions per session with incremental dedup, streaming results as they complete
4. **Synthesizes** cross-session patterns (things you correct in multiple sessions)
5. **Presents** an interactive review where you accept, reject, or edit each change

The `analyze` command processes sessions in parallel (up to 3 at a time), generates suggestions with incremental dedup, and runs cross-session synthesis at the end. Then use `review` to interactively accept, reject, or edit each suggestion.

## What kinds of insights does it find?

| Category | Example |
|---|---|
| **Repeated correction** | You keep telling Claude to use `vitest` instead of `jest` |
| **Rejected approach** | Claude suggests Redux, you always switch to Zustand |
| **Missing project knowledge** | Claude doesn't know your monorepo structure |
| **Convention establishment** | You consistently enforce a naming pattern |
| **Tool/command correction** | "Use `pnpm`, not `npm`" across sessions |
| **Intent clarification** | You regularly have to re-explain what a module does |

Each insight includes evidence (quoted messages), a confidence score, and a suggested rule.

## Example output

```
  contextlinter v0.2.5
  Analyze · /Users/you/work/my-app

▸ Analyzing Sessions
  4 to analyze, 6 already done

    Analyzing session a1b2c3d (12 user msgs)...
  ✓ 3 insights (8.2s)
    2 suggestions generated
    Analyzing session f6e5d4c (8 user msgs)...
  ✓ 2 insights (5.1s)
    1 suggestion generated
  ✓ 1 cross-session pattern found

  3 suggestions ready
  └ Run contextlinter review to apply
```

Then run `contextlinter review`:

```
▸ 3 suggestions to review
  ├ Priority: 1 high, 1 medium, 1 low
  └ Types: 2 add, 1 update

[1/3]  Add rule to CLAUDE.md § "Testing"         HIGH  92%

    + - Always use vitest, never jest
    + - Run `pnpm test` before committing

    Rationale: User corrected test runner choice in 3 separate sessions

[a]ccept  [r]eject  [e]dit  [s]kip  [q]uit
>
```

## Commands

| Command | Description |
|---|---|
| `analyze` | Analyze sessions and generate rule suggestions |
| `review` | Review and apply suggestions interactively |
| `list` | Show analyzed sessions for the current project |
| `watch` | Monitor for new sessions and auto-analyze |
| `rules` | Show current rules files and statistics |
| `init` | Create a `/contextlinter` slash command for Claude Code |

## Options

| Flag | Description |
|---|---|
| `--limit N` | Analyze only the N newest sessions |
| `--min-messages N` | Skip sessions shorter than N user messages (default: 2) |
| `--model <model>` | LLM model: `sonnet` (default), `opus`, `haiku` |
| `--min-confidence N` | Only apply suggestions above this confidence (0.0-1.0) |
| `--project <path>` | Target a specific project directory |
| `--all` | Analyze all projects (default: current directory only) |
| `--session <id>` | Show details for a specific session |
| `--yes` | Auto-confirm all prompts |
| `--dry-run` | Preview what would happen without writing files |
| `--verbose` | Show detailed progress and debug info |
| `--force` | Re-analyze sessions even if already processed |
| `--no-cross` | Skip cross-session pattern synthesis |

**Watch options:**

| Flag | Description |
|---|---|
| `--interval N` | Poll interval in seconds (default: 300) |
| `--cooldown N` | Wait before analyzing a new session (default: 60) |
| `--no-suggest` | Only analyze, don't generate suggestions |

## Requirements

- **Node.js 20+**
- **Claude Code CLI** installed and authenticated (`claude -p` must work)
- At least a few Claude Code sessions in the target project

## How suggestions get applied

ContextLinter never writes to your files without asking. The `review` command shows each suggestion as a diff and waits for your input:

- **accept** — write the change to disk
- **reject** — skip permanently
- **edit** — modify the suggested text before applying
- **skip** — skip for now (stays pending)

Backups are created before every file modification. A history log is saved to `.contextlinter/history.jsonl`.

Suggestion types:

| Type | What it does |
|---|---|
| `add` | Adds a new rule to a section |
| `update` | Replaces an existing section's content |
| `remove` | Deletes a stale or incorrect rule |
| `consolidate` | Merges duplicate/overlapping rules |
| `split` | Extracts a large section into `.claude/rules/<name>.md` |

## Architecture

```
src/
├── session-reader/   Read and parse ~/.claude/projects/ JSONL files
├── analyzer/         LLM-based session analysis → insights
├── rules-reader/     Parse CLAUDE.md and .claude/rules/ files
├── suggester/        LLM-based suggestion generation from insights + rules
├── pipeline/         Per-session orchestrator with parallel analysis
├── applier/          Interactive review and file writer
├── watcher.ts        Poll for new sessions and auto-analyze
├── store/            Persistence (insights, suggestions, cache, audit log)
├── ui/               Terminal theming, formatting, banners
└── utils/            Logger, paths, helpers
```

All LLM calls go through the Claude Code CLI (`claude -p`). There is no direct API usage — your existing Claude Code authentication is reused.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, project structure, and guidelines.

## License

[MIT](./LICENSE)
