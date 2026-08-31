/**
 * The A2A executor: one A2A task = one turn of a persistent Harness agent.
 *
 * Conversations are keyed by the A2A `contextId`: each context gets a
 * deterministic session id, so follow-up messages continue the same agent
 * session. A live agent is adopted when it already exists (e.g. the same
 * conversation was opened in the web UI); otherwise a new one is created
 * with the configured preset mounted.
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
  /** URL slug of this agent (namespaces the session id, e.g. 'mp-perf'). */
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
}

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
  private presetPromise?: Promise<string>
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
      const turn = await this.openTurn(sessionIdFor(this.options.agentId, contextId), contextId)
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

  /** Adopt the live agent for a session, or create one with the preset mounted. */
  private async openTurn(sessionId: SessionId, contextId: string): Promise<RunningTurn> {
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) {
      // Adopted agents were attached to their per-session workspace when they
      // were created (attach validates the session cwd against the workspace
      // path, which only matches the creator's row); re-attaching here could
      // mint an empty row for a session whose stored cwd predates per-session
      // dirs, so skip it.
      return { agent: live, dispose: async () => undefined, sessionId, contextId }
    }
    const selection = this.modelSelection()
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
    const presetId = presets === undefined ? undefined : await this.resolvePreset(presets)
    const cwd = this.sessionDir(sessionId, contextId)
    await mkdir(cwd, { recursive: true })
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx: Context) => {
        if (presets !== undefined && presetId !== undefined) {
          await presets.mount(agentCtx, presetId)
        }
        installModelSelection(agentCtx, { current: selection, assembled: undefined })
      },
    })
    void this.attachToWorkspace(String(sessionId), contextId)
    return { agent: handle.agent, dispose: handle.dispose, sessionId, contextId }
  }

  /** Resolve the model route for new agents: explicit config, then the harness default. */
  private modelSelection(): ModelSelection | undefined {
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

  private resolvePreset(presets: {
    resolve(name: string): Promise<{ id: string }>
  }): Promise<string> {
    this.presetPromise ??= presets.resolve(this.options.preset).then((p) => p.id)
    return this.presetPromise
  }
}
