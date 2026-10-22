/**
 * Named parameters in SQL: `:name`. Found outside strings, quoted identifiers, comments and
 * dollar-quoted bodies; not a `::cast`, not an array slice (`arr[lo:hi]` — a parameter never follows a
 * word character). Bound as quoted literals, which Postgres coerces to whatever the context needs
 * (`id = '42'` compares as a number), so the run — and its history entry — is plain SQL. NULL and raw
 * SQL (`in (:ids)` ← `1, 2, 3`) are explicit choices, never guessed from the text.
 */

export type ParamMode = 'text' | 'null' | 'raw'

export interface ParamValue {
  mode: ParamMode
  value: string
}

export interface ParamRef {
  name: string
  start: number
  end: number
}

export function findParams(sql: string): ParamRef[] {
  const out: ParamRef[] = []
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl < 0 ? sql.length : nl + 1
    } else if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2)
      i = close < 0 ? sql.length : close + 2
    } else if (ch === "'" || ch === '"') {
      i++
      while (i < sql.length && !(sql[i] === ch && sql[i + 1] !== ch)) i += sql[i] === ch ? 2 : 1
      i++
    } else if (ch === '$' && /[A-Za-z_$]/.test(next ?? '')) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0]
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length)
        i = close < 0 ? sql.length : close + tag.length
      } else i++
    } else if (ch === ':' && /[A-Za-z_]/.test(next ?? '') && !/[\w:\]]/.test(sql[i - 1] ?? '')) {
      const m = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i))!
      out.push({ name: m[1], start: i, end: i + m[0].length })
      i += m[0].length
    } else i++
  }
  return out
}

/** The distinct parameter names of several statements, in order of appearance. */
export function paramNames(sqls: string[]): string[] {
  return [...new Set(sqls.flatMap((s) => findParams(s).map((p) => p.name)))]
}

export function paramLiteral(p: ParamValue): string {
  if (p.mode === 'null') return 'NULL'
  if (p.mode === 'raw') return p.value
  return `'${p.value.replace(/'/g, "''")}'`
}

export function bindParams(sql: string, values: Record<string, ParamValue>): string {
  let out = sql
  for (const p of findParams(sql).reverse())
    if (p.name in values) out = out.slice(0, p.start) + paramLiteral(values[p.name]) + out.slice(p.end)
  return out
}
