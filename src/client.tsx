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

import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  type DraftRow,
  draftToAgents,
  freshRowId,
  isDirty,
  rowsFromAgents,
  type StoredAgent,
} from './card-state.js'

/** The settings namespace this card claims; must match the Host registration. */
const NAMESPACE = 'a2a'

export const name = 'dsh-a2a-client'
export const inject = ['slots', 'settingsScope']

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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: copy documents the ${ENV_VAR} header syntax
    headers: '请求头（每行 Name: Value，值可用 ${ENV_VAR}）',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: copy documents the ${ENV_VAR} header syntax
    headersPlaceholder: 'authorization: Bearer ${TOKEN}',
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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: copy documents the ${ENV_VAR} header syntax
    headers: 'Headers (one Name: Value per line; values may use ${ENV_VAR})',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: copy documents the ${ENV_VAR} header syntax
    headersPlaceholder: 'authorization: Bearer ${TOKEN}',
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
  border: 'var(--dsw-alias-border, #dee0e3)',
  fillSecondary: 'var(--dsw-alias-fill-secondary, #f5f6f7)',
  brand: 'var(--dsw-alias-state-business-primary, #3370ff)',
  danger: '#d83931',
}

function A2aCard(props: { scope: ScopeLike }): ReactNode {
  const t = useCopy()
  const { scope } = props
  const snapshot = useSyncExternalStore(scope.subscribe, scope.getSnapshot)
  const stored = snapshot.value?.agents
  const [rows, setRows] = useState<DraftRow[]>(() => rowsFromAgents(stored))
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const seeded = useRef(stored)

  // Re-seed the draft when the namespace moves underneath and the card holds
  // no unsaved edits (an external write, a reset, or our own save landing).
  useEffect(() => {
    if (isDirty(rows, seeded.current)) return
    seeded.current = stored
    setRows(rowsFromAgents(stored))
  }, [stored, rows])

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
      { id: freshRowId(), name: '', url: '', description: '', headersText: '' },
    ])
    setSaveFailed(false)
  }
  const removeRow = (id: number): void => {
    setRows((current) => current.filter((row) => row.id !== id))
    setSaveFailed(false)
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

  const inputStyle: Record<string, string> = {
    boxSizing: 'border-box',
    width: '100%',
    font: 'inherit',
    fontSize: '13px',
    padding: '5px 8px',
    borderRadius: '6px',
    border: `1px solid ${cssVars.border}`,
    background: 'transparent',
    color: cssVars.labelPrimary,
  }
  const fieldStyle: Record<string, string> = {
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    minWidth: 0,
    flex: '1 1 160px',
  }
  const labelStyle: Record<string, string> = {
    fontSize: '12px',
    color: cssVars.labelSecondary,
  }
  const issueStyle: Record<string, string> = {
    fontSize: '12px',
    color: cssVars.danger,
  }
  const ghostButton: Record<string, string> = {
    font: 'inherit',
    fontSize: '13px',
    cursor: 'pointer',
    background: 'transparent',
    border: `1px solid ${cssVars.border}`,
    borderRadius: '6px',
    padding: '4px 10px',
    color: cssVars.labelSecondary,
  }
  const disabled = !snapshot.writable || snapshot.status !== 'ready'

  return (
    <section
      style={{
        border: `1px solid ${cssVars.border}`,
        borderRadius: '10px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: cssVars.labelPrimary }}>
          {t.title}
        </h3>
        {overridden ? (
          <span style={{ fontSize: '12px', color: cssVars.labelTertiary }}>{t.overridden}</span>
        ) : null}
        {dirty ? <span style={{ fontSize: '12px', color: cssVars.brand }}>{t.unsaved}</span> : null}
        <span style={{ flex: '1' }} />
        {overridden && !disabled ? (
          <button type="button" style={ghostButton} onClick={() => void reset()} disabled={saving}>
            {t.reset}
          </button>
        ) : null}
        {dirty && !disabled ? (
          <button type="button" style={ghostButton} onClick={discard} disabled={saving}>
            {t.discard}
          </button>
        ) : null}
        <button
          type="button"
          style={{
            ...ghostButton,
            color: cssVars.brand,
            borderColor: cssVars.brand,
            opacity: dirty && issues.length === 0 && !disabled ? '1' : '0.5',
          }}
          onClick={() => void save()}
          disabled={disabled || saving || !dirty || issues.length > 0}
        >
          {saving ? t.saving : t.save}
        </button>
      </header>
      <p style={{ margin: 0, fontSize: '13px', color: cssVars.labelTertiary }}>{t.description}</p>
      {disabled ? (
        <p style={{ margin: 0, fontSize: '13px', color: cssVars.danger }}>{t.readonly}</p>
      ) : null}
      {saveFailed ? (
        <p style={{ margin: 0, fontSize: '13px', color: cssVars.danger }}>{t.readonly}</p>
      ) : null}
      {rows.length === 0 ? (
        <p style={{ margin: 0, fontSize: '13px', color: cssVars.labelTertiary }}>{t.empty}</p>
      ) : null}
      {rows.map((row, index) => (
        <div
          key={row.id}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            padding: '10px',
            borderRadius: '8px',
            background: cssVars.fillSecondary,
          }}
        >
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <label style={fieldStyle}>
              <span style={labelStyle}>{t.name}</span>
              <input
                style={inputStyle}
                value={row.name}
                placeholder={t.namePlaceholder}
                disabled={disabled}
                onInput={(event) =>
                  edit(row.id, { name: (event.target as HTMLInputElement).value })
                }
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
                onInput={(event) => edit(row.id, { url: (event.target as HTMLInputElement).value })}
              />
              {issueFor(index, 'url') ? (
                <span style={issueStyle}>
                  {t[issueFor(index, 'url') ?? ''] ?? issueFor(index, 'url')}
                </span>
              ) : null}
            </label>
          </div>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t.desc}</span>
            <input
              style={inputStyle}
              value={row.description}
              placeholder={t.descPlaceholder}
              disabled={disabled}
              onInput={(event) =>
                edit(row.id, { description: (event.target as HTMLInputElement).value })
              }
            />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t.headers}</span>
            <textarea
              style={{
                ...inputStyle,
                resize: 'vertical',
                minHeight: '34px',
                fontFamily: 'inherit',
              }}
              value={row.headersText}
              placeholder={t.headersPlaceholder}
              disabled={disabled}
              rows={Math.max(1, row.headersText.split('\n').length)}
              onInput={(event) =>
                edit(row.id, { headersText: (event.target as HTMLTextAreaElement).value })
              }
            />
            {issueFor(index, 'headers') ? (
              <span style={issueStyle}>
                {t[issueFor(index, 'headers') ?? ''] ?? issueFor(index, 'headers')}
              </span>
            ) : null}
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              style={{ ...ghostButton, color: cssVars.danger }}
              onClick={() => removeRow(row.id)}
              disabled={disabled}
            >
              {t.remove}
            </button>
          </div>
        </div>
      ))}
      <div>
        <button type="button" style={ghostButton} onClick={addRow} disabled={disabled}>
          + {t.add}
        </button>
      </div>
    </section>
  )
}

/** Mount the A2A card into the Plugins section when the slots and settings services exist. */
export function apply(ctx: unknown): void {
  const c = ctx as {
    get(service: string): unknown
    effect(fn: () => () => void, tag?: string): unknown
  }
  const slots = c.get('slots') as SlotsSurface | undefined
  const binder = c.get('settingsScope') as
    | { bind(spec: { namespace: string }): ScopeLike }
    | undefined
  if (slots === undefined || binder === undefined) return
  const scope = binder.bind({ namespace: NAMESPACE })
  slots.inject('settings.plugin.item', () =>
    slots.register({ name: 'settings.plugin.item', key: NAMESPACE }, () => (
      <A2aCard scope={scope} />
    )),
  )
}
