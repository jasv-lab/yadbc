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
