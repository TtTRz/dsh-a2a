/**
 * dsh-a2a: A2A v1.0 for DeepSeek Harness.
 *
 * One plugin, two halves:
 *
 * - **server** — a self-contained HTTP endpoint exposing the harness as an
 *   A2A agent (Agent Card + JSON-RPC + HTTP+JSON REST). Every A2A
 *   `contextId` maps to a persistent harness session, so follow-up messages
 *   continue the same conversation.
 * - **client** — the `a2a_call` / `a2a_list` tools, so harness agents can
 *   delegate work to remote A2A agents from a config-driven registry.
 *
 * The wire layer is the official `@a2a-js/sdk` (A2A v1.0); this package
 * contributes the harness integration only.
 *
 * @module dsh-a2a
 */

import type { Context } from '@deepseek-ai/cordis'
import { type Config as PluginConfig, resolveConfig } from './config.js'
import { DshAgentExecutor } from './executor.js'
import { A2aServer } from './server.js'
import { attachSettings } from './settings.js'
import { A2aRegistry, a2aTools } from './tools.js'
import { A2aTestService, type ServerRef } from './typert.js'

export const name = 'dsh-a2a'
export const inject = ['agents', 'tools', 'attachments']

export { callAgent, DEFAULT_CALL_TIMEOUT_MS, resolveHeaders, textOfResult } from './client.js'
export type {
  AgentCardOptions,
  AgentEntry,
  Config as A2aConfig,
  ResolvedAgentEntry,
  ResolvedConfig,
  ResolvedServer,
  ServerOptions,
} from './config.js'
export { Config, normalizeAgents, resolveConfig } from './config.js'
export { collectReplyText, DshAgentExecutor, sessionIdFor, textOf } from './executor.js'
export { A2aServer, type A2aServerOptions, buildAgentCard, type RequestObserver } from './server.js'
export { A2aSettings, attachSettings, SETTINGS_NAMESPACE } from './settings.js'
export { A2aRegistry, type A2aToolOptions, a2aTools } from './tools.js'
export {
  A2aTestService,
  type AgentCardProbe,
  type ServerInfo,
  type ServerRef,
  serverInfoOf,
} from './typert.js'

/** Mount the A2A endpoint and the model-facing tools, tied to the Cordis lifecycle. */
export function apply(ctx: Context, config: PluginConfig): void {
  const resolved = resolveConfig(config)
  const primaryCard = resolved.server.agents[0]
  // Host-side Remote surface for the settings tab (agent-card probe + server
  // summary). Reads through a mutable ref so settings-sourced Agent Card
  // overrides show up in serverInfo without a restart.
  const serverRef: ServerRef = {
    server: resolved.server.enabled ? resolved.server : undefined,
    agentCard: {
      name: primaryCard?.name ?? resolved.server.agentCard.name,
      description: primaryCard?.description ?? resolved.server.agentCard.description,
    },
  }
  new A2aTestService(ctx, serverRef)
  let server: A2aServer | undefined
  const executors = resolved.server.agents.map((agent) => ({
    agent,
    executor: new DshAgentExecutor(ctx, {
      agentId: agent.id,
      preset: agent.preset,
      turnTimeoutMs: resolved.server.turnTimeoutMs,
      cwd: agent.cwd,
      workspaceTitle: agent.workspaceTitle,
      provider: agent.provider,
      model: agent.model,
    }),
  }))
  if (resolved.server.enabled) {
    server = new A2aServer({
      config: resolved.server,
      agents: executors.map(({ agent, executor }) => ({ agent, executor })),
    })
    const bound = server
    ctx.effect(() => {
      const running = bound.start().catch((error: unknown) => {
        ctx.logger.error(`dsh-a2a: server failed to start: ${String(error)}`)
      })
      return async () => {
        await running
        await bound.stop()
      }
    }, 'dsh-a2a.server')
    // Best-effort: after a restart, re-attach persisted a2a- conversations to
    // the grouping workspace (the registry may mount after this row activates).
    for (const { executor } of executors) void reattachPersisted(ctx, executor)
  }
  const registry = new A2aRegistry(resolved.agents)
  const tools = a2aTools(registry, { callTimeoutMs: resolved.server.callTimeoutMs })
  ctx.effect(() => ctx.tools.register(tools.list), 'dsh-a2a.a2a_list')
  ctx.effect(() => ctx.tools.register(tools.call), 'dsh-a2a.a2a_call')
  // The GUI surface: settings commits (A2A settings tab) hot-reload the tools
  // and the served Agent Card; profiles without a settings service keep the
  // static cordis-row registry and identity.
  attachSettings(
    ctx,
    {
      agents: resolved.agents,
      serverAgents: resolved.server.agents.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
      })),
    },
    (value) => {
      registry.update(value.agents)
      const first = value.serverAgents[0]
      serverRef.agentCard = {
        name: first?.name ?? '',
        description: first?.description ?? '',
      }
      for (const entry of value.serverAgents) {
        server?.updateCard(entry.id, { name: entry.name, description: entry.description })
      }
    },
  )
}

/** Re-attach persisted `a2a-*` conversations to the grouping workspace. */
async function reattachPersisted(ctx: Context, executor: DshAgentExecutor): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const persistence = ctx.get('sessionPersistence') as
      | { list(): Promise<readonly { id: unknown }[]> }
      | undefined
    if (persistence === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      continue
    }
    try {
      const headers = await persistence.list()
      for (const header of headers) {
        const id = String(header.id)
        if (id.startsWith('a2a-')) await executor.attachToWorkspace(id)
      }
    } catch (error) {
      ctx.logger.warn(`dsh-a2a: failed to re-attach persisted sessions: ${String(error)}`)
    }
    return
  }
}
