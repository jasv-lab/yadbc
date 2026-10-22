/**
 * SQL for following relations from a result: "go to" the referenced (or referencing) rows, and "join"
 * a related table into the query the result came from. Pure functions, unit-tested.
 */

export interface TableRef {
  schema: string
  name: string
}

const RESERVED = new Set([
  'all',
  'analyse',
  'analyze',
  'and',
  'any',
  'array',
  'as',
  'asc',
  'asymmetric',
  'authorization',
  'binary',
  'both',
  'case',
  'cast',
  'check',
  'collate',
  'collation',
  'column',
  'concurrently',
  'constraint',
  'create',
  'cross',
  'current_catalog',
  'current_date',
  'current_role',
  'current_schema',
  'current_time',
  'current_timestamp',
  'current_user',
  'default',
  'deferrable',
  'desc',
  'distinct',
  'do',
  'else',
  'end',
  'except',
  'false',
  'fetch',
  'for',
  'foreign',
  'freeze',
  'from',
  'full',
  'grant',
  'group',
  'having',
  'ilike',
  'in',
  'initially',
  'inner',
  'intersect',
  'into',
  'is',
  'isnull',
  'join',
  'lateral',
  'leading',
  'left',
  'like',
  'limit',
  'localtime',
  'localtimestamp',
  'natural',
  'not',
  'notnull',
  'null',
  'offset',
  'on',
  'only',
  'or',
  'order',
  'outer',
  'overlaps',
  'placing',
  'primary',
  'references',
  'returning',
  'right',
  'select',
  'session_user',
  'similar',
  'some',
  'symmetric',
  'system_user',
  'table',
  'tablesample',
  'then',
  'to',
  'trailing',
  'true',
  'union',
  'unique',
  'user',
  'using',
  'variadic',
  'verbose',
  'when',
  'where',
  'window',
  'with',
])

const NUMERIC = new Set(['int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'oid'])

/** Quotes an identifier only when Postgres would otherwise fold or reject it. */
export function ident(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`
}

/** `users` for the public schema (it's on everyone's search_path), `billing.payments` otherwise. */
export function tableSql(t: TableRef): string {
  return t.schema === 'public' ? ident(t.name) : `${ident(t.schema)}.${ident(t.name)}`
}

export function literal(value: string, type: string): string {
  if (NUMERIC.has(type) && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value)) return value
  if (type === 'bool') return value === 'true' ? 'TRUE' : 'FALSE'
  return `'${value.replace(/'/g, "''")}'`
}

/** SELECT * FROM table WHERE column = value — or IN (…) for several, IS NULL for none. */
export function goToSql(table: TableRef, column: string, values: (string | null)[], type: string): string {
  const distinct = [...new Set(values.filter((v): v is string => v !== null))]
  const col = ident(column)
  const where =
    distinct.length === 0
      ? `${col} IS NULL`
      : distinct.length === 1
        ? `${col} = ${literal(distinct[0], type)}`
        : `${col} IN (${distinct.map((v) => literal(v, type)).join(', ')})`
  return `SELECT *\nFROM ${tableSql(table)}\nWHERE ${where}`
}

// ── Joining ────────────────────────────────────────────────────────────────

interface Token {
  /** Lowercased word, unquoted "identifier", or the punctuation character. */
  value: string
  kind: 'word' | 'quoted' | 'punct'
  start: number
  end: number
  depth: number
}

/**
 * Words, quoted identifiers and punctuation with their parenthesis depth; strings, comments and
 * dollar-quoted bodies are skipped, so a keyword inside them never counts.
 */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  let depth = 0
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
    } else if (ch === "'") {
      i++
      while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) i += sql[i] === "'" ? 2 : 1
      i++
    } else if (ch === '"') {
      const start = i
      let value = ''
      i++
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          value += '"'
          i += 2
        } else if (sql[i] === '"') break
        else value += sql[i++]
      }
      i++
      tokens.push({ value, kind: 'quoted', start, end: i, depth })
    } else if (ch === '$' && /[A-Za-z_$]/.test(next ?? '')) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0]
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length)
        i = close < 0 ? sql.length : close + tag.length
      } else i++
    } else if (/[A-Za-z_]/.test(ch)) {
      const start = i
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++
      tokens.push({ value: sql.slice(start, i).toLowerCase(), kind: 'word', start, end: i, depth })
    } else if (ch === '(') {
      tokens.push({ value: '(', kind: 'punct', start: i, end: i + 1, depth })
      depth++
      i++
    } else if (ch === ')') {
      depth--
      tokens.push({ value: ')', kind: 'punct', start: i, end: i + 1, depth })
      i++
    } else if (ch === ',' || ch === '.' || ch === ';' || ch === '*' || ch === ':') {
      tokens.push({ value: ch, kind: 'punct', start: i, end: i + 1, depth })
      i++
    } else i++
  }
  return tokens
}

