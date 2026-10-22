import { describe, expect, it } from 'vitest'
import { blockingTree, formatAge, PgSession } from './activity'

const s = (pid: number, over: Partial<PgSession> = {}): PgSession => ({
  pid,
  database: 'app',
  user: 'u',
  application: 'psql',
  client: null,
  backendType: 'client backend',
  state: 'active',
  waitType: null,
  wait: null,
  backendSeconds: 100,
  xactSeconds: 10,
  querySeconds: 10,
  stateSeconds: 10,
  blockedBy: [],
  query: 'select 1',
  canSignal: true,
  ...over,
})

describe('blockingTree', () => {
  it('nests a lock queue under its head, biggest pile-up first', () => {
    // 1 holds a row lock; 2 waits on 1; 3 (ALTER) waits on 1 and 2; 4 (SELECT) queues behind 3.
    const rows = blockingTree([
      s(9, { querySeconds: 500 }),
      s(4, { blockedBy: [3], waitType: 'Lock' }),
      s(3, { blockedBy: [2, 1], waitType: 'Lock' }),
      s(2, { blockedBy: [1], waitType: 'Lock' }),
      s(1, { state: 'idle in transaction', xactSeconds: 300 }),
    ])
    expect(rows.map((r) => [r.session.pid, r.depth, r.blocking])).toEqual([
      [1, 0, 3],
      [2, 1, 2],
      [3, 2, 1],
      [4, 3, 0],
      [9, 0, 0],
    ])
    expect(rows.find((r) => r.session.pid === 3)!.alsoBlockedBy).toEqual([1])
  })

  it('treats a blocker outside the list as no parent', () => {
    const rows = blockingTree([s(2, { blockedBy: [77], waitType: 'Lock' })])
    expect(rows).toEqual([{ session: expect.anything(), depth: 0, blocking: 0, alsoBlockedBy: [77] }])
  })

  it('survives a cycle in a bad snapshot', () => {
    const rows = blockingTree([s(1, { blockedBy: [2] }), s(2, { blockedBy: [1] })])
    expect(rows.map((r) => r.session.pid).sort()).toEqual([1, 2])
  })
})

describe('formatAge', () => {
  it('stays short', () => {
    expect([0.42, 12.7, 185, 3725, 2 * 86400 + 3 * 3600].map(formatAge)).toEqual([
      '0.4s',
      '12s',
      '3m 05s',
      '1h 02m',
      '2d 3h',
    ])
    expect(formatAge(null)).toBe('')
  })
})
