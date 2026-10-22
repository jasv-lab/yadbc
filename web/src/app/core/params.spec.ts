import { describe, expect, it } from 'vitest'
import { bindParams, findParams, paramNames } from './params'

describe('findParams', () => {
  it('finds :names and skips casts, slices, strings, comments and dollar quotes', () => {
    const sql = `select a::text, arr[lo:hi], ':no' as s, "x:y" -- :nope
      from t where id = :id and (kind = :kind or :kind is null) /* :not */ and f = $$ :body $$ and g=:g`
    expect(findParams(sql).map((p) => p.name)).toEqual(['id', 'kind', 'kind', 'g'])
  })

  it('lists distinct names across statements', () => {
    expect(paramNames(['select :a, :b', 'select :b, :c'])).toEqual(['a', 'b', 'c'])
  })
})

describe('bindParams', () => {
  it('replaces every occurrence with a quoted literal, NULL or raw SQL', () => {
    expect(
      bindParams("select * from t where id = :id and n = :n and k in (:ks) and s = ':id'", {
        id: { mode: 'text', value: "4'2" },
        n: { mode: 'null', value: 'ignored' },
        ks: { mode: 'raw', value: '1, 2' },
      }),
    ).toBe("select * from t where id = '4''2' and n = NULL and k in (1, 2) and s = ':id'")
  })

  it('leaves unknown names alone', () => {
    expect(bindParams('select :a, :b', { a: { mode: 'text', value: '1' } })).toBe("select '1', :b")
  })
})
