/**
 * The A2A executor: one A2A task = one turn of a persistent Harness agent.
 *
 * Conversations are keyed by the A2A `contextId`: each context gets a
 * deterministic session id, so follow-up messages continue the same agent
 * session. A live agent is adopted when it already exists (e.g. the same
 * conversation was opened in the web UI); otherwise a new one is created
 * with the configured preset mounted.
 *
 * A caller may pick the preset and the model route per request through the
 * A2A `metadata` map. The two ride different lifetimes, because that is what
 * the harness gives them: a preset composes an agent and therefore applies
 * on the request that creates the session, while the model is a per-step
 * route a live session can be switched onto.
 *
 * @module dsh-a2a/executor
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Message, Part, Task, TaskState } from '@a2a-js/sdk'
import { Role as RoleEnum, TaskState as TaskStateEnum } from '@a2a-js/sdk'
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server'
import type { Context } from '@deepseek-ai/cordis'
import { type Agent, installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'

export interface ExecutorOptions {
  /** URL slug of this agent (namespaces the session id, e.g. 'docs'). */
  agentId: string
  /** Preset mounted into each conversation agent. */
  preset: string
  /** Per-turn deadline; a slow turn is cancelled instead of left running. */
  turnTimeoutMs: number
  /** Working directory for A2A conversation agents; doubles as the sidebar workspace path. */
  cwd?: string
  /** Sidebar workspace title grouping A2A conversations. */
  workspaceTitle?: string
  /** Explicit model route; falls back to the harness default model. */
  provider?: string
  model?: string
  /** Whether callers may override the preset and the model route per request. */
  allowOverrides?: boolean
}

/**
 * What one request asked for through the A2A `metadata` map. Absent means
 * "use whatever the deployment configured", never "use nothing".
 */
export interface RequestOverrides {
  /** Preset id; applied on the request that creates the session. */
  preset?: string
  /** Provider route; paired with `model` or with the configured model. */
  provider?: string
  /** Model id, overriding `server.model`. */
  model?: string
}

/** Metadata keys naming the preset; the first one present wins. */
const PRESET_KEYS = ['agentPreset', 'preset'] as const
/** Metadata key naming the model. */
const MODEL_KEY = 'model'
/** Metadata key naming the provider route. */
const PROVIDER_KEY = 'provider'

/**
 * A preset id becomes a directory name, so what could reach outside the
 * preset root is refused here rather than at the filesystem.
 */
const PRESET_VALUE = /^[A-Za-z0-9._-]{1,64}$/
/** Provider routes are registry keys, so they stay path-safe too. */
const PROVIDER_VALUE = /^[A-Za-z0-9._-]{1,64}$/
/** Model ids are provider-owned and carry their own punctuation. */
const MODEL_VALUE = /^[A-Za-z0-9._:@/-]{1,128}$/

interface WorkspaceRegistry {
  create(path: string, title: string): Promise<Workspace>
}

interface Workspace {
  attachSession(sessionId: string): Promise<void>
}

interface ModelSelection {
  provider: string
  model: string
}

/** The mutable model route one agent reads per step; see `installModelSelection`. */
interface ModelSelectionRef {
  current: ModelSelection | undefined
  assembled: ModelSelection | undefined
}

interface RunningTurn {
  agent: Agent
  dispose: () => Promise<void>
  sessionId: SessionId
  contextId: string
}

/** Derive a stable dsh session id from an A2A context id, namespaced by agent. */
export function sessionIdFor(agentId: string, contextId: string): SessionId {
  const digest = createHash('sha256').update(contextId).digest('hex').slice(0, 24)
  return SessionId(`a2a-${agentId}-${digest}`)
}

/**
 * Read the overrides one request asked for on the A2A `metadata` map.
 *
 * The message-level map wins over the request-level one: a caller that knows
 * only one of the two still works, and a caller that writes both — a common
 * defensive habit, and what this plugin's own Java client does — is
 * unambiguous rather than order-dependent.
 *
 * @param params - the `SendMessageRequest` a transport handed to the executor.
 * @param message - the inbound user `Message`.
 * @returns the overrides; empty when the request named none.
 * @throws when a key carries a value that cannot be honoured. An override is
 *   a request, and answering on a different preset or model than the caller
 *   named — because its value did not parse — is the one outcome it cannot
 *   detect, so it fails the task instead.
 */
