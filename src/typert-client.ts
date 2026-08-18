/**
 * Client-side Remote descriptor for the A2A settings card's test button.
 * Mirrors the Host `A2aTestService` (src/typert.ts); the card mounts this
 * contribution so `remote.a2a.testAgentCard(url, headers)` routes to the Host.
 *
 * @module dsh-a2a/typert-client
 */

import { z } from 'zod'

const urlSchema = z.string()
const headersSchema = z.record(z.string(), z.string())
const resultSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
})

export const TYPERT_REMOTE = {
  package: 'dsh-a2a',
  descriptors: [
    {
      id: 'dsh-a2a#a2a/testAgentCard',
      service: 'a2a',
      namespace: 'a2a',
      method: 'testAgentCard',
      invocation: { kind: 'direct' as const },
      parameters: [
        {
          name: 'url',
          wire: 'url',
          source: 'json' as const,
          codec: { mode: 'strict' as const, typeSymbol: 'string', schema: urlSchema },
        },
        {
          name: 'headers',
          wire: 'headers',
          source: 'json' as const,
          codec: { mode: 'strict' as const, typeSymbol: 'Record<string, string>', schema: headersSchema },
        },
      ],
      result: {
        mode: 'strict' as const,
        typeSymbol: 'dsh-a2a/client#AgentCardProbe',
        schema: resultSchema,
      },
    },
  ],
}