const FROM_END = new Set([
  'where',
  'group',
  'having',
  'window',
  'order',
  'limit',
  'offset',
  'fetch',
  'for',
  'returning',
])
const SET_OPS = new Set(['union', 'intersect', 'except'])
/** Words that can follow a table reference but are not its alias. */
/** Words that are SQL, not column names (for spotting unqualified column references). */
const KEYWORDS = new Set([
  ...RESERVED,
  'by',
  'nulls',
  'first',
  'last',
  'interval',
  'between',
  'exists',
  'filter',
  'over',
  'partition',
  'rows',
  'range',
  'preceding',
  'following',
  'unbounded',
  'current',
  'row',
  'ties',
  'next',
  'percent',
  'escape',
  'at',
  'time',
  'zone',
  'without',
  'distinct',
  'asc',
  'desc',
  'similar',
  'ilike',
  'like',
  'within',
])

const NOT_ALIAS = new Set([
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'natural',
  'on',
  'using',
  'lateral',
  'tablesample',
  ...FROM_END,
])

export interface JoinRequest {
  /** The statement the result came from. */
  sql: string
  /** The table/column of the result column being followed, and its name in the result (for wrapping). */
  from: { table: TableRef; column: string; resultColumn: string }
  /** The related table/column to join. */
  to: { table: TableRef; column: string }
}

export interface JoinResult {
  sql: string
  /** "join" when spliced into the FROM clause, "wrap" when the statement became a subquery. */
  mode: 'join' | 'wrap'
}

/**
 * Adds a LEFT JOIN of the related table. A plain SELECT whose FROM clause names the source table once
 * gets the join spliced in (after the FROM items, before WHERE/GROUP/ORDER…), and `t.*` appended to an
 * explicit select list. Anything else — CTEs, set operations, the table appearing twice, no FROM — is
 * wrapped: SELECT q.*, t.* FROM (…) q LEFT JOIN t ON t.key = q.column. LEFT, so rows whose key is
 * NULL (or dangling) stay.
 */
export function joinSql(req: JoinRequest): JoinResult {
  const sql = req.sql.trim().replace(/;\s*$/, '')
  const tokens = tokenize(sql)
  const top = tokens.filter((t) => t.depth === 0)

  const spliced = splice(sql, tokens, top, req)
  if (spliced) return { sql: spliced, mode: 'join' }

  const alias = freshAlias(req.to.table.name, new Set(['q']))
  const body = sql
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n')
  return {
    mode: 'wrap',
    sql:
      `SELECT q.*, ${alias}.*\nFROM (\n${body}\n) q\n` +
      `LEFT JOIN ${tableSql(req.to.table)} ${alias} ON ${alias}.${ident(req.to.column)} = q.${ident(req.from.resultColumn)}`,
  }
}

interface FromItem {
  schema: string | null
  /** Lowercased / unquoted table name as written. */
  name: string
  /** What to qualify its columns with: the alias, else the table name as written. */
  qualifier: string
}

/** A plain SELECT's top-level shape: where FROM is, where it ends, and the tables it names. */
interface SelectShape {
  tokens: Token[]
  top: Token[]
  fromTok: Token
  /** The keyword that ends the FROM clause (WHERE, GROUP, ORDER…), if any. */
  endTok: Token | undefined
  clauseEnd: number
  items: FromItem[]
  /** Table names and aliases in FROM, for picking a fresh alias. */
  used: Set<string>
}