export function requestOverrides(params: unknown, message: unknown): RequestOverrides {
  const merged = mergeMetadata(metadataOf(params), metadataOf(message))
  const preset = pick(merged, PRESET_KEYS, PRESET_VALUE)
  const provider = pick(merged, [PROVIDER_KEY], PROVIDER_VALUE)
  const model = pick(merged, [MODEL_KEY], MODEL_VALUE)
  return {
    ...(preset === undefined ? {} : { preset }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  }
}

/** The `metadata` map of one A2A object; empty when it carries none. */
function metadataOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {}
  const metadata = (value as { metadata?: unknown }).metadata
  if (typeof metadata !== 'object' || metadata === null) return {}
  return metadata as Record<string, unknown>
}

/** Overlay two metadata maps, later-wins, without an explicit `undefined` clobbering. */
function mergeMetadata(...sources: readonly Record<string, unknown>[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) merged[key] = value
    }
  }
  return merged
}

/**
 * The first present, non-blank value among `keys`, checked against `pattern`.
 * A blank value means "not specified" — the way an empty form field reads —
 * while a non-string is a caller bug worth failing on.
 */
function pick(
  metadata: Record<string, unknown>,
  keys: readonly string[],
  pattern: RegExp,
): string | undefined {
  for (const key of keys) {
    const raw = metadata[key]
    if (raw === undefined || raw === null) continue
    if (typeof raw !== 'string') {
      throw new Error(`dsh-a2a: metadata.${key} must be a string, got ${typeof raw}`)
    }
    const value = raw.trim()
    if (value.length === 0) continue
    if (!pattern.test(value)) {
      throw new Error(
        `dsh-a2a: metadata.${key} must match ${String(pattern)}, got ${JSON.stringify(value)}`,
      )
    }
    return value
  }
  return undefined
}

/**
 * Render a preset resolution failure the way a caller can act on it: the
 * roster service throws with the ids it does supply, and naming those beats
 * a bare "unknown preset" for a caller guessing across deployments.
 *
 * Duck-typed, not `instanceof`: this package reaches the service through
 * `ctx.get` rather than through a dependency it could import the class from.
 */
function describePresetError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const available = (error as { available?: unknown } | null)?.available
  return Array.isArray(available) && available.length > 0
    ? `${message} (available: ${available.join(', ')})`
    : message
}

/** Build an A2A text part. */
export function textPart(text: string): Part {
  return {
    content: { $case: 'text', value: text },
    metadata: undefined,
    filename: '',
    mediaType: 'text/plain',
  }
}

/** Build an A2A raw-file part (e.g. a rendered PNG card). */
export function rawFilePart(data: Uint8Array, mediaType: string, filename: string): Part {
  return {
    content: { $case: 'raw', value: Buffer.from(data) },
    metadata: undefined,
    filename,
    mediaType,
  }
}

/** Build an A2A agent-role message carrying one text part. */
export function agentMessage(text: string, taskId: string, contextId: string): Message {
  return {
    role: RoleEnum.ROLE_AGENT,
    parts: [textPart(text)],
    messageId: randomUUID(),
    taskId,
    contextId,
    extensions: [],
    referenceTaskIds: [],
    metadata: undefined,
  }
}

/** Concatenate the plain-text parts of an A2A message. */
export function textOf(message: Message): string {
  const parts: string[] = []
  for (const part of message.parts ?? []) {
    if (part.content?.$case === 'text' && part.content.value.trim().length > 0) {
      parts.push(part.content.value.trim())
    }
  }
  return parts.join('\n')
}

/**
 * Collect the durable image attachment refs produced during one turn: cards
 * rendered by tools (e.g. `render_card`) land as image blocks inside
 * tool-result events. Returns them oldest-first.
 */
export function collectImageRefs(events: readonly SessionEvent[]): ImageAttachmentRef[] {
  const images: ImageAttachmentRef[] = []
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    for (const block of event.data.message.content ?? []) {
      if (block.type !== 'tool-result') continue
      for (const inner of block.content) {
        if (inner.type === 'image') images.push(inner.attachment)
      }
    }
  }
  return images
}

