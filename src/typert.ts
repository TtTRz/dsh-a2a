/**
 * Host-side Remote surface for the A2A settings card: one method that fetches
 * a remote agent card and returns its name/description, which the card shows
 * and (optionally) backfills into the name field.
 *
 * @module dsh-a2a/typert
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/** The agent-card fields a probe returns. */
export interface AgentCardProbe {
  name?: string
  description?: string
}

/**
 * Host Remote service (`ctx.a2a`) backing the settings card's test button.
 * The client mounts the matching Remote descriptor and calls
 * `a2a.testAgentCard(url, headers)`; the gateway routes it here so the fetch
 * runs on the Host (the only side with network access).
 */
export class A2aTestService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'a2a')
  }

  @Remote('testAgentCard')
  async testAgentCard(url: string, headers: Record<string, string>): Promise<AgentCardProbe> {
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
}
