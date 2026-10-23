/**
 * What to suggest at a cursor position in a (possibly half-typed) SQL statement. A forgiving lexer,
 * not a parser: it only needs the relations the statement mentions (with aliases) and what the cursor
 * is right after. Pure functions so they can be tested without Monaco.
 */

export interface RelationRef {
  schema?: string
  name: string
  alias?: string
}

export type CompletionContext =
  /** After FROM / JOIN / UPDATE / INTO / TABLE: table-like objects, optionally within a schema. */
  | { kind: 'relation'; schema?: string; refs: RelationRef[] }
  /** After `x.`: columns of relation/alias x, or objects of schema x. */
  | { kind: 'member'; qualifier: string; refs: RelationRef[] }
  /** Anywhere else: columns of the statement's relations, aliases, keywords, functions. */
  | { kind: 'general'; refs: RelationRef[] }
  /** Inside a string or comment: nothing. */
  | { kind: 'none' }

interface Token {
  type: 'word' | 'quoted' | 'punct'
  /** Identifier as Postgres sees it: unquoted folded to lower case, quoted kept exact. */
  value: string
  /** Original text, lower-cased for keyword checks. */
  lower: string
  start: number
  end: number
}

const RELATION_KEYWORDS = new Set(['from', 'join', 'update', 'into', 'table'])

/** Words that end a FROM item (so `from users where` doesn't make "where" an alias). */
const CLAUSE_WORDS = new Set([
  'where',
  'group',
  'order',
  'having',
  'limit',
  'offset',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'natural',
  'on',
  'using',
  'union',
  'intersect',
  'except',
  'window',
  'returning',
  'set',
  'values',
  'select',
  'as',
  'lateral',
  'for',
  'fetch',
  'default',
  'do',
  'when',
  'then',
  'outer',
  'into',
  'tablesample',
  // A next statement without a `;` in between (`from t` ⏎ `update t …`) isn't an alias of t.
  'insert',
  'update',
  'delete',
  'merge',
  'with',
  'create',
  'alter',
  'drop',
  'truncate',
  'begin',
  'commit',
  'rollback',
  'explain',
  'vacuum',
  'analyze',
  'grant',
  'revoke',
  'call',
  'copy',
])

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    if (/\s/.test(c)) {
      i++
    } else if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl < 0 ? sql.length : nl + 1
    } else if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      i = close < 0 ? sql.length : close + 2
    } else if (c === "'") {
      let j = i + 1
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1
      i = j + 1
    } else if (c === '"') {
      let j = i + 1
      while (j < sql.length && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1
      const raw = sql.slice(i + 1, Math.min(j, sql.length))
      tokens.push({
        type: 'quoted',
        value: raw.replace(/""/g, '"'),
        lower: raw.toLowerCase(),
        start: i,
        end: j + 1,
      })
      i = j + 1
    } else if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length)
        i = close < 0 ? sql.length : close + tag[0].length
      } else {
        i++
      }
    } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1
      while (j < sql.length && /[A-Za-z0-9_$\u0080-￿]/.test(sql[j])) j++
      const raw = sql.slice(i, j)
      tokens.push({ type: 'word', value: raw.toLowerCase(), lower: raw.toLowerCase(), start: i, end: j })
      i = j
    } else {
      tokens.push({ type: 'punct', value: c, lower: c, start: i, end: i + 1 })
      i++
    }
  }
  return tokens
}

const isIdent = (t?: Token) => !!t && (t.type === 'quoted' || t.type === 'word')

