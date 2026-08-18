# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-08-18

### Changed

- Exclude the tsup CJS intermediate (`dist/client.cjs`) from the published tarball; only the wrapped `dist/client.js` entry ships.
- Unit-test the `attachSettings` wiring (namespace registration, initial feed, hot-reload on commit, invalid-row drop + warning).

## [0.2.0] - 2026-08-18

### Added

- GUI-editable registry: the `a2a` settings namespace (schema defaults → the cordis row's `agents` as composition base → the user document) with a Plugins-section card (`settings.plugin.item`) for adding / editing / removing remote agents. A save hot-reloads the running `a2a_call` / `a2a_list` tools — no restart; a reset re-inherits the deployment registry. Profiles without the settings service keep the static v0.1 behavior.
- Browser half shipped as the closure-factory `./client` bundle (`dsh.client` declaration); invalid settings rows are dropped with a warning instead of failing the document (`normalizeAgents`).

## [0.1.0] - 2026-08-15

### Added

- A2A v1.0 server half: a standalone HTTP endpoint exposing the harness as an A2A agent — Agent Card (`GET /.well-known/agent-card.json`), JSON-RPC (`SendMessage` / `SendStreamingMessage` / `GetTask` / `CancelTask` / `ListTasks`, SSE for streaming), and HTTP+JSON REST (`message:send`, `tasks/*`), all through the official `@a2a-js/sdk` request handler.
- Harness executor: one A2A `contextId` = one persistent harness session (deterministic `sha256`-derived session id, preset-mounted, live-agent adoption), per-turn deadlines with cancellation, and a running-task table so `CancelTask` reaches the right agent.
- Client half: `a2a_call` / `a2a_list` model tools over a config-driven registry, with `${ENV_VAR}` header auth resolved at call time and per-call timeouts.
- Fail-loud config validation (URLs, names, ports, deadlines) and env-driven defaults (`A2A_HOST`, `A2A_PORT`, `A2A_ENABLED`).
- 12 tests: config validation plus real-wire integrations — the official A2A client round-tripping a blocking `SendMessage` against the server, per-context session continuity, task cancellation, header auth, and the model-facing tools.
