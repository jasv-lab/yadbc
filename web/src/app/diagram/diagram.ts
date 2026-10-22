import { HttpClient } from '@angular/common/http'
import { inject, Injectable } from '@angular/core'
import { Observable } from 'rxjs'
import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk.bundled.js'

export interface DiagramColumn {
  name: string
  type: string
  notNull: boolean
  primaryKey: boolean
  foreignKey: boolean
}

export interface DiagramTable {
  id: string
  schema: string
  name: string
  estRows: number
  comment: string | null
  /** From another schema, here because a foreign key crosses over. */
  external: boolean
  columns: DiagramColumn[]
}

export interface DiagramRelation {
  name: string
  from: { table: string; columns: string[] }
  to: { table: string; columns: string[] }
  /** Some referencing column may be NULL: an optional relation. */
  nullable: boolean
}

export interface DiagramData {
  schema: string
  tables: DiagramTable[]
  relations: DiagramRelation[]
}

@Injectable({ providedIn: 'root' })
export class DiagramApi {
  private readonly http = inject(HttpClient)

  load(connectionId: string, schema: string): Observable<DiagramData> {
    return this.http.get<DiagramData>(`/api/catalog/${connectionId}/diagram`, { params: { schema } })
  }
}

// ── Layout ─────────────────────────────────────────────────────────────────

export const HEADER = 38
export const ROW = 22
const PAD = 8
const MAX_ROWS = 14
const MIN_W = 190
const MAX_W = 340

export interface CardRow {
  name: string
  type: string
  pk: boolean
  fk: boolean
  notNull: boolean
}

export interface LaidTable {
  table: DiagramTable
  x: number
  y: number
  w: number
  h: number
  rows: CardRow[]
  /** Columns not shown (collapsed card / keys-only). */
  more: number
}

export interface LaidEdge {
  relation: DiagramRelation
  path: string
}

export interface DiagramLayout {
  tables: LaidTable[]
  edges: LaidEdge[]
  width: number
  height: number
  /** Top of the "not related" grid, if there is one. */
  looseTop: number | null
}

/**
 * Key columns always show (relations attach to them); the rest fill up to MAX_ROWS in table order, or
 * are hidden entirely in keys-only mode.
 */
export function visibleRows(t: DiagramTable, keysOnly: boolean): { rows: CardRow[]; more: number } {
  const all = t.columns
  const isKey = (c: DiagramColumn) => c.primaryKey || c.foreignKey
  let shown: DiagramColumn[]
  if (keysOnly || t.external) shown = all.filter(isKey)
  else if (all.length <= MAX_ROWS) shown = all
  else {
    const keys = all.filter(isKey).length
    let others = Math.max(0, MAX_ROWS - 1 - keys)
    shown = all.filter((c) => isKey(c) || others-- > 0)
  }
  return {
    rows: shown.map((c) => ({
      name: c.name,
      type: c.type,
      pk: c.primaryKey,
      fk: c.foreignKey,
      notNull: c.notNull,
    })),
    more: all.length - shown.length,
  }
}

let measureCtx: CanvasRenderingContext2D | null = null
function textWidth(text: string, font: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * 7
  measureCtx.font = font
  return measureCtx.measureText(text).width
}

function cardWidth(t: DiagramTable, rows: CardRow[]): number {
  const title =
    textWidth(
      t.external ? `${t.schema}.${t.name}` : t.name,
      '600 13px "Segoe UI Variable Text", "Segoe UI"',
    ) + 90
  const body = Math.max(
    0,
    ...rows.map(
      (r) => textWidth(r.name, '12px "JetBrains Mono"') + textWidth(r.type, '11px "JetBrains Mono"') + 56,
    ),
  )
  return Math.round(Math.min(MAX_W, Math.max(MIN_W, title, body)))
}

