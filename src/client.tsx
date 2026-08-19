/**
 * Client half of dsh-a2a: the A2A card inside the Plugins settings section.
 *
 * The card claims the `a2a` settings namespace (keyed `settings.plugin.item`
 * registration) and edits its one field — the `agents` registry — as staged
 * rows: add / edit / remove entries, then one save writes the whole array
 * through the client settings scope. A save lands on the Host, the namespace
 * watch fires, and the running `a2a_call` / `a2a_list` tools hot-reload — no
 * restart. The card carries its own bilingual copy so it renders identically
 * regardless of which locale services this deployment composes.
 *
 * @module dsh-a2a/client
 */

import { Button, IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react'
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

/** The slice of the client settings scope contract this card consumes. */
interface ScopeLike {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value: { agents?: StoredAgent[] } | undefined
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
  register(options: { name: string; key?: string }, render: () => ReactNode): unknown
}

/** The slice of the client Remote surface this card consumes. */
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
  const seeded = useRef(stored)

  // Re-seed the draft when the namespace moves underneath and the card holds
  // no unsaved edits (an external write, a reset, or our own save landing).
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows is compared via the seeded ref on purpose — adding it to the deps would reseed on every draft edit and loop.
  useEffect(() => {
    if (isDirty(rows, seeded.current)) return
    seeded.current = stored
    setRows(rowsFromAgents(stored))
  }, [stored])

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
    setSaveFailed(false)
  }
  const addRow = (): void => {
    setRows((current) => [
      ...current,
      { id: freshRowId(), name: '', url: '', description: '', headers: [] },
    ])
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
  const [testing, setTesting] = useState<number | null>(null)
  const [probe, setProbe] = useState<{ rowId: number; ok: boolean; message: string } | null>(null)
  const testAgent = async (row: DraftRow): Promise<void> => {
    if (testing !== null) return
    if (remote?.a2a === undefined) {
      setProbe({ rowId: row.id, ok: false, message: t.remoteUnavailable })
      return
    }
    setTesting(row.id)
    setProbe(null)
    try {
      const headers: Record<string, string> = {}
      for (const pair of row.headers) {
        const key = pair.key.trim()
        if (key.length > 0) headers[key] = pair.value
      }
      const result = await remote.a2a.testAgentCard(row.url, headers)
      if (!result.ok) throw new Error(result.error?.message ?? t.testFailed)
      const card = result.value ?? {}
      setProbe({ rowId: row.id, ok: true, message: card.name ?? card.description ?? t.testOk })
      if (card.name !== undefined && row.name.trim() === '') edit(row.id, { name: card.name })
      if (card.description !== undefined) edit(row.id, { description: card.description })
    } catch (error) {
      setProbe({
        rowId: row.id,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setTesting(null)
    }
  }
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

          {rows.map((row, index) => (
            <div
              key={row.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                marginTop: index === 0 ? '4px' : '0',
                padding: '14px 0',
                borderTop: index === 0 ? undefined : `1px solid ${cssVars.borderL1}`,
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
                <span style={{ fontSize: '12px', fontWeight: 600, color: cssVars.labelSecondary }}>
                  {t.agentLabel} {index + 1}
                </span>
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
                  onClick={() => void testAgent(row)}
                  disabled={disabled || testing !== null}
                >
                  {testing === row.id ? t.testing : t.test}
                </Button>
              </div>

              {probe !== null && probe.rowId === row.id ? (
                <p
                  role="status"
                  style={{
                    margin: 0,
                    fontSize: '12px',
                    lineHeight: 1.5,
                    color: probe.ok ? cssVars.brand : cssVars.labelError,
                  }}
                >
                  {probe.message}
                </p>
              ) : null}

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
          ))}

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
              disabled={!dirty || issues.length > 0 || saving || disabled}
            >
              {saving ? t.saving : t.save}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}

/** Mount the A2A card into the Plugins section when the slots and settings services exist. */
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
  slots.inject('settings.plugin.item', () =>
    slots.register({ name: 'settings.plugin.item', key: NAMESPACE }, () => (
      <A2aCard scope={scope} remote={cardRemote} />
    )),
  )
}
