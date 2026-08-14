# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-15

### Added

- A2A v1.0 server half: a standalone HTTP endpoint exposing the harness as an A2A agent — Agent Card (`GET /.well-known/agent-card.json`), JSON-RPC (`SendMessage` / `SendStreamingMessage` / `GetTask` / `CancelTask` / `ListTasks`, SSE for streaming), and HTTP+JSON REST (`message:send`, `tasks/*`), all through the official `@a2a-js/sdk` request handler.
- Harness executor: one A2A `contextId` = one persistent harness session (deterministic `sha256`-derived session id, preset-mounted, live-agent adoption), per-turn deadlines with cancellation, and a running-task table so `CancelTask` reaches the right agent.
- Client half: `a2a_call` / `a2a_list` model tools over a config-driven registry, with `${ENV_VAR}` header auth resolved at call time and per-call timeouts.
- Fail-loud config validation (URLs, names, ports, deadlines) and env-driven defaults (`A2A_HOST`, `A2A_PORT`, `A2A_ENABLED`).
- 12 tests: config validation plus real-wire integrations — the official A2A client round-tripping a blocking `SendMessage` against the server, per-context session continuity, task cancellation, header auth, and the model-facing tools.
