import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from './markdown'

describe('parseMarkdown', () => {
  it('reads paragraphs, lists, headings and code', () => {
    const blocks = parseMarkdown(
      '## Why\nThe scan reads\nevery row.\n\n- add an index\n- `ANALYZE` it\n\n```sql\nCREATE INDEX ON t (a);\n```\nDone.',
    )
    expect(blocks.map((b) => b.t)).toEqual(['h', 'p', 'list', 'code', 'p'])
    expect(blocks[1]).toEqual({ t: 'p', inl: [{ t: 'text', v: 'The scan reads every row.' }] })
    expect(blocks[3]).toEqual({ t: 'code', lang: 'sql', v: 'CREATE INDEX ON t (a);', open: false })
  })

  it('keeps an unclosed fence as code in progress (streaming)', () => {
    const blocks = parseMarkdown('Try:\n```sql\nSELECT 1\nFROM')
    expect(blocks[1]).toEqual({ t: 'code', lang: 'sql', v: 'SELECT 1\nFROM', open: true })
  })

  it('separates ordered and unordered lists', () => {
    const blocks = parseMarkdown('1. one\n2. two\n- x')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ t: 'list', ordered: true })
  })
})

describe('parseInline', () => {
  it('splits code and bold, leaves markup-looking text as text', () => {
    expect(parseInline('a `b` **c** <i>d</i>')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'code', v: 'b' },
      { t: 'text', v: ' ' },
      { t: 'bold', v: 'c' },
      { t: 'text', v: ' <i>d</i>' },
    ])
  })
})
