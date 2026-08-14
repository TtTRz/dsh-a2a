/**
 * Model-facing A2A tools: `a2a_list` (what remote agents are registered)
 * and `a2a_call` (send a prompt to one and wait for the reply).
 *
 * @module dsh-a2a/tools
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { callAgent } from './client.js'
import type { ResolvedAgentEntry } from './config.js'

export class A2aRegistry {
  private readonly byName: Map<string, ResolvedAgentEntry>

  constructor(entries: readonly ResolvedAgentEntry[]) {
    this.byName = new Map(entries.map((entry) => [entry.name, entry]))
  }

  list(): ResolvedAgentEntry[] {
    return [...this.byName.values()]
  }

  get(name: string): ResolvedAgentEntry | undefined {
    return this.byName.get(name)
  }
}

export interface A2aToolOptions {
  /** Per-call deadline for `a2a_call`. */
  callTimeoutMs?: number
}

/** Build the two tool definitions over a registry. */
export function a2aTools(
  registry: A2aRegistry,
  options: A2aToolOptions = {},
): {
  list: ToolDefinition
  call: ToolDefinition
} {
  const list = defineTool({
    name: 'a2a_list',
    description:
      'List the registered remote A2A agents available for delegation (name, URL, and description).',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    execute: async () => {
      const entries = registry.list()
      if (entries.length === 0) return '（未注册任何远程 A2A agent）'
      return entries.map((entry) => `- ${entry.name}: ${entry.description || entry.url}`).join('\n')
    },
  })

  const call = defineTool({
    name: 'a2a_call',
    description:
      'Send a prompt to a registered remote A2A agent and wait for its completed text reply. Use it to delegate work to specialized agents; prefer local tools for local work.',
    parameters: {
      agent: {
        type: 'string',
        required: true,
        description: 'Registry name of the remote A2A agent (see a2a_list).',
      },
      message: {
        type: 'string',
        required: true,
        description: 'Prompt text to send to the remote agent.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: options.callTimeoutMs,
    execute: async ({ agent, message }) => {
      const entry = registry.get(agent)
      if (entry === undefined) {
        throw new Error(`dsh-a2a: no such remote agent ${JSON.stringify(agent)}; see a2a_list`)
      }
      return callAgent(entry, message, { timeoutMillis: options.callTimeoutMs })
    },
  })

  return { list, call }
}
