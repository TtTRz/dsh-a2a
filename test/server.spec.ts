/**
 * Server-half integration: a real A2A HTTP endpoint (Agent Card + JSON-RPC)
 * driven by the DshAgentExecutor over a stubbed harness context, exercised
 * end to end with the official A2A client.
 */

import type { Message } from '@a2a-js/sdk'
import { Role as RoleEnum, TaskState } from '@a2a-js/sdk'
import { ClientFactory, ClientFactoryOptions } from '@a2a-js/sdk/client'
import type { ExecutionEventBus } from '@a2a-js/sdk/server'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { DshAgentExecutor, textPart } from '../src/executor.js'
import { A2aServer } from '../src/server.js'
import { freePort } from './net.js'

interface SessionEventLike {
  type: string
  data: unknown
}

/** A minimal agent stand-in: appends a reply event, then goes idle. */
class FakeAgent {
  status: 'idle' | 'busy' = 'idle'
  readonly session = { events: [] as SessionEventLike[] }
  private resolveIdle?: () => void
  /** When true, the turn never finishes until cancel() is called. */
  hang = false
  cancelled = false

  followup(): void {
    this.status = 'busy'
    if (this.hang) return
    this.session.events.push({
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'reasoning', text: 'thinking' },
            { type: 'text', text: 'pong' },
          ],
        },
      },
    })
    queueMicrotask(() => this.resolveIdle?.())
  }

  whenIdle(): Promise<void> {
    return new Promise((resolve) => {
      this.resolveIdle = () => {
        this.status = 'idle'
        resolve()
      }
    })
  }

  cancel(): void {
    this.cancelled = true
    this.status = 'idle'
    this.resolveIdle?.()
  }
}

interface CreateCall {
  sessionId: string
  setup?: (agentCtx: Context) => Promise<void>
}

function fakeCtx(agents: Map<string, FakeAgent> = new Map()): Context {
  const ctx = {
    get: (name: string) => {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }
      }
      if (name === 'agentPresets') {
        return { resolve: async () => ({ id: 'standard' }), mount: async () => undefined }
      }
      return undefined
    },
    agents: {
      get: (id: string) => agents.get(id),
      create: async ({ sessionId, setup }: CreateCall) => {
        await setup?.({
          agentPresets: { mount: async () => undefined },
          on: () => () => undefined,
        } as unknown as Context)
        const agent = new FakeAgent()
        agents.set(sessionId, agent)
        return { agent, dispose: async () => undefined }
      },
    },
    agentPresets: { resolve: async () => ({ id: 'standard' }), mount: async () => undefined },
    logger: console,
  }
  return ctx as unknown as Context
}

function userMessage(text: string): Message {
  return {
    role: RoleEnum.ROLE_USER,
    parts: [textPart(text)],
    messageId: 'm-1',
    taskId: '',
    contextId: '',
    extensions: [],
    referenceTaskIds: [],
    metadata: undefined,
  }
}

function collectingBus(): { bus: ExecutionEventBus; events: unknown[] } {
  const events: unknown[] = []
  const bus: ExecutionEventBus = {
    publish: (event: unknown) => {
      events.push(event)
    },
    on: () => bus,
    off: () => bus,
    once: () => bus,
    removeAllListeners: () => bus,
    finished: () => undefined,
  }
  return { bus, events }
}

