/**
 * The GUI-editable settings half: one `a2a` namespace over the dsh settings
 * service, resolved as schema defaults → composition base (the cordis row's
 * `agents` and `serverAgents`) → the user document (what the A2A settings tab
 * writes).
 *
 * Every commit hot-reloads the running `a2a_call` / `a2a_list` tools AND the
 * served Agent Card set (add / remove / re-identity a served agent) — a save
 * is live without a restart. The settings service is optional: profiles
 * without a provider keep resolving entry config alone.
 *
 * @module dsh-a2a/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  type AgentEntry,
  normalizeAgents,
  normalizeServerAgents,
  type ResolvedAgentEntry,
  type ResolvedAgentSpec,
  type ServerAgentDefaults,
} from './config.js'

/** The settings namespace the A2A settings tab claims. */
export const SETTINGS_NAMESPACE = 'a2a'

/**
 * One served-agent row as stored in the settings document. Blank fields are
 * normalized in `apply` against the matching base agent (by id) then the
 * server defaults, so a row that only edits identity keeps the deployment's
 * preset / cwd.
 */
export interface ServerAgentSpec {
  id: string
  name: string
  description: string
  version: string
  preset: string
  cwd: string
  workspaceTitle: string
  provider?: string
  model?: string
}

/** The section the settings schema resolves; see {@link A2aSettings}. */
export interface A2aSettingsValue {
  agents: AgentEntry[]
  serverAgents: ServerAgentSpec[]
}

/** What the plugin actually applies from a resolved section. */
export interface A2aSettingsApplied {
  agents: ResolvedAgentEntry[]
  /** The full served-agent set (identity + preset + cwd) to reconcile. */
  serverAgents: ResolvedAgentSpec[]
}

/** One registry row as stored in the settings document. */
export const AgentEntrySettings = z.object({
  name: z.string(),
  url: z.string(),
  description: z.string().default(''),
  headers: z.dict(z.string()).default({}),
})

/** One served-agent row as stored in the settings document (blank = inherit). */
export const AgentSpecSettings = z.object({
  id: z.string(),
  name: z.string().default(''),
  description: z.string().default(''),
  version: z.string().default(''),
  preset: z.string().default(''),
  cwd: z.string().default(''),
  workspaceTitle: z.string().default(''),
  provider: z.string(),
  model: z.string(),
})

/**
 * The `a2a` namespace schema: the outbound registry plus the served-agent set.
 * Blank fields fall back to the composition base (the cordis row) and the
 * server defaults, never to the hard-coded defaults.
 */
export const A2aSettings = z.object({
  agents: z.array(AgentEntrySettings).default([]),
  serverAgents: z.array(AgentSpecSettings).default([]),
})

/**
 * The slice of `ctx.settings` this plugin consumes, spelled structurally so
 * the package gains no hard dependency beyond its peers.
 */
interface SettingsService {
  register(
    ns: string,
    schema: unknown,
    options: { base?: Record<string, unknown>; applies?: 'live' | 'restart' },
  ): {
    get(): A2aSettingsValue | undefined
    watch(listener: (next: A2aSettingsValue) => void): () => void
  }
}

/**
 * Register the `a2a` namespace when a settings service is present and feed
 * every resolved section — the initial value included — to `onChange`.
 * Invalid rows are dropped with a warning; a blank served-agent field means
 * "inherit the composition base" (by id) then the server defaults.
 */
export function attachSettings(
  ctx: Context,
  base: { agents: AgentEntry[]; serverAgents: ResolvedAgentSpec[] },
  defaults: ServerAgentDefaults,
  onChange: (value: A2aSettingsApplied) => void,
): void {
  ctx.inject(['settings'], (scoped) => {
    const settings = (scoped as unknown as { settings: SettingsService }).settings
    const scope = settings.register(SETTINGS_NAMESPACE, A2aSettings, {
      base: {
        agents: base.agents,
        serverAgents: base.serverAgents,
      },
      applies: 'live',
    })
    const apply = (value: A2aSettingsValue | undefined): void => {
      if (value === undefined) return
      const { agents, rejected } = normalizeAgents(value.agents)
      if (rejected > 0) {
        ctx.logger.warn(`dsh-a2a: dropped ${String(rejected)} invalid agent row(s) from settings`)
      }
      const normalized =
        value.serverAgents.length > 0
          ? normalizeServerAgents(value.serverAgents, base.serverAgents, defaults)
          : { agents: base.serverAgents, rejected: 0 }
      // If every settings row was invalid (or none were given), the served set
      // falls back to the composition base so one bad hand edit never empties
      // the endpoint.
      const serverAgents =
        normalized.agents.length > 0 ? normalized : { agents: base.serverAgents, rejected: 0 }
      if (serverAgents.rejected > 0) {
        ctx.logger.warn(
          `dsh-a2a: dropped ${String(serverAgents.rejected)} invalid served-agent row(s) from settings`,
        )
      }
      onChange({ agents, serverAgents: serverAgents.agents })
    }
    ctx.effect(() => scope.watch(apply), 'dsh-a2a.settings.watch')
    apply(scope.get())
  })
}