/** Rounded corners on an orthogonal polyline. */
export function roundedPath(points: { x: number; y: number }[], radius = 8): string {
  if (!points.length) return ''
  let d = `M${points[0].x},${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]]
    const d1 = Math.hypot(b.x - a.x, b.y - a.y)
    const d2 = Math.hypot(c.x - b.x, c.y - b.y)
    const r = Math.min(radius, d1 / 2, d2 / 2)
    if (r < 0.5) {
      d += ` L${b.x},${b.y}`
      continue
    }
    const p = { x: b.x - ((b.x - a.x) / d1) * r, y: b.y - ((b.y - a.y) / d1) * r }
    const q = { x: b.x + ((c.x - b.x) / d2) * r, y: b.y + ((c.y - b.y) / d2) * r }
    d += ` L${p.x},${p.y} Q${b.x},${b.y} ${q.x},${q.y}`
  }
  const last = points[points.length - 1]
  return d + ` L${last.x},${last.y}`
}

const portId = (table: string, column: string, side: 'E' | 'W') => `${table}\u0000${column}\u0000${side}`

/**
 * A layered (Sugiyama) layout via ELK, flowing left to right along the references: a referenced table
 * (users, a lookup) sits left of the tables pointing at it, crossings are minimized layer by layer, and
 * edges are routed orthogonally between the exact rows — the key column on the referenced table's
 * right edge, the foreign-key column on the referencing table's left edge. Tables without any relation
 * would only scatter that picture; they go to an alphabetical grid underneath.
 */
export async function layoutDiagram(data: DiagramData, keysOnly: boolean): Promise<DiagramLayout> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js')
  const elk = new ELK()

  const byId = new Map(data.tables.map((t) => [t.id, t]))
  const relations = data.relations.filter((r) => byId.has(r.from.table) && byId.has(r.to.table))
  const related = new Set(relations.flatMap((r) => [r.from.table, r.to.table]))

  const cards = new Map<string, Omit<LaidTable, 'x' | 'y'>>()
  for (const t of data.tables) {
    const { rows, more } = visibleRows(t, keysOnly)
    const h = HEADER + Math.max(rows.length, 1) * ROW + (more ? ROW : 0) + PAD
    cards.set(t.id, { table: t, rows, more, w: cardWidth(t, rows), h })
  }

  const rowCenter = (tableId: string, column: string) => {
    const card = cards.get(tableId)!
    const i = card.rows.findIndex((r) => r.name === column)
    return HEADER + (i < 0 ? 0 : i) * ROW + ROW / 2
  }

  const ports = new Map<string, ElkPort[]>()
  const addPort = (table: string, column: string, side: 'E' | 'W') => {
    const id = portId(table, column, side)
    const list = ports.get(table) ?? []
    if (!list.some((p) => p.id === id)) {
      list.push({
        id,
        width: 1,
        height: 1,
        x: side === 'E' ? cards.get(table)!.w : -1,
        y: rowCenter(table, column),
        layoutOptions: { 'elk.port.side': side === 'E' ? 'EAST' : 'WEST' },
      })
      ports.set(table, list)
    }
    return id
  }

  // Edges run from the referenced table to the referencing one, so references flow left → right.
  const edges: ElkExtendedEdge[] = relations.map((r, i) => ({
    id: `e${i}`,
    sources: [addPort(r.to.table, r.to.columns[0], 'E')],
    targets: [addPort(r.from.table, r.from.columns[0], 'W')],
  }))

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': '110',
      'elk.layered.spacing.edgeNodeBetweenLayers': '28',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
      'elk.spacing.nodeNode': '36',
      'elk.spacing.edgeNode': '18',
      'elk.spacing.edgeEdge': '10',
      'elk.spacing.componentComponent': '80',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.separateConnectedComponents': 'true',
      'elk.layered.unnecessaryBendpoints': 'false',
    },
    children: data.tables
      .filter((t) => related.has(t.id))
      .map((t) => ({
        id: t.id,
        width: cards.get(t.id)!.w,
        height: cards.get(t.id)!.h,
        ports: ports.get(t.id) ?? [],
        layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
      })),
    edges,
  }

  const result = related.size ? await elk.layout(graph) : { children: [], edges: [], width: 0, height: 0 }

  const tables: LaidTable[] = []
  for (const n of result.children ?? []) tables.push({ ...cards.get(n.id)!, x: n.x ?? 0, y: n.y ?? 0 })

  const laidEdges: LaidEdge[] = []
  for (const e of (result.edges ?? []) as ElkExtendedEdge[]) {
    const relation = relations[Number(e.id.slice(1))]
    for (const s of e.sections ?? []) {
      laidEdges.push({ relation, path: roundedPath([s.startPoint, ...(s.bendPoints ?? []), s.endPoint]) })
    }
  }

  // Unrelated tables: an alphabetical grid under the graph, as wide as the graph (or 5 cards).
  let width = result.width ?? 0
  let height = result.height ?? 0
  const loose = data.tables.filter((t) => !related.has(t.id)).sort((a, b) => a.name.localeCompare(b.name))
  let looseTop: number | null = null
  if (loose.length) {
    const gap = 36
    const top = height ? height + 90 : 0
    looseTop = top
    const maxRowWidth = Math.max(width, 5 * (MIN_W + gap))
    let x = 0
    let y = top + 30
    let rowH = 0
    for (const t of loose) {
      const card = cards.get(t.id)!
      if (x > 0 && x + card.w > maxRowWidth) {
        x = 0
        y += rowH + gap
        rowH = 0
      }
      tables.push({ ...card, x, y })
      x += card.w + gap
      rowH = Math.max(rowH, card.h)
      width = Math.max(width, x - gap)
    }
    height = y + rowH
  }
  return { tables, edges: laidEdges, width, height, looseTop }
}
