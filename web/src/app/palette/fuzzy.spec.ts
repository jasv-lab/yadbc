import { describe, expect, it } from 'vitest'
import { fuzzyMatch, highlight } from './fuzzy'

const rank = (query: string, items: string[]) =>
  items
    .map((text) => ({ text, m: fuzzyMatch(query, text) }))
    .filter((x) => x.m)
    .sort((a, b) => b.m!.score - a.m!.score)
    .map((x) => x.text)

describe('fuzzyMatch', () => {
  it('matches subsequences case-insensitively and rejects out-of-order', () => {
    expect(fuzzyMatch('usr', 'users')).not.toBeNull()
    expect(fuzzyMatch('USR', 'users')).not.toBeNull()
    expect(fuzzyMatch('rsu', 'users')).toBeNull()
  })

  it('prefers substrings, then word starts, then scattered hits', () => {
    expect(rank('inv', ['active_users', 'billing_invoice_lines', 'invoices', 'i_n_v'])).toEqual([
      'invoices',
      'billing_invoice_lines',
      'i_n_v',
    ])
    expect(rank('ua', ['users_audit', 'unusual', 'quartz'])[0]).toBe('users_audit')
  })

  it('ranks commands sensibly', () => {
    expect(rank('expl', ['Explain', 'Explain analyze (runs it, rolled back)', 'Export options'])).toEqual([
      'Explain',
      'Explain analyze (runs it, rolled back)',
    ])
    expect(rank('tog side', ['Toggle sidebar', 'Toggle drawer', 'Toggle results'])[0]).toBe('Toggle sidebar')
  })

  it('returns highlight positions', () => {
    expect(fuzzyMatch('us', 'billing_users')!.positions).toEqual([8, 9])
    expect(highlight('users', [0, 1])).toEqual([
      { text: 'us', hit: true },
      { text: 'ers', hit: false },
    ])
  })
})
