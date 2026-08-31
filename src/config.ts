/**
 * Configuration surface: the schemastery schema cordis validates, and a
 * resolve step that normalizes it into a checked runtime shape. Fail-loud
 * checks live here so misconfiguration surfaces at plugin load.
 *
 * @module dsh-a2a/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
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
  /**
   * Local agents served at `/agents/<id>`, each with its own preset + Agent
   * Card. When empty, a single default agent is derived from `preset` /
   * `agentCard` below (legacy single-agent form).
   */
  agents?: AgentSpec[]
  /** Preset mounted into each A2A conversation agent (legacy single-agent form). */
  preset?: string
  /** Per-turn deadline; a slow turn is cancelled so the next message is not stuck. */
  turnTimeoutMs?: number
  /** Per-call deadline for the client `a2a_call` tool reaching a remote agent. */
  callTimeoutMs?: number
  /** Agent Card identity (legacy single-agent form). */
  agentCard?: AgentCardOptions
  /** Public base URL advertised on the Agent Card (e.g. behind a reverse proxy). */
  publicUrl?: string
  /** When set, every request must present `Authorization: Bearer <apiKey>`. */
  apiKey?: string
  /** Model route for A2A conversation agents (falls back to the harness default model). */
  provider?: string
  /** Model name paired with `provider` (falls back to the harness default model). */
  model?: string
  /** Working directory for A2A conversation agents; doubles as the sidebar workspace path. */
  cwd?: string
  /** Sidebar workspace title grouping A2A conversations (defaults to "A2A"). */
  workspaceTitle?: string
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

/**
 * One LOCAL agent this A2A server serves at `/agents/<id>`. Each has its own
 * preset (tools + persona), its own Agent Card identity, and its own session
 * namespace, so one server can expose several presets — the A2A equivalent of
 * running several WeCom bots.
 */
export interface AgentSpec {
  /** URL path slug under `/agents/` (e.g. `mp-perf`); must be URL-safe. */
  id: string
  /** Agent Card name. */
  name: string
  description?: string
  version?: string
  /** Preset mounted into this agent's conversations. */
  preset: string
  provider?: string
  model?: string
  /** Working directory for this agent's conversations. */
  cwd?: string
  /** Sidebar workspace title grouping this agent's conversations. */
  workspaceTitle?: string
  /** The abilities advertised on the Agent Card (A2A `skills`). */
  skills?: AgentSkillSpec[]
}

/** One advertised ability on an Agent Card (the config stores only these). */
export interface AgentSkillSpec {
  /** Stable skill id, e.g. `query-gray-release`. */
  id: string
  /** Human-readable name, e.g. `查询灰度版本`. */
  name: string
  /** Detailed description of the ability. */
  description: string
}

export interface Config {
  server?: ServerOptions
  agents?: AgentEntry[]
}

export const DEFAULT_PORT = 8899
export const DEFAULT_TURN_TIMEOUT_MS = 300_000
export const DEFAULT_CALL_TIMEOUT_MS = 300_000

