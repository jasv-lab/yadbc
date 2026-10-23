import { describe, expect, it } from 'vitest'
import { splitSql, statementAt } from './sql-splitter'

describe('splitSql', () => {
  it('splits on top-level semicolons and records offsets', () => {
    const text = 'select 1;\n  select 2 ;'
    const s = splitSql(text)
    expect(s.map((x) => x.sql)).toEqual(['select 1', 'select 2'])
    expect(text.slice(s[1].start, s[1].start + 8)).toBe('select 2')
  })

  it('ignores semicolons in strings, identifiers, comments and dollar quotes', () => {
    const text = [
      "select ';', 'it''s;', E'\\';', \"a;b\" -- ; comment",
      ';',
      '/* ; /* nested ; */ still ; */ select 2;',
      'create function f() returns int as $body$ begin; return 1; end $body$ language plpgsql;',
      'select $$;$$',
    ].join('\n')
    expect(splitSql(text).map((x) => x.sql.split('\n')[0])).toEqual([
      "select ';', 'it''s;', E'\\';', \"a;b\" -- ; comment",
      '/* ; /* nested ; */ still ; */ select 2',
      'create function f() returns int as $body$ begin; return 1; end $body$ language plpgsql',
      'select $$;$$',
    ])
  })

  it('does not treat $1 parameters as dollar quotes', () => {
    expect(splitSql('select $1; select 2').length).toBe(2)
  })

  it('ends a statement at a blank line followed by a statement keyword', () => {
    const text =
      'select *\nfrom vms\nlimit 10\n\ninsert into vms (id) values (1)\n\n-- note\nupdate vms set a = 1'
    const s = splitSql(text)
    expect(s.map((x) => x.sql)).toEqual([
      'select *\nfrom vms\nlimit 10',
      'insert into vms (id) values (1)',
      '-- note\nupdate vms set a = 1',
    ])
    expect(s[0].end).toBe(text.indexOf('10') + 2)
    expect(text.slice(s[1].start, s[1].start + 6)).toBe('insert')
  })

  it('keeps statements whole across blank lines that do not end them', () => {
    const whole = [
      // a CTE: WITH isn't complete until its SELECT
      'with a as (\n  select 1\n),\n\nb as (select 2)\n\nselect * from a, b',
      // blank line not followed by a statement keyword
      'select *\nfrom t\n\nwhere x = 1\n\norder by 1',
      // inside parentheses
      'select * from t where id in (\n\n  select id from u\n)',
      // a trailing AS / UNION / comma / operator
      'create view v as\n\nselect 1',
      'select 1\nunion all\n\nselect 2',
      'select a,\n\n  b from t',
      // INSERT before its VALUES / SELECT, UPDATE before its SET, EXPLAIN before its statement
      'insert into t (a)\n\nselect 1',
      'update t\n\nset a = 1',
      'explain analyze\n\nselect 1',
    ]
    for (const sql of whole) expect(splitSql(sql).map((x) => x.sql)).toEqual([sql])
  })

  it('ignores blank lines inside strings, comments and function bodies', () => {
    const sql = "select 'a\n\nselect' as x, $$\n\nselect$$ /*\n\nselect */ from t"
    expect(splitSql(sql).map((x) => x.sql)).toEqual([sql])
  })

  it('drops comment-only statements', () => {
    expect(splitSql('-- just a note\n;\nselect 1;\n/* x */').map((x) => x.sql)).toEqual(['select 1'])
  })
})

describe('statementAt', () => {
  const text = 'select 1;\n\nselect 2;\n'
  const stmts = splitSql(text)

  it('picks the statement containing the cursor', () => {
    expect(statementAt(stmts, 3)?.sql).toBe('select 1')
    expect(statementAt(stmts, text.indexOf('2'))?.sql).toBe('select 2')
  })

  it('picks the previous statement when the cursor is between statements', () => {
    expect(statementAt(stmts, 10)?.sql).toBe('select 1')
    expect(statementAt(stmts, text.length)?.sql).toBe('select 2')
  })
})