/** Relations named in FROM / JOIN / UPDATE / INTO lists, with their aliases. Subqueries are skipped. */
export function relationRefs(tokens: Token[]): RelationRef[] {
  const refs: RelationRef[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type !== 'word' || !RELATION_KEYWORDS.has(t.lower) || t.lower === 'table') continue
    let j = i + 1
    // FROM a, b x, c AS y — keep reading items while separated by commas.
    for (;;) {
      if (tokens[j]?.lower === 'only' || tokens[j]?.lower === 'lateral') j++
      if (!isIdent(tokens[j]) || (tokens[j].type === 'word' && CLAUSE_WORDS.has(tokens[j].lower))) break
      let schema: string | undefined
      let name = tokens[j].value
      j++
      if (tokens[j]?.value === '.' && isIdent(tokens[j + 1])) {
        schema = name
        name = tokens[j + 1].value
        j += 2
      }
      // `from f(…)` is a function call, not a relation; `into t (a, b)` is a column list.
      if (tokens[j]?.value === '(' && t.lower !== 'into') break
      let alias: string | undefined
      if (tokens[j]?.lower === 'as' && isIdent(tokens[j + 1])) {
        alias = tokens[j + 1].value
        j += 2
      } else if (isIdent(tokens[j]) && !(tokens[j].type === 'word' && CLAUSE_WORDS.has(tokens[j].lower))) {
        alias = tokens[j].value
        j++
      }
      refs.push({ schema, name, alias })
      if (tokens[j]?.value !== ',' || t.lower !== 'from') break
      j++
    }
  }
  return refs
}

/** Decides what the cursor wants. `offset` is relative to `sql` (the current statement). */
export function completionContext(sql: string, offset: number): CompletionContext {
  const before = sql.slice(0, offset)
  if (insideStringOrComment(before)) return { kind: 'none' }

  const refs = relationRefs(tokenize(sql))
  const tokens = tokenize(before)
  // The word being typed (possibly empty) isn't context; look at what precedes it.
  let k = tokens.length - 1
  if (k >= 0 && isIdent(tokens[k]) && tokens[k].end === before.length) k--

  const prev = tokens[k]
  if (prev?.value === '.' && isIdent(tokens[k - 1])) {
    const qualifier = tokens[k - 1].value
    // `from public.` is still a relation position.
    if (tokens[k - 2]?.type === 'word' && RELATION_KEYWORDS.has(tokens[k - 2].lower))
      return { kind: 'relation', schema: qualifier, refs }
    return { kind: 'member', qualifier, refs }
  }
  if (prev?.type === 'word' && RELATION_KEYWORDS.has(prev.lower)) return { kind: 'relation', refs }
  // `from a, |`
  if (prev?.value === ',' && inFromList(tokens, k)) return { kind: 'relation', refs }
  return { kind: 'general', refs }
}

/** Is the comma at k inside a FROM list (no clause keyword between it and the FROM)? */
function inFromList(tokens: Token[], k: number): boolean {
  for (let i = k - 1; i >= 0; i--) {
    const t = tokens[i]
    if (t.type !== 'word') {
      if (t.value === '(' || t.value === ')') return false
      continue
    }
    if (t.lower === 'from') return true
    if (CLAUSE_WORDS.has(t.lower) || t.lower === 'select') return false
  }
  return false
}

function insideStringOrComment(before: string): boolean {
  let i = 0
  while (i < before.length) {
    const c = before[i]
    if (c === '-' && before[i + 1] === '-') {
      const nl = before.indexOf('\n', i)
      if (nl < 0) return true
      i = nl + 1
    } else if (c === '/' && before[i + 1] === '*') {
      const close = before.indexOf('*/', i + 2)
      if (close < 0) return true
      i = close + 2
    } else if (c === "'") {
      let j = i + 1
      while (j < before.length && !(before[j] === "'" && before[j + 1] !== "'"))
        j += before[j] === "'" ? 2 : 1
      if (j >= before.length) return true
      i = j + 1
    } else {
      i++
    }
  }
  return false
}

/** Finds the relation a qualifier refers to: an alias first, then a table name. */
export function resolveQualifier(qualifier: string, refs: RelationRef[]): RelationRef | undefined {
  return (
    refs.find((r) => r.alias === qualifier) ??
    refs.find((r) => !r.alias && r.name === qualifier) ??
    refs.find((r) => r.name === qualifier)
  )
}
