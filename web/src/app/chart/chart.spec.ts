import { describe, expect, it } from 'vitest'
import { buildSeries, compact, defaultSpec, niceTicks, parseTime, reconcile, timeTicks } from './chart'

const col = (name: string, type: string) => ({ name, type })

describe('defaultSpec', () => {
  it('puts time on x and the numbers as series, as a line', () => {
    expect(
      defaultSpec([col('n', 'text'), col('day', 'date'), col('a', 'int8'), col('b', 'numeric')]),
    ).toEqual({
      x: 1,
      ys: [2, 3],
      kind: 'line',
    })
  })

  it('uses categories as bars, and gives up without a number', () => {
    expect(defaultSpec([col('status', 'text'), col('count', 'int8')])).toEqual({ x: 0, ys: [1], kind: 'bar' })
    expect(defaultSpec([col('a', 'text'), col('b', 'text')])).toBeNull()
  })

  it('keeps the chosen columns across a re-run by name', () => {
    const before = [col('day', 'date'), col('a', 'int8'), col('b', 'int8')]
    const after = [col('b', 'int8'), col('day', 'date'), col('c', 'int8')]
    expect(reconcile({ x: 0, ys: [2], kind: 'bar' }, after, before)).toEqual({ x: 1, ys: [0], kind: 'bar' })
  })
})

describe('buildSeries', () => {
  it('sums rows that share an x, skips null x, keeps category order', () => {
    const s = buildSeries(
      'text',
      ['b', 'a', 'b', null],
      [
        ['1', '2', '3', '4'],
        ['x', null, '1', '1'],
      ],
    )
    expect(s.points.map((p) => [p.label, p.ys])).toEqual([
      ['b', [4, 1]],
      ['a', [2, null]],
    ])
    expect(s.summed).toBe(true)
    expect(s.skipped).toBe(1)
  })

  it('sorts time ascending', () => {
    const s = buildSeries('time', ['2026-10-02', '2026-10-01'], [['1', '2']])
    expect(s.points.map((p) => p.label)).toEqual(['2026-10-01', '2026-10-02'])
  })
})

describe('axes', () => {
  it('parses Postgres timestamps', () => {
    expect(parseTime('2026-10-22 19:28:26.29+02')).toBe(Date.UTC(2026, 9, 22, 17, 28, 26, 290))
    expect(parseTime('nope')).toBeNaN()
  })

  it('makes round ticks that cover the range', () => {
    expect(niceTicks(0, 87)).toEqual([0, 20, 40, 60, 80, 100])
    expect(niceTicks(-3, 3)).toEqual([-4, -2, 0, 2, 4])
  })

  it('makes daily ticks for a two-week range', () => {
    const from = new Date(2026, 9, 1).getTime()
    const { ticks } = timeTicks(from, from + 13 * 86_400_000)
    expect(ticks.length).toBeGreaterThan(1)
    expect(ticks.every((t) => new Date(t).getHours() === 0)).toBe(true)
  })

  it('compacts big numbers', () => {
    expect([compact(950), compact(1284), compact(12_900), compact(4_200_000), compact(0.25)]).toEqual([
      '950',
      '1.3K',
      '12.9K',
      '4.2M',
      '0.25',
    ])
  })
})
