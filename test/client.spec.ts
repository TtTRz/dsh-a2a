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
import { callAgent, resolveHeaders } from '../src/client.js'
import { resolveConfig } from '../src/config.js'
import { agentMessage, textOf } from '../src/executor.js'
import { A2aServer } from '../src/server.js'
import { A2aRegistry, a2aTools } from '../src/tools.js'
import { freePort } from './net.js'

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
    executor: echoExecutor,
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
      { name: 'echo', url: server.url, headers: {}, description: '' },
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
        url: server.url,
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

describe('a2aTools', () => {
  it('lists registry entries and calls a remote agent', async () => {
    server = await startEchoServer()
    const registry = new A2aRegistry([
      { name: 'echo', url: server.url, headers: {}, description: 'an echo agent' },
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
