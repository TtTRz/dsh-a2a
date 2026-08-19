/**
 * Host-side Remote surface for the A2A settings tab: one method that fetches
 * a remote agent card (the per-row test button) and one that reports the
 * local server's resolved configuration as a read-only summary (the tab's
 * inbound panel). Secrets never cross the wire: `apiKey` is reduced to a
 * boolean.
 *
 * @module dsh-a2a/typert
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ResolvedServer } from './config.js'

/** The agent-card fields a probe returns. */
export interface AgentCardProbe {
  name?: string
  description?: string
}

/** Read-only summary of the local A2A server, as the settings tab shows it. */
export interface ServerInfo {
  enabled: boolean
  host: string
  port: number
  publicUrl?: string
  /** Whether a Bearer key is configured; the key itself never leaves the Host. */
  apiKeySet: boolean
  provider?: string
  model?: string
  preset: string
  workspaceTitle: string
  agentCard: { name: string; description: string; version: string }
}

/** Project the resolved server config into its wire-safe summary. */
export function serverInfoOf(server: ResolvedServer | undefined): ServerInfo {
  if (server === undefined) {
    return {
      enabled: false,
      host: '127.0.0.1',
      port: 0,
      apiKeySet: false,
      preset: 'standard',
      workspaceTitle: 'A2A',
      agentCard: { name: 'dsh-a2a', description: '', version: '' },
    }
  }
  return {
    enabled: server.enabled,
    host: server.host,
    port: server.port,
    publicUrl: server.publicUrl,
    apiKeySet: typeof server.apiKey === 'string' && server.apiKey.length > 0,
    provider: server.provider,
    model: server.model,
    preset: server.preset,
    workspaceTitle: server.workspaceTitle,
    agentCard: {
      name: server.agentCard.name,
      description: server.agentCard.description,
      version: server.agentCard.version,
    },
  }
}

/**
 * Host Remote service (`ctx.a2a`) backing the settings tab. The client mounts
 * the matching Remote descriptors and calls `a2a.testAgentCard(...)` /
 * `a2a.serverInfo()`; the gateway routes them here so the fetch and the
 * resolved-config projection run on the Host.
 */
export class A2aTestService extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly server: ResolvedServer | undefined,
  ) {
    super(ctx, 'a2a')
  }

  @Remote('testAgentCard')
  async testAgentCard(url: string, headers: Record<string, string>): Promise<AgentCardProbe> {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      throw new Error('invalid URL')
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error('only http(s) URLs are supported')
    }
    const response = await fetch(target, {
      headers: { ...headers, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    const card = (await response.json()) as { name?: string; description?: string }
    return { name: card.name, description: card.description }
  }

  @Remote('serverInfo')
  async serverInfo(): Promise<ServerInfo> {
    return serverInfoOf(this.server)
  }
}
