/**
 * The GUI-editable settings half: one `a2a` namespace over the dsh settings
 * service, resolved as schema defaults → composition base (the cordis row's
 * `agents` and `agentCard`) → the user document (what the A2A settings tab
 * writes).
 *
 * Every commit hot-reloads the running `a2a_call` / `a2a_list` tools and the
 * served Agent Card — a save is live without a restart. The settings service
 * is optional: profiles without a provider keep resolving entry config alone.
 *
 * @module dsh-a2a/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { type AgentEntry, normalizeAgents, type ResolvedAgentEntry } from './config.js'

/** The settings namespace the A2A settings tab claims. */
export const SETTINGS_NAMESPACE = 'a2a'

/** The section the settings schema resolves; see {@link A2aSettings}. */
export interface A2aSettingsValue {
  agents: AgentEntry[]
  agentCard: { name: string; description: string }
}

/** What the plugin actually applies from a resolved section. */
export interface A2aSettingsApplied {
  agents: ResolvedAgentEntry[]
  /** Full Agent Card identity: blank fields fall back to the composition base. */
  agentCard: { name: string; description: string }
}

/** One registry row as stored in the settings document. */
export const AgentEntrySettings = z.object({
  name: z.string(),
  url: z.string(),
  description: z.string().default(''),
  headers: z.dict(z.string()).default({}),
})

/**
 * The `a2a` namespace schema: the outbound registry plus the Agent Card
 * identity override. Blank fields fall back to the composition base (the
 * cordis row), never to the hard-coded defaults.
 */
export const A2aSettings = z.object({
  agents: z.array(AgentEntrySettings).default([]),
  agentCard: z
    .object({
      name: z.string().default(''),
      description: z.string().default(''),
    })
    .default({ name: '', description: '' }),
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
 * Invalid rows are dropped with a warning; a blank agent-card field means
 * "inherit the composition base" and is omitted from the applied override.
 */
export function attachSettings(
  ctx: Context,
  base: { agents: AgentEntry[]; agentCard: { name: string; description: string } },
  onChange: (value: A2aSettingsApplied) => void,
): void {
  ctx.inject(['settings'], (scoped) => {
    const settings = (scoped as unknown as { settings: SettingsService }).settings
    const scope = settings.register(SETTINGS_NAMESPACE, A2aSettings, {
      base: {
        agents: base.agents,
        agentCard: { name: base.agentCard.name, description: base.agentCard.description },
      },
      applies: 'live',
    })
    const apply = (value: A2aSettingsValue | undefined): void => {
      if (value === undefined) return
      const { agents, rejected } = normalizeAgents(value.agents)
      if (rejected > 0) {
        ctx.logger.warn(`dsh-a2a: dropped ${String(rejected)} invalid agent row(s) from settings`)
      }
      onChange({
        agents,
        agentCard: {
          name: value.agentCard.name.trim() || base.agentCard.name,
          description: value.agentCard.description.trim() || base.agentCard.description,
        },
      })
    }
    ctx.effect(() => scope.watch(apply), 'dsh-a2a.settings.watch')
    apply(scope.get())
  })
}
