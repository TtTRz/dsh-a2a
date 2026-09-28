import { describe, expect, it } from 'vitest'
import { Config, readLive, resolveConfig } from '../src/config.js'

describe('resolveConfig', () => {
  it('applies defaults for an empty config', () => {
    const resolved = resolveConfig({})
    expect(resolved.server).toMatchObject({
      enabled: true,
      host: '127.0.0.1',
      port: 8899,
      preset: 'standard',
      turnTimeoutMs: 300_000,
      callTimeoutMs: 300_000,
      agentCard: { name: 'dsh-a2a' },
    })
    expect(resolved.agents).toEqual([])
  })

  it('rejects out-of-range ports and non-positive timeouts', () => {
    expect(() => resolveConfig({ server: { port: 0 } })).toThrow(/server.port/)
    expect(() => resolveConfig({ server: { port: 70_000 } })).toThrow(/server.port/)
    expect(() => resolveConfig({ server: { turnTimeoutMs: 0 } })).toThrow(/turnTimeoutMs/)
    expect(() => resolveConfig({ server: { callTimeoutMs: 0 } })).toThrow(/callTimeoutMs/)
  })

  it('rejects malformed registry entries', () => {
    expect(() => resolveConfig({ agents: [{ name: '  ', url: 'https://x' }] })).toThrow(/name/)
    expect(() => resolveConfig({ agents: [{ name: 'a', url: 'not-a-url' }] })).toThrow(/url/)
    expect(() => resolveConfig({ agents: [{ name: 'a', url: 'ftp://x' }] })).toThrow(/http/)
  })

  it('normalizes registry entries and keeps headers', () => {
    const resolved = resolveConfig({
      agents: [{ name: ' x ', url: 'https://x.example.com/', headers: { a: 'b' } }],
    })
    expect(resolved.agents).toEqual([
      { name: 'x', url: 'https://x.example.com/', headers: { a: 'b' }, description: '' },
    ])
  })

  it('exposes the cordis schema with defaults', () => {
    expect(Config).toBeDefined()
  })

  it('reads rc.2 volatile fields produced by the actual schema', () => {
    const config = Config({ agents: [{ name: 'local', url: 'http://127.0.0.1:9000' }] })
    expect(config.agents).toHaveProperty('get')
    expect(readLive(config.agents, [])[0]?.name).toBe('local')
    expect(resolveConfig(config).agents[0]?.name).toBe('local')
    expect(resolveConfig(Config({})).agents).toEqual([])
  })
})
