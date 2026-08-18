import { describe, expect, it } from 'vitest'
import { draftToAgents, isDirty, rowsFromAgents } from '../src/card-state.js'
import { normalizeAgents } from '../src/config.js'
import { A2aRegistry } from '../src/tools.js'

describe('card-state round trip', () => {
  it('projects stored agents into rows and back', () => {
    const stored = [
      {
        name: 'a',
        url: 'https://a.example.com/',
        description: 'first',
        headers: { authorization: 'Bearer x' },
      },
      { name: 'b', url: 'http://b.example.com/' },
    ]
    const rows = rowsFromAgents(stored)
    expect(rows.map(({ name, url }) => ({ name, url }))).toEqual([
      { name: 'a', url: 'https://a.example.com/' },
      { name: 'b', url: 'http://b.example.com/' },
    ])
    const { agents, issues } = draftToAgents(rows)
    expect(issues).toEqual([])
    expect(agents).toEqual([
      stored[0],
      { name: 'b', url: 'http://b.example.com/', description: '' },
    ])
  })

  it('reports row-level issues instead of throwing', () => {
    const rows = rowsFromAgents(undefined)
    rows.push({
      id: rows.length + 1,
      name: '',
      url: 'nope',
      description: '',
      headersText: 'bad line',
    })
    const { agents, issues } = draftToAgents(rows)
    expect(agents).toEqual([])
    expect(issues.map(({ field }) => field)).toContain('name')
    expect(issues.map(({ field }) => field)).toContain('url')
    expect(issues.map(({ field }) => field)).toContain('headers')
  })

  it('flags duplicate names and drops empty rows', () => {
    const rows = [
      { id: 1, name: 'x', url: 'https://x/', description: '', headersText: '' },
      { id: 2, name: 'x', url: 'https://y/', description: '', headersText: '' },
      { id: 3, name: '', url: '', description: '', headersText: '' },
    ]
    const { agents, issues } = draftToAgents(rows)
    expect(agents).toEqual([{ name: 'x', url: 'https://x/', description: '' }])
    expect(issues.some(({ message }) => message === 'nameDuplicate')).toBe(true)
    expect(issues.some(({ message }) => message === 'nameRequired')).toBe(true)
  })

  it('tracks dirtiness against the stored value', () => {
    const stored = [{ name: 'a', url: 'https://a/' }]
    expect(isDirty(rowsFromAgents(stored), stored)).toBe(false)
    const edited = rowsFromAgents(stored)
    const first = edited[0]
    if (first !== undefined) first.description = 'changed'
    expect(isDirty(edited, stored)).toBe(true)
    expect(isDirty(rowsFromAgents(undefined), undefined)).toBe(false)
  })
})

describe('normalizeAgents (settings-fed registries)', () => {
  it('keeps valid rows and drops invalid ones', () => {
    const { agents, rejected } = normalizeAgents([
      { name: ' ok ', url: 'https://ok.example.com/', headers: { a: 'b', c: 1 } },
      { name: '', url: 'https://x/' },
      { name: 'bad', url: 'ftp://x/' },
      'nonsense',
    ])
    expect(agents).toEqual([
      { name: 'ok', url: 'https://ok.example.com/', headers: { a: 'b' }, description: '' },
    ])
    expect(rejected).toBe(3)
  })
})

describe('A2aRegistry.update', () => {
  it('hot-swaps the registry contents', () => {
    const registry = new A2aRegistry([
      { name: 'a', url: 'https://a/', headers: {}, description: '' },
    ])
    expect(registry.get('a')).toBeDefined()
    registry.update([{ name: 'b', url: 'https://b/', headers: {}, description: '' }])
    expect(registry.get('a')).toBeUndefined()
    expect(registry.list().map((entry) => entry.name)).toEqual(['b'])
  })
})
