# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Local structured plain-text evidence summarization (D10): separate auto (~1,200 token budget) and manual (~2,000 token budget with timeline sections and effort weights) context generation.
- Tool footprints with grouped counts (`修改`, `命令`, `搜索`, `读取（准备动作）`), error flags, and relative paths without dumping raw parameters or tool output.
- Folding of fenced code blocks into `[代码 N 行]`, exclusion of `branch_summary` entries, trivial confirmation merging, and token-budget enforcement.
- Automated tests expanded to 36, covering plain-text evidence extraction, token budgets, CJK estimation, and D11 trigger semantics.

### Changed
- Simplified automatic naming triggers (D11): removed tool count triggers; naming now triggers in parallel with user messages (`message_end`), retries on `agent_settled` with recent assistant response and tool footprint, and forces naming on the third user message.
- Semantic deferral (`NO_TITLE`) no longer triggers cooldown penalty, allowing timely retry on settlement.
- Aligned documentation across `AGENTS.md`, `docs/design.md`, `docs/decisions.md`, and `README.md`.
- Added an automatic naming switch, enabled by default, for global and session settings. Disabling it preserves manual generation and prevents late automatic results from being applied; older configurations default to enabled.
- Implemented background session naming after tool completion, settled Q&A, and the third user message, with bounded task-focused context and CJK-aware title cleanup.
- Added `/titler` with manual regeneration, authenticated model selection, and Tab-switched global/session settings.
- Added persistent full-session configuration snapshots, restoration of global inheritance, optional current-model fallback, and opt-in historical-session naming.
- Added 35 automated tests, including Pi 1.5.0 extension loading, real session-file persistence, hierarchical menu navigation, stable aligned settings layout, and the automatic naming switch, plus local installation and configuration instructions.

### Changed
- Renamed the inheritance action to “恢复全局配置” and removed its extra right-column status text.
- Aligned concise setting names and values in two CJK-aware columns. Reserved two help lines for every selection and truncated long model names to keep the settings frame stable.
- Clarified the fallback setting as “标题模型失败时，改用会话模型”, with a focused-item explanation identifying the model used for the current conversation.
- Unified the settings screen with Pi's bordered, themed selector style. Removed the duplicate top-level model entry; model selection now lives under Settings.
- Made Escape return one menu level at a time, including model → provider → settings → home, without saving cancelled changes.
- Targeted Pi 1.5.0 and verified its provider-neutral `reasoning` option; all host packages remain peer and development dependencies only.
- Kept existing titles on automatic naming and provider failure; manual regeneration replaces titles without a second confirmation, while protecting concurrent user edits and session switches.
- Slimmed `AGENTS.md` to hard constraints, module map and conventions; moved current behavior to `docs/design.md`, decisions and proposals to `docs/decisions.md`, and archived the previous long-form document under `docs/archive/`.

## [0.1.0] - 2026-11-10

### Added
- Initial project scaffolding and architecture design.
- Pi package manifest and TypeScript configuration.
- Comprehensive `AGENTS.md` guidelines for development and maintenance.
