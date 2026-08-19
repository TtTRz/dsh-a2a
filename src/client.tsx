/**
 * Client half of dsh-a2a: the A2A settings tab (its own `settings.section`,
 * so the service is one click from the settings nav rather than buried under
 * Plugins → Plugin configuration).
 *
 * The tab owns two panels:
 * - **inbound** — a read-only summary of the local A2A endpoint (listen
 *   address, public URL, auth state, model route, Agent Card identity),
 *   projected by the Host through the `a2a.serverInfo` Remote; the apiKey
 *   itself never crosses the wire.
 * - **outbound** — the `agents` registry editor over the `a2a` settings
 *   namespace: staged rows (name / URL / description / structured headers),
 *   per-row agent-card probe, save / discard / reset. A save lands on the
 *   Host, the namespace watch fires, and the running `a2a_call` / `a2a_list`
 *   tools hot-reload — no restart. The tab carries its own bilingual copy so
 *   it renders identically regardless of which locale services this
 *   deployment composes.
 *
 * @module dsh-a2a/client
 */

import {
  Button,
  IconChevronDownOutline14,
  IconQuestionOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  type DraftRow,
  draftToAgents,
  freshHeaderId,
  freshRowId,
  isDirty,
  rowsFromAgents,
  type StoredAgent,
} from './card-state.js'
import { TYPERT_REMOTE } from './typert-client.js'

/** The settings namespace this card claims; must match the Host registration. */
const NAMESPACE = 'a2a'

export const name = 'dsh-a2a-client'
// NOTE: `remote.a2a` must NOT be declared here — that namespace service is
// created by this very plugin's `$mount(TYPERT_REMOTE)` inside apply(), so a
// static inject would park the fiber waiting on itself forever (client boot:
// "pending (waiting for service: remote.a2a)"). The card reads it lazily.
export const inject = ['slots', 'settingsScope', 'remote']

/** The slice of the client settings scope contract this tab consumes. */
interface ScopeLike {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value:
      | {
          agents?: StoredAgent[]
          agentCard?: { name: string; description: string }
        }
      | undefined
    user: unknown
    revision: number | undefined
    writable: boolean
  }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

interface SlotsSurface {
  inject(key: string, register: () => unknown): unknown
  register(
    options: { name: string; id?: string; order?: number; label?: string; key?: string },
    render: () => ReactNode,
  ): unknown
}

