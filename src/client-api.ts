/**
 * Client-side HTTP data face for the A2A settings tab.
 *
 * The Host exposes plain `webServer.register(...)` routes (see routes.ts) —
 * not a Typert Remote service — so the client reads/writes them with `fetch`
 * instead of `remote.a2a`. Keeping this in its own module makes the round
 * trip unit-testable and keeps the React components free of the wire shape.
 *
 * @module dsh-a2a/client-api
 */

/** The agent-card fields a probe returns (mirrors the Host projection). */
export interface CardProbe {
  name?: string
  description?: string
}

/** The inbound server summary the Host projects (enabled server form). */
export interface ServerInfoValue {
  enabled: boolean
  host: string
  port: number
  publicUrl?: string
  apiKeySet: boolean
  provider?: string
  model?: string
  preset: string
  workspaceTitle: string
  agentCard: { name: string; description: string; version: string }
}

const TEST_CARD = '/api/a2a/testAgentCard'
const SERVER_INFO = '/api/a2a/serverInfo'

interface ErrorPayload {
  error?: string
}

/** Probe one remote agent card through the Host route; rejects on any failure. */
export async function probeCard(url: string, headers: Record<string, string>): Promise<CardProbe> {
  const response = await fetch(TEST_CARD, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ url, headers }),
  })
  const payload = (await response.json()) as CardProbe & ErrorPayload
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`)
  return { name: payload.name, description: payload.description }
}

/** Read the inbound server summary through the Host route; rejects on failure. */
export async function fetchServerInfo(): Promise<ServerInfoValue> {
  const response = await fetch(SERVER_INFO, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const payload = (await response.json()) as ServerInfoValue
  if (payload === null || typeof payload !== 'object') throw new Error('invalid payload')
  return payload
}
