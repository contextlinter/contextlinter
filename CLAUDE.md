# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

- `pnpm build` — compile TypeScript (`tsc`)
- `pnpm start` — run CLI directly via tsx (no build needed)
- `pnpm test` — run all tests once
- `pnpm test:watch` — run tests in watch mode
- `pnpm test:coverage` — run tests with coverage (35% line threshold)
- `pnpm lint` — type-check only (`tsc --noEmit`)
- `pnpm check` — lint + tests together
- Run a single test file: `pnpm vitest run src/analyzer/__tests__/llm-client.test.ts`

## Architecture

ContextLinter is a CLI tool that analyzes Claude Code sessions (JSONL transcripts in `~/.claude/projects/`) to extract patterns and generate CLAUDE.md rule suggestions. It runs a three-stage pipeline:

```
analyze → suggest → apply
```

### Pipeline Stages (each maps to a CLI command and a `src/` module)

1. **session-reader** — discovers and parses Claude Code JSONL session files into `SessionInfo` objects
2. **analyzer** — sends session transcripts to Claude CLI (`claude -p`) to extract structured `Insight` objects, then synthesizes cross-session `CrossSessionPattern`s
3. **rules-reader** — discovers and parses existing CLAUDE.md / `.claude/rules/*.md` files into a `RulesSnapshot`
4. **suggester** — combines insights + rules snapshot, calls Claude CLI to generate `Suggestion` objects (add/update/remove/consolidate/split), deduplicates and ranks them
5. **applier** — interactive review UI, atomic file writes (temp file + rename), backup creation, audit logging to `.contextlinter/history.jsonl`
6. **watcher** (`src/watcher.ts`) — polls for new sessions and runs analyze/suggest automatically

### Other Key Modules

- **store/** — persistence layer for caching parsed sessions, analysis results, suggestions, and audit log. All state lives in `.contextlinter/` (gitignored). Uses atomic writes.
- **utils/logger.ts** — chalk-based terminal output (headers, tables, progress, errors)
- **utils/paths.ts** — path resolution for Claude projects dir and session files
- **prompts/** — markdown templates sent to Claude CLI for analysis, cross-session synthesis, and suggestion generation

### LLM Integration

All LLM calls go through `analyzer/llm-client.ts` which spawns `claude -p` as a subprocess with stdin/stdout piping. The working directory is set to a sandboxed temp dir. Model is configurable via `--model` flag or environment. Timeouts: 120s for analysis, 300s for suggestions.

## Conventions

- **ES modules** (`"type": "module"`) with Node16 module resolution — use `.js` extensions in imports
- **TypeScript strict mode** — no `any` types
- **Tests colocated** with source: `src/<module>/__tests__/<name>.test.ts`
- **Conventional Commits**: `feat:`, `fix:`, `docs:`, `test:`, `chore:`
- **No eslint/prettier** — only `tsc` for linting
- **Minimal dependencies** — only chalk and uuid at runtime
- **CLI entry point** is `src/index.ts` — parses args with Node's built-in `parseArgs`, dispatches to command handlers
