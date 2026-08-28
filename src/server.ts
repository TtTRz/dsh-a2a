/**
 * The A2A endpoint: a self-contained Node HTTP server speaking the A2A v1.0
 * wire — Agent Card discovery, JSON-RPC (the protocol's mandatory transport,
 * including SSE streaming), and the HTTP+JSON REST surface — backed by the
 * official SDK's request handler and a Harness-agent executor.
 *
 * It deliberately does not ride the harness web server: the Agent Card and
 * JSON-RPC live at the agent's root URL, which the web GUI already owns.
 * A dedicated listen port keeps the two surfaces cleanly separated.
 *
 * @module dsh-a2a/server
 */

import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  type AgentCard,
  type SendMessageRequest,
  type Task,
  TaskState as TaskStateEnum,
} from '@a2a-js/sdk'
import {
  type AgentExecutor,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
} from '@a2a-js/sdk/server'
import type { ResolvedAgentSpec, ResolvedServer } from './config.js'

const MAX_BODY_BYTES = 16 * 1024 * 1024
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const

/** Observed for observability and tests; never affects the response. */
export type RequestObserver = (req: IncomingMessage) => void

export interface A2aServerOptions {
  config: ResolvedServer
  /** One executor per local agent, named by its URL slug. */
  agents: Array<{ agent: ResolvedAgentSpec; executor: AgentExecutor }>
  /** Optional per-request hook (observability, tests). */
  onRequest?: RequestObserver
}