export const Config: z<Config> = z.object({
  server: z.object({
    enabled: z.boolean().default(true),
    host: z.string().default('127.0.0.1'),
    port: z.number().default(DEFAULT_PORT),
    agents: z
      .array(
        z.object({
          id: z.string().required(),
          name: z.string().required(),
          description: z.string(),
          version: z.string(),
          preset: z.string().required(),
          provider: z.string(),
          model: z.string(),
          cwd: z.string(),
          workspaceTitle: z.string(),
          skills: z
            .array(
              z.object({
                id: z.string(),
                name: z.string(),
                description: z.string(),
              }),
            )
            .default([]),
        }),
      )
      .default([]),
    preset: z.string().default('standard'),
    turnTimeoutMs: z.number().default(DEFAULT_TURN_TIMEOUT_MS),
    callTimeoutMs: z.number().default(DEFAULT_CALL_TIMEOUT_MS),
    agentCard: z.object({
      name: z.string().default('dsh-a2a'),
      description: z.string().default('A DeepSeek Harness agent exposed over the A2A protocol.'),
      version: z.string().default('0.1.0'),
    }),
    publicUrl: z.string(),
    apiKey: z.string(),
    provider: z.string(),
    model: z.string(),
    cwd: z.string(),
    workspaceTitle: z.string().default('A2A'),
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

export interface ResolvedAgentSpec {
  id: string
  name: string
  description: string
  version: string
  preset: string
  provider?: string
  model?: string
  cwd: string
  workspaceTitle: string
  /** Abilities advertised on the Agent Card (A2A `skills`). */
  skills?: AgentSkillSpec[]
}

export interface ResolvedServer {
  enabled: boolean
  host: string
  port: number
  /** Local agents served at `/agents/<id>`; one preset + Agent Card each. */
  agents: ResolvedAgentSpec[]
  turnTimeoutMs: number
  callTimeoutMs: number
  publicUrl?: string
  apiKey?: string
  /** Legacy single-agent identity, retained for backward compatibility. */
  agentCard: Required<AgentCardOptions>
  /** Legacy single-agent preset, retained for backward compatibility. */
  preset: string
  provider?: string
  model?: string
  cwd: string
  workspaceTitle: string
}

export interface ResolvedAgentEntry {
  name: string
  url: string
  headers: Record<string, string>
  description: string
}

/** Defaults filled into settings-fed served agents for blank fields. */
export interface ServerAgentDefaults {
  cwd: string
  workspaceTitle: string
  /** Fallback preset for a brand-new served agent (the server-level preset). */
  preset: string
  provider?: string
  model?: string
}

/** Normalize one settings-fed served agent against a base map (by id) + defaults. */
export function normalizeServerAgent(
  raw: unknown,
  base: ReadonlyMap<string, ResolvedAgentSpec>,
  defaults: ServerAgentDefaults,
  label: string,
): ResolvedAgentSpec {
  const row = (raw ?? {}) as Partial<AgentSpec>
  const id = (row.id ?? '').trim()
  if (id.length === 0 || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    throw new Error(
      `dsh-a2a: ${label}.id must be a URL-safe slug (e.g. mp-perf), got ${JSON.stringify(row.id)}`,
    )
  }
  const known = base.get(id)
  const name = (row.name ?? '').trim() || known?.name || ''
  if (name.length === 0) throw new Error(`dsh-a2a: ${label}.name must not be empty`)
  const preset = (row.preset ?? '').trim() || known?.preset || defaults.preset
  if (preset.length === 0) throw new Error(`dsh-a2a: ${label}.preset must not be empty`)
  const provider = (row.provider ?? '').trim() || known?.provider || defaults.provider
  const model = (row.model ?? '').trim() || known?.model || defaults.model
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error(`dsh-a2a: ${label}.provider and ${label}.model must be set together`)
  }
  const cwd = (row.cwd ?? '').trim() || known?.cwd || defaults.cwd
  if (!isAbsolute(cwd)) {
    throw new Error(
      `dsh-a2a: ${label}.cwd must be an absolute path, got ${JSON.stringify(row.cwd)}`,
    )
  }
  return {
    id,
    name,
    description:
      (row.description ?? '').trim() ||
      known?.description ||
      'A DeepSeek Harness agent exposed over the A2A protocol.',
    version: (row.version ?? '').trim() || known?.version || '0.1.0',
    preset,
    provider,
    model,
    cwd,
    workspaceTitle:
      (row.workspaceTitle ?? '').trim() || known?.workspaceTitle || defaults.workspaceTitle,
    skills:
      Array.isArray(row.skills) && row.skills.length > 0
        ? row.skills.map((skill) => ({ id: skill.id, name: skill.name, description: skill.description }))
        : known?.skills ?? [],
  }
}

/**
 * Lenient normalization for settings-fed served agents: rows the strict
 * load-time checks would reject (blank name/preset, bad id, non-absolute cwd)
 * are dropped instead of failing the whole document, so one bad hand edit
 * never breaks the settings tab. Blank fields inherit the matching base agent
 * (by id) then the server defaults, so a row that only edits identity keeps
 * the deployment's preset / cwd.
 */
export function normalizeServerAgents(
  entries: readonly unknown[],
  baseAgents: readonly ResolvedAgentSpec[],
  defaults: ServerAgentDefaults,
): { agents: ResolvedAgentSpec[]; rejected: number } {
  const base = new Map(baseAgents.map((agent) => [agent.id, agent]))
  const agents: ResolvedAgentSpec[] = []
  let rejected = 0
  entries.forEach((raw, index) => {
    try {
      agents.push(normalizeServerAgent(raw, base, defaults, `serverAgents[${index}]`))
    } catch {
      rejected += 1
    }
  })
  return { agents, rejected }
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

/** Build the local agent list. `server.agents` is the new multi-agent form
 * (one preset + Agent Card per agent); when empty, derive a single agent from
 * the legacy `server.preset`/`server.agentCard` so existing configs still load. */
function resolveServerAgents(
  server: ServerOptions,
  defaults: { cwd: string; workspaceTitle: string; provider?: string; model?: string },
): ResolvedAgentSpec[] {
  const specs = (server.agents ?? []).map((agent, index) => {
    const label = `server.agents[${index}]`
    const id = (agent.id ?? '').trim()
    if (id.length === 0 || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
      throw new Error(
        `dsh-a2a: ${label}.id must be a URL-safe slug (e.g. mp-perf), got ${JSON.stringify(agent.id)}`,
      )
    }
    const name = (agent.name ?? '').trim()
    if (name.length === 0) throw new Error(`dsh-a2a: ${label}.name must not be empty`)
    const preset = (agent.preset ?? '').trim()
    if (preset.length === 0) throw new Error(`dsh-a2a: ${label}.preset must not be empty`)
    const provider = agent.provider?.trim() || undefined
    const model = agent.model?.trim() || undefined
    if ((provider === undefined) !== (model === undefined)) {
      throw new Error(`dsh-a2a: ${label}.provider and ${label}.model must be set together`)
    }
    const cwd = agent.cwd?.trim() || defaults.cwd
    if (!isAbsolute(cwd)) {
      throw new Error(
        `dsh-a2a: ${label}.cwd must be an absolute path, got ${JSON.stringify(agent.cwd)}`,
      )
    }
    const card = server.agentCard ?? {}
    const skills = (agent.skills ?? []).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
    }))
    return {
      id,
      name,
      description:
        agent.description?.trim() ||
        card.description ||
        'A DeepSeek Harness agent exposed over the A2A protocol.',
      version: agent.version?.trim() || card.version || '0.1.0',
      preset,
      provider: provider ?? defaults.provider,
      model: model ?? defaults.model,
      cwd,
      workspaceTitle: agent.workspaceTitle?.trim() || defaults.workspaceTitle,
      skills,
    }
  })
  if (specs.length === 0) {
    const card = server.agentCard ?? {}
    return [
      {
        id: (server.preset ?? 'agent').trim() || 'agent',
        name: card.name ?? 'dsh-a2a',
        description: card.description ?? 'A DeepSeek Harness agent exposed over the A2A protocol.',
        version: card.version ?? '0.1.0',
        preset: server.preset ?? 'standard',
        provider: defaults.provider,
        model: defaults.model,
        cwd: defaults.cwd,
        workspaceTitle: defaults.workspaceTitle,
      },
    ]
  }
  return specs
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
  const callTimeoutMs = server.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  if (!Number.isFinite(callTimeoutMs) || callTimeoutMs <= 0) {
    throw new Error(
      `dsh-a2a: server.callTimeoutMs must be a positive number, got ${String(callTimeoutMs)}`,
    )
  }
  const host = server.host ?? '127.0.0.1'
  if (host.length === 0) throw new Error('dsh-a2a: server.host must not be empty')
  const publicUrl = server.publicUrl?.trim()
  if (publicUrl !== undefined && publicUrl.length > 0) {
    try {
      const parsed = new URL(publicUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`dsh-a2a: server.publicUrl must be http(s), got ${parsed.protocol}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('dsh-a2a:')) throw error
      throw new Error(
        `dsh-a2a: server.publicUrl is not a valid URL: ${JSON.stringify(server.publicUrl)}`,
      )
    }
  }
  const provider = server.provider?.trim() || undefined
  const model = server.model?.trim() || undefined
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error('dsh-a2a: server.provider and server.model must be set together')
  }
  const cwd = server.cwd?.trim() || process.env.DSH_A2A_CWD || join(homedir(), '.a2a-sessions')
  if (!isAbsolute(cwd)) {
    throw new Error(
      `dsh-a2a: server.cwd must be an absolute path, got ${JSON.stringify(server.cwd)}`,
    )
  }
  const workspaceTitle = server.workspaceTitle?.trim() || 'A2A'
  const agents = resolveServerAgents(server, { cwd, workspaceTitle, provider, model })
  return {
    server: {
      enabled: server.enabled !== false,
      host,
      port,
      agents,
      turnTimeoutMs,
      callTimeoutMs,
      publicUrl: publicUrl === '' ? undefined : publicUrl,
      apiKey: server.apiKey,
      provider,
      model,
      cwd,
      workspaceTitle,
      agentCard: {
        name: server.agentCard?.name ?? 'dsh-a2a',
        description:
          server.agentCard?.description ??
          'A DeepSeek Harness agent exposed over the A2A protocol.',
        version: server.agentCard?.version ?? '0.1.0',
      },
      preset: server.preset ?? 'standard',
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
