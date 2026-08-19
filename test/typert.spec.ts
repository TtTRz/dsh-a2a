import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { serverInfoOf } from '../src/typert.js'

describe('serverInfoOf', () => {
  it('projects the resolved config and reduces apiKey to a boolean', () => {
    const server = resolveConfig({
      server: {
        host: '127.0.0.1',
        port: 9001,
        apiKey: 'super-secret-token',
        provider: 'venus',
        model: 'deepseek-v4-flash-official',
        preset: 'mp',
        agentCard: { name: 'n', description: 'd', version: '1' },
      },
    }).server
    const info = serverInfoOf(server)
    expect(info).toMatchObject({
      enabled: true,
      host: '127.0.0.1',
      port: 9001,
      apiKeySet: true,
      provider: 'venus',
      model: 'deepseek-v4-flash-official',
      preset: 'mp',
      workspaceTitle: 'A2A',
    })
    // The key itself must never be part of the wire-safe summary.
    expect(JSON.stringify(info)).not.toContain('super-secret-token')
  })

  it('reports a disabled server without exposing a port or key', () => {
    const info = serverInfoOf(undefined)
    expect(info).toMatchObject({ enabled: false, apiKeySet: false, preset: 'standard' })
    // No string field may carry a credential; only the apiKeySet boolean exists.
    expect(JSON.stringify(info)).not.toMatch(/"apiKey":\s*"[^"]+"/)
  })

  it('carries the publicUrl and the agent card identity', () => {
    const server = resolveConfig({
      server: { publicUrl: 'https://gw.example.com/', agentCard: { name: 'x', version: '2' } },
    }).server
    const info = serverInfoOf(server)
    expect(info.publicUrl).toBe('https://gw.example.com/')
    expect(info.agentCard.name).toBe('x')
    expect(info.agentCard.version).toBe('2')
  })
})
