/**
 * Host HTTP routes backing the A2A settings tab.
 *
 * Replaces the Typert Remote `A2aTestService` with plain
 * `webServer.register(...)` routes (the dsh-engram / dsh-tencent-memory
 * pattern). The typert gateway's SRC claims only recognize Services whose
 * registration predates its claims snapshot or which arrive through a
 * manifest; a live Service mounted at plugin `apply()` is never claimed, so
 * the previous `/api/a2a/testAgentCard` and `/api/a2a/serverInfo` returned
 * 404. Plain routes mounted on the same inject fiber are registered directly
 * with the web server and always reachable.
 *
 * @module dsh-a2a/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentCardProbe, ServerRef } from './typert.js'
import { serverInfoOf } from './typert.js'

interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
  }): () => void
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim().length === 0) {
        reject(new Error('empty body'))
        return
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>)
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/** Fetch one remote agent card; rejects on an invalid URL or a non-2xx response. */
export async function probeCard(
  url: string,
  headers: Record<string, string>,
): Promise<AgentCardProbe> {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    throw new Error('invalid URL')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('only http(s) URLs are supported')
  }
  const response = await fetch(target, {
    headers: { ...headers, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const card = (await response.json()) as { name?: string; description?: string }
  return { name: card.name, description: card.description }
}

/**
 * Mount the two `/api/a2a/*` routes. The callback fiber applies once
 * `webServer` appears (immediately when already present); a plain
 * `ctx.inject(['webServer'])` would keep the plugin waiting on profiles that
 * never provide one (TUI), and `ctx.get('webServer')` inside our own fiber's
 * effect runs before the provider is active — both silently drop the routes.
 * The child fiber's disposal is registered as a parent effect, so stopping
 * the plugin unregisters every route.
 */
export function registerA2aRoutes(ctx: Context, ref: ServerRef): void {
  ctx.inject(['webServer'], (wsCtx: Context) => {
    wsCtx.effect(() => {
      const webServer = wsCtx.get('webServer', false) as WebServerLike | undefined
      if (webServer === undefined) return () => undefined

      const disposers: Array<() => void> = []

      disposers.push(
        webServer.register({
          kind: 'exact',
          path: '/api/a2a/testAgentCard',
          handler: async (req, res) => {
            let target: string
            let headers: Record<string, string>
            try {
              const body = await readJsonBody(req)
              if (typeof body.url !== 'string') throw new Error('url must be a string')
              if (body.headers === undefined) {
                headers = {}
              } else if (
                typeof body.headers === 'object' &&
                body.headers !== null &&
                !Array.isArray(body.headers)
              ) {
                headers = body.headers as Record<string, string>
              } else {
                throw new Error('headers must be an object')
              }
              target = body.url
            } catch (error) {
              send(res, 400, {
                error: error instanceof Error ? error.message : String(error),
              })
              return
            }
            try {
              const card = await probeCard(target, headers)
              send(res, 200, card)
            } catch (error) {
              send(res, 502, {
                error: error instanceof Error ? error.message : String(error),
              })
            }
          },
        }),
      )

      disposers.push(
        webServer.register({
          kind: 'exact',
          path: '/api/a2a/serverInfo',
          handler: (_req, res) => {
            send(res, 200, serverInfoOf(ref))
          },
        }),
      )

      return () => {
        for (const dispose of disposers) dispose()
      }
    })
  })
}
