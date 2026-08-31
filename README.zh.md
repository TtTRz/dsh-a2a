# dsh-a2a

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 A2A v1.0 插件——把 harness 暴露为 A2A agent，也让 harness agent 能调远程 A2A agent。

[![npm version](https://img.shields.io/npm/v/dsh-a2a)](https://www.npmjs.com/package/dsh-a2a)
[![license](https://img.shields.io/npm/l/dsh-a2a)](LICENSE)
[![node](https://img.shields.io/node/v/dsh-a2a)](https://nodejs.org)

一个插件两个半身，底层走官方 [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js)（A2A 协议 v1.0）：

- **Server**——自带的 HTTP 端点把 harness 暴露为 A2A agent：Agent Card 发现、JSON-RPC（必选传输，含 SSE 流式）、HTTP+JSON REST。每个 A2A `contextId` 映射到一个**持久化 harness 会话**，追问继续同一个对话。
- **Client**——`a2a_call` / `a2a_list` 两个模型工具，从配置驱动的注册表把活派给远程 A2A agent，支持 header 鉴权。

## ✨ 特性

- 🤖 **多 agent 服务器**——一个端点服务多个 agent，每个在自身 `/agents/<id>`，各有自己的 preset、模型路由、工作区、Agent Card 身份与 `skills`；一个 `contextId` 映射为该 agent 的一个持久 harness 会话（`sha256(contextId)` 确定性派生 id），挂载 preset、跨轮次延续
- 📇 **Agent Card 级 `skills`**——每个 agent 在它自己的 card 上以 A2A `AgentSkill[]`（`id` / `name` / `description`）宣称能力，A2A 客户端可按"这个 agent 干什么用"路由
- 🎛️ **动态管理被服务 agent**——设置页入口编辑器可新增/删除/改身份；保存即对运行中的服务器做 reconcile，无需重启
- 🔑 **token 查看与轮换**——设置页展示 Bearer key（默认掩码、可显示+复制）并可轮换，新 key 即时生效并写入 settings 文档持久化
- 🔌 **完整 A2A v1.0 线格式**——`/.well-known/agent-card.json`、JSON-RPC `SendMessage` / `SendStreamingMessage` / `GetTask` / `CancelTask` / `ListTasks`（流式走 SSE）、REST `message:send` / `tasks/*`——全部经官方 SDK 的 request handler
- 🔒 **客户端 header 鉴权**——每个 agent 的 headers 支持 `${ENV_VAR}` 占位符调用时解析，凭证不进配置
- 🔑 **服务端 Bearer 鉴权**——设了 `server.apiKey` 后，除 Agent Card 外的所有请求须带 `Authorization: Bearer <key>`；Agent Card 还可宣告反代后的 `publicUrl`
- 🎛️ **请求级 preset 与模型**——调用方可通过 A2A `metadata` 指定 preset 与模型路由，而不必沿用部署方的路由（见[请求级覆盖](#-请求级覆盖)）
- 🧭 **独立模型路由与工作区**——A2A 会话可指定 provider/model 对，并归入专属 workspace（默认 `A2A` 分组、`~/.a2a-sessions` 目录）
- ⏱️ **单轮超时**——慢轮次主动 cancel（`turnTimeoutMs`，默认 5 分钟），下一条消息不会被卡住
- 🛡️ **配置失败即报错**——非法 URL、空名字、越界端口在插件加载时抛出
- 🧪 **真线格式测试**——server 半身用官方 A2A client 走真实 HTTP 端口端到端验证

## 🚀 快速开始

```sh
dsh plugin --profile web add dsh-a2a

export A2A_HOST=127.0.0.1
export A2A_PORT=8899

dsh web   # 重启后 GET http://127.0.0.1:8899/.well-known/agent-card.json
```

JSON-RPC 阻塞调用：

```sh
curl -s http://127.0.0.1:8899/ -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"role":"user","messageId":"m1","parts":[{"kind":"text","text":"hi"}],"contextId":"demo"}}}'
```

`A2A_ENABLED=0` 只跑 client 工具，不开监听。

## ⚙️ 配置

挂载行在 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: a2a
  name: dsh-a2a
  config:
    server:
      enabled: true            # 是否开启 A2A 端点
      host: 127.0.0.1          # A2A_HOST
      port: 8899               # A2A_PORT
      turnTimeoutMs: 300000    # 单轮超时
      allowOverrides: true     # 允许调用方按请求指定 preset/model
      agents:                  # 在本机 /agents/<id> 托管的本地 agent
        - id: support
          name: Support Agent
          description: Answers internal support questions.
          version: '0.1.0'
          preset: standard
          workspaceTitle: A2A
          skills:
            - id: query-orders
              name: Query orders
              description: Look up an order's status and timeline.
    agents: []                 # a2a_call 可触达的远程 agent
```

每个本地 agent 位于 `/agents/<id>/.well-known/agent-card.json`，并有自己的会话命名空间（`a2a-<id>-<hash>`）、工作区分组与 Agent Card。旧的单 agent 形式（`server.preset` / `server.agentCard`）仍可用：`server.agents` 为空时，从它派生出一个 agent。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `server.enabled` | `true` | 是否开启 A2A 端点；client 工具不受影响 |
| `server.host` / `server.port` | `127.0.0.1` / `8899` | 监听地址（env `A2A_HOST` / `A2A_PORT`） |
| `server.preset` | `standard` | 挂进每个 A2A 会话 agent 的 preset |
| `server.turnTimeoutMs` | `300000` | 单轮超时，超时取消本轮 |
| `server.allowOverrides` | `true` | 是否允许调用方通过 `metadata` 按请求指定 preset/model；设为 `false` 时覆盖值被丢弃（并记录日志） |
| `server.publicUrl` | — | Agent Card 上对外宣告的公开 URL（反代后必设）；env `A2A_PUBLIC_URL` |
| `server.apiKey` | — | 设置后除 Agent Card 外的请求须带 `Authorization: Bearer <key>`；env `A2A_API_KEY` |
| `server.provider` / `server.model` | — | A2A 会话模型路由，必须成对设置；缺省用 harness 默认模型；env `A2A_PROVIDER` / `A2A_MODEL` |
| `server.cwd` | `~/.a2a-sessions` | A2A 会话工作目录（兼作侧边栏 workspace 路径）；env `DSH_A2A_CWD` |
| `server.workspaceTitle` | `A2A` | 侧边栏 A2A 会话分组标题 |
| `server.agents[].id` | — | `/agents/` 下的 URL slug（须 URL-safe），如 `support` |
| `server.agents[].name` / `description` / `version` | — | 该 agent 的 Agent Card 身份 |
| `server.agents[].preset` | — | 挂进该 agent 会话的 preset |
| `server.agents[].provider` / `model` | — | 该 agent 的模型路由（须成对）；缺省用 harness 默认 |
| `server.agents[].cwd` / `workspaceTitle` | `server.cwd` / `A2A` | 该 agent 的工作目录 / 分组标题 |
| `server.agents[].skills` | `[]` | 该 agent card 上宣告的 A2A `AgentSkill[]`（`id` / `name` / `description`） |
| `server.agentCard.*` | — | 旧单 agent 身份（`server.agents` 为空时用） |
| `agents[].name` / `url` | — | **远程** `a2a_call` 注册名 + Agent Card URL |
| `agents[].headers` | `{}` | 请求头；`${ENV_VAR}` 占位符调用时解析 |
| `agents[].description` | `''` | `a2a_list` 展示 |

## 🎛️ 请求级覆盖

默认情况下所有会话都走部署方的路由：配置的 `server.preset` 与 provider/model 对。调用方可以在 A2A `metadata` 里点名自己要的 preset 和模型：

```sh
curl -s http://127.0.0.1:8899/ -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{
        "message":{"role":"user","messageId":"m1","parts":[{"kind":"text","text":"hi"}],"contextId":"demo"},
        "metadata":{"agentPreset":"general","model":"model-a"}
      }}'
```

| 键 | 别名 | 含义 | 生效时机 |
| --- | --- | --- | --- |
| `agentPreset` | `preset` | 组装 agent 的 preset id，覆盖 `server.preset` | **创建**会话的那条请求 |
| `model` | — | 模型 id，覆盖 `server.model` | 每条请求都生效，并在会话内**保持** |
| `provider` | — | provider 路由，与配置的（或默认的）模型配对 | 每条请求都生效 |

两者的生命周期不同，因为 harness 给它们的就是不同的：

- **preset 是组装 agent 用的**——它在会话创建时挂载工具与技能。会话一旦存在，组装就固定了，因此后续轮次的 `preset` 会被忽略并记日志：中途换工具会留下新组合解释不了的 tool 调用记录。请在第一条消息带上 preset（或换一个 `contextId`）。
- **模型是逐步路由的**，所以活着的会话可以切到请求的模型，且对话不丢——连历史已经攒下的 KV-cache 前缀也一起保住。

优先级与边界：

- `params.message.metadata` 覆盖 `params.metadata`；两处写同值（REST `message:send` 的形状容易诱导这么写）结果无歧义，只写其中一处的调用方同样有效。
- 只给 `model` 时，会与 `server.provider` 配对，再回落到 harness 默认模型的 provider：调用方知道自己要哪个模型，不见得知道是哪个 provider 在提供。若到处都找不到可配对的 provider，任务直接失败，而不是用一个调用方没要的模型来回答。
- 值不合法（非字符串，或可能逃出 preset 根目录）时任务失败，并指明是哪个键。
- preset 不存在时任务失败，并列出本部署实际提供的 id。
- 设 `server.allowOverrides: false` 可锁死部署方路由：覆盖值被丢弃并记日志，请求照常回答。

## 🏷️ 部署定制（推荐用法）

dsh 的装配是分层的：**bundle 自带 patch（随 npm 分发）→ profile 的 `cordis.patch.yml` → 环境变量**。给部署打专属身份时，按层放对位置：

- **包内 `cordis.patch.yml` 保持通用默认**——它随 npm 分发给所有用户，不要把部署专属身份（特定 preset、专属 Agent Card 名称/描述）写进去。
- **部署身份放 profile 覆盖层**——在 `~/.dsh/profiles/web/cordis.patch.yml` 按 id 覆盖 `a2a` 行（不带 `- insert:` 前缀，且写全 `server` 字段）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: a2a
  name: dsh-a2a
  config:
    server:
      enabled: true
      host: 127.0.0.1
      port: 8899
      preset: my-support-preset      # 部署专属 preset
      turnTimeoutMs: 300000
      agentCard:
        name: My Support Agent       # 部署专属身份
        description: Answers internal support questions.
        version: '0.1.0'
    agents: []
```

- **敏感值走环境变量**——`publicUrl` / `apiKey` / `provider` / `model` 的真实值不进任何 yaml，patch 里只留 `!!js process.env.XXX` 读取表达式，真实值放启动环境（systemd 用户可放 `EnvironmentFile`）：

```ini
# /etc/dsh-web.env（systemd EnvironmentFile 示例）
A2A_PUBLIC_URL=https://gateway.example.com/
A2A_API_KEY=<secret>
A2A_PROVIDER=venus
A2A_MODEL=model-b
```

patch 层改动在装配期读取，改完需重启 `dsh web` 才生效；GUI 注册表（`agents`）例外，保存即热更新。

## 💬 模型工具

| 工具 | 作用 |
| --- | --- |
| `a2a_list` | 列出已注册的远程 A2A agent（名字 + 描述） |
| `a2a_call` | 给某个已注册 agent 发 prompt，返回其完整文本回复 |

## 🏗️ 工作原理

- server 是**独立 Node HTTP 监听**（不挂在 web GUI 路由上）：它服务多个本地 agent，每个在 `/agents/<id>/...`，各有自己的 Agent Card、JSON-RPC + REST 面、挂载 preset 的 executor 与会话命名空间。根 `/.well-known/agent-card.json` 返回第一个 agent（`/` 无默认 agent）；`server.agents[]` 为多 agent 形态，旧单 agent 配置派生一个 agent。生命周期绑定 Cordis fiber——插件加载时起监听，卸载时连同 socket 一起关。
- 每个 agent 的 executor 实现 SDK 的 `AgentExecutor` 契约：先发 `task` 事件 → 跑一轮 harness（`followup` → 带截止时间的 `whenIdle` → 超时 `cancel`）→ 回复以 `message` 事件发出 → 终态 `statusUpdate`。`CancelTask` 通过运行任务表找到正确的 agent；executor 按 `contextId` 命名会话（命名空间 `a2a-<agentId>-<hash>`），后续轮次继续同一会话。
- client 用 SDK 的 `ClientFactory`（JSON-RPC + REST 双传输）解析注册表，authenticating fetch 注入每个 agent 的 headers。

## ⚠️ 限制

- 入站鉴权：0.3.0 起可设 `server.apiKey` 开启 Bearer token 校验（Agent Card 除外——它必须公开可读）；大规模部署仍建议再套鉴权网关或反代，Agent Card 不声明 security scheme
- **每个 `/agents/<id>` 一个 executor 实例**（服务该 agent 的所有 context）；session 跨轮次延续，但 dsh 重启后内存态重建。根 `/.well-known/agent-card.json` 只返回第一个 agent——指定某个 agent 请走 `/agents/<id>/...`
- `model` 覆盖只能切换本 executor 实例创建的会话；从外部 adopt 来的会话（在 web UI 打开过、或从磁盘恢复的）没有可切换的路由句柄，覆盖值记日志后忽略，回复沿用创建时的模型。会话由本 executor 创建之后再发 model 则正常切换
- **0.2.0 起注册表支持 GUI 配置**：设置 → 插件 → 插件配置里的「A2A 远程 agent」卡片可直接增删改注册表，保存即热更新 `a2a_call` / `a2a_list`，无需重启；重置则恢复部署默认（cordis 行配置）。配置落在 settings 文档的 `a2a` 命名空间，解析层级为 schema 默认值 → 行配置 base → 用户覆盖

## 🧪 开发

```sh
npm run check   # biome + typecheck + vitest（59 个测试）+ 构建
```

测试覆盖配置校验、官方 A2A client 走真实 HTTP 端口的 Agent Card + JSON-RPC 往返、按 context 会话延续、任务取消、header 鉴权、请求级覆盖与模型工具。

## 📄 License

[MIT](LICENSE)
