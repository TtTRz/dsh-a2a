/**
 * Host-side projection of the local A2A server's resolved configuration,
 * shared by the HTTP routes (src/routes.ts) and the settings tab's inbound
 * panel. The apiKey is surfaced to the tab (so an operator can hand it to a
 * client) but is NEVER logged anywhere; the client masks it by default.
 *
 * This module is deliberately runtime-free (no webServer, no typert gateway).
 * The settings tab is backed by plain `webServer.register(...)` routes, not a
 * Typert Remote service — the typert gateway's SRC claims only recognize
 * Services registered before its snapshot (or via a manifest), so a live
 * Service mounted at plugin `apply()` silently drops its `/api/*` routes and
 * the panel 404s (the same failure class documented in dsh-engram and
 * dsh-tencent-memory).
 *
 * @module dsh-a2a/typert
 */

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
  /** Whether a Bearer key is configured. */
  apiKeySet: boolean
  /**
   * The configured Bearer key, surfaced so an operator can hand it to an A2A
   * client. Only set when configured; the client masks it by default.
   */
  apiKey?: string
  provider?: string
  model?: string
  preset: string
  workspaceTitle: string
  /** Whether callers may override the preset and the model route per request. */
  allowOverrides: boolean
  agentCard: { name: string; description: string; version: string }
}

/** Mutable view the Host keeps current as settings land. */
export interface ServerRef {
  server: ResolvedServer | undefined
  /** Full identity, already merged with any settings override. */
  agentCard: { name: string; description: string }
}

/** Project the live server state into its summary. */
export function serverInfoOf(ref: ServerRef): ServerInfo {
  const server = ref.server
  if (server === undefined) {
    return {
      enabled: false,
      host: '127.0.0.1',
      port: 0,
      apiKeySet: false,
      preset: 'standard',
      workspaceTitle: 'A2A',
      allowOverrides: true,
      agentCard: { name: ref.agentCard.name, description: ref.agentCard.description, version: '' },
    }
  }
  const apiKey =
    typeof server.apiKey === 'string' && server.apiKey.length > 0 ? server.apiKey : undefined
  return {
    enabled: server.enabled,
    host: server.host,
    port: server.port,
    publicUrl: server.publicUrl,
    apiKeySet: apiKey !== undefined,
    apiKey: apiKey,
    provider: server.provider,
    model: server.model,
    preset: server.preset,
    workspaceTitle: server.workspaceTitle,
    allowOverrides: server.allowOverrides,
    agentCard: {
      name: ref.agentCard.name,
      description: ref.agentCard.description,
      version: server.agentCard.version,
    },
  }
}
