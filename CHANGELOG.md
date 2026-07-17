# Changelog

All notable changes to this project are documented here.

## 1.0.0 — 2026-07-17

First public release.

### Added

- Durable, per-project task queues with scheduling, dependencies, pause/resume handoffs, preparation jobs, councils, side questions, and verification evidence.
- Claude Code skill, CLI, lifecycle hooks, optional MCP bridge, and a dependency-free local dashboard.
- Tamper-evident audit history, rotating local backups, offline capture spool, and interrupted-work recovery.
- Original orchestration animations for the dashboard and GitHub README, including reduced-motion fallbacks.

### Security

- Published from a new root commit so private development history and local planning artifacts are not exposed.
- Replaced browser token bootstrap with short-lived one-use launch tickets and HttpOnly, same-site browser sessions.
- Removed project paths from dashboard bootstrap responses.
- Removed command-shell interpolation from installer process termination.
- Added privacy, secret, path, artifact-size, syntax, and live bootstrap checks to CI.