/** The slice of the client Remote surface this tab consumes. */
interface RemoteLike {
  a2a?: {
    testAgentCard(
      url: string,
      headers: Record<string, string>,
    ): Promise<{
      ok: boolean
      value?: { name?: string; description?: string }
      error?: { code?: string; message?: string }
    }>
    serverInfo(): Promise<{
      ok: boolean
      value?: {
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
      error?: { code?: string; message?: string }
    }>
  }
}

type Dictionary = Record<string, string>

const COPY: { zh: Dictionary; en: Dictionary } = {
  zh: {
    title: 'A2A 远程 agent',
    description: 'a2a_call / a2a_list 工具可触达的注册表；保存后立即生效，无需重启。',
    empty: '尚未注册任何远程 agent。',
    add: '添加 agent',
    remove: '移除',
    name: '名称',
    namePlaceholder: '例如 specialist',
    url: 'Agent Card URL',
    urlPlaceholder: 'https://example.com/',
    desc: '描述',
    descPlaceholder: '这个 agent 擅长什么',
    headers: '自定义 header',
    headerKey: 'Header 名称',
    headerValue: '值',
    addHeader: '添加 header',
    removeHeader: '移除',
    test: '测试 agent-card',
    testing: '测试中…',
    testOk: '连接成功',
    testFailed: '测试失败',
    remoteUnavailable: '测试功能不可用。',
    save: '保存',
    saving: '保存中…',
    discard: '放弃修改',
    reset: '重置为默认',
    unsaved: '未保存',
    overridden: '已覆盖部署默认值',
    readonly: '当前部署不接受设置写入。',
    nameRequired: '必填',
    nameDuplicate: '与其他行重名',
    urlInvalid: '必须是 http(s) URL',
    headerLine: '格式应为 Name: Value',
    agentLabel: 'Agent',
    saveFailed: '保存失败，请重试。',
    remoteCard: '远端声明的信息',
    remoteNoName: '（远端未声明名称）',
    remoteEmpty: '远端 Agent Card 未声明名称与描述。',
    adopt: '采用',
    probeRequired: '保存前需先测试成功。',
    probeBlocked: '仍有 agent 未验证通过，全部测试成功后才能保存',
    edit: '编辑',
    done: '完成',
    unnamed: '未命名',
    urlEmpty: '（未填 URL）',
    identityEdit: '编辑身份',
    unverifiedBadge: '未验证',
    verifiedBadge: '已验证',
    testingBadge: '测试中',
    failedBadge: '测试失败',
    remoteBadge: '远端',
    headerCountUnit: '个请求头',
    tabTitle: 'A2A 服务',
    tabIntro: '本地 A2A 端点与出站远程 agent 注册表。',
    inboundTitle: '入口（本机作为 A2A agent）',
    inboundLoading: '读取入口配置…',
    inboundUnavailable: '入口配置不可用。',
    inboundRefresh: '刷新',
    inboundStatus: '服务状态',
    inboundOn: '运行中',
    inboundOff: '已关闭',
    inboundListen: '监听地址',
    inboundPublicUrl: '公开地址',
    inboundIdentity: 'Agent Card 身份',
    inboundAuth: '鉴权',
    inboundAuthOn: '已启用 Bearer token',
    inboundAuthOff: '未启用（端口仅限本机/受信网络）',
    inboundModel: '模型路由',
    inboundModelDefault: '跟随 harness 默认模型',
    inboundPreset: 'Preset',
    inboundWorkspace: '工作区分组',
    outboundTitle: '出口（可调用的远程 agent）',
    cardUrl: 'Agent Card 地址',
    cardUrlCopy: '复制',
    cardUrlCopied: '已复制',
    identityTitle: 'Agent Card 身份（可编辑，保存即生效）',
    identityName: '名称',
    identityDescription: '描述',
    identitySave: '保存身份',
    identitySaving: '保存中…',
    identityReset: '重置为部署默认',
    tutorialTitle: '使用教程',
    tutorialStep1:
      '调用本机 agent：把下面的地址交给对方 A2A 客户端即可发现并调用本 agent（浏览器打开可查看身份卡片）。',
    tutorialStep2:
      '添加远程 agent：在出口区域「添加 agent」→ 填 Agent Card URL → 点「测试 agent-card」→ 测试成功后可「采用」远端声明的名称与描述 → 保存（未测试成功的行不能保存）。',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: copy documents the ${ENV_VAR} header syntax
    tutorialStep3:
      '保存立即生效：注册表热更新到 a2a_call / a2a_list 工具，无需重启。请求头里可用 ${ENV_VAR} 引用环境变量。',
  },
  en: {
    title: 'A2A remote agents',
    description:
      'The registry the a2a_call / a2a_list tools reach; a save is live, no restart needed.',
    empty: 'No remote agent registered yet.',
    add: 'Add agent',
    remove: 'Remove',
    name: 'Name',
    namePlaceholder: 'e.g. specialist',
    url: 'Agent Card URL',
    urlPlaceholder: 'https://example.com/',
    desc: 'Description',
    descPlaceholder: 'What this agent is good at',
    headers: 'Custom headers',
    headerKey: 'Header name',
    headerValue: 'Value',
    addHeader: 'Add header',
    removeHeader: 'Remove',
    test: 'Test agent card',
    testing: 'Testing…',
    testOk: 'Connected',
    testFailed: 'Test failed',
    remoteUnavailable: 'Test is unavailable.',
    save: 'Save',
    saving: 'Saving…',
    discard: 'Discard changes',
    reset: 'Reset to default',
    unsaved: 'Unsaved',
    overridden: 'Overrides the deployment default',
    readonly: 'This deployment does not accept settings writes.',
    nameRequired: 'Required',
    nameDuplicate: 'Duplicates another row',
    urlInvalid: 'Must be an http(s) URL',
    headerLine: 'Expected Name: Value',
    agentLabel: 'Agent',
    saveFailed: 'Save failed; try again.',
    remoteCard: 'Advertised by the remote card',
    remoteNoName: '(the remote card declares no name)',
    remoteEmpty: 'The remote Agent Card declares no name or description.',
    adopt: 'Adopt',
    probeRequired: 'Test this agent successfully before saving.',
    probeBlocked: 'Some agents are not verified yet — save once all tests pass',
    edit: 'Edit',
    done: 'Done',
    unnamed: 'Unnamed',
    urlEmpty: '(no URL)',
    identityEdit: 'Edit identity',
    unverifiedBadge: 'Unverified',
    verifiedBadge: 'Verified',
    testingBadge: 'Testing',
    failedBadge: 'Failed',
    remoteBadge: 'Remote',
    headerCountUnit: 'header(s)',
    tabTitle: 'A2A service',
    tabIntro: 'The local A2A endpoint and the outbound remote-agent registry.',
    inboundTitle: 'Inbound (this harness as an A2A agent)',
    inboundLoading: 'Reading inbound config…',
    inboundUnavailable: 'Inbound config is unavailable.',
    inboundRefresh: 'Refresh',
    inboundStatus: 'Status',
    inboundOn: 'Running',
    inboundOff: 'Disabled',
    inboundListen: 'Listen address',
    inboundPublicUrl: 'Public URL',
    inboundIdentity: 'Agent Card identity',
    inboundAuth: 'Auth',
    inboundAuthOn: 'Bearer token enforced',
    inboundAuthOff: 'None (keep the port local / behind a trusted network)',
    inboundModel: 'Model route',
    inboundModelDefault: 'Follows the harness default model',
    inboundPreset: 'Preset',
    inboundWorkspace: 'Workspace group',
    outboundTitle: 'Outbound (remote agents to call)',
    cardUrl: 'Agent Card URL',
    cardUrlCopy: 'Copy',
    cardUrlCopied: 'Copied',
    identityTitle: 'Agent Card identity (editable, live on save)',
    identityName: 'Name',
    identityDescription: 'Description',
    identitySave: 'Save identity',
    identitySaving: 'Saving…',
    identityReset: 'Reset to deployment default',
    tutorialTitle: 'How to use',
    tutorialStep1:
      'Call this agent: hand the address below to any A2A client to discover and call it (open it in a browser to inspect the card).',
    tutorialStep2:
      'Add a remote agent: in Outbound, "Add agent" → paste its Agent Card URL → "Test agent card" → once it passes you can "Adopt" the advertised name/description → Save (rows that never passed a test cannot be saved).',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: copy documents the ${ENV_VAR} header syntax
    tutorialStep3:
      'Saves are live: the registry hot-reloads the a2a_call / a2a_list tools with no restart. Header values may reference environment variables as ${ENV_VAR}.',
  },
}

function useCopy(): Dictionary {
  const ref = useRef<Dictionary | undefined>(undefined)
  if (ref.current === undefined) {
    const zh =
      typeof navigator === 'object' && (navigator.language ?? '').toLowerCase().startsWith('zh')
    ref.current = zh ? COPY.zh : COPY.en
  }
  return ref.current
}

const cssVars = {
  labelPrimary: 'var(--dsw-alias-label-primary, #1f2329)',
  labelSecondary: 'var(--dsw-alias-label-secondary, #646a73)',
  labelTertiary: 'var(--dsw-alias-label-tertiary, #8f959e)',
  labelDimmed: 'var(--dsw-alias-label-dimmed, #8f959e)',
  labelError: 'var(--dsw-alias-label-error, #d83931)',
  borderL1: 'var(--dsw-alias-border-l1, #dee0e3)',
  borderL2: 'var(--dsw-alias-border-l2, #dee0e3)',
  bgLayer2: 'var(--dsw-alias-bg-layer-2, #f5f6f7)',
  bgLayer3: 'var(--dsw-alias-bg-layer-3, #ffffff)',
  bgModulePlatform: 'var(--dsw-alias-bg-module-platform, #eef0f3)',
  brand: 'var(--dsw-alias-state-business-primary, #3370ff)',
}

function A2aCard(props: { scope: ScopeLike; remote?: RemoteLike }): ReactNode {
  const t = useCopy()
  const { scope, remote } = props
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
  )
  const stored = snapshot.value?.agents
  const [rows, setRows] = useState<DraftRow[]>(() => rowsFromAgents(stored))
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [open, setOpen] = useState(true)
  /** The row whose edit form is expanded; null = all rows show summaries. */
  const [editingRow, setEditingRow] = useState<number | null>(null)
  const seeded = useRef(stored)

