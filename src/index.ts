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
import { A2aTestService } from './typert.js'

export const name = 'dsh-a2a'
export const inject = ['agents', 'tools']

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

/** Mount the A2A endpoint and the model-facing tools, tied to the Cordis lifecycle. */
export function apply(ctx: Context, config: PluginConfig): void {
  // Host-side Remote surface for the settings card's "test agent-card" button.
  new A2aTestService(ctx)
  const resolved = resolveConfig(config)
  if (resolved.server.enabled) {
    const server = new A2aServer({
      config: resolved.server,
      executor: new DshAgentExecutor(ctx, {
        preset: resolved.server.preset,
        turnTimeoutMs: resolved.server.turnTimeoutMs,
      }),
    })
    ctx.effect(() => {
      const running = server.start().catch((error: unknown) => {
        ctx.logger.error(`dsh-a2a: server failed to start: ${String(error)}`)
      })
      return async () => {
        await running
        await server.stop()
      }
    }, 'dsh-a2a.server')
  }
  const registry = new A2aRegistry(resolved.agents)
  const tools = a2aTools(registry)
  ctx.effect(() => ctx.tools.register(tools.list), 'dsh-a2a.a2a_list')
  ctx.effect(() => ctx.tools.register(tools.call), 'dsh-a2a.a2a_call')
  // The GUI registry: settings commits (Plugins → A2A card) hot-reload the
  // tools above; profiles without a settings service keep the static registry.
  attachSettings(ctx, { agents: resolved.agents }, (agents) => registry.update(agents))
}
