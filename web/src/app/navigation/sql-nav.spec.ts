import { describe, expect, it } from 'vitest'
import { freshAlias, goToSql, joinSql, JoinRequest, literal, tokenize } from './sql-nav'

const users = { schema: 'public', name: 'users' }
const invoices = { schema: 'public', name: 'invoices' }
const req = (sql: string, over: Partial<JoinRequest> = {}): JoinRequest => ({
  sql,
  from: { table: invoices, column: 'user_id', resultColumn: 'user_id' },
  to: { table: users, column: 'id' },
  ...over,
})

describe('goToSql', () => {
  it('uses =, IN or IS NULL', () => {
    expect(goToSql(users, 'id', ['42'], 'int8')).toBe('SELECT *\nFROM users\nWHERE id = 42')
    expect(goToSql(users, 'id', ['1', '2', '2', null], 'int8')).toBe(
      'SELECT *\nFROM users\nWHERE id IN (1, 2)',
    )
    expect(goToSql(users, 'id', [null], 'int8')).toBe('SELECT *\nFROM users\nWHERE id IS NULL')
  })

  it('quotes non-numeric values and odd names, keeps non-public schemas', () => {
    expect(goToSql({ schema: 'billing', name: 'Payments' }, 'order', ["O'1"], 'text')).toBe(
      `SELECT *\nFROM billing."Payments"\nWHERE "order" = 'O''1'`,
    )
    expect(literal('1e3', 'numeric')).toBe('1e3')
    expect(literal('12a', 'int8')).toBe("'12a'")
  })
})

describe('joinSql', () => {
  it('splices a LEFT JOIN before WHERE and keeps the rest', () => {
    const r = joinSql(req('select * from invoices i where i.total > 100 order by i.id limit 50;'))
    expect(r.mode).toBe('join')
    expect(r.sql).toBe(
      'select * from invoices i\n  LEFT JOIN users u ON u.id = i.user_id\nwhere i.total > 100 order by i.id limit 50',
    )
  })

  it('uses the table name when there is no alias, and appends u.* to an explicit select list', () => {
    const r = joinSql(
      req('SELECT invoices.id, invoices.total AS t\nFROM public.invoices\nWHERE invoices.total > 5'),
    )
    expect(r.sql).toBe(
      'SELECT invoices.id, invoices.total AS t, u.*\nFROM public.invoices\n  LEFT JOIN users u ON u.id = invoices.user_id\nWHERE invoices.total > 5',
    )
  })

  it('adds to existing joins and avoids taken aliases', () => {
    const r = joinSql(
      req('select * from invoices AS u join billing.payments p on p.invoice_id = u.id', {
        to: { table: users, column: 'id' },
      }),
    )
    expect(r.sql).toBe(
      'select * from invoices AS u join billing.payments p on p.invoice_id = u.id\n  LEFT JOIN users u2 ON u2.id = u.user_id',
    )
  })

  it('ignores FROM inside strings and comments', () => {
    const sql = "select i.id, 'from users' as x, count(i.id) -- from users\nfrom invoices i"
    const r = joinSql(req(sql))
    expect(r.mode).toBe('join')
    expect(r.sql.endsWith('from invoices i\n  LEFT JOIN users u ON u.id = i.user_id')).toBe(true)
  })

  it('wraps when an unqualified column could become ambiguous', () => {
    for (const sql of [
      'SELECT * FROM invoices WHERE id IN (1, 2)',
      'select i.* from invoices i order by total',
      'select i.id, (select 1) as x from invoices i',
    ])
      expect(joinSql(req(sql)).mode).toBe('wrap')
    expect(
      joinSql(req("select i.* from invoices i where i.code::text like 'A%' and i.total > interval '1 day'"))
        .mode,
    ).toBe('join')
  })

  it('wraps CTEs, set operations and ambiguous references', () => {
    for (const sql of [
      'with x as (select * from invoices) select * from x',
      'select * from invoices union all select * from invoices',
      'select * from invoices a join invoices b on a.id = b.id',
      'select 1',
    ]) {
      const r = joinSql(req(sql))
      expect(r.mode).toBe('wrap')
      expect(r.sql).toContain('LEFT JOIN users u ON u.id = q.user_id')
    }
  })

  it('wraps with the result column name, quoted when needed', () => {
    const r = joinSql(
      req('with x as (select user_id as "Who" from invoices) select * from x', {
        from: { table: invoices, column: 'user_id', resultColumn: 'Who' },
      }),
    )
    expect(r.sql).toBe(
      'SELECT q.*, u.*\nFROM (\n  with x as (select user_id as "Who" from invoices) select * from x\n) q\n' +
        'LEFT JOIN users u ON u.id = q."Who"',
    )
  })
})

describe('helpers', () => {
  it('makes short, free aliases', () => {
    expect(freshAlias('hardware_models', new Set())).toBe('hm')
    expect(freshAlias('users', new Set(['u', 'u2']))).toBe('u3')
    expect(freshAlias('on_call', new Set())).toBe('oc')
    expect(freshAlias('order', new Set())).toBe('o')
    expect(freshAlias('in_stock', new Set())).toBe('is2')
  })

  it('tokenizes dollar quotes and quoted identifiers', () => {
    const t = tokenize('select $$ from x $$, "A""b" from y')
    expect(t.map((x) => x.value)).toEqual(['select', ',', 'A"b', 'from', 'y'])
  })
})