  const { issues } = draftToAgents(rows)
  const issueFor = (row: number, field: 'name' | 'url' | 'headers'): string | undefined =>
    issues.find((issue) => issue.row === row && issue.field === field)?.message
  const dirty = isDirty(rows, stored)
  const overridden =
    snapshot.user !== undefined &&
    snapshot.user !== null &&
    typeof snapshot.user === 'object' &&
    'agents' in (snapshot.user as Record<string, unknown>)

  const edit = (id: number, patch: Partial<Omit<DraftRow, 'id'>>): void => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
    // A URL or header edit invalidates the row's verification; name/description
    // edits keep it (the probe hit the same endpoint).
    if (patch.url !== undefined || patch.headers !== undefined) setProbe(id, undefined)
    setSaveFailed(false)
  }
  const addRow = (): void => {
    const id = freshRowId()
    setRows((current) => [...current, { id, name: '', url: '', description: '', headers: [] }])
    setEditingRow(id)
    setSaveFailed(false)
  }
  const removeRow = (id: number): void => {
    setRows((current) => current.filter((row) => row.id !== id))
    setSaveFailed(false)
  }
  const addHeader = (rowId: number): void => {
    setRows((current) =>
      current.map((row) =>
        row.id === rowId
          ? { ...row, headers: [...row.headers, { id: freshHeaderId(), key: '', value: '' }] }
          : row,
      ),
    )
    setSaveFailed(false)
  }
  const editHeader = (
    rowId: number,
    headerId: number,
    patch: Partial<Omit<{ id: number; key: string; value: string }, 'id'>>,
  ): void => {
    setRows((current) =>
      current.map((row) =>
        row.id === rowId
          ? {
              ...row,
              headers: row.headers.map((h) => (h.id === headerId ? { ...h, ...patch } : h)),
            }
          : row,
      ),
    )
    setProbe(rowId, undefined)
    setSaveFailed(false)
  }
  const removeHeader = (rowId: number, headerId: number): void => {
    setRows((current) =>
      current.map((row) =>
        row.id === rowId ? { ...row, headers: row.headers.filter((h) => h.id !== headerId) } : row,
      ),
    )
    setSaveFailed(false)
  }
  /** Per-row verification state; a URL or header edit invalidates the row. */
  interface RowProbe {
    status: 'testing' | 'ok' | 'failed'
    url: string
    remoteName?: string
    remoteDescription?: string
    message?: string
  }
  const [probes, setProbes] = useState<ReadonlyMap<number, RowProbe>>(new Map())
  const inflight = useRef(new Set<number>())
  const setProbe = useCallback((rowId: number, probe: RowProbe | undefined): void => {
    setProbes((current) => {
      const next = new Map(current)
      if (probe === undefined) next.delete(rowId)
      else next.set(rowId, probe)
      return next
    })
  }, [])
  // Stable across renders on purpose (remote/t are stable): the seed effect
  // depends on it, so a probe landing must NOT re-trigger re-seeding.
  const runProbe = useCallback(
    async (row: DraftRow, silent: boolean): Promise<void> => {
      const url = row.url.trim()
      if (url.length === 0 || inflight.current.has(row.id)) return
      if (remote?.a2a === undefined) {
        // Auto-probes skip quietly while the Remote surface is still mounting;
        // a manual test reports the unavailability instead.
        if (!silent) {
          setProbe(row.id, { status: 'failed', url, message: t.remoteUnavailable })
        }
        return
      }
      inflight.current.add(row.id)
      setProbe(row.id, { status: 'testing', url })
      try {
        const headers: Record<string, string> = {}
        for (const pair of row.headers) {
          const key = pair.key.trim()
          if (key.length > 0) headers[key] = pair.value
        }
        const result = await remote.a2a.testAgentCard(url, headers)
        if (!result.ok) throw new Error(result.error?.message ?? t.testFailed)
        const card = result.value ?? {}
        setProbe(row.id, {
          status: 'ok',
          url,
          remoteName: card.name,
          remoteDescription: card.description,
        })
      } catch (error) {
        setProbe(row.id, {
          status: 'failed',
          url,
          message: error instanceof Error ? error.message : String(error),
        })
      } finally {
        inflight.current.delete(row.id)
      }
    },
    [remote, t, setProbe],
  )
  const adopt = (row: DraftRow, probe: RowProbe): void => {
    if (probe.remoteName !== undefined) edit(row.id, { name: probe.remoteName })
    if (probe.remoteDescription !== undefined)
      edit(row.id, { description: probe.remoteDescription })
  }
  /** Rows whose current URL has no successful probe yet; a save must wait. */
  const unverified = rows.filter((row) => {
    const url = row.url.trim()
    if (url.length === 0) return false
    const probe = probes.get(row.id)
    return probe === undefined || probe.url !== url || probe.status !== 'ok'
  })
  // Re-seed the draft when the namespace moves underneath and the card holds
  // no unsaved edits (an external write, a reset, or our own save landing).
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows is compared via the seeded ref on purpose — adding it to the deps would reseed on every draft edit and loop.
  useEffect(() => {
    if (isDirty(rows, seeded.current)) return
    seeded.current = stored
    const next = rowsFromAgents(stored)
    setRows(next)
    setEditingRow(null)
    // Auto-verify persisted rows so the tab opens with remote info already
    // shown and verified states established; failures just surface in-row.
    for (const row of next) {
      if (row.url.trim().length > 0) void runProbe(row, true)
    }
  }, [stored, runProbe])
  const discard = (): void => {
    seeded.current = stored
    setRows(rowsFromAgents(stored))
    setSaveFailed(false)
  }
  const save = async (): Promise<void> => {
    if (issues.length > 0 || !dirty || saving) return
    setSaving(true)
    try {
      const { agents } = draftToAgents(rows)
      await scope.set('agents', agents)
      seeded.current = agents
      setSaveFailed(false)
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }
  const reset = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      await scope.unset('agents')
      setSaveFailed(false)
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const fieldStyle: Record<string, string> = {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minWidth: 0,
    flex: '1 1 160px',
  }
  const labelStyle: Record<string, string> = {
    fontSize: '11px',
    fontWeight: 500,
    color: cssVars.labelSecondary,
  }
  const issueStyle: Record<string, string> = {
    margin: 0,
    fontSize: '12px',
    lineHeight: 1.5,
    color: cssVars.labelError,
  }
  const inputStyle: Record<string, string> = {
    boxSizing: 'border-box',
    width: '100%',
    font: 'inherit',
    fontSize: '13px',
    padding: '6px 8px',
    borderRadius: '6px',
    border: `1px solid ${cssVars.borderL1}`,
    background: 'transparent',
    color: cssVars.labelPrimary,
  }
  const disabled = !snapshot.writable || snapshot.status !== 'ready'

  return (
    <section
      style={{
        border: `1px solid ${cssVars.borderL2}`,
        background: cssVars.bgLayer3,
        borderRadius: '12px',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        style={{
          appearance: 'none',
          width: '100%',
          font: 'inherit',
          color: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          background: 'transparent',
          border: 0,
          borderRadius: '12px',
          alignItems: 'center',
          gap: '12px',
          padding: '14px 16px',
          display: 'flex',
        }}
      >
        <span
          style={{ flexDirection: 'column', flex: '1', gap: '4px', minWidth: 0, display: 'flex' }}
        >
          <span
            style={{
              color: cssVars.labelPrimary,
              fontSize: '15px',
              fontWeight: 600,
              lineHeight: 1.4,
            }}
          >
            {t.title}
          </span>
          <span style={{ color: cssVars.labelTertiary, fontSize: '13px', lineHeight: 1.5 }}>
            {t.description}
          </span>
        </span>
        {dirty ? (
          <span
            style={{
              whiteSpace: 'nowrap',
              background: cssVars.bgModulePlatform,
              color: cssVars.labelSecondary,
              borderRadius: '999px',
              flex: 'none',
              padding: '1px 8px',
              fontSize: '11px',
              fontWeight: 500,
              lineHeight: '17px',
            }}
          >
            {t.unsaved}
          </span>
        ) : null}
        <IconChevronDownOutline14
          style={{
            color: cssVars.labelTertiary,
            flex: 'none',
            transition: 'transform .16s',
            transform: open ? 'rotate(180deg)' : undefined,
          }}
        />
      </button>

      {open ? (
        <div
          style={{
            borderTop: `1px solid ${cssVars.borderL2}`,
            margin: '0 16px',
            paddingBottom: '12px',
          }}
        >
          {disabled ? (
            <p
              role="status"
              style={{
                color: cssVars.labelTertiary,
                margin: '12px 0 0',
                fontSize: '12px',
                lineHeight: 1.5,
              }}
            >
              {t.readonly}
            </p>
          ) : null}

          {rows.length === 0 ? (
            <p style={{ color: cssVars.labelTertiary, margin: '12px 0 0', fontSize: '13px' }}>
              {t.empty}
            </p>
          ) : null}

          {rows.map((row, index) => {
            const probe = probes.get(row.id)
            const rowShell = {
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              marginTop: index === 0 ? '4px' : '0',
              padding: '14px 0',
              borderTop: index === 0 ? undefined : `1px solid ${cssVars.borderL1}`,
            } as const

            // ---- Summary view: read-only row with badge + actions. ----
            if (editingRow !== row.id) {
              const badge =
                probe === undefined
                  ? { text: t.unverifiedBadge, color: cssVars.labelTertiary }
                  : probe.status === 'testing'
                    ? { text: t.testingBadge, color: cssVars.labelSecondary }
                    : probe.status === 'ok'
                      ? { text: t.verifiedBadge, color: cssVars.brand }
                      : { text: t.failedBadge, color: cssVars.labelError }
              const name = row.name.trim()
              const url = row.url.trim()
              const description = row.description.trim()
              const remoteLine =
                probe?.status === 'ok' &&
                (probe.remoteName !== undefined || probe.remoteDescription !== undefined)
                  ? `${probe.remoteName ?? t.remoteNoName}${probe.remoteDescription ? ` — ${probe.remoteDescription}` : ''}`
                  : null
              return (
                <div key={row.id} style={rowShell}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                    <span
                      style={{
                        flex: 'none',
                        marginTop: '1px',
                        fontSize: '11px',
                        fontWeight: 600,
                        lineHeight: '18px',
                        padding: '0 8px',
                        borderRadius: '999px',
                        background: cssVars.bgModulePlatform,
                        color: badge.color,
                      }}
                    >
                      {badge.text}
                    </span>
                    <div
                      style={{
                        flex: '1',
                        minWidth: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '3px',
                      }}
                    >
                      <span
                        style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          gap: '6px',
                          minWidth: 0,
                          fontSize: '13px',
                          fontWeight: 600,
                          color: cssVars.labelPrimary,
                        }}
                      >
                        <span
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {name.length > 0 ? name : t.unnamed}
                        </span>
                        {row.headers.length > 0 ? (
                          <span
                            style={{
                              flex: 'none',
                              fontSize: '11px',
                              fontWeight: 400,
                              color: cssVars.labelTertiary,
                            }}
                          >
                            {String(row.headers.length)} {t.headerCountUnit}
                          </span>
                        ) : null}
                      </span>
                      <code
                        title={url}
                        style={{
                          fontSize: '12px',
                          color: url.length > 0 ? cssVars.labelSecondary : cssVars.labelTertiary,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {url.length > 0 ? url : t.urlEmpty}
                      </code>
                      {description.length > 0 ? (
                        <p
                          style={{
                            margin: 0,
                            fontSize: '12px',
                            lineHeight: 1.5,
                            color: cssVars.labelTertiary,
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}
                        >
                          {description}
                        </p>
                      ) : null}
                      {remoteLine !== null ? (
                        <p
                          title={remoteLine}
                          style={{
                            margin: 0,
                            fontSize: '12px',
                            lineHeight: 1.5,
                            color: cssVars.brand,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {t.remoteBadge}：{remoteLine}
                        </p>
                      ) : null}
                      {probe?.status === 'failed' ? (
                        <p
                          style={{
                            margin: 0,
                            fontSize: '12px',
                            lineHeight: 1.5,
                            color: cssVars.labelError,
                          }}
                        >
                          {t.testFailed}：{probe.message}
                        </p>
                      ) : null}
                    </div>
                    <div
                      style={{ display: 'flex', gap: '6px', flex: 'none', alignItems: 'center' }}
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void runProbe(row, false)}
                        disabled={disabled || probe?.status === 'testing'}
                      >
                        {probe?.status === 'testing' ? t.testing : t.test}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditingRow(row.id)}
                        disabled={disabled}
                      >
                        {t.edit}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeRow(row.id)}
                        disabled={disabled}
                        style={{ color: cssVars.labelError }}
                      >
                        {t.remove}
                      </Button>
                    </div>
                  </div>
                </div>
              )
            }

            // ---- Edit view: the full form, with a Done affordance. ----
            return (
              <div
                key={row.id}
                style={{
                  ...rowShell,
                  padding: '14px 12px',
                  background: cssVars.bgLayer2,
                  borderRadius: '10px',
                  borderTop: undefined,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                  }}
                >
                  <span
                    style={{ fontSize: '12px', fontWeight: 600, color: cssVars.labelSecondary }}
                  >
                    {t.agentLabel} {index + 1}
                  </span>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditingRow(null)}
                      disabled={disabled}
                    >
                      {t.done}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeRow(row.id)}
                      disabled={disabled}
                      style={{ color: cssVars.labelError }}
                    >
                      {t.remove}
                    </Button>
                  </div>
                </div>

                <div
                  style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}
                >
                  <label style={fieldStyle}>
                    <span style={labelStyle}>{t.name}</span>
                    <input
                      style={inputStyle}
                      value={row.name}
                      placeholder={t.namePlaceholder}
                      disabled={disabled}
                      onChange={(event) => edit(row.id, { name: event.target.value })}
                    />
                    {issueFor(index, 'name') ? (
                      <span style={issueStyle}>
                        {t[issueFor(index, 'name') ?? ''] ?? issueFor(index, 'name')}
                      </span>
                    ) : null}
                  </label>
                  <label style={{ ...fieldStyle, flex: '2 1 260px' }}>
                    <span style={labelStyle}>{t.url}</span>
                    <input
                      style={inputStyle}
                      value={row.url}
                      placeholder={t.urlPlaceholder}
                      disabled={disabled}
                      onChange={(event) => edit(row.id, { url: event.target.value })}
                    />
                    {issueFor(index, 'url') ? (
                      <span style={issueStyle}>
                        {t[issueFor(index, 'url') ?? ''] ?? issueFor(index, 'url')}
                      </span>
                    ) : null}
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void runProbe(row, false)}
                    disabled={disabled || probes.get(row.id)?.status === 'testing'}
                  >
                    {probes.get(row.id)?.status === 'testing' ? t.testing : t.test}
                  </Button>
                </div>

                {(() => {
                  const inner = probes.get(row.id)
                  if (inner === undefined) {
                    return row.url.trim().length > 0 && !disabled ? (
                      <p
                        style={{
                          margin: 0,
                          fontSize: '12px',
                          lineHeight: 1.5,
                          color: cssVars.labelTertiary,
                        }}
                      >
                        {t.probeRequired}
                      </p>
                    ) : null
                  }
                  if (inner.status === 'testing') {
                    return (
                      <p
                        style={{
                          margin: 0,
                          fontSize: '12px',
                          lineHeight: 1.5,
                          color: cssVars.labelTertiary,
                        }}
                      >
                        {t.testing}
                      </p>
                    )
                  }
                  if (inner.status === 'failed') {
                    return (
                      <p
                        style={{
                          margin: 0,
                          fontSize: '12px',
                          lineHeight: 1.5,
                          color: cssVars.labelError,
                        }}
                      >
                        {t.testFailed}：{inner.message}
                      </p>
                    )
                  }
                  const hasRemote =
                    inner.remoteName !== undefined || inner.remoteDescription !== undefined
                  return (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                        padding: '10px 12px',
                        borderRadius: '8px',
                        background: cssVars.bgLayer3,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '8px',
                        }}
                      >
                        <span style={{ fontSize: '12px', fontWeight: 600, color: cssVars.brand }}>
                          ✓ {t.testOk}
                        </span>
                        {hasRemote ? (
                          <Button variant="ghost" size="sm" onClick={() => adopt(row, inner)}>
                            {t.adopt}
                          </Button>
                        ) : null}
                      </div>
                      {hasRemote ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <span
                            style={{
                              fontSize: '11px',
                              fontWeight: 500,
                              color: cssVars.labelSecondary,
                            }}
                          >
                            {t.remoteCard}
                          </span>
                          <p style={{ margin: 0, fontSize: '13px', color: cssVars.labelPrimary }}>
                            {inner.remoteName ?? t.remoteNoName}
                          </p>
                          {inner.remoteDescription !== undefined ? (
                            <p
                              style={{
                                margin: 0,
                                fontSize: '12px',
                                lineHeight: 1.5,
                                color: cssVars.labelTertiary,
                              }}
                            >
                              {inner.remoteDescription}
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <p style={{ margin: 0, fontSize: '12px', color: cssVars.labelTertiary }}>
                          {t.remoteEmpty}
                        </p>
                      )}
                    </div>
                  )
                })()}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <span style={labelStyle}>{t.headers}</span>
                  {row.headers.map((header) => (
                    <div
                      key={header.id}
                      style={{ display: 'flex', gap: '8px', alignItems: 'center' }}
                    >
                      <input
                        style={{ ...inputStyle, flex: '1 1 160px' }}
                        value={header.key}
                        placeholder={t.headerKey}
                        disabled={disabled}
                        onChange={(event) =>
                          editHeader(row.id, header.id, { key: event.target.value })
                        }
                      />
                      <input
                        style={{ ...inputStyle, flex: '1 1 220px' }}
                        value={header.value}
                        placeholder={t.headerValue}
                        disabled={disabled}
                        onChange={(event) =>
                          editHeader(row.id, header.id, { value: event.target.value })
                        }
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeHeader(row.id, header.id)}
                        disabled={disabled}
                        style={{ color: cssVars.labelError, flex: 'none' }}
                      >
                        {t.removeHeader}
                      </Button>
                    </div>
                  ))}
                  <div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => addHeader(row.id)}
                      disabled={disabled}
                    >
                      + {t.addHeader}
                    </Button>
                  </div>
                </div>
              </div>
            )
          })}

          <div style={{ marginTop: '12px' }}>
            <Button variant="outline" size="sm" onClick={addRow} disabled={disabled}>
              + {t.add}
            </Button>
          </div>

          <div
            style={{
              borderTop: `1px solid ${cssVars.borderL2}`,
              justifyContent: 'flex-end',
              alignItems: 'center',
              gap: '8px',
              padding: '12px 0 0',
              marginTop: '12px',
              display: 'flex',
            }}
          >
            {saveFailed ? (
              <p
                role="status"
                style={{
                  minWidth: 0,
                  color: cssVars.labelError,
                  flex: '1',
                  margin: 0,
                  fontSize: '12px',
                  lineHeight: 1.5,
                }}
              >
                {t.saveFailed}
              </p>
            ) : null}
            {unverified.length > 0 && !disabled ? (
              <p
                role="status"
                style={{
                  minWidth: 0,
                  color: cssVars.labelTertiary,
                  flex: '1',
                  margin: 0,
                  fontSize: '12px',
                  lineHeight: 1.5,
                }}
              >
                {t.probeBlocked}（{unverified.length}）
              </p>
            ) : null}
            {overridden && !disabled ? (
              <Button variant="ghost" size="sm" onClick={() => void reset()} disabled={saving}>
                {t.reset}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={discard}
              disabled={!dirty || saving || disabled}
            >
              {t.discard}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void save()}
              disabled={!dirty || issues.length > 0 || unverified.length > 0 || saving || disabled}
            >
              {saving ? t.saving : t.save}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}

