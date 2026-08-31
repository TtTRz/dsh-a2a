/**
 * Per-request overrides: the metadata contract callers use to pick a preset
 * and a model route, and the two lifetimes the executor gives them — a preset
 * composes an agent and therefore applies on the request that creates the
 * session, while the model is a per-step route a live session is switched
 * onto.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestOverrides, textPart } from '../src/executor.js'

/** The mutable route an agent reads per step; capturing them is how a switch shows up. */
interface SelectionRef {
  current: { provider: string; model: string } | undefined
  assembled: { provider: string; model: string } | undefined
}

// `vi.mock` factories are hoisted above the module body, so the array they
// push into has to be hoisted with them.
const { installed, warns } = vi.hoisted(() => ({
  installed: [] as SelectionRef[],
  warns: [] as string[],
}))

vi.mock('@deepseek-ai/dsh-agent', () => ({
  installModelSelection: (_agentCtx: unknown, selection: unknown): (() => void) => {
    installed.push(selection as SelectionRef)
    return () => undefined
  },
}))

const { DshAgentExecutor } = await import('../src/executor.js')

/** A minimal agent stand-in: replies once, then goes idle. */
class FakeAgent {
  readonly session = {
    events: [
      {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'pong' }] } },
      },
    ] as Array<{ type: string; data: unknown }>,
  }

  followup(): void {}

  whenIdle(): Promise<void> {
    return Promise.resolve()
  }

  cancel(): void {}
}

interface CreateCall {
  sessionId: string
  meta: { cwd: string; agentPreset?: string }
  agentOptions: { provider: string; model: string }
  setup?: (agentCtx: Context) => Promise<void>
}

/** The route this deployment answers on when no request says otherwise. */
const ROUTE = { provider: 'cfg-provider', model: 'cfg-model' }

/** Sessions are minted under a throwaway root so the tests touch no project path. */
const SESSION_ROOT = mkdtempSync(join(tmpdir(), 'dsh-a2a-overrides-'))
afterAll(() => {
  rmSync(SESSION_ROOT, { recursive: true, force: true })
})

interface HarnessOptions {
  /** Preset resolution; the default echoes the requested name back as the id. */
  resolvePreset?: (name: string) => Promise<string>
  /** Overrides the executor is constructed with. */
  allowOverrides?: boolean
  provider?: string
  model?: string
}

function harness(options: HarnessOptions = {}): {
  ctx: Context
  creates: CreateCall[]
  executor: InstanceType<typeof DshAgentExecutor>
} {
  const agents = new Map<string, FakeAgent>()
  const creates: CreateCall[] = []
  const ctx = {
    get: (name: string) => {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ ...ROUTE }) }
      if (name === 'agentPresets') {
        return {
          resolve: options.resolvePreset ?? (async (name: string) => ({ id: name })),
          mount: async () => undefined,
        }
      }
      return undefined
    },
    agents: {
      get: (id: string) => agents.get(id),
      create: async (call: CreateCall) => {
        creates.push(call)
        await call.setup?.(ctx as unknown as Context)
        const agent = new FakeAgent()
        agents.set(call.sessionId, agent)
        return { agent, dispose: async () => undefined }
      },
    },
    logger: {
      info: () => undefined,
      error: () => undefined,
      warn: (message: string) => warns.push(message),
    },
  }
  const executor = new DshAgentExecutor(ctx as unknown as Context, {
    preset: 'standard',
    turnTimeoutMs: 10_000,
    cwd: SESSION_ROOT,
    workspaceTitle: 'A2A',
    provider: options.provider,
    model: options.model,
    allowOverrides: options.allowOverrides,
  })
  return { ctx: ctx as unknown as Context, creates, executor }
}

let bus: { events: unknown[] }
beforeEach(() => {
  installed.length = 0
  warns.length = 0
  bus = { events: [] }
})

