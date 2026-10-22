import { PlanNode } from './plan'

export const CARD_W = 252
export const CARD_H = 92
const H_GAP = 24
const V_GAP = 46
const MARGIN = 24

export interface Placed {
  node: PlanNode
  x: number
  y: number
}

export interface Edge {
  from: Placed
  to: Placed
  /** 1–7px, by rows flowing through it (log scale) */
  width: number
}

/**
 * Top-down tidy tree: each subtree takes the width of its children side by side (at least one
 * card), and a parent is centred over its children. Plans are deep rather than wide, so this stays
 * readable without a general graph layout.
 */
export function layoutPlan(root: PlanNode): {
  placed: Placed[]
  edges: Edge[]
  width: number
  height: number
} {
  const widths = new Map<number, number>()
  const measure = (n: PlanNode): number => {
    const w = n.children.length
      ? Math.max(CARD_W, n.children.reduce((s, c) => s + measure(c), 0) + H_GAP * (n.children.length - 1))
      : CARD_W
    widths.set(n.id, w)
    return w
  }
  measure(root)

  const placed: Placed[] = []
  const byId = new Map<number, Placed>()
  const place = (n: PlanNode, left: number, depth: number) => {
    const w = widths.get(n.id)!
    let x = left + (w - CARD_W) / 2
    if (n.children.length) {
      const childrenWidth =
        n.children.reduce((s, c) => s + widths.get(c.id)!, 0) + H_GAP * (n.children.length - 1)
      let cx = left + (w - childrenWidth) / 2
      const centres: number[] = []
      for (const c of n.children) {
        place(c, cx, depth + 1)
        // Placed x includes the margin; centre in layout coordinates (margin added once, below).
        centres.push(byId.get(c.id)!.x - MARGIN + CARD_W / 2)
        cx += widths.get(c.id)! + H_GAP
      }
      x = (centres[0] + centres[centres.length - 1]) / 2 - CARD_W / 2
    }
    const p = { node: n, x: MARGIN + x, y: MARGIN + depth * (CARD_H + V_GAP) }
    placed.push(p)
    byId.set(n.id, p)
  }
  place(root, 0, 0)

  const rowsThrough = (n: PlanNode) => (n.actualRows ?? n.planRows) * Math.max(1, n.loops)
  const maxRows = Math.max(1, ...placed.map((p) => rowsThrough(p.node)))
  const edges: Edge[] = placed.flatMap((p) =>
    p.node.children.map((c) => {
      const to = byId.get(c.id)!
      return { from: p, to, width: 1 + 6 * (Math.log10(rowsThrough(c) + 1) / Math.log10(maxRows + 1)) }
    }),
  )

  const maxDepth = Math.max(...placed.map((p) => p.node.depth))
  return {
    placed,
    edges,
    width: widths.get(root.id)! + MARGIN * 2,
    height: (maxDepth + 1) * (CARD_H + V_GAP) - V_GAP + MARGIN * 2,
  }
}

/** Parent bottom-centre → child top-centre, as a smooth vertical S. */
export function edgePath(e: Edge): string {
  const x1 = e.from.x + CARD_W / 2
  const y1 = e.from.y + CARD_H
  const x2 = e.to.x + CARD_W / 2
  const y2 = e.to.y
  const mid = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`
}
