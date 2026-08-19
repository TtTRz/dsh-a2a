/**
 * Client-side Remote descriptors for the A2A settings tab. Mirrors the Host
 * `A2aTestService` (src/typert.ts); the tab mounts this contribution so
 * `remote.a2a.testAgentCard(...)` and `remote.a2a.serverInfo()` route to the
 * Host.
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
const serverInfoSchema = z.object({
  enabled: z.boolean(),
  host: z.string(),
  port: z.number(),
  publicUrl: z.string().optional(),
  apiKeySet: z.boolean(),
  provider: z.string().optional(),
  model: z.string().optional(),
  preset: z.string(),
  workspaceTitle: z.string(),
  agentCard: z.object({
    name: z.string(),
    description: z.string(),
    version: z.string(),
  }),
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
          codec: {
            mode: 'strict' as const,
            typeSymbol: 'Record<string, string>',
            schema: headersSchema,
          },
        },
      ],
      result: {
        mode: 'strict' as const,
        typeSymbol: 'dsh-a2a/client#AgentCardProbe',
        schema: resultSchema,
      },
    },
    {
      id: 'dsh-a2a#a2a/serverInfo',
      service: 'a2a',
      namespace: 'a2a',
      method: 'serverInfo',
      invocation: { kind: 'direct' as const },
      parameters: [],
      result: {
        mode: 'strict' as const,
        typeSymbol: 'dsh-a2a/client#ServerInfo',
        schema: serverInfoSchema,
      },
    },
  ],
}
