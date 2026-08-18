/**
 * The GUI-editable settings half: one `a2a` namespace over the dsh settings
 * service, resolved as schema defaults → composition base (the cordis row's
 * `agents`) → the user document (what the Plugins settings card writes).
 *
 * Every commit hot-reloads the running `a2a_call` / `a2a_list` tools — a card
 * save is live without a restart, which is the one v0.1 limitation this
 * removes. The settings service is optional: profiles without a provider keep
 * resolving entry config alone, exactly as before.
 *
 * @module dsh-a2a/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { type AgentEntry, normalizeAgents, type ResolvedAgentEntry } from './config.js'

/** The settings namespace the Plugins section's A2A card claims. */
export const SETTINGS_NAMESPACE = 'a2a'

/** The registry rows the settings schema resolves; see {@link A2aSettings}. */
export interface A2aSettingsValue {
  agents: AgentEntry[]
}

/** One registry row as stored in the settings document. */
export const AgentEntrySettings = z.object({
  name: z.string(),
  url: z.string(),
  description: z.string().default(''),
  headers: z.dict(z.string()).default({}),
})

/** The `a2a` namespace schema: only the registry is user-editable for now. */
export const A2aSettings = z.object({
  agents: z.array(AgentEntrySettings).default([]),
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
 * every resolved registry — the initial value included — to `onChange`.
 * Invalid rows are dropped with a warning instead of failing the document.
 */
export function attachSettings(
  ctx: Context,
  base: { agents: AgentEntry[] },
  onChange: (agents: ResolvedAgentEntry[]) => void,
): void {
  ctx.inject(['settings'], (scoped) => {
    const settings = (scoped as unknown as { settings: SettingsService }).settings
    const scope = settings.register(SETTINGS_NAMESPACE, A2aSettings, {
      base: { agents: base.agents },
      applies: 'live',
    })
    const apply = (value: A2aSettingsValue | undefined): void => {
      if (value === undefined) return
      const { agents, rejected } = normalizeAgents(value.agents)
      if (rejected > 0) {
        ctx.logger.warn(`dsh-a2a: dropped ${String(rejected)} invalid agent row(s) from settings`)
      }
      onChange(agents)
    }
    ctx.effect(() => scope.watch(apply), 'dsh-a2a.settings.watch')
    apply(scope.get())
  })
}
