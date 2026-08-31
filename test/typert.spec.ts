import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { type ServerRef, serverInfoOf } from '../src/typert.js'

const IDENTITY = { name: 'n', description: 'd' }

function refOf(
  server: Parameters<typeof resolveConfig>[0]['server'] | undefined,
  agentCard: ServerRef['agentCard'] = IDENTITY,
): ServerRef {
  return {
    server: server === undefined ? undefined : resolveConfig({ server }).server,
    agentCard,
  }
}

describe('serverInfoOf', () => {
  it('projects the resolved config and surfaces the apiKey for operators', () => {
    const info = serverInfoOf(
      refOf({
        host: '127.0.0.1',
        port: 9001,
        apiKey: 'super-secret-token',
        provider: 'venus',
        model: 'model-a',
        preset: 'mp',
        agentCard: { name: 'n', description: 'd', version: '1' },
      }),
    )
    expect(info).toMatchObject({
      enabled: true,
      host: '127.0.0.1',
      port: 9001,
      apiKeySet: true,
      apiKey: 'super-secret-token',
      provider: 'venus',
      model: 'model-a',
      preset: 'mp',
      workspaceTitle: 'A2A',
      agentCard: { name: 'n', description: 'd', version: '1' },
    })
  })

  it('reflects the settings-merged agent card identity', () => {
    const info = serverInfoOf(
      refOf(
        { agentCard: { name: 'cordis', description: 'c', version: '2' } },
        { name: 'settings', description: 's' },
      ),
    )
    expect(info.agentCard).toEqual({ name: 'settings', description: 's', version: '2' })
  })

  it('reports a disabled server without exposing a port or key', () => {
    const info = serverInfoOf(refOf(undefined))
    expect(info).toMatchObject({ enabled: false, apiKeySet: false, preset: 'standard' })
    // No string field may carry a credential; only the apiKeySet boolean exists.
    expect(JSON.stringify(info)).not.toMatch(/"apiKey":\s*"[^"]+"/)
  })

  it('carries the publicUrl and the agent card identity', () => {
    const info = serverInfoOf(
      refOf(
        { publicUrl: 'https://gw.example.com/', agentCard: { name: 'cordis', version: '2' } },
        { name: 'x', description: 'y' },
      ),
    )
    expect(info.publicUrl).toBe('https://gw.example.com/')
    expect(info.agentCard.name).toBe('x')
    expect(info.agentCard.version).toBe('2')
  })
})
