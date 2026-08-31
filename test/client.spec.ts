/**
 * Client-half integration: the `callAgent` helper and the model-facing tools
 * exercised against a local A2A endpoint built from the same server code,
 * with header auth resolved from `${ENV}` placeholders.
 */

import type { IncomingMessage } from 'node:http'
import type { Task } from '@a2a-js/sdk'
import { TaskState as TaskStateEnum } from '@a2a-js/sdk'
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server'
import { afterEach, describe, expect, it } from 'vitest'
import { baseUrlOf, callAgent, resolveHeaders, textOfResult } from '../src/client.js'
import { resolveConfig } from '../src/config.js'
import { agentMessage, textOf } from '../src/executor.js'
import { A2aServer } from '../src/server.js'
import { A2aRegistry, a2aTools } from '../src/tools.js'
import { freePort } from './net.js'

const testAgent = {
  id: 'test',
  name: 'test-agent',
  description: 'test',
  version: '0.1.0',
  preset: 'standard',
  cwd: '/tmp',
  workspaceTitle: 'A2A',
}

const observedHeaders: string[] = []

/** Echo executor: replies with the received text, records nothing secret. */
const echoExecutor: AgentExecutor = {
  execute: async (requestContext: RequestContext, eventBus: ExecutionEventBus) => {
    const taskId = requestContext.taskId
    const contextId = requestContext.contextId
    const snapshot: Task = requestContext.task ?? {
      id: taskId,
      contextId,
      status: {
        state: TaskStateEnum.TASK_STATE_SUBMITTED,
        timestamp: new Date().toISOString(),
        message: undefined,
      },
      artifacts: [],
      history: [requestContext.userMessage],
      metadata: undefined,
    }
    eventBus.publish(AgentEvent.task(snapshot))
    eventBus.publish(
      AgentEvent.message(
        agentMessage(`echo:${textOf(requestContext.userMessage)}`, taskId, contextId),
      ),
    )
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: TaskStateEnum.TASK_STATE_COMPLETED,
          timestamp: new Date().toISOString(),
          message: undefined,
        },
        metadata: {},
      }),
    )
  },
  cancelTask: async () => undefined,
}

let server: A2aServer | undefined

async function startEchoServer(): Promise<A2aServer> {
  const port = await freePort()
  const created = new A2aServer({
    config: resolveConfig({ server: { host: '127.0.0.1', port } }).server,
    agents: [{ agent: testAgent, executor: echoExecutor }],
    onRequest: (req: IncomingMessage) => {
      observedHeaders.push(req.headers.authorization ?? '')
    },
  })
  await created.start()
  return created
}

afterEach(async () => {
  await server?.stop()
  server = undefined
  observedHeaders.length = 0
  delete process.env.MOCK_TOKEN
})

describe('callAgent', () => {
  it('round-trips a prompt through a real A2A endpoint', async () => {
    server = await startEchoServer()
    const reply = await callAgent(
      { name: 'echo', url: `${server.url}agents/test/`, headers: {}, description: '' },
      '你好',
      { timeoutMillis: 10_000 },
    )
    expect(reply).toBe('echo:你好')
  })

  // biome-ignore lint/suspicious/noTemplateCurlyInString: ${ENV} placeholder syntax is intentional
  it('sends auth headers resolved from ${ENV} placeholders', async () => {
    process.env.MOCK_TOKEN = 'secret-token'
    server = await startEchoServer()
    await callAgent(
      {
        name: 'echo',
        url: `${server.url}agents/test/`,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: ${ENV} placeholder syntax is intentional
        headers: { authorization: 'Bearer ${MOCK_TOKEN}' },
        description: '',
      },
      'hi',
      { timeoutMillis: 10_000 },
    )
    expect(observedHeaders).toContain('Bearer secret-token')
  })
})

describe('resolveHeaders', () => {
  it('substitutes env placeholders and rejects unknown variables', () => {
    process.env.MOCK_TOKEN = 'abc'
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${ENV} placeholder syntax is intentional
    expect(resolveHeaders({ authorization: 'Bearer ${MOCK_TOKEN}' })).toEqual({
      authorization: 'Bearer abc',
    })
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${ENV} placeholder syntax is intentional
    expect(() => resolveHeaders({ authorization: 'Bearer ${NO_SUCH_VAR}' })).toThrow(/NO_SUCH_VAR/)
  })
})

describe('baseUrlOf', () => {
  it('keeps a bare base URL unchanged (trailing slash retained for the SDK)', () => {
    expect(baseUrlOf('http://host:18878/')).toBe('http://host:18878/')
    expect(baseUrlOf('http://host:18878')).toBe('http://host:18878')
    expect(baseUrlOf('http://host/base/')).toBe('http://host/base/')
  })

  it('strips a full agent-card path down to the base', () => {
    expect(baseUrlOf('http://host:18878/.well-known/agent-card.json')).toBe('http://host:18878')
  })

  it('strips any deeper .well-known path down to the base', () => {
    expect(baseUrlOf('http://host:18878/.well-known/agent-card.json/')).toBe('http://host:18878')
    expect(baseUrlOf('http://host/base/.well-known/agent-card.json')).toBe('http://host/base')
  })
})

describe('textOfResult', () => {
  it('reads the reply from the terminal status message of a completed task', () => {
    const task = {
      id: 't-1',
      contextId: 'c-1',
      status: {
        state: TaskStateEnum.TASK_STATE_COMPLETED,
        timestamp: new Date().toISOString(),
        message: {
          role: 'agent',
          parts: [{ content: { $case: 'text', value: '全部查完了，结论如下' } }],
        },
      },
      artifacts: [],
    } as unknown as Task
    expect(textOfResult(task)).toBe('全部查完了，结论如下')
  })

  it('falls back to the task state when no reply text is present', () => {
    const task = {
      id: 't-1',
      contextId: 'c-1',
      status: { state: TaskStateEnum.TASK_STATE_WORKING, timestamp: new Date().toISOString() },
      artifacts: [],
    } as unknown as Task
    expect(textOfResult(task)).toBe('task ended in state 2')
  })
})

describe('a2aTools', () => {
  it('lists registry entries and calls a remote agent', async () => {
    server = await startEchoServer()
    const registry = new A2aRegistry([
      { name: 'echo', url: `${server.url}agents/test/`, headers: {}, description: 'an echo agent' },
    ])
    const tools = a2aTools(registry, { callTimeoutMs: 10_000 })

    const listed = await (tools.list.execute as (args: never, exec: never) => Promise<string>)(
      {} as never,
      undefined as never,
    )
    expect(listed).toContain('echo: an echo agent')

    const reply = await (
      tools.call.execute as (
        args: { agent: string; message: string },
        exec: never,
      ) => Promise<string>
    )({ agent: 'echo', message: 'ping' }, undefined as never)
    expect(reply).toBe('echo:ping')

    await expect(
      (
        tools.call.execute as (
          args: { agent: string; message: string },
          exec: never,
        ) => Promise<string>
      )({ agent: 'missing', message: 'x' }, undefined as never),
    ).rejects.toThrow(/no such remote agent/)
  })
})
