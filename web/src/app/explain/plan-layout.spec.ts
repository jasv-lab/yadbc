import { describe, expect, it } from 'vitest'
import join from './fixtures/join.json'
import { parsePlan } from './plan'
import { CARD_W, layoutPlan } from './plan-layout'

describe('layoutPlan', () => {
  it('centres parents over their children and never overlaps cards on a row', () => {
    const { placed } = layoutPlan(parsePlan(join).root)
    const byId = new Map(placed.map((p) => [p.node.id, p]))
    for (const p of placed) {
      if (!p.node.children.length) continue
      const kids = p.node.children.map((c) => byId.get(c.id)!)
      const mid = (kids[0].x + kids[kids.length - 1].x) / 2
      expect(p.x).toBeCloseTo(mid)
    }
    const rows = new Map<number, number[]>()
    placed.forEach((p) => rows.set(p.y, [...(rows.get(p.y) ?? []), p.x]))
    for (const xs of rows.values()) {
      xs.sort((a, b) => a - b)
      for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(CARD_W)
    }
  })
})
