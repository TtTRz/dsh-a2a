import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { attachSettings } from '../src/settings.js'

interface SettingsValue {
  agents: unknown[]
}

interface FakeScope {
  get(): SettingsValue | undefined
  watch(listener: (next: SettingsValue) => void): () => void
}

interface FakeSettings {
  register: (ns: string, schema: unknown, opts: unknown) => FakeScope
  watchers: Array<(next: SettingsValue) => void>
  lastOptions: { base?: Record<string, unknown>; applies?: string } | undefined
  fire: (agents: unknown[]) => void
}

function fakeSettings(initial: unknown[] = []): FakeSettings {
  const watchers: Array<(next: SettingsValue) => void> = []
  let value: SettingsValue | undefined = { agents: initial }
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
    fire: (agents) => {
      value = { agents }
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

describe('attachSettings', () => {
  it('registers the namespace with the row config as composition base and feeds the initial value', () => {
    const settings = fakeSettings([{ name: 'a', url: 'https://a.example.com/' }])
    const { ctx } = fakeCtx(settings)
    const onChange = vi.fn()
    const base = [{ name: 'base', url: 'https://base.example.com/' }]
    attachSettings(ctx, { agents: base }, onChange)
    expect(settings.lastOptions).toMatchObject({ applies: 'live', base: { agents: base } })
    expect(onChange).toHaveBeenCalledWith([
      { name: 'a', url: 'https://a.example.com/', headers: {}, description: '' },
    ])
  })

  it('hot-reloads the registry when the settings document commits', () => {
    const settings = fakeSettings()
    const { ctx } = fakeCtx(settings)
    const onChange = vi.fn()
    attachSettings(ctx, { agents: [] }, onChange)
    onChange.mockClear()
    settings.fire([{ name: 'b', url: 'http://b.example.com/' }])
    expect(onChange).toHaveBeenCalledWith([
      { name: 'b', url: 'http://b.example.com/', headers: {}, description: '' },
    ])
  })

  it('drops invalid rows and warns instead of failing the document', () => {
    const settings = fakeSettings([
      { name: '', url: 'x' },
      { name: 'ok', url: 'https://ok.example.com/' },
    ])
    const { ctx, warnings } = fakeCtx(settings)
    const onChange = vi.fn()
    attachSettings(ctx, { agents: [] }, onChange)
    expect(onChange).toHaveBeenCalledWith([
      { name: 'ok', url: 'https://ok.example.com/', headers: {}, description: '' },
    ])
    expect(warnings.some((warning) => warning.includes('dropped 1'))).toBe(true)
  })
})
