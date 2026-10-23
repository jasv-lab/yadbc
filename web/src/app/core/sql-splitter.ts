export interface SplitStatement {
  sql: string
  /** Offset of the first non-whitespace character in the source text. */
  start: number
  /** Offset just past the terminating `;` (or end of text). */
  end: number
}

/** Words a statement starts with: after a blank line, they begin a new one (no `;` needed). */
const STATEMENT_STARTS = new Set([
  'select', 'insert', 'update', 'delete', 'merge', 'with', 'create', 'alter', 'drop', 'truncate',
  'begin', 'commit', 'rollback', 'savepoint', 'release', 'abort', 'explain', 'analyze', 'vacuum',
  'grant', 'revoke', 'call', 'copy', 'set', 'reset', 'show', 'do', 'refresh', 'comment', 'reindex',
  'cluster', 'lock', 'prepare', 'deallocate', 'discard', 'listen', 'notify', 'unlisten', 'declare',
  'checkpoint', 'import', 'security',
]) // prettier-ignore

/** A statement ending in one of these goes on after the blank line (`… as` ⏎⏎ `select …`). */
const CONTINUES = new Set([
  'as',
  'union',
  'all',
  'intersect',
  'except',
  'distinct',
  'and',
  'or',
  'not',
  'then',
  'else',
  'do',
  'analyze',
  'verbose',
])

/** Statements that aren't complete until a later word: WITH … SELECT, INSERT … VALUES, UPDATE … SET, EXPLAIN … */
const COMPLETED_BY: Record<string, Set<string>> = {
  with: new Set(['select', 'insert', 'update', 'delete', 'merge', 'values', 'table']),
  insert: new Set(['values', 'select', 'default', 'table', 'with']),
  update: new Set(['set']),
  explain: new Set([
    'select',
    'insert',
    'update',
    'delete',
    'merge',
    'with',
    'values',
    'table',
    'create',
    'execute',
    'declare',
  ]),
}

/**
 * Splits a SQL script into statements: at top-level semicolons, and at a blank line followed by a
 * statement keyword — scratch files often have none between them — unless the statement isn't finished
 * yet (inside parentheses, a WITH still missing its SELECT, a trailing AS / UNION / comma…), so long
 * statements with blank lines inside stay whole. A lexer, not a parser: it only needs to know what's
 * inside a string ('…', E'…', "…"), a comment (--, nested /* *\/) or a dollar-quoted body ($$…$$,
 * $tag$…$tag$). Statements that contain only comments are dropped.
 */
export function splitSql(text: string): SplitStatement[] {
  const out: SplitStatement[] = []
  let stmtStart = 0
  let i = 0
  const n = text.length

  // The statement read so far: parenthesis depth, its first word, what would complete it, and its
  // last word / last code character (to see whether it can end at a blank line).
  let depth = 0
  let first: string | null = null
  let awaiting: Set<string> | null = null
  let lastWord: string | null = null
  let lastChar = ''
  let codeEnd = 0

  const push = (endExclusive: number, end: number) => {
    const raw = text.slice(stmtStart, endExclusive)
    const lead = raw.length - raw.trimStart().length
    const sql = raw.trim()
    if (sql && hasCode(sql)) out.push({ sql, start: stmtStart + lead, end })
    depth = 0
    first = awaiting = lastWord = null
    lastChar = ''
  }

  const canEndAt = () =>
    depth === 0 &&
    first !== null &&
    awaiting === null &&
    !(lastWord !== null && lastChar === '' && CONTINUES.has(lastWord)) &&
    !',(=<>+-*/|&%^~!@#.:'.includes(lastChar || ' ')

  // A code token that isn't a word (a string, a quoted name, punctuation) just ended at `end`.
  const symbol = (ch: string, end: number) => {
    first ??= ''
    lastWord = null
    lastChar = ch
    codeEnd = end
  }

  // At a newline: a blank line next, then a statement keyword, ends the statement here.
  const lineEnd = (nl: number) => {
    if (!/^[ \t\r]*\n/.test(text.slice(nl + 1, nl + 200)) || !canEndAt()) return
    const word = /^[A-Za-z_]+/.exec(text.slice(skipSpaceAndComments(text, nl + 1)))?.[0].toLowerCase()
    if (!word || !STATEMENT_STARTS.has(word)) return
    push(nl, codeEnd)
    stmtStart = nl + 1
  }

  while (i < n) {
    const c = text[i]
    const next = text[i + 1]

    if (c === '-' && next === '-') {
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? n : nl + 1
      if (nl >= 0) lineEnd(nl)
    } else if (c === '/' && next === '*') {
      i = skipBlockComment(text, i)
    } else if (c === "'") {
      const escapes = i > 0 && (text[i - 1] === 'E' || text[i - 1] === 'e') && !isIdentChar(text[i - 2])
      i = skipQuoted(text, i, "'", escapes)
      symbol(c, i)
    } else if (c === '"') {
      i = skipQuoted(text, i, '"', false)
      symbol(c, i)
    } else if (c === '$' && !isIdentChar(text[i - 1])) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64))
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length)
        i = close < 0 ? n : close + tag[0].length
      } else {
        i++
      }
      symbol(c, i)
    } else if (c === ';') {
      push(i, i + 1)
      stmtStart = i + 1
      i++
    } else if (/[A-Za-z_]/.test(c) && !isIdentChar(text[i - 1])) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++
      const word = text.slice(i, j).toLowerCase()
      if (first === null) {
        first = word
        awaiting = COMPLETED_BY[word] ?? null
      } else if (awaiting && depth === 0 && awaiting.has(word)) {
        awaiting = null
      }
      lastWord = word
      lastChar = ''
      codeEnd = j
      i = j
    } else if (c === '\n') {
      lineEnd(i)
      i++
    } else if (c === ' ' || c === '\t' || c === '\r') {
      i++
    } else {
      if (c === '(') depth++
      else if (c === ')') depth = Math.max(0, depth - 1)
      symbol(c, i + 1)
      i++
    }
  }
  push(n, n)
  return out
}

/** The statement under the cursor; between statements, the nearest one before it. */
export function statementAt(statements: SplitStatement[], offset: number): SplitStatement | undefined {
  let candidate: SplitStatement | undefined
  for (const s of statements) {
    if (offset >= s.start && offset <= s.end) return s
    if (s.end <= offset) candidate = s
    else if (!candidate) return s
  }
  return candidate
}

/** Past whitespace and comments: where the next code starts. */
function skipSpaceAndComments(text: string, i: number): number {
  while (i < text.length) {
    if (/\s/.test(text[i])) i++
    else if (text[i] === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? text.length : nl + 1
    } else if (text[i] === '/' && text[i + 1] === '*') i = skipBlockComment(text, i)
    else break
  }
  return i
}

function skipBlockComment(text: string, i: number): number {
  let depth = 0
  while (i < text.length) {
    if (text[i] === '/' && text[i + 1] === '*') {
      depth++
      i += 2
    } else if (text[i] === '*' && text[i + 1] === '/') {
      depth--
      i += 2
      if (depth === 0) return i
    } else {
      i++
    }
  }
  return i
}

function skipQuoted(text: string, i: number, quote: string, backslashEscapes: boolean): number {
  i++
  while (i < text.length) {
    const c = text[i]
    if (backslashEscapes && c === '\\') {
      i += 2
    } else if (c === quote) {
      if (text[i + 1] === quote) i += 2
      else return i + 1
    } else {
      i++
    }
  }
  return i
}

function isIdentChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_]/.test(c)
}

function hasCode(sql: string): boolean {
  return (
    sql
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim().length > 0
  )
}
