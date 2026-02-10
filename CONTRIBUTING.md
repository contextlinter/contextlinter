# Contributing to ContextLinter

Thanks for your interest in contributing! Whether it's a bug report, feature request, or code contribution — all help is welcome.

## Getting started

```bash
git clone https://github.com/contextlinter/contextlinter.git
cd contextlinter
pnpm install
pnpm test
```

## Development

| Command              | Description        |
| -------------------- | ------------------ |
| `pnpm test`          | Run tests          |
| `pnpm test:watch`    | Watch mode          |
| `pnpm test:coverage` | Coverage report     |
| `pnpm lint`          | Type check (`tsc --noEmit`) |
| `pnpm check`         | Lint + tests        |

## Project structure

```
src/
├── session-reader/   # Discovers and parses Claude Code JSONL sessions
├── analyzer/         # LLM-powered single-session + cross-session analysis
├── rules-reader/     # Discovers and parses CLAUDE.md / .claude/rules/ files
├── suggester/        # Generates rule suggestions from insights
├── applier/          # Interactive review and file writing
├── store/            # Persistence: caching, audit log, analysis results
├── utils/            # Paths, logging helpers
└── index.ts          # CLI entry point
```

## How to contribute

- **Bug reports** — open an issue with reproduction steps
- **Feature requests** — open an issue, describe the use case
- **Pull requests** — fork, branch, make changes, ensure tests pass, open PR
- **First time?** — look for issues labeled `good first issue`

## Code style

- TypeScript strict mode
- No eslint/prettier yet — just `tsc`
- Tests next to source: `src/module/__tests__/module.test.ts`
- Test runner: vitest

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation
- `test:` tests
- `chore:` maintenance
