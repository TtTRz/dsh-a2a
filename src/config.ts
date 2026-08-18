/**
 * Configuration surface: the schemastery schema cordis validates, and a
 * resolve step that normalizes it into a checked runtime shape. Fail-loud
 * checks live here so misconfiguration surfaces at plugin load.
 *
 * @module dsh-a2a/config
 */

import z from '@deepseek-ai/schemastery'

export interface AgentCardOptions {
  /** Human-readable agent name shown to callers on the Agent Card. */
  name?: string
  description?: string
  version?: string
}

export interface ServerOptions {
  /** Serve the A2A endpoint at all; client tools still work when off. */
  enabled?: boolean
  /** Listen host. */
  host?: string
  /** Listen port. */
  port?: number
  /** Preset mounted into each A2A conversation agent. */
  preset?: string
  /** Per-turn deadline; a slow turn is cancelled so the next message is not stuck. */
  turnTimeoutMs?: number
  agentCard?: AgentCardOptions
}

export interface AgentEntry {
  /** Registry name used by `a2a_call`. */
  name: string
  /** Agent Card URL (or base URL of the remote agent). */
  url: string
  /** Extra request headers; values may use `${ENV_VAR}` placeholders. */
  headers?: Record<string, string>
  /** Short description surfaced by `a2a_list`. */
  description?: string
}

export interface Config {
  server?: ServerOptions
  agents?: AgentEntry[]
}

export const DEFAULT_PORT = 8899
export const DEFAULT_TURN_TIMEOUT_MS = 300_000

export const Config: z<Config> = z.object({
  server: z.object({
    enabled: z.boolean().default(true),
    host: z.string().default('127.0.0.1'),
    port: z.number().default(DEFAULT_PORT),
    preset: z.string().default('standard'),
    turnTimeoutMs: z.number().default(DEFAULT_TURN_TIMEOUT_MS),
    agentCard: z.object({
      name: z.string().default('dsh-a2a'),
      description: z.string().default('A DeepSeek Harness agent exposed over the A2A protocol.'),
      version: z.string().default('0.1.0'),
    }),
  }),
  agents: z
    .array(
      z.object({
        name: z.string(),
        url: z.string(),
        headers: z.any(),
        description: z.string(),
      }),
    )
    .default([]),
})

export interface ResolvedServer {
  enabled: boolean
  host: string
  port: number
  preset: string
  turnTimeoutMs: number
  agentCard: Required<AgentCardOptions>
}

export interface ResolvedAgentEntry {
  name: string
  url: string
  headers: Record<string, string>
  description: string
}

export interface ResolvedConfig {
  server: ResolvedServer
  agents: ResolvedAgentEntry[]
}

/**
 * Lenient runtime normalization for settings-fed registries: rows the strict
 * load-time checks would reject are dropped instead of failing the whole
 * document, so one bad hand edit can never take the tools down.
 */
export function normalizeAgents(entries: readonly unknown[]): {
  agents: ResolvedAgentEntry[]
  rejected: number
} {
  const agents: ResolvedAgentEntry[] = []
  let rejected = 0
  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null) {
      rejected += 1
      continue
    }
    const entry = raw as AgentEntry
    const name = (entry.name ?? '').trim()
    let ok = name.length > 0 && typeof entry.url === 'string' && entry.url.length > 0
    if (ok) {
      try {
        const parsed = new URL(entry.url)
        ok = parsed.protocol === 'http:' || parsed.protocol === 'https:'
      } catch {
        ok = false
      }
    }
    if (!ok) {
      rejected += 1
      continue
    }
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(entry.headers ?? {})) {
      if (typeof value === 'string') headers[key] = value
    }
    agents.push({ name, url: entry.url, headers, description: entry.description ?? '' })
  }
  return { agents, rejected }
}

/** Validate and normalize the raw config; throws with field-naming messages. */
export function resolveConfig(input: Config): ResolvedConfig {
  const server = input.server ?? {}
  const port = server.port ?? DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`dsh-a2a: server.port must be an integer in 1..65535, got ${String(port)}`)
  }
  const turnTimeoutMs = server.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
  if (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0) {
    throw new Error(
      `dsh-a2a: server.turnTimeoutMs must be a positive number, got ${String(turnTimeoutMs)}`,
    )
  }
  const host = server.host ?? '127.0.0.1'
  if (host.length === 0) throw new Error('dsh-a2a: server.host must not be empty')
  return {
    server: {
      enabled: server.enabled !== false,
      host,
      port,
      preset: server.preset ?? 'standard',
      turnTimeoutMs,
      agentCard: {
        name: server.agentCard?.name ?? 'dsh-a2a',
        description:
          server.agentCard?.description ??
          'A DeepSeek Harness agent exposed over the A2A protocol.',
        version: server.agentCard?.version ?? '0.1.0',
      },
    },
    agents: (input.agents ?? []).map((entry, index) => {
      const label = `agents[${index}]`
      const name = entry.name.trim()
      if (name.length === 0) throw new Error(`dsh-a2a: ${label}.name must not be empty`)
      let parsed: URL
      try {
        parsed = new URL(entry.url)
      } catch {
        throw new Error(`dsh-a2a: ${label}.url is not a valid URL: ${JSON.stringify(entry.url)}`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`dsh-a2a: ${label}.url must be http(s), got ${parsed.protocol}`)
      }
      return {
        name,
        url: entry.url,
        headers: entry.headers ?? {},
        description: entry.description ?? '',
      }
    }),
  }
}
