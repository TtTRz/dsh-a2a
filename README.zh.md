# dsh-a2a

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 A2A v1.0 插件——把 harness 暴露为 A2A agent，也让 harness agent 能调远程 A2A agent。

[![npm version](https://img.shields.io/npm/v/dsh-a2a)](https://www.npmjs.com/package/dsh-a2a)
[![license](https://img.shields.io/npm/l/dsh-a2a)](LICENSE)
[![node](https://img.shields.io/node/v/dsh-a2a)](https://nodejs.org)

一个插件两个半身，底层走官方 [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js)（A2A 协议 v1.0）：

- **Server**——自带的 HTTP 端点把 harness 暴露为 A2A agent：Agent Card 发现、JSON-RPC（必选传输，含 SSE 流式）、HTTP+JSON REST。每个 A2A `contextId` 映射到一个**持久化 harness 会话**，追问继续同一个对话。
- **Client**——`a2a_call` / `a2a_list` 两个模型工具，从配置驱动的注册表把活派给远程 A2A agent，支持 header 鉴权。

## ✨ 特性

- 🤖 **一个 contextId = 一个 harness agent**——会话 id 由 `sha256(contextId)` 确定性派生，挂载 preset（默认 `standard`），跨轮次延续
- 🔌 **完整 A2A v1.0 线格式**——`/.well-known/agent-card.json`、JSON-RPC `SendMessage` / `SendStreamingMessage` / `GetTask` / `CancelTask` / `ListTasks`（流式走 SSE）、REST `message:send` / `tasks/*`——全部经官方 SDK 的 request handler
- 🔒 **客户端 header 鉴权**——每个 agent 的 headers 支持 `${ENV_VAR}` 占位符调用时解析，凭证不进配置
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
      preset: standard         # 挂进每个会话 agent 的 preset
      turnTimeoutMs: 300000    # 单轮超时
      agentCard:
        name: dsh-a2a
        description: A DeepSeek Harness agent exposed over the A2A protocol.
        version: '0.1.0'
    agents:                    # a2a_call 可触达的远程 agent
      - name: specialist
        url: http://127.0.0.1:9000/
        headers:
          authorization: Bearer ${SPECIALIST_TOKEN}
        description: 领域问题的专家 agent。
```

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `server.enabled` | `true` | 是否开启 A2A 端点；client 工具不受影响 |
| `server.host` / `server.port` | `127.0.0.1` / `8899` | 监听地址（env `A2A_HOST` / `A2A_PORT`） |
| `server.preset` | `standard` | 挂进每个 A2A 会话 agent 的 preset |
| `server.turnTimeoutMs` | `300000` | 单轮超时，超时取消本轮 |
| `server.agentCard.*` | — | 展示给调用方的 Agent Card 身份 |
| `agents[].name` / `url` | — | `a2a_call` 用的注册名 + Agent Card URL |
| `agents[].headers` | `{}` | 请求头；`${ENV_VAR}` 占位符调用时解析 |
| `agents[].description` | `''` | `a2a_list` 展示 |

## 💬 模型工具

| 工具 | 作用 |
| --- | --- |
| `a2a_list` | 列出已注册的远程 A2A agent（名字 + 描述） |
| `a2a_call` | 给某个已注册 agent 发 prompt，返回其完整文本回复 |

## 🏗️ 工作原理

- server 是**独立 Node HTTP 监听**（不挂在 web GUI 路由上）：Agent Card 与 JSON-RPC 位于 agent 根 URL，而 web 应用已占用根路径。生命周期绑定 Cordis fiber——插件加载时起监听，卸载时连同 socket 一起关。
- executor 实现 SDK 的 `AgentExecutor` 契约：先发 `task` 事件 → 跑一轮 harness（`followup` → 带截止时间的 `whenIdle` → 超时 `cancel`）→ 回复以 `message` 事件发出 → 终态 `statusUpdate`。`CancelTask` 通过运行任务表找到正确的 agent。
- client 用 SDK 的 `ClientFactory`（JSON-RPC + REST 双传输）解析注册表，authenticating fetch 注入每个 agent 的 headers。

## ⚠️ 限制

- 入站鉴权交给部署层（把端口放到太湖网关或反代后面）；v0.1 的 Agent Card 不声明任何 security scheme
- 单个 executor 实例服务所有 context；跨轮次延续会话，但 dsh 重启后内存态重建（`sessionPersistence` 持久化是规划中的后续）
- 出站注册表改动需要改 profile patch 并重启（settings 化 CRUD 是规划中的后续）

## 🧪 开发

```sh
npm run check   # biome + typecheck + vitest（12 个测试）+ 构建
```

测试覆盖配置校验、官方 A2A client 走真实 HTTP 端口的 Agent Card + JSON-RPC 往返、按 context 会话延续、任务取消、header 鉴权与模型工具。

## 📄 License

[MIT](LICENSE)