function readSelect(sql: string): SelectShape | null {
  const tokens = tokenize(sql)
  const top = tokens.filter((t) => t.depth === 0)
  if (top[0]?.value !== 'select' || top.some((t) => t.kind === 'word' && SET_OPS.has(t.value))) return null
  const fromAt = top.findIndex((t) => t.kind === 'word' && t.value === 'from')
  if (fromAt < 0) return null
  const fromTok = top[fromAt]
  const endTok = top.slice(fromAt + 1).find((t) => t.kind === 'word' && FROM_END.has(t.value))
  const clauseEnd = endTok ? endTok.start : sql.length

  // Table references inside the FROM clause (depth 0): after FROM, JOIN or a comma.
  const toks = top.filter((t) => t.start > fromTok.start && t.start < clauseEnd)
  const items: FromItem[] = []
  const used = new Set<string>()
  for (let k = 0; k < toks.length; k++) {
    const prev = k === 0 ? 'from' : toks[k - 1].value
    if (prev !== 'from' && prev !== 'join' && prev !== ',') continue
    if (toks[k].kind === 'punct') continue
    // [schema .] name [AS] [alias]
    let schema: string | null = null
    let nameTok = toks[k]
    let j = k + 1
    if (toks[j]?.value === '.' && toks[j + 1] && toks[j + 1].kind !== 'punct') {
      schema = toks[k].value
      nameTok = toks[j + 1]
      j += 2
    }
    let alias: string | null = null
    if (toks[j]?.kind === 'word' && toks[j].value === 'as') j++
    const a = toks[j]
    if (a && (a.kind === 'quoted' || (a.kind === 'word' && !NOT_ALIAS.has(a.value)))) {
      alias = sql.slice(a.start, a.end)
      used.add(a.value)
    }
    used.add(nameTok.value)
    items.push({ schema, name: nameTok.value, qualifier: alias ?? sql.slice(nameTok.start, nameTok.end) })
  }
  return { tokens, top, fromTok, endTok, clauseEnd, items, used }
}

/** The one FROM item that is this table, or null (absent, or there twice). */
function qualifierOf(shape: SelectShape, table: TableRef): string | null {
  const hits = shape.items.filter(
    (i) => i.name === table.name && (i.schema === null || i.schema === table.schema),
  )
  return hits.length === 1 ? hits[0].qualifier : null
}

function splice(sql: string, tokens: Token[], top: Token[], req: JoinRequest): string | null {
  const shape = readSelect(sql)
  if (!shape) return null
  const { fromTok, endTok, clauseEnd, used } = shape
  const qualifier = qualifierOf(shape, req.from.table)
  if (!qualifier) return null
  const matches = [{ alias: qualifier }]
  if (!safeToSplice(tokens, fromTok.start, clauseEnd)) return null

  const alias = freshAlias(req.to.table.name, used)
  const join =
    `\n  LEFT JOIN ${tableSql(req.to.table)} ${alias} ON ${alias}.${ident(req.to.column)} = ` +
    `${matches[0].alias}.${ident(req.from.column)}`

  // Insert after the FROM clause's last non-space character, keeping the whitespace before WHERE etc.
  let insertAt = clauseEnd
  while (insertAt > fromTok.end && /\s/.test(sql[insertAt - 1])) insertAt--
  // The rest of the statement (WHERE…) starts on its own line after the join.
  const rest = sql.slice(insertAt)
  let out =
    sql.slice(0, insertAt) + join + (endTok && !/^[ \t]*\r?\n/.test(rest) ? '\n' + rest.trimStart() : rest)

  // An explicit select list gets the joined table's columns too; * already includes them.
  const list = tokens.filter((t) => t.depth === 0 && t.start > top[0].end && t.start < fromTok.start)
  const star = list.length === 1 && list[0].value === '*'
  if (!star) {
    let listEnd = fromTok.start
    while (listEnd > top[0].end && /\s/.test(out[listEnd - 1])) listEnd--
    out = out.slice(0, listEnd) + `, ${alias}.*` + out.slice(listEnd)
  }
  return out
}

/**
 * A join adds columns, so an unqualified column reference elsewhere in the statement could become
 * ambiguous (both tables have an `id`). Splicing is only safe when every column outside the FROM clause
 * is written as alias.column, and there are no subqueries to reason about. Unqualified-looking words:
 * not SQL keywords, not function names (followed by "("), not part of a.b, not an AS alias, not a
 * type after "::".
 */
function safeToSplice(tokens: Token[], fromStart: number, fromEnd: number): boolean {
  if (tokens.some((t) => t.depth > 0 && t.kind === 'word' && t.value === 'select')) return false
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]
    if (t.start >= fromStart && t.start < fromEnd) continue
    if (t.kind === 'punct' || (t.kind === 'word' && KEYWORDS.has(t.value))) continue
    const prev = tokens[k - 1]
    const next = tokens[k + 1]
    if (next?.value === '(' || next?.value === '.' || prev?.value === '.') continue
    if (prev?.value === 'as' || prev?.value === ':') continue
    return false
  }
  return true
}

/** users → u, hardware_models → hm; numbered when taken or reserved. */
export function freshAlias(table: string, used: Set<string>): string {
  const base =
    table
      .split(/[_\s]+/)
      .filter(Boolean)
      .map((p) => p[0].toLowerCase())
      .join('')
      .replace(/[^a-z]/g, '') || 't'
  let alias = base
  for (let n = 2; used.has(alias) || RESERVED.has(alias); n++) alias = `${base}${n}`
  return alias
}