/** Collect the assistant text blocks of the session events written during a turn. */
export function collectReplyText(events: readonly SessionEvent[]): string {
  const texts: string[] = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const content = event.data.message.content
    for (const block of content) {
      if (block.type === 'text' && block.text.trim().length > 0) texts.push(block.text.trim())
    }
  }
  return texts.length > 0 ? texts.join('\n') : '（该轮没有文本回复）'
}

function withDeadline<T>(
  promise: Promise<T>,
  millis: number,
): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), millis)
  })
  return Promise.race([promise.then((value) => ({ done: true, value })), deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

function status(
  state: TaskState,
  message?: Message,
): { state: TaskState; timestamp: string; message: Message | undefined } {
  return { state, timestamp: new Date().toISOString(), message }
}

/**
 * Runs A2A tasks on persistent per-context Harness agents. One instance
 * serves every task; the running-task table pairs task ids with the agent
 * turns that own them so cancellation reaches the right agent.
 */
export class DshAgentExecutor implements AgentExecutor {
  private readonly running = new Map<string, RunningTurn>()
  /** Resolved preset ids by preset name; discovery re-reads the roots per call. */
  private readonly presetIds = new Map<string, Promise<string>>()
  /** The mutable model route of every agent this instance created, by session id. */
  private readonly selections = new Map<string, ModelSelectionRef>()
  private workspacePromise?: Map<string, Promise<Workspace | undefined>>

  constructor(
    private readonly ctx: Context,
    private readonly options: ExecutorOptions,
  ) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const taskId = requestContext.taskId
    const contextId = requestContext.contextId
    const userMessage = requestContext.userMessage
    const snapshot: Task = requestContext.task ?? {
      id: taskId,
      contextId,
      status: status(TaskStateEnum.TASK_STATE_SUBMITTED),
      artifacts: [],
      history: [userMessage],
      metadata: userMessage.metadata,
    }
    eventBus.publish(AgentEvent.task(snapshot))
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: status(TaskStateEnum.TASK_STATE_WORKING),
        metadata: {},
      }),
    )
    try {
      const overrides = this.overridesOf(requestContext, contextId)
      const turn = await this.openTurn(
        sessionIdFor(this.options.agentId, contextId),
        contextId,
        overrides,
      )
      this.running.set(taskId, turn)
      turn.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: textOf(userMessage) }],
          source: { kind: 'user' },
        }),
      )
      const settled = await withDeadline(turn.agent.whenIdle(), this.options.turnTimeoutMs)
      if (!settled.done) {
        turn.agent.cancel({ kind: 'user' })
        throw new Error(`dsh-a2a: turn exceeded ${this.options.turnTimeoutMs}ms and was cancelled`)
      }
      // Cards rendered during the turn (e.g. render_card tool) ship as file
      // artifacts BEFORE the terminal status: the SDK's execution queue ends
      // the event stream at the first terminal statusUpdate, so artifacts
      // published afterwards would never reach the caller.
      await this.publishCardArtifacts(eventBus, taskId, contextId, turn.agent.session.events)
      // The reply must ride ON the terminal status: publishing a separate
      // message first would strand the task in WORKING forever in the task
      // store.
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: status(
            TaskStateEnum.TASK_STATE_COMPLETED,
            agentMessage(collectReplyText(turn.agent.session.events), taskId, contextId),
          ),
          metadata: {},
        }),
      )
    } catch (error) {
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: status(
            TaskStateEnum.TASK_STATE_FAILED,
            agentMessage(`dsh-a2a: ${String(error)}`, taskId, contextId),
          ),
          metadata: {},
        }),
      )
    } finally {
      this.running.delete(taskId)
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const turn = this.running.get(taskId)
    if (turn === undefined) return
    turn.agent.cancel({ kind: 'user' })
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: turn.contextId,
        status: status(TaskStateEnum.TASK_STATE_CANCELED),
        metadata: {},
      }),
    )
  }

  /**
   * Cancel and release every running turn, then drop the tracking table. Used
   * when a served agent is removed or rebuilt live so in-flight turns never
   * outlive the route that owned them. Idle sessions are left to the harness
   * (they stay adoptable); this only stops the currently-running turns.
   */
  async dispose(): Promise<void> {
    const turns = [...this.running.values()]
    this.running.clear()
    for (const turn of turns) {
      try {
        turn.agent.cancel({ kind: 'user' })
        await turn.dispose()
      } catch {
        // best-effort: a session that already closed must never block removal
      }
    }
  }

  /**
   * Publish each rendered card as one file artifact (raw PNG part). A card
   * whose bytes cannot be read is logged and skipped; the text reply still
   * completes the task.
   */
  private async publishCardArtifacts(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    events: readonly SessionEvent[],
  ): Promise<void> {
    const refs = collectImageRefs(events)
    if (refs.length === 0) return
    const attachments = (
      this.ctx as unknown as {
        attachments?: {
          readImage(ref: ImageAttachmentRef): Promise<{ data: Uint8Array; ref: ImageAttachmentRef }>
        }
      }
    ).attachments
    if (attachments === undefined) return
    for (const [index, ref] of refs.entries()) {
      try {
        const stored = await attachments.readImage(ref)
        eventBus.publish(
          AgentEvent.artifactUpdate({
            taskId,
            contextId,
            append: false,
            lastChunk: true,
            metadata: undefined,
            artifact: {
              artifactId: randomUUID(),
              name: `card-${index + 1}`,
              description: 'Rendered summary card',
              parts: [rawFilePart(stored.data, ref.mediaType, `card-${index + 1}.png`)],
              metadata: undefined,
              extensions: [],
            },
          }),
        )
      } catch (error) {
        this.ctx.logger.warn(
          `dsh-a2a: card artifact ${index + 1} could not be read: ${String(error)}`,
        )
      }
    }
  }

  /**
   * The overrides this request carries, or none when the deployment refuses
   * them.
   *
   * A refused override is logged rather than failed: the caller asked for a
   * policy the deployment does not grant, and answering on the deployment's
   * own route beats an error a caller that is not its operator cannot act on.
   */
  private overridesOf(requestContext: RequestContext, contextId: string): RequestOverrides {
    const overrides = requestOverrides(requestContext.request, requestContext.userMessage)
    const keys = Object.keys(overrides)
    if (keys.length === 0) return overrides
    if (this.options.allowOverrides === false) {
      this.ctx.logger.warn(
        `dsh-a2a: ignored request overrides for context ${contextId} (${JSON.stringify(overrides)}): server.allowOverrides is false`,
      )
      return {}
    }
    this.ctx.logger.info(
      `dsh-a2a: request overrides for context ${contextId}: ${JSON.stringify(overrides)}`,
    )
    return overrides
  }

  /** Adopt the live agent for a session, or create one with the preset mounted. */
  private async openTurn(
    sessionId: SessionId,
    contextId: string,
    overrides: RequestOverrides,
  ): Promise<RunningTurn> {
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) {
      // Adopted agents were attached to their per-session workspace when they
      // were created (attach validates the session cwd against the workspace
      // path, which only matches the creator's row); re-attaching here could
      // mint an empty row for a session whose stored cwd predates per-session
      // dirs, so skip it.
      //
      // A preset composes an agent, so it applies on the request that creates
      // the session — not here. Swapping a live session's tools mid
      // conversation would leave logged tool calls the new composition cannot
      // make, so the override is dropped rather than applied; say so, because
      // answering on a different preset than requested is otherwise invisible
      // to the caller.
      if (overrides.preset !== undefined) {
        this.ctx.logger.warn(
          `dsh-a2a: preset override ${JSON.stringify(overrides.preset)} ignored for context ${contextId}: the session already exists; a preset applies on the request that creates it`,
        )
      }
      this.applyModelOverride(String(sessionId), contextId, overrides)
      return { agent: live, dispose: async () => undefined, sessionId, contextId }
    }
    const selection = this.modelSelection(overrides)
    if (selection === undefined) {
      throw new Error(
        'dsh-a2a: no model route for A2A agents; set server.provider/server.model or the default model',
      )
    }
    // Presets are an optional capability: profiles without an agent-presets
    // service get plain agents (the harness default model) instead.
    const presets = this.ctx.get('agentPresets') as
      | {
          resolve(name: string): Promise<{ id: string }>
          mount(agentCtx: Context, id: string): Promise<void>
        }
      | undefined
    const presetName = overrides.preset ?? this.options.preset
    let presetId: string | undefined
    if (presets !== undefined) {
      try {
        presetId = await this.resolvePreset(presets, presetName)
      } catch (error) {
        throw new Error(
          `dsh-a2a: cannot mount preset ${JSON.stringify(presetName)}: ${describePresetError(error)}`,
        )
      }
    }
    const cwd = this.sessionDir(sessionId, contextId)
    await mkdir(cwd, { recursive: true })
    // The ref is mutable because the model is a per-step route: a later
    // request may switch this session onto another model without losing the
    // conversation (see applyModelOverride).
    const ref: ModelSelectionRef = { current: selection, assembled: undefined }
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx: Context) => {
        if (presets !== undefined && presetId !== undefined) {
          await presets.mount(agentCtx, presetId)
        }
        installModelSelection(agentCtx, ref)
      },
    })
    this.selections.set(String(sessionId), ref)
    this.ctx.logger.info(
      `dsh-a2a: context ${contextId} → session ${String(sessionId)} (preset ${presetId ?? 'none'}, ${selection.provider}/${selection.model})`,
    )
    void this.attachToWorkspace(String(sessionId), contextId)
    return { agent: handle.agent, dispose: handle.dispose, sessionId, contextId }
  }

  /**
   * Switch a live session onto the model route this request named.
   *
   * The selection is a mutable ref the agent reads per step, so the next turn
   * answers on the new model while the conversation — and the KV-cache prefix
   * its history already earned — survives. Only sessions this executor
   * instance created carry such a ref; one adopted from outside it (opened in
   * the web UI, or resumed from disk) has no handle to switch, so the answer
   * keeps the route it was created with.
   */
  private applyModelOverride(
    sessionKey: string,
    contextId: string,
    overrides: RequestOverrides,
  ): void {
    if (overrides.model === undefined && overrides.provider === undefined) return
    const selection = this.modelSelection(overrides)
    const ref = this.selections.get(sessionKey)
    if (selection === undefined || ref === undefined) {
      this.ctx.logger.warn(
        `dsh-a2a: model override ignored for context ${contextId}: the session was not created by this executor instance`,
      )
      return
    }
    ref.current = selection
    ref.assembled = undefined
    this.ctx.logger.info(
      `dsh-a2a: context ${contextId} switched to ${selection.provider}/${selection.model}`,
    )
  }

  /**
   * Resolve the model route for one turn: a request override wins over the
   * configured route, which wins over the harness default.
   *
   * A caller that names only a model has it paired with the configured (or
   * default) provider: callers know the model they want, not the route
   * serving it.
   *
   * @throws when the request names a route half no other source completes —
   *   routing the turn to a model the caller did not ask for is worse than
   *   failing.
   */
  private modelSelection(overrides: RequestOverrides = {}): ModelSelection | undefined {
    const route = this.configuredSelection()
    const provider = overrides.provider ?? route?.provider
    const model = overrides.model ?? route?.model
    if (provider !== undefined && model !== undefined) return { provider, model }
    if (overrides.provider !== undefined || overrides.model !== undefined) {
      // A half-override the deployment cannot complete (e.g. a bare model with
      // no provider anywhere): fall back to the configured/default route rather
      // than failing the task. A caller cannot act on an error naming a route it
      // does not administer, so answer on the route it would get without the
      // override and say so.
      this.ctx.logger.warn(
        'dsh-a2a: ignored a model override the deployment could not complete (no provider/model pair); using the configured route',
      )
      return route
    }
    return undefined
  }

  /** The route this deployment answers on: explicit config, else the harness default. */
  private configuredSelection(): ModelSelection | undefined {
    if (this.options.provider !== undefined && this.options.model !== undefined) {
      return { provider: this.options.provider, model: this.options.model }
    }
    const defaults = this.ctx.get('agentDefaultModel') as
      | { currentSelection(): { provider?: string; model?: string } | undefined }
      | undefined
    const selection = defaults?.currentSelection()
    if (selection?.provider !== undefined && selection.model !== undefined) {
      return { provider: selection.provider, model: selection.model }
    }
    return undefined
  }

  /**
   * Best-effort attach of one A2A session to its per-session sidebar workspace.
   * Each A2A session runs in its own cwd (see sessionDir), and workspace
   * membership validates the session cwd against the workspace path, so the
   * grouping workspace is per-session too — one sidebar row per A2A caller
   * context. A session whose grouping fails must never fail the message itself.
   */
  async attachToWorkspace(sessionId: string, contextId?: string): Promise<void> {
    try {
      const workspace = await this.ensureWorkspace(sessionId, contextId)
      await workspace?.attachSession(sessionId)
    } catch (error) {
      this.ctx.logger.warn(`dsh-a2a: workspace attach failed for ${sessionId}: ${String(error)}`)
    }
  }

  /**
   * Resolve the per-session grouping workspace. Failures (including a
   * not-yet-mounted registry) are forgotten so the next call retries instead of
   * caching the miss forever.
   */
  private ensureWorkspace(sessionId: string, contextId?: string): Promise<Workspace | undefined> {
    this.workspacePromise ??= new Map()
    const cached = this.workspacePromise.get(sessionId)
    if (cached !== undefined) return cached
    const current = this.openWorkspace(sessionId, contextId).then(
      (workspace) => {
        if (workspace === undefined) this.forgetWorkspace(sessionId, current)
        return workspace
      },
      (error) => {
        this.forgetWorkspace(sessionId, current)
        throw error
      },
    )
    this.workspacePromise.set(sessionId, current)
    return current
  }

  private forgetWorkspace(sessionId: string, current: Promise<Workspace | undefined>): void {
    if (this.workspacePromise?.get(sessionId) === current) {
      this.workspacePromise.delete(sessionId)
    }
  }

  private async openWorkspace(
    sessionId: string,
    contextId?: string,
  ): Promise<Workspace | undefined> {
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined
    if (registry === undefined) return undefined
    const cwd = this.sessionDir(SessionId(sessionId), contextId ?? sessionId)
    await mkdir(cwd, { recursive: true })
    const dirName = cwd.split('/').pop() ?? ''
    const stripped = dirName.replace(/^A2A-/, '').replace(/-[^-]*$/, '')
    const m = /^(.+)-(\d{4})-(\d{2})(\d{2})(\d{2})$/.exec(stripped)
    const suffix =
      m !== null &&
      m[1] !== undefined &&
      m[2] !== undefined &&
      m[3] !== undefined &&
      m[4] !== undefined &&
      m[5] !== undefined
        ? `${m[1]} ${m[2].slice(0, 2)}-${m[2].slice(2)} ${m[3]}:${m[4]}:${m[5]}`
        : sessionId
    const title = `${this.options.workspaceTitle ?? 'A2A'} · ${suffix}`
    return registry.create(cwd, title)
  }

  /**
   * Per-session sandbox cwd: every A2A session gets its own subdirectory under
   * the configured base, so the harness sandbox fence (workspace-write against
   * SessionHeader.cwd) isolates each caller context's filesystem.
   *
   * Directory naming: `A2A-{caller}-{MMDD}-{hash6}` — a readable slug of
   * the caller's contextId, the session's first-seen month-day, and 6 hash
   * chars of the stable session id so slug collisions can never merge or
   * split a caller's identity. Sessions minted before readable naming (raw
   * session-id dirs) are adopted as-is, so live sessions never move.
   */
  private sessionDir(sessionId: SessionId, contextId: string): string {
    const base = this.options.cwd ?? process.cwd()
    const sid = String(sessionId)
    const hash6 = sid.slice(-6)
    const pattern = new RegExp(`^A2A-.*-${hash6}$`)
    try {
      const hit = readdirSync(base).find((name) => pattern.test(name))
      if (hit !== undefined) return join(base, hit)
    } catch {
      // base not readable yet — fall through to mint a new name
    }
    const slug =
      contextId
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24) || 'caller'
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    return join(base, `A2A-${slug}-${stamp}-${hash6}`)
  }

  /**
   * Resolve one preset id by name.
   *
   * Discovery re-reads the roots on every call — so a preset authored while
   * the process runs is visible immediately — which is also why results are
   * cached per name instead of re-resolved per session. A rejection is
   * forgotten, the way the workspace table forgets a miss, so a preset whose
   * file is fixed becomes usable without a restart.
   */
  private resolvePreset(
    presets: { resolve(name: string): Promise<{ id: string }> },
    name: string,
  ): Promise<string> {
    const cached = this.presetIds.get(name)
    if (cached !== undefined) return cached
    const pending = presets.resolve(name).then(
      (preset) => preset.id,
      (error: unknown) => {
        if (this.presetIds.get(name) === pending) this.presetIds.delete(name)
        throw error
      },
    )
    this.presetIds.set(name, pending)
    return pending
  }
}
