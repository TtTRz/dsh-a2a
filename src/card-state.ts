/**
 * Pure draft-state helpers for the A2A settings card: converting the
 * namespace section into editable rows and a staged draft back into the
 * `agents` array a save writes. Kept free of React so the round trip is
 * unit-testable in Node.
 *
 * @module dsh-a2a/card-state
 */

/** One editable registry row in the card's draft state. */
export interface DraftRow {
  /** Stable per-card identity (not persisted); keyed React list identity. */
  id: number
  name: string
  url: string
  description: string
  /** Header lines as typed, one `Name: Value` per line. */
  headersText: string
}

/** A row-level problem keyed by field, as the card renders it. */
export interface RowIssue {
  row: number
  field: 'name' | 'url' | 'headers'
  message: string
}

let nextRowId = 1

/** Allocate the next stable row id. */
export function freshRowId(): number {
  const id = nextRowId
  nextRowId += 1
  return id
}

/** One stored agent entry (the slice of the section the card edits). */
export interface StoredAgent {
  name: string
  url: string
  description?: string
  headers?: Record<string, string>
}

function headersToText(headers: Record<string, string> | undefined): string {
  if (headers === undefined) return ''
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}

/** Project the namespace section's agent list into editable rows. */
export function rowsFromAgents(agents: readonly StoredAgent[] | undefined): DraftRow[] {
  return (agents ?? []).map((agent) => ({
    id: freshRowId(),
    name: agent.name,
    url: agent.url,
    description: agent.description ?? '',
    headersText: headersToText(agent.headers),
  }))
}

/** Parse `Name: Value` lines into a header record; throws on a malformed line. */
function parseHeaders(text: string, row: number, issues: RowIssue[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const separator = line.indexOf(':')
    if (separator <= 0) {
      issues.push({ row, field: 'headers', message: 'headerLine' })
      continue
    }
    headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return headers
}

/**
 * Validate a draft and build the value a save would write. Rows with an
 * empty name or a non-http(s) URL contribute issues instead of blocking the
 * whole save: the card marks them and refuses to write until fixed.
 */
export function draftToAgents(draft: readonly DraftRow[]): {
  agents: StoredAgent[]
  issues: RowIssue[]
} {
  const issues: RowIssue[] = []
  const agents: StoredAgent[] = []
  const seen = new Set<string>()
  draft.forEach((row, index) => {
    const name = row.name.trim()
    // Collect every issue the row has, so the card marks all its fields at
    // once instead of fixing them one save at a time.
    const rowIssues: RowIssue[] = []
    if (name.length === 0) rowIssues.push({ row: index, field: 'name', message: 'nameRequired' })
    else if (seen.has(name)) rowIssues.push({ row: index, field: 'name', message: 'nameDuplicate' })
    let urlOk = true
    try {
      const parsed = new URL(row.url.trim())
      urlOk = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
      urlOk = false
    }
    if (!urlOk) rowIssues.push({ row: index, field: 'url', message: 'urlInvalid' })
    const headers = parseHeaders(row.headersText, index, rowIssues)
    issues.push(...rowIssues)
    if (rowIssues.length > 0) return
    seen.add(name)
    const agent: StoredAgent = { name, url: row.url.trim(), description: row.description.trim() }
    if (Object.keys(headers).length > 0) agent.headers = headers
    agents.push(agent)
  })
  return { agents, issues }
}

/** Whether a draft differs from the section value it was seeded from. */
export function isDirty(
  draft: readonly DraftRow[],
  stored: readonly StoredAgent[] | undefined,
): boolean {
  const { agents } = draftToAgents(draft)
  const current = stored ?? []
  if (agents.length !== current.length) return true
  return agents.some((agent, index) => {
    const other = current[index]
    if (other === undefined) return true
    if (agent.name !== other.name || agent.url !== other.url) return true
    if ((agent.description ?? '') !== (other.description ?? '')) return true
    const left = agent.headers ?? {}
    const right = other.headers ?? {}
    const leftKeys = Object.keys(left)
    if (leftKeys.length !== Object.keys(right).length) return true
    return leftKeys.some((key) => left[key] !== right[key])
  })
}
