# dsh-a2a

> A2A v1.0 for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — expose the harness as an A2A agent, and let harness agents delegate to remote A2A agents.

[![npm version](https://img.shields.io/npm/v/dsh-a2a)](https://www.npmjs.com/package/dsh-a2a)
[![license](https://img.shields.io/npm/l/dsh-a2a)](LICENSE)
[![node](https://img.shields.io/node/v/dsh-a2a)](https://nodejs.org)

One plugin, two halves, built on the official [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js) (A2A Protocol v1.0):

- **Server** — a self-contained HTTP endpoint exposing the harness as an A2A agent: Agent Card discovery, JSON-RPC (the mandatory transport, SSE streaming included), and the HTTP+JSON REST surface. Every A2A `contextId` maps to a **persistent harness session**, so follow-up messages continue the same conversation.
- **Client** — the `a2a_call` / `a2a_list` model tools, so harness agents can delegate work to remote A2A agents from a config-driven registry with header auth.

## ✨ Features

- 🤖 **One contextId = one harness agent** — deterministic session ids (`sha256(contextId)`), preset-mounted (`standard` by default), persistent across turns.
- 🔌 **Full A2A v1.0 wire** — `/.well-known/agent-card.json`, JSON-RPC `SendMessage` / `SendStreamingMessage` / `GetTask` / `CancelTask` / `ListTasks` (SSE for streaming), REST `message:send` / `tasks/*` — all through the official SDK's request handler.
- 🔒 **Header auth on the client side** — per-agent headers with `${ENV_VAR}` placeholders resolved at call time; credentials never sit in the config.
- 🔑 **Bearer auth on the server side** — with `server.apiKey` set, every request except the Agent Card must present `Authorization: Bearer <key>`; the card can also advertise a `publicUrl` behind a reverse proxy.
- 🎛️ **Per-request preset and model** — a caller can name the preset and the model route on the A2A `metadata` map instead of using the deployment's route (see [Per-request overrides](#-per-request-overrides)).
- 🧭 **Model route and workspace** — A2A conversations can pin a provider/model pair and live in their own workspace group (`A2A`, `~/.a2a-sessions` by default).
- ⏱️ **Turn deadlines** — a slow turn is cancelled (`turnTimeoutMs`, default 5 min) so the next message is never stuck.
- 🛡️ **Fail-loud config** — bad URLs, empty names, or out-of-range ports throw at plugin load.
- 🧪 **Real-wire tests** — the server half is exercised end to end with the official A2A client over a live HTTP port.

## 🚀 Quick Start

```sh
dsh plugin --profile web add dsh-a2a

export A2A_HOST=127.0.0.1
export A2A_PORT=8899

dsh web   # restart, then GET http://127.0.0.1:8899/.well-known/agent-card.json
```

Call the agent (JSON-RPC, blocking):

```sh
curl -s http://127.0.0.1:8899/ -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"role":"user","messageId":"m1","parts":[{"kind":"text","text":"hi"}],"contextId":"demo"}}}'
```

`A2A_ENABLED=0` runs the client tools only (no listener).

## ⚙️ Configuration

The mounted row lives in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: a2a
  name: dsh-a2a
  config:
    server:
      enabled: true            # serve the A2A endpoint at all
      host: 127.0.0.1          # A2A_HOST
      port: 8899               # A2A_PORT
      preset: standard         # preset mounted into each conversation agent
      turnTimeoutMs: 300000    # per-turn deadline
      allowOverrides: true     # let callers pick preset/model per request
      agentCard:
        name: dsh-a2a
        description: A DeepSeek Harness agent exposed over the A2A protocol.
        version: '0.1.0'
    agents:                    # remote agents reachable from a2a_call
      - name: specialist
        url: http://127.0.0.1:9000/
        headers:
          authorization: Bearer ${SPECIALIST_TOKEN}
        description: A specialist agent for domain questions.
```

| Field | Default | Meaning |
| --- | --- | --- |
| `server.enabled` | `true` | Serve the A2A endpoint; client tools work regardless |
| `server.host` / `server.port` | `127.0.0.1` / `8899` | Listen address (env `A2A_HOST` / `A2A_PORT`) |
| `server.preset` | `standard` | Preset mounted into each A2A conversation agent |
| `server.turnTimeoutMs` | `300000` | Per-turn deadline; a slow turn is cancelled |
| `server.allowOverrides` | `true` | Whether callers may pick preset/model per request via `metadata`; when `false` their overrides are dropped (and logged) |
| `server.publicUrl` | — | Public URL advertised on the Agent Card (required behind a reverse proxy); env `A2A_PUBLIC_URL` |
| `server.apiKey` | — | When set, every request except the Agent Card must present `Authorization: Bearer <key>`; env `A2A_API_KEY` |
| `server.provider` / `server.model` | — | Model route for A2A conversations, must be set as a pair; falls back to the harness default model; env `A2A_PROVIDER` / `A2A_MODEL` |
| `server.cwd` | `~/.a2a-sessions` | Working directory for A2A conversations (doubles as the sidebar workspace path); env `DSH_A2A_CWD` |
| `server.workspaceTitle` | `A2A` | Sidebar group title for A2A conversations |
| `server.agentCard.*` | — | Agent Card identity shown to callers |
| `agents[].name` / `url` | — | Registry name for `a2a_call` + Agent Card URL |
| `agents[].headers` | `{}` | Request headers; `${ENV_VAR}` placeholders resolved at call time |
| `agents[].description` | `''` | Shown by `a2a_list` |

## 🎛️ Per-request overrides

By default every conversation uses the deployment's route: the configured `server.preset` and provider/model pair. A caller can pick its own instead by naming them on the A2A `metadata` map:

```sh
curl -s http://127.0.0.1:8899/ -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{
        "message":{"role":"user","messageId":"m1","parts":[{"kind":"text","text":"hi"}],"contextId":"demo"},
        "metadata":{"agentPreset":"general","model":"model-a"}
      }}'
```

| Key | Aliases | Meaning | Applies |
| --- | --- | --- | --- |
| `agentPreset` | `preset` | Preset id to compose the agent from, overriding `server.preset` | on the request that **creates** the session |
| `model` | — | Model id, overriding `server.model` | on every request, and it **sticks** for the rest of the session |
| `provider` | — | Provider route, paired with the configured (or default) model | on every request |

The two ride different lifetimes because the harness gives them different ones:

- **A preset composes an agent** — it mounts tools and skills at session creation. Once a session exists its composition is fixed, so a `preset` on a later turn is ignored and logged: swapping tools mid-conversation would leave tool calls the new composition cannot make. Send the preset on the first message (or use a fresh `contextId`).
- **The model is a per-step route**, so a live session is switched onto the requested model without losing the conversation — or the KV-cache prefix its history already earned.

Precedence and edge cases:

- `params.message.metadata` wins over `params.metadata`; writing the same value to both — as the REST `message:send` shape invites — is unambiguous, and callers that only know one of them still work.
- A bare `model` is paired with `server.provider`, falling back to the harness default model's provider: callers know the model they want, not the route serving it. Without any provider to pair with, the task fails rather than answering on a model the caller did not ask for.
- A malformed value (a non-string, or one that could escape the preset root) fails the task with a message naming the key.
- An unknown preset fails the task and lists the ids this deployment does supply.
- Set `server.allowOverrides: false` to lock the deployment's route: overrides are then dropped and logged, and the request is still answered.

## 🏷️ Deployment customization (recommended)

dsh assemblies are layered: **the bundle's own patch (npm-distributed) → the profile's `cordis.patch.yml` → environment variables**. When giving a deployment its own identity, put each piece on the right layer:

- **Keep the shipped `cordis.patch.yml` generic** — it reaches every npm consumer, so never bake deployment-specific identity (a bespoke preset, a dedicated Agent Card name/description) into it.
- **Deployment identity goes in the profile override layer** — override the `a2a` row by id in `~/.dsh/profiles/web/cordis.patch.yml` (no `- insert:` prefix, and spell out the full `server` block):

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: a2a
  name: dsh-a2a
  config:
    server:
      enabled: true
      host: 127.0.0.1
      port: 8899
      preset: my-support-preset      # deployment-specific preset
      turnTimeoutMs: 300000
      agentCard:
        name: My Support Agent       # deployment-specific identity
        description: Answers internal support questions.
        version: '0.1.0'
    agents: []
```

- **Secrets go in environment variables** — the real values of `publicUrl` / `apiKey` / `provider` / `model` never sit in any YAML; keep the `!!js process.env.XXX` expressions and inject the values at launch (systemd users can use `EnvironmentFile`):

```ini
# /etc/dsh-web.env (systemd EnvironmentFile example)
A2A_PUBLIC_URL=https://gateway.example.com/
A2A_API_KEY=<secret>
A2A_PROVIDER=venus
A2A_MODEL=model-b
```

Patch-layer changes are read at assembly time — restart `dsh web` to apply them. The GUI registry (`agents`) is the exception: saves hot-reload.

## 💬 Model tools

| Tool | What it does |
| --- | --- |
| `a2a_list` | Lists the registered remote A2A agents (name + description). |
| `a2a_call` | Sends a prompt to one registered agent and returns its completed text reply. |

## 🏗️ How it works

- The server is a **standalone Node HTTP listener** (not a route on the web GUI): the Agent Card and JSON-RPC live at the agent's root URL, which the web app already owns. Lifecycle is tied to the Cordis fiber — the listener starts on plugin load and closes (sockets included) on plugin disposal.
- The executor implements the SDK's `AgentExecutor` contract: publish a `task` event, run one harness turn (`followup` → `whenIdle` with deadline → cancel on timeout), publish the reply as a `message` event, then a terminal `statusUpdate`. `CancelTask` reaches the right agent through the running-task table.
- The client resolves the registry through the SDK's `ClientFactory` (JSON-RPC + REST transports) with an authenticating fetch that injects the per-agent headers.

## ⚠️ Limitations

- Inbound authentication: since 0.3.0 `server.apiKey` enforces a Bearer token on every request except the Agent Card (which must stay publicly readable); for larger deployments, still put the port behind an authenticating gateway or a reverse proxy. The Agent Card advertises no security schemes.
- One executor instance serves every context; sessions resume across turns but a dsh restart creates fresh in-memory state (session persistence via `sessionPersistence` is a planned follow-up).
- A `model` override switches sessions this executor instance created. One adopted from outside it — opened in the web UI, or resumed from disk — has no route handle to switch, so the override is logged and ignored; the reply keeps the model it was created with. Sending the model again after the executor creates the session works as expected.
- ~~Outbound registry edits require a profile patch + restart~~ **0.2.0: GUI-configurable.** The Plugins → Plugin configuration section ships an "A2A remote agents" card over the `a2a` settings namespace (schema defaults → row-config base → user overrides); a save hot-reloads the running tools, and a reset re-inherits the deployment registry.

## 🧪 Development

```sh
npm run check   # biome + typecheck + vitest (49 tests) + build
```

The suite covers config validation, the Agent Card + JSON-RPC round trip through the official A2A client against a real HTTP listener, per-context session continuity, task cancellation, header auth, per-request overrides, and the model-facing tools.

## 📄 License

[MIT](LICENSE)
