# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Multi-agent server** — one endpoint now serves several local agents, each
  at its own `/agents/<id>` with its own preset, model route, workspace group,
  Agent Card identity, and `skills`. The root `/.well-known/agent-card.json`
  discovery returns the first agent; every agent is addressed by path.
- **Per-agent skills on the Agent Card** — `server.agents[].skills` advertises
  each agent's abilities as A2A `AgentSkill[]` (id / name / description) on
  its own card, so an A2A client sees what each agent is for.
- **Live served-agent management in the settings tab** — the inbound identity
  editor can add / remove / re-identity a served agent; a save reconciles the
  running server (a new agent is mounted, a dropped agent is disposed, an
  edited identity is hot-applied) without a restart.
- **Endpoint token view + rotation** — the settings tab shows the Bearer key
  (masked by default, with reveal + copy) and can rotate it; the new key is
  applied live to the running server and persisted to the `a2a` settings
  document so it survives a restart.
- **Per-agent Agent Card addresses** — the inbound panel lists each served
  agent's own card URL at `/agents/<id>/.well-known/agent-card.json`, styled to
  match the outbound registry (preset chip + name + path + description + copy).

### Changed

- The settings tab no longer rides a Typert Remote service: `/api/a2a/*`
  (`serverInfo`, `testAgentCard`, `regenerateKey`) are plain `webServer`
  routes mounted once the web server is ready, so the panel no longer 404s.

### Fixed

- **REST `message:send` (issue #1)** — the handler passed the request body
  `Buffer` straight to `restBody()`, whose `body.message ?? {}` read `.message`
  off the buffer and always got `undefined`, so every REST call failed with
  `message.messageId is required`. The body is now parsed as UTF-8 then JSON.
- **Half model override** — a request that named only `model` (or only
  `provider`) no longer fails the task when the deployment cannot complete the
  pair; it falls back to the configured/default route with a warning.

## [0.6.0] - 2026-08-30

### Added

- Callers can now pick the preset and the model route per request through the
  A2A `metadata` map, instead of always using the deployment's route. Three
  keys are read from `params.metadata` and `params.message.metadata` (the
  message-level map wins): `agentPreset` (alias `preset`), `model`, and
  `provider`. The two ride different lifetimes because the harness gives them
  different ones — a preset composes an agent, so it applies on the request
  that creates the session and is ignored (logged) on later turns, swapping
  tools mid-conversation would leave tool calls the new composition cannot
  make; the model is a per-step route, so a live session is switched onto it
  without losing the conversation. A bare `model` pairs with
  `server.provider`, falling back to the harness default model's provider.
- `server.allowOverrides` (default `true`) locks the deployment's route when
  set to `false`: request overrides are then dropped and logged, and the
  request is still answered on the configured route. The settings panel shows
  whether overrides are honored.

### Changed

- A malformed override (a non-string, or a value that could escape the preset
  root) now fails the task naming the offending key, rather than being
  silently ignored; an unknown preset fails listing the ids this deployment
  does supply. Routing a turn to a preset or model the caller did not ask for
  — because its value did not parse — is the one outcome a caller cannot
  detect.

## [0.5.0] - 2026-08-24

### Added

- Rendered image cards can now reach the A2A caller. When an agent turn renders
  a card (e.g. the `render_card` tool), the executor collects the durable image
  attachments from the tool-result events and publishes each as a file artifact
  (raw PNG part, `image/png`) on the terminal status — before the terminal
  `statusUpdate`, because the SDK ends the event stream there and anything
  published after would never reach the caller. A card whose bytes cannot be
  read is logged and skipped; the text reply still completes.

## [0.4.2] - 2026-08-21

### Added

- Per-session sandbox cwd: every A2A caller context runs in its own
  directory under the server base — `A2A-{caller}-{MMDD}-{hhmmss}-{id-tail}`
  — so the harness sandbox fence isolates each caller's filesystem, with one
  workspace row per session titled from the minted directory name
  (`A2A · {caller} {MM-DD} {HH:mm:ss}`).

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
