# Changelog

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