/** The read-only inbound summary the Host projects (secrets reduced to booleans). */
interface ServerInfoValue {
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

/** Inbound panel: how this harness presents itself as an A2A agent. */
function ServerInfoPanel(props: { remote: RemoteLike; scope: ScopeLike }): ReactNode {
  const t = useCopy()
  const { remote, scope } = props
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
  )
  const [info, setInfo] = useState<ServerInfoValue | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [descDraft, setDescDraft] = useState<string | null>(null)
  const [savingIdentity, setSavingIdentity] = useState(false)
  const [editingIdentity, setEditingIdentity] = useState(false)
  const refreshServerInfo = useCallback(async (): Promise<void> => {
    try {
      const result = await remote.a2a?.serverInfo()
      if (result === undefined || !result.ok) {
        setFailed(true)
        return
      }
      setInfo(result.value ?? null)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [remote])
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot load on mount; the refresh button is the reload path and remote.a2a is a stable lazily-resolved facade.
  useEffect(() => {
    setLoading(true)
    setFailed(false)
    void refreshServerInfo()
  }, [])

  const valueStyle: Record<string, string> = {
    margin: 0,
    fontSize: '13px',
    color: cssVars.labelPrimary,
    wordBreak: 'break-all',
  }
  const itemStyle: Record<string, string> = { display: 'flex', flexDirection: 'column', gap: '2px' }
  const labelStyle2: Record<string, string> = {
    fontSize: '11px',
    fontWeight: 500,
    color: cssVars.labelSecondary,
  }
  const inputStyle2: Record<string, string> = {
    boxSizing: 'border-box',
    width: '100%',
    font: 'inherit',
    fontSize: '13px',
    padding: '5px 8px',
    borderRadius: '6px',
    border: `1px solid ${cssVars.borderL1}`,
    background: cssVars.bgLayer3,
    color: cssVars.labelPrimary,
  }
  const row = (label: string, value: ReactNode): ReactNode => (
    <div key={label} style={itemStyle}>
      <span style={labelStyle2}>{label}</span>
      <p style={valueStyle}>{value}</p>
    </div>
  )
  const currentCard = snapshot.value?.agentCard
  const cardBase =
    info !== null && info.enabled
      ? (info.publicUrl ?? `http://${info.host}:${String(info.port)}/`)
      : undefined
  const cardUrl =
    cardBase === undefined
      ? undefined
      : cardBase.endsWith('/')
        ? `${cardBase}.well-known/agent-card.json`
        : `${cardBase}/.well-known/agent-card.json`
  const copyCardUrl = (): void => {
    if (cardUrl === undefined || typeof navigator === 'undefined') return
    void navigator.clipboard.writeText(cardUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  const identityDirty = nameDraft !== null || descDraft !== null
  const saveIdentity = async (): Promise<void> => {
    if (savingIdentity) return
    setSavingIdentity(true)
    try {
      await scope.set('agentCard', {
        name: nameDraft ?? currentCard?.name ?? '',
        description: descDraft ?? currentCard?.description ?? '',
      })
      setNameDraft(null)
      setDescDraft(null)
      setEditingIdentity(false)
      setLoading(true)
      setFailed(false)
      await refreshServerInfo()
    } catch {
      /* keep drafts so the user can retry */
    } finally {
      setSavingIdentity(false)
    }
  }
  const resetIdentity = async (): Promise<void> => {
    if (savingIdentity) return
    setSavingIdentity(true)
    try {
      await scope.unset('agentCard')
      setNameDraft(null)
      setDescDraft(null)
      setEditingIdentity(false)
      setLoading(true)
      setFailed(false)
      await refreshServerInfo()
    } catch {
      /* keep drafts so the user can retry */
    } finally {
      setSavingIdentity(false)
    }
  }
  const writable = snapshot.writable && snapshot.status === 'ready'

  return (
    <section
      style={{
        border: `1px solid ${cssVars.borderL1}`,
        borderRadius: '10px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: cssVars.labelPrimary }}>
          {t.inboundTitle}
        </h3>
        <span style={{ flex: '1' }} />
        <TutorialPopover cardUrl={cardUrl} />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setLoading(true)
            setFailed(false)
            void refreshServerInfo()
          }}
        >
          {t.inboundRefresh}
        </Button>
      </header>
      {loading ? (
        <p style={{ margin: 0, fontSize: '13px', color: cssVars.labelTertiary }}>
          {t.inboundLoading}
        </p>
      ) : null}
      {!loading && failed ? (
        <p style={{ margin: 0, fontSize: '13px', color: cssVars.labelError }}>
          {t.inboundUnavailable}
        </p>
      ) : null}
      {!loading && !failed && info !== null ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '12px',
            }}
          >
            {row(
              t.inboundStatus,
              info.enabled ? `${t.inboundOn} · ${info.host}:${String(info.port)}` : t.inboundOff,
            )}
            {row(t.inboundListen, `${info.host}:${String(info.port)}`)}
            {row(t.inboundPublicUrl, info.publicUrl ?? `http://${info.host}:${String(info.port)}/`)}
            {row(t.inboundAuth, info.apiKeySet ? t.inboundAuthOn : t.inboundAuthOff)}
            {row(
              t.inboundModel,
              info.provider !== undefined && info.model !== undefined
                ? `${info.provider} / ${info.model}`
                : t.inboundModelDefault,
            )}
            {row(t.inboundPreset, info.preset)}
            {row(t.inboundWorkspace, info.workspaceTitle)}
          </div>
          {cardUrl !== undefined ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
              <span style={{ ...labelStyle2, flex: 'none' }}>{t.cardUrl}</span>
              <code
                style={{
                  minWidth: 0,
                  flex: '1',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: '12px',
                  color: cssVars.labelSecondary,
                }}
                title={cardUrl}
              >
                {cardUrl}
              </code>
              <Button variant="ghost" size="sm" onClick={copyCardUrl}>
                {copied ? t.cardUrlCopied : t.cardUrlCopy}
              </Button>
            </div>
          ) : null}
          {writable ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                borderTop: `1px solid ${cssVars.borderL2}`,
                paddingTop: '12px',
              }}
            >
              {editingIdentity ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                    }}
                  >
                    <span
                      style={{ fontSize: '12px', fontWeight: 600, color: cssVars.labelPrimary }}
                    >
                      {t.identityTitle}
                    </span>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      {snapshot.user !== undefined &&
                      snapshot.user !== null &&
                      typeof snapshot.user === 'object' &&
                      'agentCard' in (snapshot.user as Record<string, unknown>) ? (
                        <Button variant="ghost" size="sm" onClick={() => void resetIdentity()}>
                          {t.identityReset}
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setNameDraft(null)
                          setDescDraft(null)
                          setEditingIdentity(false)
                        }}
                      >
                        {t.discard}
                      </Button>
                    </div>
                  </div>
                  <label style={itemStyle}>
                    <span style={labelStyle2}>{t.identityName}</span>
                    <input
                      style={inputStyle2}
                      value={nameDraft ?? currentCard?.name ?? ''}
                      placeholder={t.identityName}
                      onChange={(event) => setNameDraft(event.target.value)}
                    />
                  </label>
                  <label style={itemStyle}>
                    <span style={labelStyle2}>{t.identityDescription}</span>
                    <input
                      style={inputStyle2}
                      value={descDraft ?? currentCard?.description ?? ''}
                      placeholder={t.identityDescription}
                      onChange={(event) => setDescDraft(event.target.value)}
                    />
                  </label>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void saveIdentity()}
                      disabled={!identityDirty || savingIdentity}
                    >
                      {savingIdentity ? t.identitySaving : t.identitySave}
                    </Button>
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                    borderTop: `1px solid ${cssVars.borderL2}`,
                    paddingTop: '12px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                    }}
                  >
                    <span
                      style={{ fontSize: '12px', fontWeight: 600, color: cssVars.labelPrimary }}
                    >
                      {t.inboundIdentity}
                      {info.agentCard.version ? (
                        <span
                          style={{
                            marginLeft: '6px',
                            fontWeight: 400,
                            fontSize: '11px',
                            color: cssVars.labelTertiary,
                          }}
                        >
                          v{info.agentCard.version}
                        </span>
                      ) : null}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => setEditingIdentity(true)}>
                      {t.identityEdit}
                    </Button>
                  </div>
                  <p style={{ margin: 0, fontSize: '13px', color: cssVars.labelPrimary }}>
                    {currentCard?.name ?? info.agentCard.name}
                  </p>
                  {(currentCard?.description ?? info.agentCard.description).length > 0 ? (
                    <p
                      style={{
                        margin: 0,
                        fontSize: '12px',
                        lineHeight: 1.5,
                        color: cssVars.labelTertiary,
                      }}
                    >
                      {currentCard?.description ?? info.agentCard.description}
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

/** Hover-pop how-to, anchored to a question icon in the inbound header. */
function TutorialPopover(props: { cardUrl?: string }): ReactNode {
  const t = useCopy()
  const { cardUrl } = props
  const [open, setOpen] = useState(false)
  const step = (text: string): ReactNode => (
    <li style={{ margin: 0, fontSize: '12px', lineHeight: 1.6, color: cssVars.labelSecondary }}>
      {text}
    </li>
  )
  return (
    <div style={{ position: 'relative', flex: 'none' }}>
      <button
        type="button"
        aria-label={t.tutorialTitle}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        style={{
          appearance: 'none',
          font: 'inherit',
          cursor: 'pointer',
          background: 'transparent',
          border: 0,
          padding: '2px',
          borderRadius: '6px',
          display: 'flex',
          alignItems: 'center',
          color: open ? cssVars.labelPrimary : cssVars.labelTertiary,
        }}
      >
        <IconQuestionOutline14 style={{ display: 'block' }} />
      </button>
      {open ? (
        <div
          role="tooltip"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            width: 'min(380px, 86vw)',
            zIndex: 20,
            background: cssVars.bgLayer3,
            border: `1px solid ${cssVars.borderL1}`,
            borderRadius: '10px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <span style={{ fontSize: '12px', fontWeight: 600, color: cssVars.labelPrimary }}>
            {t.tutorialTitle}
          </span>
          <ol
            style={{
              margin: 0,
              paddingLeft: '18px',
              display: 'flex',
              flexDirection: 'column',
              gap: '5px',
            }}
          >
            {step(t.tutorialStep1)}
            {step(t.tutorialStep2)}
            {step(t.tutorialStep3)}
          </ol>
          {cardUrl !== undefined ? (
            <code
              style={{
                fontSize: '11px',
                color: cssVars.labelSecondary,
                background: cssVars.bgLayer2,
                borderRadius: '6px',
                padding: '4px 8px',
                wordBreak: 'break-all',
              }}
            >
              {cardUrl}
            </code>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** The whole A2A settings tab: inbound summary on top, outbound registry below. */
function A2aSection(props: { scope: ScopeLike; remote: RemoteLike }): ReactNode {
  const t = useCopy()
  return (
    <section
      style={{
        maxWidth: '760px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        padding: '8px 0',
      }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: cssVars.labelPrimary }}>
          {t.tabTitle}
        </h2>
        <p style={{ margin: 0, fontSize: '13px', color: cssVars.labelTertiary }}>{t.tabIntro}</p>
      </header>
      <ServerInfoPanel remote={props.remote} scope={props.scope} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: cssVars.labelPrimary }}>
          {t.outboundTitle}
        </h3>
        <A2aCard scope={props.scope} remote={props.remote} />
      </div>
    </section>
  )
}

/** Mount the A2A settings tab when the slots and settings services exist. */
export function apply(ctx: unknown): void {
  const c = ctx as {
    get(service: string): unknown
    effect(fn: () => () => void, tag?: string): unknown
    remote: RemoteLike & { $mount(contribution: unknown): Promise<() => void> }
  }
  const slots = c.get('slots') as SlotsSurface | undefined
  const binder = c.get('settingsScope') as
    | { bind(spec: { namespace: string }): ScopeLike }
    | undefined
  if (slots === undefined || binder === undefined) return
  const scope = binder.bind({ namespace: NAMESPACE })
  const remote = c.remote
  c.effect(() => {
    const state = { dispose: (): void => {} }
    void remote.$mount(TYPERT_REMOTE).then((d) => {
      state.dispose = d
    })
    return () => state.dispose()
  })
  // `remote.a2a` only exists once the $mount above lands, and property access
  // on the traced Remote facade throws without a static inject — so the card
  // receives a facade that resolves the namespace lazily at click time.
  const cardRemote: RemoteLike = {
    get a2a() {
      return c.get('remote.a2a') as RemoteLike['a2a']
    },
  }
  slots.inject('settings.section', () =>
    slots.register({ name: 'settings.section', id: 'a2a', order: 900, label: 'A2A' }, () => (
      <A2aSection scope={scope} remote={cardRemote} />
    )),
  )
}
