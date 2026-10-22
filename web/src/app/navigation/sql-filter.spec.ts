import { describe, expect, it } from 'vitest'
import { condition, filterSql, FilterCondition } from './sql-nav'

const users = { schema: 'public', name: 'users' }
const invoices = { schema: 'public', name: 'invoices' }

const userId = (values: (string | null)[]): FilterCondition => ({
  table: invoices,
  column: 'user_id',
  resultColumn: 'who',
  values,
  type: 'int8',
})
const f = (sql: string, conds: FilterCondition[], negate = false) =>
  filterSql({ sql, conditions: conds, negate })

describe('filterSql', () => {
  it('adds a WHERE before ORDER/LIMIT, through the table alias', () => {
    expect(f('select i.user_id as who from invoices i order by i.id limit 5;', [userId(['42'])]).sql).toBe(
      'select i.user_id as who from invoices i\nWHERE i.user_id = 42\norder by i.id limit 5',
    )
  })

  it('ANDs onto an existing WHERE, parenthesizing a top-level OR', () => {
    expect(f('select * from invoices where total > 5', [userId(['1', '2'])]).sql).toBe(
      'select * from invoices where total > 5\n  AND invoices.user_id IN (1, 2)',
    )
    expect(f('select * from invoices i where i.a = 1 or i.b = 2\norder by 1', [userId(['3'])]).sql).toBe(
      'select * from invoices i where (i.a = 1 or i.b = 2)\n  AND i.user_id = 3\norder by 1',
    )
  })

  it('stacks: filtering a filtered query adds another AND', () => {
    const once = f('select * from invoices i', [userId(['1'])]).sql
    expect(f(once, [userId(['2'])], true).sql).toBe(
      'select * from invoices i\nWHERE i.user_id = 1\n  AND i.user_id IS DISTINCT FROM 2',
    )
  })

  it('combines several columns of one row', () => {
    const plan: FilterCondition = {
      table: users,
      column: 'plan',
      resultColumn: 'plan',
      values: ['pro'],
      type: 'plan',
    }
    expect(f('select * from invoices i join users u on u.id = i.user_id', [userId(['7']), plan]).sql).toBe(
      "select * from invoices i join users u on u.id = i.user_id\nWHERE i.user_id = 7 AND u.plan = 'pro'",
    )
  })

  it('wraps computed columns, set operations and a table named twice', () => {
    const computed: FilterCondition = {
      table: null,
      column: null,
      resultColumn: 'n',
      values: ['3'],
      type: 'int8',
    }
    expect(f('select count(*) as n from invoices', [computed]).sql).toBe(
      'SELECT *\nFROM (\n  select count(*) as n from invoices\n) q\nWHERE q.n = 3',
    )
    expect(f('select * from invoices a join invoices b on a.id = b.id', [userId(['1'])]).mode).toBe('wrap')
    expect(f('select * from invoices union select * from invoices', [userId(['1'])]).mode).toBe('wrap')
  })
})

describe('condition', () => {
  it('keeps or excludes values, NULL-safely', () => {
    expect(condition('x', ['1'], 'int4', false)).toBe('x = 1')
    expect(condition('x', [null], 'int4', false)).toBe('x IS NULL')
    expect(condition('x', ['a', null], 'text', false)).toBe("(x = 'a' OR x IS NULL)")
    // Excluding 'x' keeps the NULL rows — unless NULL was among the excluded values.
    expect(condition('x', ['1'], 'int4', true)).toBe('x IS DISTINCT FROM 1')
    expect(condition('x', ['1', '2'], 'int4', true)).toBe('(x IS NULL OR x NOT IN (1, 2))')
    expect(condition('x', [null], 'int4', true)).toBe('x IS NOT NULL')
    expect(condition('x', ['1', null], 'int4', true)).toBe('x <> 1')
  })
})