describe('A2A server with a harness executor', () => {
  it('serves the Agent Card and answers a JSON-RPC SendMessage with the agent reply', async () => {
    const port = await freePort()
    const agents = new Map<string, FakeAgent>()
    const ctx = fakeCtx(agents)
    const executor = new DshAgentExecutor(ctx, { preset: 'standard', turnTimeoutMs: 10_000 })
    const server = new A2aServer({
      config: resolveConfig({
        server: { host: '127.0.0.1', port, agentCard: { name: 'test-agent' } },
      }).server,
      executor,
    })
    await server.start()
    try {
      // Agent Card discovery over plain HTTP.
      const cardResponse = await fetch(`${server.url}.well-known/agent-card.json`)
      expect(cardResponse.status).toBe(200)
      const card = (await cardResponse.json()) as { name: string }
      expect(card.name).toBe('test-agent')

      // Blocking SendMessage through the official client.
      const client = await new ClientFactory(ClientFactoryOptions.default).createFromUrl(server.url)
      const result = await client.sendMessage({
        tenant: '',
        message: userMessage('hello'),
        configuration: undefined,
        metadata: undefined,
      })
      // The reply rides on the terminal status update (the SDK ends the event
      // stream at the first terminal event), so callers get a completed Task.
      const task = result as unknown as {
        status: { state: TaskState; message?: Message }
      }
      expect(task.status.state).toBe(TaskState.TASK_STATE_COMPLETED)
      const reply = (task.status.message?.parts ?? [])
        .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
        .join('')
      expect(reply).toBe('pong')
    } finally {
      await server.stop()
    }
  })

  it('keeps per-context sessions and continues the same agent', async () => {
    const port = await freePort()
    const agents = new Map<string, FakeAgent>()
    const executor = new DshAgentExecutor(fakeCtx(agents), {
      preset: 'standard',
      turnTimeoutMs: 10_000,
    })
    const server = new A2aServer({
      config: resolveConfig({ server: { host: '127.0.0.1', port } }).server,
      executor,
    })
    await server.start()
    try {
      const client = await new ClientFactory(ClientFactoryOptions.default).createFromUrl(server.url)
      const message = (text: string): Message => ({
        ...userMessage(text),
        messageId: Math.random().toString(),
        contextId: 'ctx-1',
      })
      await client.sendMessage({
        tenant: '',
        message: message('one'),
        configuration: undefined,
        metadata: undefined,
      })
      await client.sendMessage({
        tenant: '',
        message: message('two'),
        configuration: undefined,
        metadata: undefined,
      })
      // Both turns ran on the same derived session.
      const ids = [...agents.keys()]
      expect(ids).toHaveLength(1)
      expect(ids[0]).toMatch(/^a2a-/)
    } finally {
      await server.stop()
    }
  })

  it('cancels a running turn through cancelTask', async () => {
    const port = await freePort()
    const agents = new Map<string, FakeAgent>()
    const ctx = fakeCtx(agents)
    const executor = new DshAgentExecutor(ctx, { preset: 'standard', turnTimeoutMs: 10_000 })
    const { bus, events } = collectingBus()
    const hanging = new FakeAgent()
    hanging.hang = true
    ;(
      ctx as unknown as {
        agents: { create: () => Promise<{ agent: FakeAgent; dispose: () => Promise<void> }> }
      }
    ).agents.create = async () => ({ agent: hanging, dispose: async () => undefined })

    const taskId = 'task-1'
    const requestContext = {
      taskId,
      contextId: 'ctx-1',
      context: {},
      userMessage: userMessage('hello'),
      request: {
        tenant: '',
        message: userMessage('hello'),
        configuration: undefined,
        metadata: undefined,
      },
    } as never
    const execution = executor.execute(requestContext, bus)
    await new Promise((resolve) => setTimeout(resolve, 30))
    await executor.cancelTask(taskId, bus)
    await execution
    expect(hanging.cancelled).toBe(true)
    const states = (events as Array<{ kind: string; data?: { status?: { state: number } } }>)
      .filter((event) => event.kind === 'statusUpdate')
      .map((event) => event.data?.status?.state)
    expect(states).toContain(2) // TASK_STATE_WORKING
    expect(states).toContain(5) // TASK_STATE_CANCELED
    expect(port).toBeGreaterThan(0)
  })

  it('enforces the configured API key on everything but the Agent Card', async () => {
    const port = await freePort()
    const executor = new DshAgentExecutor(fakeCtx(), { preset: 'standard', turnTimeoutMs: 10_000 })
    const server = new A2aServer({
      config: resolveConfig({ server: { host: '127.0.0.1', port, apiKey: 'secret' } }).server,
      executor,
    })
    await server.start()
    try {
      // The Agent Card stays public for discovery and declares the scheme.
      const cardResponse = await fetch(`${server.url}.well-known/agent-card.json`)
      expect(cardResponse.status).toBe(200)
      const card = (await cardResponse.json()) as {
        securitySchemes: Record<string, unknown>
        securityRequirements: Array<{ schemes: Record<string, unknown> }>
      }
      expect('bearer' in card.securitySchemes).toBe(true)
      expect(card.securityRequirements.length).toBeGreaterThan(0)

      const body = JSON.stringify({
        message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      })
      // No credentials → 401.
      const noAuth = await fetch(`${server.url}message:send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      expect(noAuth.status).toBe(401)
      // Wrong credentials → 401.
      const badAuth = await fetch(`${server.url}message:send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
        body,
      })
      expect(badAuth.status).toBe(401)
      // Correct credentials pass the fence (the business reply may still vary).
      const goodAuth = await fetch(`${server.url}message:send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
        body,
      })
      expect(goodAuth.status).not.toBe(401)
    } finally {
      await server.stop()
    }
  })

  it('advertises the configured public URL on the Agent Card', async () => {
    const port = await freePort()
    const executor = new DshAgentExecutor(fakeCtx(), { preset: 'standard', turnTimeoutMs: 10_000 })
    const server = new A2aServer({
      config: resolveConfig({
        server: { host: '127.0.0.1', port, publicUrl: 'https://agents.example.com/' },
      }).server,
      executor,
    })
    await server.start()
    try {
      expect(server.url).toBe('https://agents.example.com/')
      const cardResponse = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`)
      expect(cardResponse.status).toBe(200)
      const card = (await cardResponse.json()) as { provider: { url: string } }
      expect(card.provider.url).toBe('https://agents.example.com/')
    } finally {
      await server.stop()
    }
  })

  it('creates A2A agents with a model route and the A2A workspace metadata', async () => {
    const agents = new Map<string, FakeAgent>()
    const ctx = fakeCtx(agents)
    const creates: Array<{ meta?: unknown; agentOptions?: unknown }> = []
    ;(
      ctx as unknown as {
        agents: {
          create: (options: {
            meta?: unknown
            agentOptions?: unknown
          }) => Promise<{ agent: FakeAgent; dispose: () => Promise<void> }>
        }
      }
    ).agents.create = async (options) => {
      creates.push(options)
      const agent = new FakeAgent()
      return { agent, dispose: async () => undefined }
    }
    const executor = new DshAgentExecutor(ctx, {
      preset: 'standard',
      turnTimeoutMs: 10_000,
      cwd: '/tmp/a2a-ws-test',
      workspaceTitle: 'A2A',
    })
    const { bus } = collectingBus()
    await executor.execute(
      {
        taskId: 'task-1',
        contextId: 'ctx-1',
        context: {},
        userMessage: userMessage('hello'),
        request: {
          tenant: '',
          message: userMessage('hello'),
          configuration: undefined,
          metadata: undefined,
        },
      } as never,
      bus,
    )
    expect(creates[0]?.agentOptions).toEqual({ provider: 'test-provider', model: 'test-model' })
    expect(creates[0]?.meta).toMatchObject({ cwd: '/tmp/a2a-ws-test', agentPreset: 'standard' })
  })

  it('validates the A2A workspace defaults and the provider/model pair', () => {
    const defaults = resolveConfig({ server: { host: '127.0.0.1' } })
    expect(defaults.server.workspaceTitle).toBe('A2A')
    expect(defaults.server.cwd.length).toBeGreaterThan(0)
    expect(() => resolveConfig({ server: { provider: 'venus' } })).toThrow(/together/)
  })
})
