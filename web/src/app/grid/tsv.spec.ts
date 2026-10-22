import { describe, expect, it } from 'vitest'
import { parseTsv } from './tsv'

describe('parseTsv', () => {
  it('splits rows and cells, ignoring the trailing line break', () => {
    expect(parseTsv('a\tb\r\n1\t2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(parseTsv('x')).toEqual([['x']])
  })

  it('keeps empty fields', () => {
    expect(parseTsv('\t\tc\n')).toEqual([['', '', 'c']])
    expect(parseTsv('a\t\n')).toEqual([['a', '']])
  })

  it('reads quoted fields with tabs, line breaks and doubled quotes', () => {
    expect(parseTsv('"line 1\nline 2"\t"say ""hi"""\r\nz\t"a\tb"')).toEqual([
      ['line 1\nline 2', 'say "hi"'],
      ['z', 'a\tb'],
    ])
  })

  it('treats a quote inside a field literally', () => {
    expect(parseTsv('5" floppy\tx')).toEqual([['5" floppy', 'x']])
  })
})