/** Build the Agent Card advertised on `GET /.well-known/agent-card.json`. */
export function buildAgentCard(
  config: ResolvedServer,
  serverRootUrl: string,
  agent?: ResolvedAgentSpec,
  agentUrl?: string,
): AgentCard {
  const name = agent?.name ?? config.agentCard.name
  const description = agent?.description ?? config.agentCard.description
  const version = agent?.version ?? config.agentCard.version
  const endpoint = agentUrl ?? serverRootUrl
  const interfaceShape = {
    url: endpoint,
    protocolVersion: A2A_PROTOCOL_VERSION,
    tenant: '',
  }
  return {
    name,
    description,
    version,
    supportedInterfaces: [
      { ...interfaceShape, protocolBinding: 'JSONRPC' },
      { ...interfaceShape, protocolBinding: 'HTTP+JSON' },
    ],
    provider: {
      organization: 'dsh-a2a',
      url: serverRootUrl,
    },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes:
      config.apiKey === undefined
        ? {}
        : {
            bearer: {
              scheme: {
                $case: 'httpAuthSecurityScheme',
                value: {
                  scheme: 'Bearer',
                  description: 'Present the configured API key as a Bearer token.',
                  bearerFormat: 'API key',
                },
              },
            },
          },
    securityRequirements:
      config.apiKey === undefined ? [] : [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [],
    documentationUrl: '',
    signatures: [],
  }
}

/** Normalize the snake_case REST wire body into the internal camelCase shape. */
function restBody(raw: unknown): SendMessageRequest {
  const body = (raw ?? {}) as Record<string, unknown>
  return {
    tenant: '',
    message: (body.message ?? {}) as SendMessageRequest['message'],
    configuration: body.configuration as SendMessageRequest['configuration'],
    metadata: body.metadata as SendMessageRequest['metadata'],
  }
}

/** One local agent route: its card + SDK handler + the sub-path it owns. */
interface AgentRoute {
  id: string
  card: AgentCard
  handler: DefaultRequestHandler
  /** URL-safe base path, e.g. `/agents/mp-perf`. */
  basePath: string
}

/**
 * A multi-agent A2A endpoint: one Node HTTP listener that serves several local
 * agents, each at `/agents/<id>/...` with its own Agent Card and preset-backed
 * executor. `/.well-known/agent-card.json` lists them (there is no default
 * agent at `/`), so an A2A client addresses a specific agent by path.
 */
export class A2aServer {
  private http: HttpServer | undefined
  private readonly sockets = new Set<import('node:net').Socket>()
  private readonly routes = new Map<string, AgentRoute>()
  private readonly cards: AgentCard[] = []

  constructor(private readonly options: A2aServerOptions) {
    for (const { agent, executor } of options.agents) {
      const basePath = `/agents/${agent.id}`
      // Server-root provider URL + per-agent endpoint URL: A2A clients read
      // `supportedInterfaces[].url` to pick the transport endpoint, so each
      // card must point at ITS OWN `/agents/<id>/` (there is no `/` agent).
      const card = buildAgentCard(options.config, this.url, agent, this.urlFor(basePath))
      const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor)
      this.routes.set(agent.id, { id: agent.id, card, handler, basePath })
      this.cards.push(card)
    }
  }

  /** Agent Card identity for one agent (from its executor/options). */
  private urlFor(basePath: string): string {
    const publicUrl = this.options.config.publicUrl
    if (publicUrl !== undefined && publicUrl.length > 0) {
      return `${publicUrl.replace(/\/$/, '')}${basePath}/`
    }
    return `http://${this.options.config.host}:${this.options.config.port}${basePath}/`
  }

  private get boundUrl(): string {
    return this.urlFor('')
  }

  /** The agent's base URL: the configured public URL, else the bound address. */
  get url(): string {
    return (
      this.options.config.publicUrl ??
      this.boundUrl ??
      `http://${this.options.config.host}:${this.options.config.port}/`
    )
  }

  /** Hot-apply a settings-sourced Agent Card override to the first agent. */
  updateCard(patch: { name?: string; description?: string }): void {
    const first = [...this.routes.values()][0]
    if (first === undefined) return
    first.card = {
      ...first.card,
      name: patch.name ?? first.card.name,
      description: patch.description ?? first.card.description,
    }
    if (this.cards.length > 0) this.cards[0] = first.card
  }

  /** Bind the configured port; resolves once listening. */
  async start(): Promise<void> {
    if (this.http !== undefined) return
    const http = createServer((req, res) => this.route(req, res))
    http.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    this.http = http
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(this.options.config.port, this.options.config.host, resolve)
    })
  }

  /** Close the listener and destroy open sockets; idempotent. */
  async stop(): Promise<void> {
    const http = this.http
    if (http === undefined) return
    this.http = undefined
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.options.onRequest?.(req)
    const url = new URL(req.url ?? '/', this.url)
    const path = url.pathname
    try {
      const isDiscovery = req.method === 'GET' && path === `/${AGENT_CARD_PATH}`
      if (isDiscovery) {
        // A2A v1.0 discovery: a single Agent Card. We serve the first local
        // agent's card here (there is no agent mounted at `/`); every agent is
        // addressed by path at `/agents/<id>`.
        const first = [...this.routes.values()][0]
        sendJson(res, 200, first === undefined ? { name: 'dsh-a2a' } : first.card)
        return
      }
      if (!isDiscovery && this.options.config.apiKey !== undefined) {
        const expected = `Bearer ${this.options.config.apiKey}`
        if (req.headers.authorization !== expected) {
          sendJson(res, 401, { error: 'unauthorized' })
          return
        }
      }
      const match = /^\/agents\/([^/]+)(\/.*)?$/.exec(path)
      if (match === null || match[1] === undefined) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      const route = this.routes.get(decodeURIComponent(match[1]))
      if (route === undefined) {
        sendJson(res, 404, { error: `unknown agent` })
        return
      }
      const sub = (match[2] ?? '').replace(/^\/+|\/+$/g, '')
      if (req.method === 'GET' && sub === AGENT_CARD_PATH) {
        sendJson(res, 200, route.card)
        return
      }
      await this.handleAgent(route, sub, req, res)
    } catch (error) {
      sendJson(res, 400, { error: String(error instanceof Error ? error.message : error) })
    }
  }

  private async handleAgent(
    route: AgentRoute,
    sub: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const jsonRpc = new JsonRpcTransportHandler(route.handler)
    if (req.method === 'POST' && sub === '') {
      await this.handleJsonRpc(jsonRpc, req, res)
      return
    }
    if (req.method === 'POST' && sub === 'message:send') {
      const body = await readBody(req)
      sendJson(
        res,
        200,
        await route.handler.sendMessage(restBody(body), new ServerCallContext()),
      )
      return
    }
    if (req.method === 'GET' && sub === 'tasks') {
      sendJson(
        res,
        200,
        await route.handler.listTasks(
          { tenant: '', contextId: '', status: TaskStateEnum.TASK_STATE_UNSPECIFIED, pageToken: '', statusTimestampAfter: '' },
          new ServerCallContext(),
        ),
      )
      return
    }
    const taskMatch = /^tasks\/([^/]+)(?::cancel)?$/.exec(sub)
    if (taskMatch !== null && taskMatch[1] !== undefined) {
      const taskId = decodeURIComponent(taskMatch[1])
      if (req.method === 'GET' && !sub.endsWith(':cancel')) {
        sendJson(res, 200, await route.handler.getTask({ id: taskId, tenant: '' }, new ServerCallContext()))
        return
      }
      if (req.method === 'POST' && sub.endsWith(':cancel')) {
        sendJson(res, 200, await route.handler.cancelTask({ id: taskId, tenant: '', metadata: undefined }, new ServerCallContext()))
        return
      }
    }
    sendJson(res, 404, { error: 'not found' })
  }

  private async handleJsonRpc(
    jsonRpc: JsonRpcTransportHandler,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = (await readBody(req)).toString('utf8')
    const outcome = await jsonRpc.handle(body, new ServerCallContext())
    if (isAsyncGenerator(outcome)) {
      const iterator = outcome[Symbol.asyncIterator]()
      let first: IteratorResult<unknown>
      try {
        first = await iterator.next()
      } catch (error) {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: String(error instanceof Error ? error.message : error) },
        })
        return
      }
      res.writeHead(200, SSE_HEADERS)
      if (first.done !== true) res.write(`data: ${JSON.stringify(first.value)}\n\n`)
      try {
        for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
          res.write(`data: ${JSON.stringify(next.value)}\n\n`)
        }
      } catch (error) {
        res.write(`event: error\ndata: ${JSON.stringify({ code: -32603, message: String(error) })}\n\n`)
      }
      res.end()
      return
    }
    sendJson(res, 200, outcome)
  }
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, void, undefined> {
  return (
    typeof (value as { [Symbol.asyncIterator]?: unknown })?.[Symbol.asyncIterator] === 'function'
  )
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(body.byteLength),
  })
  res.end(body)
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`dsh-a2a: request body exceeds ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export type { Task }