/** Drive one turn through the executor with the metadata a caller would send. */
async function send(
  executor: InstanceType<typeof DshAgentExecutor>,
  contextId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const userMessage = {
    role: 1,
    parts: [textPart('hello')],
    messageId: `m-${contextId}-${Math.random().toString()}`,
    taskId: '',
    contextId,
    extensions: [],
    referenceTaskIds: [],
    metadata,
  }
  await executor.execute(
    {
      taskId: `t-${contextId}-${Math.random().toString()}`,
      contextId,
      context: {},
      userMessage,
      request: { tenant: '', message: userMessage, configuration: undefined, metadata },
    } as never,
    {
      publish: (event: unknown) => bus.events.push(event),
      on: () => undefined,
      off: () => undefined,
      once: () => undefined,
      removeAllListeners: () => undefined,
      finished: () => undefined,
    } as never,
  )
}

/** The text of every terminal message the executor published. */
function replies(): string[] {
  return (bus.events as Array<{ kind?: string; data?: { status?: { message?: unknown } } }>)
    .filter((event) => event.kind === 'statusUpdate')
    .map((event) => textOfParts(event.data?.status?.message))
    .filter((text) => text.length > 0)
}

function textOfParts(message: unknown): string {
  const parts = (message as { parts?: Array<{ content?: { $case: string; value?: string } }> })
    ?.parts
  return (parts ?? [])
    .map((part) => (part.content?.$case === 'text' ? (part.content.value ?? '') : ''))
    .join('')
}

describe('requestOverrides', () => {
  const params = (metadata: Record<string, unknown>): Record<string, unknown> => ({
    tenant: '',
    message: {},
    configuration: undefined,
    metadata,
  })
  const message = (metadata: Record<string, unknown>): Record<string, unknown> => ({
    role: 1,
    parts: [],
    messageId: 'm',
    contextId: '',
    taskId: '',
    extensions: [],
    referenceTaskIds: [],
    metadata,
  })

  it('reads the preset from either key', () => {
    expect(requestOverrides(params({ agentPreset: 'graphrag' }), message({}))).toEqual({
      preset: 'graphrag',
    })
    expect(requestOverrides(params({ preset: 'graphrag' }), message({}))).toEqual({
      preset: 'graphrag',
    })
  })

  it('reads the model route from either map', () => {
    expect(
      requestOverrides(params({}), message({ model: 'deepseek-v4-pro', provider: 'bai' })),
    ).toEqual({ model: 'deepseek-v4-pro', provider: 'bai' })
    expect(requestOverrides(params({ model: 'deepseek-v4-pro' }), message({}))).toEqual({
      model: 'deepseek-v4-pro',
    })
  })

  it('lets message-level metadata win over request-level', () => {
    expect(requestOverrides(params({ model: 'slow' }), message({ model: 'fast' }))).toEqual({
      model: 'fast',
    })
  })

  it('treats blank and absent values as "not specified"', () => {
    expect(requestOverrides(params({}), message({}))).toEqual({})
    expect(requestOverrides(params({ model: '   ' }), message({}))).toEqual({})
    expect(requestOverrides(undefined, undefined)).toEqual({})
    expect(requestOverrides(params({}), message({ metadata: undefined }))).toEqual({})
  })

  it('rejects a value it could not honour silently', () => {
    expect(() => requestOverrides(params({ model: 42 }), message({}))).toThrow(/must be a string/)
    expect(() => requestOverrides(params({ agentPreset: '../etc' }), message({}))).toThrow(
      /metadata\.agentPreset/,
    )
    expect(() => requestOverrides(params({ model: 'x'.repeat(200) }), message({}))).toThrow(/model/)
  })
})

