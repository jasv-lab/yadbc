import { describe, expect, it } from 'vitest'
import join from './fixtures/join.json'
import parallel from './fixtures/parallel.json'
import { factor, parsePlan } from './plan'

/** Minimal ANALYZE node for synthetic plans. */
function node(
  type: string,
  ms: number,
  rows: number,
  planRows: number,
  extra: Record<string, unknown> = {},
  plans: unknown[] = [],
) {
  return {
    'Node Type': type,
    'Total Cost': 100,
    'Plan Rows': planRows,
    'Actual Total Time': ms,
    'Actual Rows': rows,
    'Actual Loops': 1,
    ...extra,
    ...(plans.length ? { Plans: plans } : {}),
  }
}

describe('parsePlan — real PG 18 output', () => {
  it('reads the join plan: titles, details, timing summary', () => {
    const p = parsePlan(join)
    expect(p.analyze).toBe(true)
    expect(p.nodes.map((n) => n.type)).toEqual([
      'Sort',
      'Aggregate',
      'Merge Join',
      'Index Scan',
      'Sort',
      'Seq Scan',
    ])
    expect(p.planningMs).toBeGreaterThan(0)
    expect(p.executionMs).toBeGreaterThan(0)
    const index = p.nodes[3]
    // Without VERBOSE, Postgres names relations without their schema.
    expect(index.title).toBe('Index Scan using users_pkey on users u')
    expect(p.nodes[5].title).toBe('Seq Scan on invoices i')
    expect(p.nodes[2].detail).toMatch(/^Merge: /)
  })

  it('does not flag an index scan stopped early by its Merge Join as a misestimate', () => {
    const p = parsePlan(join)
    const index = p.nodes[3]
    expect(index.actualRows).toBeLessThan(index.planRows / 10)
    expect(index.misestimate).toBeNull()
    expect(index.warnings).toEqual([])
  })

  it('shares add up to the whole query', () => {
    const p = parsePlan(join)
    const sum = p.nodes.reduce((s, n) => s + n.share, 0)
    expect(sum).toBeGreaterThan(0.99)
    expect(sum).toBeLessThan(1.01)
  })

  it('divides parallel nodes by the processes that ran them', () => {
    const p = parsePlan(parallel)
    const gather = p.nodes.find((n) => n.type === 'Gather')!
    const scan = p.nodes.find((n) => n.type.includes('Seq Scan'))!
    expect(gather.title).toBe('Gather (2 workers)')
    expect(scan.title).toBe('Parallel Seq Scan on users')
    expect(scan.loops).toBe(3)
    // 3 loops × avg time ÷ 3 processes = the per-process average, not three times it.
    const raw = (parallel as any)[0].Plan.Plans[0].Plans[0].Plans[0]['Actual Total Time']
    expect(scan.inclusiveMs).toBeCloseTo(raw, 5)
    expect(p.nodes.every((n) => (n.exclusiveMs ?? 0) >= 0)).toBe(true)
  })
})

describe('parsePlan — warnings', () => {
  const plan = (root: unknown) => parsePlan([{ Plan: root, 'Execution Time': 10 }])

  it('flags big misestimates in either direction', () => {
    const p = plan(
      node('Hash Join', 5, 50_000, 10, {}, [node('Seq Scan', 1, 50_000, 50_000), node('Hash', 1, 10, 10)]),
    )
    expect(factor(p.root.misestimate!)).toBe(5000)
    expect(p.worstMisestimate).toBe(p.root)
    expect(p.root.warnings[0]).toMatch(/5,000× more rows than estimated/)
  })

  it('flags filters that discard most rows, disk sorts, hash batches and busy nested loops', () => {
    const scan = plan(
      node('Seq Scan', 9, 10, 10, { 'Rows Removed by Filter': 99_990, 'Relation Name': 'users' }),
    )
    expect(scan.root.warnings.join()).toMatch(/threw away 99,990 rows to keep 10/)

    const sort = plan(
      node('Sort', 9, 10, 10, {
        'Sort Method': 'external merge',
        'Sort Space Type': 'Disk',
        'Sort Space Used': 4096,
      }),
    )
    expect(sort.root.warnings.join()).toMatch(/spilled to disk \(4,096 kB\)/)

    const hash = plan(node('Hash', 9, 10, 10, { 'Hash Batches': 8 }))
    expect(hash.root.warnings.join()).toMatch(/8 batches/)

    const inner = { ...node('Index Scan', 0.01, 1, 1), 'Actual Loops': 5000 }
    const loop = plan(node('Nested Loop', 9, 5000, 5000, {}, [node('Seq Scan', 1, 5000, 5000), inner]))
    expect(loop.root.warnings.join()).toMatch(/inner side ran 5,000 times/)
  })

  it('works without ANALYZE: shares from cost, no timing', () => {
    const p = parsePlan([
      {
        Plan: {
          'Node Type': 'Hash Join',
          'Total Cost': 100,
          'Plan Rows': 5,
          Plans: [
            { 'Node Type': 'Seq Scan', 'Total Cost': 60, 'Plan Rows': 5 },
            { 'Node Type': 'Hash', 'Total Cost': 20, 'Plan Rows': 5 },
          ],
        },
      },
    ])
    expect(p.analyze).toBe(false)
    expect(p.root.inclusiveMs).toBeNull()
    expect(p.root.share).toBeCloseTo(0.2)
    expect(p.slowest?.type).toBe('Seq Scan')
  })
})
