# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-08-19

### Changed

- View/edit split across the tab: outbound rows render as compact summaries (status badge, name, URL, description, header count, remote line) with Test / Edit / Remove actions; the full form opens only on Edit (new rows open in edit mode), Done collapses back. The inbound identity block shows text with an Edit button; inputs appear only in edit mode.
- The how-to block became a hover popover behind a question icon in the inbound header, embedding the live Agent Card URL; it no longer takes vertical space.
- Dropped the duplicated identity row from the inbound grid (version tag moved to the identity block heading) and flattened the collapsible outbound card into the section's visual language — the registry panel matches the inbound panel and the footer carries one status line (save failed / unverified count / unsaved).

## [0.4.0] - 2026-08-19

### Added

- Dedicated A2A settings section (settings nav tab) with an inbound panel and an outbound registry editor, replacing the Plugins → Plugin configuration card.
- Inbound panel: read-only server summary over the `a2a.serverInfo` Remote (listen address, public URL, Bearer-auth state, model route, preset, workspace group, Agent Card identity), the full Agent Card URL with a copy button, an editable Agent Card name/description (settings namespace, hot-applied via `A2aServer.updateCard`, blank fields fall back to the deployment identity), and a bilingual how-to block.
- Outbound registry: every row must pass the agent-card probe before the save enables; a URL or header edit invalidates the row's verification; persisted rows auto-probe on open; a successful probe shows the remote name/description with an "Adopt" button.

## [0.3.0] - 2026-08-18

### Added

- Server-side bearer auth (`server.apiKey`) and a `publicUrl` advertised on the Agent Card for reverse-proxied deployments.
- Model route for A2A conversations (`server.provider` / `server.model`, set as a pair) and a dedicated workspace (`server.cwd` / `server.workspaceTitle`).
- Task replies ride the terminal status update so tasks reach COMPLETED.
- Deployment-customization guidance in the READMEs: keep the npm-distributed bundle patch generic, put deployment identity in the profile override layer, and inject secrets through environment variables.

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
