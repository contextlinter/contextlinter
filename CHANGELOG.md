# Changelog

## [0.2.6] - 2026-02-13

### Added
- Content-based deduplication using word-level Jaccard similarity to catch duplicate suggestions across different target files
- Content brevity enforcement in prompts — each suggested rule is now limited to 1-3 lines
- Verbose content warning when generated suggestions exceed 5 lines

### Changed
- Updated suggestion generation prompts to include cross-file dedup guidance and stricter brevity constraints

## [0.2.5] - 2026-02-12

### Added
- Per-session pipeline with parallel analysis (up to 3 sessions concurrently) and combined analyze+suggest LLM calls

### Changed
- Updated CLAUDE.md with ui module documentation, prompt template syntax, and CI info

### Removed
- `clinter` bin alias

## [0.2.4] - 2026-02-12

### Added
- `--format json` output mode for machine-consumable run results

### Fixed
- Run CLI integration tests via tsx against source instead of dist

## [0.2.3] - 2026-02-12

_No changes._

## [0.2.2] - 2026-02-11

### Added
- `clinter` as a short CLI alias for `contextlinter`

### Changed
- Made `contextlinter` the primary CLI name over `clinter`
- Replaced chalk calls with centralized UI theme and formatting system
- Updated demo gif and removed unused logo

## [0.2.1] - 2026-02-11

### Added
- `clinter` as a short CLI alias

### Changed
- Replaced chalk calls with centralized UI theme and formatting system
- Updated demo gif and removed unused logo

## [0.2.0] - 2026-02-11

### Added
- `watch` command for auto-analyzing new sessions

### Changed
- Updated logo

## [0.1.1] - 2026-02-10

### Changed
- Updated project logo
- Added .gitattributes for binary file handling

## [0.1.0] - 2026-02-10

### Added
- Initial release
- Session analysis with LLM-powered insights
- Cross-session synthesis
- Rule suggestion generation
- Interactive review and apply workflow
- Support for CLAUDE.md and .cursor/rules
