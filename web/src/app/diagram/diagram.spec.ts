import { describe, expect, it } from 'vitest'
import { DiagramTable, roundedPath, visibleRows } from './diagram'

const col = (name: string, over: { pk?: boolean; fk?: boolean } = {}) => ({
  name,
  type: 'text',
  notNull: false,
  primaryKey: !!over.pk,
  foreignKey: !!over.fk,
})

const table = (columns: ReturnType<typeof col>[], external = false): DiagramTable => ({
  id: 'public.t',
  schema: 'public',
  name: 't',
  estRows: 0,
  comment: null,
  external,
  columns,
})

describe('visibleRows', () => {
  const wide = table([
    col('id', { pk: true }),
    ...Array.from({ length: 20 }, (_, i) => col(`c${i}`)),
    col('owner_id', { fk: true }),
  ])

  it('keeps every key column and caps the rest', () => {
    const { rows, more } = visibleRows(wide, false)
    expect(rows.length).toBe(13)
    expect(rows.map((r) => r.name)).toContain('owner_id')
    expect(more).toBe(22 - 13)
  })

  it('shows only keys in keys-only mode and for external tables', () => {
    expect(visibleRows(wide, true).rows.map((r) => r.name)).toEqual(['id', 'owner_id'])
    expect(visibleRows({ ...wide, external: true }, false).rows.length).toBe(2)
  })

  it('shows small tables whole', () => {
    expect(visibleRows(table([col('a'), col('b')]), false)).toEqual({
      rows: [
        { name: 'a', type: 'text', pk: false, fk: false, notNull: false },
        { name: 'b', type: 'text', pk: false, fk: false, notNull: false },
      ],
      more: 0,
    })
  })
})

describe('roundedPath', () => {
  it('rounds bends and leaves straight lines alone', () => {
    expect(
      roundedPath([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toBe('M0,0 L10,0')
    expect(
      roundedPath([
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 40 },
      ]),
    ).toBe('M0,0 L32,0 Q40,0 40,8 L40,40')
  })

  it('shrinks the radius on short segments', () => {
    expect(
      roundedPath([
        { x: 0, y: 0 },
        { x: 6, y: 0 },
        { x: 6, y: 40 },
      ]),
    ).toBe('M0,0 L3,0 Q6,0 6,3 L6,40')
  })
})
