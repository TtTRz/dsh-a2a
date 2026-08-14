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
import type { Message, Part, Task, TaskState } from '@a2a-js/sdk'
import { Role as RoleEnum, TaskState as TaskStateEnum } from '@a2a-js/sdk'
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'

export interface ExecutorOptions {
  /** Preset mounted into each conversation agent. */
  preset: string
  /** Per-turn deadline; a slow turn is cancelled instead of left running. */
  turnTimeoutMs: number
}

interface RunningTurn {
  agent: Agent
  dispose: () => Promise<void>
  sessionId: SessionId
  contextId: string
}

/** Derive a stable dsh session id from an A2A context id. */
export function sessionIdFor(contextId: string): SessionId {
  const digest = createHash('sha256').update(contextId).digest('hex').slice(0, 24)
  return SessionId(`a2a-${digest}`)
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
      const turn = await this.openTurn(sessionIdFor(contextId), contextId)
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
      eventBus.publish(
        AgentEvent.message(
          agentMessage(collectReplyText(turn.agent.session.events), taskId, contextId),
        ),
      )
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: status(TaskStateEnum.TASK_STATE_COMPLETED),
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

  /** Adopt the live agent for a session, or create one with the preset mounted. */
  private async openTurn(sessionId: SessionId, contextId: string): Promise<RunningTurn> {
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) {
      return { agent: live, dispose: async () => undefined, sessionId, contextId }
    }
    // Presets are an optional capability: profiles without an agent-presets
    // service get plain agents (the harness default model) instead.
    const presets = this.ctx.get('agentPresets') as
      | {
          resolve(name: string): Promise<{ id: string }>
          mount(agentCtx: Context, id: string): Promise<void>
        }
      | undefined
    if (presets === undefined) {
      const handle = await this.ctx.agents.create({ sessionId })
      return { agent: handle.agent, dispose: handle.dispose, sessionId, contextId }
    }
    const presetId = await this.resolvePreset(presets)
    const handle = await this.ctx.agents.create({
      sessionId,
      setup: async (agentCtx: Context) => {
        await presets.mount(agentCtx, presetId)
      },
    })
    return { agent: handle.agent, dispose: handle.dispose, sessionId, contextId }
  }

  private resolvePreset(presets: {
    resolve(name: string): Promise<{ id: string }>
  }): Promise<string> {
    this.presetPromise ??= presets.resolve(this.options.preset).then((p) => p.id)
    return this.presetPromise
  }
}
