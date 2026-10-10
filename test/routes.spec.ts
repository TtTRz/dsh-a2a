import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { registerA2aRoutes } from '../src/routes.js'
import type { ServerRef } from '../src/typert.js'

interface CapturedRoute {
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

function registerWith(webServer: { register: (route: CapturedRoute) => () => void }): {
  ctx: Context
  routes: CapturedRoute[]
} {
  const routes: CapturedRoute[] = []
  webServer.register = (route) => {
    routes.push(route)
    return () => undefined
  }
  const ctx = {
    inject: (_deps: string[], cb: (scoped: unknown) => void) => {
      cb({
        effect: (fn: () => unknown) => {
          fn()
          return () => undefined
        },
        get: () => webServer,
      })
      return () => undefined
    },
  }
  return { ctx: ctx as unknown as Context, routes }
}

function refOf(): ServerRef {
  const server = resolveConfig({ server: { host: '127.0.0.1', port: 8899 } }).server
  return { server, agentCard: { name: 'n', description: 'd' } }
}

function fakeRes(): ServerResponse & { body: unknown } {
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    end: (body: unknown) => {
      res.body = body
    },
  } as unknown as ServerResponse & { body: unknown }
  res.body = undefined
  return res
}

describe('registerA2aRoutes', () => {
  it('rotates the endpoint key live and notifies the persister', async () => {
    const webServer = { register: (_r: CapturedRoute) => () => undefined }
    const { ctx, routes } = registerWith(webServer)
    const ref = refOf()
    const persistKey = vi.fn()
    registerA2aRoutes(ctx, ref, persistKey)

    const route = routes.find((r) => r.path === '/api/a2a/regenerateKey')
    expect(route).toBeDefined()
    const res = fakeRes()
    await route?.handler({} as IncomingMessage, res as ServerResponse)
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(String(res.body)) as { ok?: boolean; apiKey?: string }
    expect(payload.ok).toBe(true)
    expect(typeof payload.apiKey).toBe('string')
    expect(payload.apiKey?.length).toBeGreaterThan(20)
    // The running server + serverInfo now see the new key, and the persister got it.
    expect(ref.server?.apiKey).toBe(payload.apiKey)
    expect(persistKey).toHaveBeenCalledWith(payload.apiKey)
  })

  it('rejects rotation when the endpoint is disabled', async () => {
    const webServer = { register: (_r: CapturedRoute) => () => undefined }
    const { ctx, routes } = registerWith(webServer)
    const ref: ServerRef = { server: undefined, agentCard: { name: 'n', description: 'd' } }
    registerA2aRoutes(ctx, ref)

    const route = routes.find((r) => r.path === '/api/a2a/regenerateKey')
    const res = fakeRes()
    await route?.handler({} as IncomingMessage, res as ServerResponse)
    expect(res.statusCode).toBe(400)
  })

  it('rejects serverInfo without the key once an apiKey is configured', async () => {
    const webServer = { register: (_r: CapturedRoute) => () => undefined }
    const { ctx, routes } = registerWith(webServer)
    const server = resolveConfig({
      server: { host: '127.0.0.1', port: 8899, apiKey: 'secret-key' },
    }).server
    const ref: ServerRef = { server, agentCard: { name: 'n', description: 'd' } }
    registerA2aRoutes(ctx, ref)
    const route = routes.find((r) => r.path === '/api/a2a/serverInfo')
    const res = fakeRes()
    await route?.handler({ headers: {} } as IncomingMessage, res as ServerResponse)
    expect(res.statusCode).toBe(401)
  })

  it('surfaces the apiKey in serverInfo only to bearers of the key', async () => {
    const webServer = { register: (_r: CapturedRoute) => () => undefined }
    const { ctx, routes } = registerWith(webServer)
    const server = resolveConfig({
      server: { host: '127.0.0.1', port: 8899, apiKey: 'secret-key' },
    }).server
    const ref: ServerRef = { server, agentCard: { name: 'n', description: 'd' } }
    registerA2aRoutes(ctx, ref)
    const route = routes.find((r) => r.path === '/api/a2a/serverInfo')

    const wrong = fakeRes()
    await route?.handler(
      { headers: { authorization: 'Bearer nope' } } as unknown as IncomingMessage,
      wrong as ServerResponse,
    )
    expect(wrong.statusCode).toBe(401)

    const right = fakeRes()
    await route?.handler(
      { headers: { authorization: 'Bearer secret-key' } } as unknown as IncomingMessage,
      right as ServerResponse,
    )
    expect(right.statusCode).toBe(200)
    const payload = JSON.parse(String(right.body)) as { apiKeySet: boolean; apiKey?: string }
    expect(payload.apiKeySet).toBe(true)
    expect(payload.apiKey).toBe('secret-key')
  })

  it('serves serverInfo openly when no apiKey is configured', async () => {
    const webServer = { register: (_r: CapturedRoute) => () => undefined }
    const { ctx, routes } = registerWith(webServer)
    const ref = refOf()
    registerA2aRoutes(ctx, ref)
    const route = routes.find((r) => r.path === '/api/a2a/serverInfo')
    const res = fakeRes()
    await route?.handler({ headers: {} } as IncomingMessage, res as ServerResponse)
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(String(res.body)) as { apiKeySet: boolean; apiKey?: string }
    expect(payload.apiKeySet).toBe(false)
  })

  it('rejects key rotation and card probing without the key once configured', async () => {
    const webServer = { register: (_r: CapturedRoute) => () => undefined }
    const { ctx, routes } = registerWith(webServer)
    const server = resolveConfig({
      server: { host: '127.0.0.1', port: 8899, apiKey: 'secret-key' },
    }).server
    const ref: ServerRef = { server, agentCard: { name: 'n', description: 'd' } }
    const persistKey = vi.fn()
    registerA2aRoutes(ctx, ref, persistKey)

    const rotate = routes.find((r) => r.path === '/api/a2a/regenerateKey')
    const rotateRes = fakeRes()
    await rotate?.handler({ headers: {} } as IncomingMessage, rotateRes as ServerResponse)
    expect(rotateRes.statusCode).toBe(401)
    expect(persistKey).not.toHaveBeenCalled()
    // The configured key must survive the rejected rotation.
    expect(server.apiKey).toBe('secret-key')

    const probe = routes.find((r) => r.path === '/api/a2a/testAgentCard')
    const probeRes = fakeRes()
    await probe?.handler({ headers: {} } as IncomingMessage, probeRes as ServerResponse)
    expect(probeRes.statusCode).toBe(401)
  })
})