// ── Filtering ──────────────────────────────────────────────────────────────

export interface FilterCondition {
  /** Source table/column of the result column; null for computed columns (then the query is wrapped). */
  table: TableRef | null
  column: string | null
  /** Its name in the result, for the wrapped form. */
  resultColumn: string
  values: (string | null)[]
  type: string
}

export interface FilterRequest {
  sql: string
  conditions: FilterCondition[]
  /** Exclude the values instead of keeping only them (single condition). */
  negate: boolean
}

/**
 * `expr = v` / `IN (…)` / `IS NULL`, or for exclude the NULL-safe opposite: excluding 'x' keeps the
 * NULL rows (`IS DISTINCT FROM`), unless NULL was among the excluded values.
 */
export function condition(expr: string, values: (string | null)[], type: string, negate: boolean): string {
  const distinct = [...new Set(values.filter((v): v is string => v !== null))]
  const hasNull = values.some((v) => v === null)
  const lits = distinct.map((v) => literal(v, type))
  if (!negate) {
    const eq =
      lits.length === 1 ? `${expr} = ${lits[0]}` : lits.length ? `${expr} IN (${lits.join(', ')})` : ''
    if (!eq) return `${expr} IS NULL`
    return hasNull ? `(${eq} OR ${expr} IS NULL)` : eq
  }
  if (!lits.length) return `${expr} IS NOT NULL`
  if (hasNull) return lits.length === 1 ? `${expr} <> ${lits[0]}` : `${expr} NOT IN (${lits.join(', ')})`
  return lits.length === 1
    ? `${expr} IS DISTINCT FROM ${lits[0]}`
    : `(${expr} IS NULL OR ${expr} NOT IN (${lits.join(', ')}))`
}

const WHERE_END = new Set([
  'group',
  'having',
  'window',
  'order',
  'limit',
  'offset',
  'fetch',
  'for',
  'returning',
])

/**
 * Adds the conditions to the statement's WHERE (ANDed; an existing top-level OR is parenthesized first),
 * or adds a WHERE after the FROM clause. Columns are referenced through their source table's alias —
 * WHERE can't see output aliases. Computed columns, set operations and a table named twice are
 * wrapped instead: SELECT * FROM (…) q WHERE q.col = ….
 */
export function filterSql(req: FilterRequest): JoinResult {
  const sql = req.sql.trim().replace(/;\s*$/, '')
  const shape = readSelect(sql)
  const exprs = shape
    ? req.conditions.map((c) => {
        const q = c.table && c.column ? qualifierOf(shape, c.table) : null
        return q ? `${q}.${ident(c.column!)}` : null
      })
    : []
  if (shape && exprs.every((e) => e !== null)) {
    const conds = req.conditions
      .map((c, i) => condition(exprs[i]!, c.values, c.type, req.negate))
      .join(' AND ')
    const { top, fromTok, endTok, clauseEnd } = shape
    if (endTok?.value === 'where') {
      const whereEnd =
        top.find((t) => t.start > endTok.end && t.kind === 'word' && WHERE_END.has(t.value))?.start ??
        sql.length
      let condEnd = whereEnd
      while (condEnd > endTok.end && /\s/.test(sql[condEnd - 1])) condEnd--
      const existing = sql.slice(endTok.end, condEnd)
      const hasOr = top.some(
        (t) => t.start > endTok.end && t.start < condEnd && t.kind === 'word' && t.value === 'or',
      )
      const kept = hasOr ? ` (${existing.trim()})` : existing
      const rest = sql.slice(condEnd)
      const tail = whereEnd < sql.length && !/^[ \t]*\r?\n/.test(rest) ? '\n' + rest.trimStart() : rest
      return { mode: 'join', sql: sql.slice(0, endTok.end) + kept + `\n  AND ${conds}` + tail }
    }
    let insertAt = clauseEnd
    while (insertAt > fromTok.end && /\s/.test(sql[insertAt - 1])) insertAt--
    const rest = sql.slice(insertAt)
    const tail = endTok && !/^[ \t]*\r?\n/.test(rest) ? '\n' + rest.trimStart() : rest
    return { mode: 'join', sql: sql.slice(0, insertAt) + `\nWHERE ${conds}` + tail }
  }

  const body = sql
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n')
  const conds = req.conditions
    .map((c) => condition(`q.${ident(c.resultColumn)}`, c.values, c.type, req.negate))
    .join(' AND ')
  return { mode: 'wrap', sql: `SELECT *\nFROM (\n${body}\n) q\nWHERE ${conds}` }
}
