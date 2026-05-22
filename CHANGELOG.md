# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-05-22

### Added
- Initial release with integrated Agent support (OpenClaw, Hermes, etc.).
- Local proxy for Codex and Claude Code.
- Provider management (add, list, show, remove).
- Automatic takeover and configuration backup/recovery.
- Failover support with configurable provider queues.
- Local project-level provider overrides for Claude Code.
- `apm status` command for comprehensive system overview.
- Colorized terminal UI for better readability.
- `apm rename` command to update provider names and local references.
- Usage extraction for Codex SSE and deep-nested response objects.
- Fast import from CC-Switch configuration.
