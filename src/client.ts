/**
 * Remote A2A client: resolves the registry entries into SDK clients and
 * turns a plain-text prompt into a blocking sendMessage round trip.
 * Credentials never appear in the config: header values may carry
 * `${ENV_VAR}` placeholders resolved at call time.
 *
 * @module dsh-a2a/client
 */

import { randomUUID } from 'node:crypto'
import type { SendMessageResult, Task } from '@a2a-js/sdk'
import { Role, TaskState } from '@a2a-js/sdk'
import {
  type AuthenticationHandler,
  ClientFactory,
  ClientFactoryOptions,
  createAuthenticatingFetchWithRetry,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from '@a2a-js/sdk/client'
import type { ResolvedAgentEntry } from './config.js'
import { textPart } from './executor.js'

export const DEFAULT_CALL_TIMEOUT_MS = 300_000

/** Resolve `${ENV_VAR}` placeholders against process.env at call time. */
export function resolveHeaders(template: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(template)) {
    out[name] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
      const resolved = process.env[key]
      if (resolved === undefined) {
        throw new Error(`dsh-a2a: header ${name} references undefined env var ${key}`)
      }
      return resolved
    })
  }
  return out
}

/** A static-header authentication handler for the SDK's fetch wrapper. */
function staticHeaders(headers: Record<string, string>): AuthenticationHandler {
  const resolved = resolveHeaders(headers)
  return {
    headers: async () => resolved,
    shouldRetryWithHeaders: async () => undefined,
  }
}

/** Extract the plain text of a completed sendMessage result. */
export function textOfResult(result: SendMessageResult): string {
  if ('role' in result) return textOfParts(result.parts ?? [])
  const task = result as Task
  const statusParts = task.status?.message?.parts ?? []
  const artifactParts = (task.artifacts ?? []).flatMap((artifact) => artifact.parts ?? [])
  return (
    textOfParts(statusParts) ||
    textOfParts(artifactParts) ||
    `task ended in state ${String(task.status?.state)}`
  )
}

/**
 * Normalize a registry URL to the agent BASE the SDK expects: the SDK
 * appends `/.well-known/agent-card.json` itself, so an entry that already
 * names the full agent-card path would otherwise double the segment.
 */
export function baseUrlOf(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  const cardPath = '/.well-known/agent-card.json'
  if (trimmed.endsWith(cardPath)) return trimmed.slice(0, -cardPath.length)
  const wellKnown = trimmed.indexOf('/.well-known/')
  if (wellKnown >= 0) return trimmed.slice(0, wellKnown)
  return trimmed
}

function textOfParts(
  parts: ReadonlyArray<{ content?: { $case?: string; value?: unknown } }>,
): string {
  const texts = parts
    .filter((part) => part.content?.$case === 'text')
    .map((part) => String(part.content?.value ?? ''))
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
  return texts.join('\n')
}

export interface CallOptions {
  /** Deadline for the whole round trip; the request is aborted past it. */
  timeoutMillis?: number
}

/**
 * Send one text prompt to a registered remote agent and wait for the
 * completed reply. Throws on transport, timeout, or task failures.
 */
export async function callAgent(
  entry: ResolvedAgentEntry,
  text: string,
  options: CallOptions = {},
): Promise<string> {
  const timeoutMillis = options.timeoutMillis ?? DEFAULT_CALL_TIMEOUT_MS
  const fetchImpl = createAuthenticatingFetchWithRetry(fetch, staticHeaders(entry.headers))
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [
        new JsonRpcTransportFactory({ fetchImpl }),
        new RestTransportFactory({ fetchImpl }),
      ],
    }),
  )
  const client = await factory.createFromUrl(baseUrlOf(entry.url))
  const signal = AbortSignal.timeout(timeoutMillis)
  const result = await client.sendMessage(
    {
      tenant: '',
      message: {
        role: Role.ROLE_USER,
        parts: [textPart(text)],
        messageId: randomUUID(),
        taskId: '',
        contextId: '',
        extensions: [],
        referenceTaskIds: [],
        metadata: undefined,
      },
      configuration: undefined,
      metadata: undefined,
    },
    { signal },
  )
  // Synchronous agents answer with a Message; asynchronous ones return a Task
  // that must be polled to a terminal state before its reply is readable.
  if ('role' in result) return textOfResult(result)
  let task = result
  while (
    task.status?.state === TaskState.TASK_STATE_SUBMITTED ||
    task.status?.state === TaskState.TASK_STATE_WORKING
  ) {
    if (signal.aborted) throw new Error('dsh-a2a: timed out waiting for the remote task to finish')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    task = await client.getTask({ id: task.id, tenant: '' }, { signal })
  }
  return textOfResult(task)
}
