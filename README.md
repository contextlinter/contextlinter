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
npx clinter run
```

No config files, no API keys. It uses your existing Claude Code CLI to call the LLM.

## What it actually does

Every time you correct Claude Code — "no, use pnpm not npm", "we don't put tests there", "I told you to use the existing helper" — that's a rule waiting to be written. ContextLinter finds those patterns automatically:

1. **Reads** session transcripts from `~/.claude/projects/`
2. **Analyzes** each conversation for corrections, rejected approaches, repeated clarifications, and established conventions
3. **Synthesizes** cross-session patterns (things you correct in multiple sessions)
4. **Generates** precise rule suggestions — adds, updates, removals, or splits of large files
5. **Presents** an interactive review where you accept, reject, or edit each change

The pipeline has three stages that can run independently or together:

```
analyze → suggest → apply
```

`run` executes all three. You can also run `analyze`, `suggest`, and `apply` separately if you want more control.

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
==> ContextLinter Analyzer v0.1.0

Analyzing project: /Users/you/work/my-app
Sessions to analyze: 4 (6 already analyzed, skipped)

    Analyzing session a1b2c3d4e5f6 (12 user messages)...
  ✓ 3 insights found (8.2s)
    Analyzing session f6e5d4c3b2a1 (8 user messages)...
  ✓ 2 insights found (5.1s)

==> Suggestion 1/3                              HIGH  92%

    Add rule to CLAUDE.md § "Testing"

    + - Always use vitest, never jest
    + - Run `pnpm test` before committing

    Rationale: User corrected test runner choice in 3 separate sessions

[a]ccept  [r]eject  [e]dit  [s]kip  [q]uit all
>
```

## Commands

| Command | Description |
|---|---|
| `run` | Full pipeline: analyze → suggest → apply |
| `analyze` | Analyze sessions and extract insights |
| `suggest` | Generate rule suggestions from insights |
| `apply` | Review and apply suggestions interactively |
| `rules` | Show current rules files and statistics |
| `init` | Create a `/clinter` slash command for Claude Code |

## Options

| Flag | Description |
|---|---|
| `--limit N` | Analyze only the N newest sessions |
| `--min-messages N` | Skip sessions shorter than N user messages (default: 2) |
| `--model <model>` | LLM model: `sonnet` (default), `opus`, `haiku` |
| `--min-confidence N` | Auto-accept only above this confidence (0.0-1.0) |
| `--yes` | Auto-confirm all prompts |
| `--dry-run` | Preview what would happen without writing files |
| `--verbose` | Show detailed progress and debug info |
| `--force` | Re-analyze sessions even if already processed |
| `--no-cross` | Skip cross-session pattern synthesis |

## Requirements

- **Node.js 20+**
- **Claude Code CLI** installed and authenticated (`claude -p` must work)
- At least a few Claude Code sessions in the target project

## How suggestions get applied

ContextLinter never writes to your files without asking. The `apply` step shows each suggestion as a diff and waits for your input:

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
├── applier/          Interactive review and file writer
├── store/            Persistence (insights, suggestions, cache, audit log)
└── utils/            Logger, paths, helpers
```

All LLM calls go through the Claude Code CLI (`claude -p`). There is no direct API usage — your existing Claude Code authentication is reused.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, project structure, and guidelines.

## License

[MIT](./LICENSE)
