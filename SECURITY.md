# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability, please report it via [GitHub Security Advisories](https://github.com/contextlinter/contextlinter/security/advisories/new) or email **security@contextlinter.ai**.

We aim to respond within 48 hours.

## How ContextLinter handles data

- All analysis runs locally through your Claude Code CLI
- Session files are read from `~/.claude/projects/` — never uploaded anywhere
- No data is sent to external servers beyond what the Claude CLI itself does
- Suggestions and analysis results are stored locally in `.contextlinter/`