describe('per-request overrides in the executor', () => {
  it('creates the agent with the preset and model the request named', async () => {
    const { creates, executor } = harness()
    await send(executor, 'ctx-1', { agentPreset: 'graphrag', model: 'deepseek-v4-pro' })
    // A bare model pairs with the route's provider: callers name the model
    // they want, not the route serving it.
    expect(creates[0]?.agentOptions).toEqual({
      provider: 'cfg-provider',
      model: 'deepseek-v4-pro',
    })
    expect(creates[0]?.meta.agentPreset).toBe('graphrag')
  })

  it('honours a full route override and the configured preset when none is named', async () => {
    const { creates, executor } = harness({ provider: 'bai', model: 'deepseek-v4-flash' })
    await send(executor, 'ctx-1', { provider: 'venus', model: 'other-model' })
    expect(creates[0]?.agentOptions).toEqual({ provider: 'venus', model: 'other-model' })
    expect(creates[0]?.meta.agentPreset).toBe('standard')
  })

  it('switches a live session onto the model the request named', async () => {
    const { creates, executor } = harness()
    await send(executor, 'ctx-1')
    expect(installed[0]?.current).toEqual(ROUTE)
    await send(executor, 'ctx-1', { model: 'deepseek-v4-pro' })
    // One install proves the session was reused, and the mutated ref proves
    // the switch: the agent is never recreated for a model change.
    expect(creates).toHaveLength(1)
    expect(installed).toHaveLength(1)
    expect(installed[0]?.current).toEqual({ provider: 'cfg-provider', model: 'deepseek-v4-pro' })
  })

  it('keeps the overridden route for turns that name no model', async () => {
    const { executor } = harness()
    await send(executor, 'ctx-1', { model: 'deepseek-v4-pro' })
    await send(executor, 'ctx-1')
    expect(installed[0]?.current).toEqual({ provider: 'cfg-provider', model: 'deepseek-v4-pro' })
  })

  it('ignores a preset override once the session exists, and says so', async () => {
    const { creates, executor } = harness()
    await send(executor, 'ctx-1', { agentPreset: 'graphrag' })
    await send(executor, 'ctx-1', { agentPreset: 'myshcode' })
    // A preset composes an agent, so swapping it mid-conversation would leave
    // tool calls the new composition cannot make.
    expect(creates).toHaveLength(1)
    expect(creates[0]?.meta.agentPreset).toBe('graphrag')
    expect(warns.join('\n')).toMatch(/preset override "myshcode" ignored/)
  })

  it('fails the task when the preset does not exist, naming what does', async () => {
    const { executor } = harness({
      resolvePreset: async () => {
        const error = new Error('no preset named "code"') as Error & { available?: string[] }
        error.available = ['graphrag', 'myshcode']
        throw error
      },
    })
    await send(executor, 'ctx-1', { agentPreset: 'code' })
    expect(replies().join('\n')).toMatch(
      /cannot mount preset "code".*available: graphrag, myshcode/s,
    )
  })

  it('drops overrides when the deployment refuses them', async () => {
    const { creates, executor } = harness({ allowOverrides: false })
    await send(executor, 'ctx-1', { agentPreset: 'graphrag', model: 'deepseek-v4-pro' })
    expect(creates[0]?.agentOptions).toEqual(ROUTE)
    expect(creates[0]?.meta.agentPreset).toBe('standard')
    expect(warns.join('\n')).toMatch(/allowOverrides is false/)
  })

  it('leaves a request that names no override exactly as before', async () => {
    const { creates, executor } = harness({ provider: 'bai', model: 'deepseek-v4-flash' })
    await send(executor, 'ctx-1')
    expect(creates[0]?.agentOptions).toEqual({ provider: 'bai', model: 'deepseek-v4-flash' })
    expect(creates[0]?.meta.agentPreset).toBe('standard')
    expect(warns).toEqual([])
  })

  it('fails the task when a bare model has no provider to pair with', async () => {
    const noDefault = harness()
    // Drop the default-model service so there is no provider anywhere.
    ;(noDefault.ctx as unknown as { get: (name: string) => unknown }).get = (name: string) =>
      name === 'agentPresets'
        ? { resolve: async (id: string) => ({ id }), mount: async () => undefined }
        : undefined
    const bare = new DshAgentExecutor(noDefault.ctx, {
      preset: 'standard',
      turnTimeoutMs: 10_000,
      cwd: SESSION_ROOT,
    })
    await send(bare, 'ctx-2', { model: 'deepseek-v4-pro' })
    expect(replies().join('\n')).toMatch(/no provider\/model pair could be completed/)
  })
})
