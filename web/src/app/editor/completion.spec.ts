import { describe, expect, it } from 'vitest'
import { completionContext, relationRefs, resolveQualifier, tokenize } from './completion'

/** `|` marks the cursor. */
function at(sqlWithCursor: string) {
  const offset = sqlWithCursor.indexOf('|')
  return completionContext(sqlWithCursor.replace('|', ''), offset)
}

describe('relationRefs', () => {
  it('finds tables, schemas and aliases in FROM and JOIN', () => {
    const refs = relationRefs(
      tokenize(
        'select * from public.users u join invoices as i on i.user_id = u.id left join billing.payments p on true',
      ),
    )
    expect(refs).toEqual([
      { schema: 'public', name: 'users', alias: 'u' },
      { schema: undefined, name: 'invoices', alias: 'i' },
      { schema: 'billing', name: 'payments', alias: 'p' },
    ])
  })

  it('reads comma lists and stops at clause keywords', () => {
    expect(relationRefs(tokenize('select 1 from a, b x, c where a.id = 1'))).toEqual([
      { schema: undefined, name: 'a', alias: undefined },
      { schema: undefined, name: 'b', alias: 'x' },
      { schema: undefined, name: 'c', alias: undefined },
    ])
  })

  it('takes no alias from the next statement when the `;` is missing', () => {
    expect(relationRefs(tokenize('select\nfrom invoices\n\nupdate invoices set id = 1'))).toEqual([
      { schema: undefined, name: 'invoices', alias: undefined },
      { schema: undefined, name: 'invoices', alias: undefined },
    ])
    expect(relationRefs(tokenize('select * from t\ninsert into u values (1)'))).toEqual([
      { schema: undefined, name: 't', alias: undefined },
      { schema: undefined, name: 'u', alias: undefined },
    ])
  })

  it('folds unquoted names and keeps quoted ones exact', () => {
    expect(relationRefs(tokenize('select * from Users "Mixed""Case"'))).toEqual([
      { schema: undefined, name: 'users', alias: 'Mixed"Case' },
    ])
  })

  it('handles UPDATE and INSERT INTO, skips functions and subqueries', () => {
    expect(relationRefs(tokenize('update users set x = 1'))).toEqual([
      { schema: undefined, name: 'users', alias: undefined },
    ])
    expect(relationRefs(tokenize('insert into billing.payments (id) values (1)'))).toEqual([
      { schema: 'billing', name: 'payments', alias: undefined },
    ])
    expect(relationRefs(tokenize('select * from generate_series(1, 3) g, (select 1) s'))).toEqual([])
  })
})

describe('completionContext', () => {
  it('suggests relations after FROM / JOIN / UPDATE, including half-typed names', () => {
    expect(at('select * from |').kind).toBe('relation')
    expect(at('select * from us|').kind).toBe('relation')
    expect(at('select * from users u join |').kind).toBe('relation')
    expect(at('update |').kind).toBe('relation')
    expect(at('select * from a, |').kind).toBe('relation')
  })

  it('suggests a schema’s objects after `from schema.`', () => {
    expect(at('select * from billing.|')).toMatchObject({ kind: 'relation', schema: 'billing' })
    expect(at('select * from billing.pa|')).toMatchObject({ kind: 'relation', schema: 'billing' })
  })

  it('suggests members after alias. — with FROM after the cursor too', () => {
    const ctx = at('select u.| from users u')
    expect(ctx).toMatchObject({ kind: 'member', qualifier: 'u' })
    if (ctx.kind === 'member') expect(resolveQualifier('u', ctx.refs)?.name).toBe('users')
    expect(at('select * from users u where u.em|')).toMatchObject({ kind: 'member', qualifier: 'u' })
  })

  it('is general elsewhere, with the statement’s relations in scope', () => {
    const ctx = at('select | from users u join invoices i on i.user_id = u.id')
    expect(ctx.kind).toBe('general')
    if (ctx.kind === 'general') expect(ctx.refs.map((r) => r.name)).toEqual(['users', 'invoices'])
    expect(at('select * from users where |').kind).toBe('general')
    expect(at('select * from a, b where x = 1 and |').kind).toBe('general')
  })

  it('stays quiet inside strings and comments', () => {
    expect(at("select 'from |'").kind).toBe('none')
    expect(at('select 1 -- from |').kind).toBe('none')
    expect(at('select /* from | */').kind).toBe('none')
    expect(at("select 'it''s' from |").kind).toBe('relation')
  })
})
