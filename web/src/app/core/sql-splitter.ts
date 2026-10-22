export interface SplitStatement {
  sql: string
  /** Offset of the first non-whitespace character in the source text. */
  start: number
  /** Offset just past the terminating `;` (or end of text). */
  end: number
}

/**
 * Splits a SQL script on top-level semicolons. A lexer, not a parser: it only needs to know when a
 * `;` is inside a string ('…', E'…', "…"), a comment (--, nested /* *\/) or a dollar-quoted body
 * ($$…$$, $tag$…$tag$). Statements that contain only comments are dropped.
 */
export function splitSql(text: string): SplitStatement[] {
  const out: SplitStatement[] = []
  let stmtStart = 0
  let i = 0
  const n = text.length

  const push = (endExclusive: number, end: number) => {
    const raw = text.slice(stmtStart, endExclusive)
    const lead = raw.length - raw.trimStart().length
    const sql = raw.trim()
    if (sql && hasCode(sql)) out.push({ sql, start: stmtStart + lead, end })
  }

  while (i < n) {
    const c = text[i]
    const next = text[i + 1]

    if (c === '-' && next === '-') {
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? n : nl + 1
    } else if (c === '/' && next === '*') {
      i = skipBlockComment(text, i)
    } else if (c === "'") {
      const escapes = i > 0 && (text[i - 1] === 'E' || text[i - 1] === 'e') && !isIdentChar(text[i - 2])
      i = skipQuoted(text, i, "'", escapes)
    } else if (c === '"') {
      i = skipQuoted(text, i, '"', false)
    } else if (c === '$' && !isIdentChar(text[i - 1])) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64))
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length)
        i = close < 0 ? n : close + tag[0].length
      } else {
        i++
      }
    } else if (c === ';') {
      push(i, i + 1)
      stmtStart = i + 1
      i++
    } else {
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
