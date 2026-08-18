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
import type { ResolvedServer } from './config.js'

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
  executor: AgentExecutor
  /** Optional per-request hook (observability, tests). */
  onRequest?: RequestObserver
}

/** Build the Agent Card advertised on `GET /.well-known/agent-card.json`. */
export function buildAgentCard(config: ResolvedServer, baseUrl: string): AgentCard {
  const interfaceShape = {
    url: baseUrl,
    protocolVersion: A2A_PROTOCOL_VERSION,
    tenant: '',
  }
  return {
    name: config.agentCard.name,
    description: config.agentCard.description,
    version: config.agentCard.version,
    supportedInterfaces: [
      { ...interfaceShape, protocolBinding: 'JSONRPC' },
      { ...interfaceShape, protocolBinding: 'HTTP+JSON' },
    ],
    provider: {
      organization: 'dsh-a2a',
      url: baseUrl,
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
    securityRequirements: config.apiKey === undefined ? [] : [{ schemes: { bearer: { list: [] } } }],
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

/**
 * The A2A HTTP endpoint. `start()` binds the port; `stop()` closes the
 * listener and destroys open sockets. Thread-safe for one server instance
 * per plugin fiber (created and stopped through `ctx.effect`).
 */
export class A2aServer {
  private http: HttpServer | undefined
  private readonly sockets = new Set<import('node:net').Socket>()
  private readonly jsonRpc: JsonRpcTransportHandler

  constructor(private readonly options: A2aServerOptions) {
    const taskStore = new InMemoryTaskStore()
    const handler = new DefaultRequestHandler(
      buildAgentCard(options.config, this.url),
      taskStore,
      options.executor,
    )
    this.jsonRpc = new JsonRpcTransportHandler(handler)
    this.requestHandler = handler
  }

  private readonly requestHandler: DefaultRequestHandler
  private boundUrl: string | undefined

  /** The agent's base URL: the configured public URL, else the bound address. */
  get url(): string {
    return (
      this.options.config.publicUrl ??
      this.boundUrl ??
      `http://${this.options.config.host}:${this.options.config.port}/`
    )
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
    const address = http.address()
    if (address !== null && typeof address === 'object') {
      const port = address.port
      const host = this.options.config.host === '0.0.0.0' ? '127.0.0.1' : this.options.config.host
      this.boundUrl = `http://${host}:${port}/`
    }
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
    try {
      // The Agent Card stays public for discovery; every other request must
      // present the configured API key as a Bearer token (when one is set).
      const isCard = req.method === 'GET' && url.pathname === `/${AGENT_CARD_PATH}`
      if (!isCard && this.options.config.apiKey !== undefined) {
        const expected = `Bearer ${this.options.config.apiKey}`
        if (req.headers.authorization !== expected) {
          sendJson(res, 401, { error: 'unauthorized' })
          return
        }
      }
      if (isCard) {
        sendJson(res, 200, await this.requestHandler.getAgentCard())
        return
      }
      if (req.method === 'POST' && url.pathname === '/') {
        await this.handleJsonRpc(req, res)
        return
      }
      if (req.method === 'POST' && url.pathname === '/message:send') {
        const body = await readBody(req)
        sendJson(
          res,
          200,
          await this.requestHandler.sendMessage(restBody(body), new ServerCallContext()),
        )
        return
      }
      if (req.method === 'GET' && url.pathname === '/tasks') {
        sendJson(
          res,
          200,
          await this.requestHandler.listTasks(
            {
              tenant: '',
              contextId: '',
              status: TaskStateEnum.TASK_STATE_UNSPECIFIED,
              pageToken: '',
              statusTimestampAfter: '',
            },
            new ServerCallContext(),
          ),
        )
        return
      }
      const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)(?::cancel)?$/)
      if (taskMatch !== null && taskMatch[1] !== undefined) {
        const taskId = decodeURIComponent(taskMatch[1])
        if (req.method === 'GET' && !url.pathname.endsWith(':cancel')) {
          sendJson(
            res,
            200,
            await this.requestHandler.getTask({ id: taskId, tenant: '' }, new ServerCallContext()),
          )
          return
        }
        if (req.method === 'POST' && url.pathname.endsWith(':cancel')) {
          sendJson(
            res,
            200,
            await this.requestHandler.cancelTask(
              { id: taskId, tenant: '', metadata: undefined },
              new ServerCallContext(),
            ),
          )
          return
        }
      }
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      sendJson(res, 400, { error: String(error instanceof Error ? error.message : error) })
    }
  }

  private async handleJsonRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readBody(req)).toString('utf8')
    const outcome = await this.jsonRpc.handle(body, new ServerCallContext())
    if (isAsyncGenerator(outcome)) {
      // Peek the first event before committing to SSE, so an early failure
      // surfaces as a plain JSON-RPC error instead of a broken stream.
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
        res.write(
          `event: error\ndata: ${JSON.stringify({ code: -32603, message: String(error) })}\n\n`,
        )
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
