import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { attachSettings } from '../src/settings.js'

interface SettingsValue {
  agents: unknown[]
  agentCard?: { name?: string; description?: string }
}

interface FakeScope {
  get(): SettingsValue | undefined
  watch(listener: (next: SettingsValue) => void): () => void
}

interface FakeSettings {
  register: (ns: string, schema: unknown, opts: unknown) => FakeScope
  watchers: Array<(next: SettingsValue) => void>
  lastOptions: { base?: Record<string, unknown>; applies?: string } | undefined
  fire: (value: Partial<SettingsValue>) => void
}

function fakeSettings(initial: Partial<SettingsValue> = {}): FakeSettings {
  const watchers: Array<(next: SettingsValue) => void> = []
  let value: SettingsValue | undefined = {
    agents: initial.agents ?? [],
    agentCard: { name: '', description: '' },
    ...initial,
  }
  let lastOptions: FakeSettings['lastOptions']
  return {
    watchers,
    get lastOptions() {
      return lastOptions
    },
    register: (_ns, _schema, opts) => {
      lastOptions = opts as FakeSettings['lastOptions']
      return {
        get: () => value,
        watch: (listener) => {
          watchers.push(listener)
          return () => {
            const index = watchers.indexOf(listener)
            if (index >= 0) watchers.splice(index, 1)
          }
        },
      }
    },
    fire: (next) => {
      value = { ...(value ?? { agents: [] }), ...next }
      for (const watcher of watchers) watcher(value)
    },
  }
}

function fakeCtx(settings: FakeSettings): { ctx: Context; warnings: string[] } {
  const warnings: string[] = []
  const ctx = {
    inject: (_deps: string[], callback: (scoped: unknown) => void) => {
      callback({ settings: { register: settings.register } })
      return () => undefined
    },
    effect: (fn: () => unknown) => {
      fn()
      return () => undefined
    },
    logger: { warn: (message: string) => warnings.push(message) },
  }
  return { ctx: ctx as unknown as Context, warnings }
}

const IDENTITY = { name: '部署默认身份', description: 'base description' }

describe('attachSettings', () => {
  it('registers the namespace with the row config as composition base and feeds the initial value', () => {
    const settings = fakeSettings({ agents: [{ name: 'a', url: 'https://a.example.com/' }] })
    const { ctx } = fakeCtx(settings)
    const onChange = vi.fn()
    const base = [{ name: 'base', url: 'https://base.example.com/' }]
    attachSettings(ctx, { agents: base, agentCard: IDENTITY }, onChange)
    expect(settings.lastOptions).toMatchObject({
      applies: 'live',
      base: { agents: base, agentCard: IDENTITY },
    })
    expect(onChange).toHaveBeenCalledWith({
      agents: [{ name: 'a', url: 'https://a.example.com/', headers: {}, description: '' }],
      agentCard: IDENTITY,
    })
  })

  it('hot-reloads the registry when the settings document commits', () => {
    const settings = fakeSettings()
    const { ctx } = fakeCtx(settings)
    const onChange = vi.fn()
    attachSettings(ctx, { agents: [], agentCard: IDENTITY }, onChange)
    onChange.mockClear()
    settings.fire({ agents: [{ name: 'b', url: 'http://b.example.com/' }] })
    expect(onChange).toHaveBeenCalledWith({
      agents: [{ name: 'b', url: 'http://b.example.com/', headers: {}, description: '' }],
      agentCard: IDENTITY,
    })
  })

  it('overrides the agent card identity and falls back on blank fields', () => {
    const settings = fakeSettings({
      agentCard: { name: '用户身份', description: '' },
    })
    const { ctx } = fakeCtx(settings)
    const onChange = vi.fn()
    attachSettings(ctx, { agents: [], agentCard: IDENTITY }, onChange)
    expect(onChange).toHaveBeenCalledWith({
      agents: [],
      agentCard: { name: '用户身份', description: IDENTITY.description },
    })
  })

  it('drops invalid rows and warns instead of failing the document', () => {
    const settings = fakeSettings({
      agents: [
        { name: '', url: 'x' },
        { name: 'ok', url: 'https://ok.example.com/' },
      ],
    })
    const { ctx, warnings } = fakeCtx(settings)
    const onChange = vi.fn()
    attachSettings(ctx, { agents: [], agentCard: IDENTITY }, onChange)
    expect(onChange).toHaveBeenCalledWith({
      agents: [{ name: 'ok', url: 'https://ok.example.com/', headers: {}, description: '' }],
      agentCard: IDENTITY,
    })
    expect(warnings.some((warning) => warning.includes('dropped 1'))).toBe(true)
  })
})
