/**
 * EXPLAIN (FORMAT JSON) → an annotated tree for the visual plan. Pure functions, unit-tested.
 *
 * Times: Postgres reports per-loop averages, and for parallel nodes the average per process. A node's
 * inclusive wall time ≈ Actual Total Time × loops ÷ parallelism; its own (exclusive) time is that minus
 * its children's — clamped at 0, because parallel and early-terminated nodes don't add up exactly.
 */

type Raw = Record<string, unknown>

export interface PlanNode {
  id: number
  type: string
  /** "Seq Scan on users u", "Hash Join (Inner)", "Gather (2 workers)" */
  title: string
  /** The most telling condition: Index Cond, Filter, Hash Cond, Sort Key… */
  detail: string | null
  relationship: string | null
  children: PlanNode[]
  /** Raw properties for the detail pane (without Plans). */
  props: [string, unknown][]
  depth: number

  /** ms; null without ANALYZE */
  inclusiveMs: number | null
  exclusiveMs: number | null
  /** Share of the whole query: exclusive time with ANALYZE, else exclusive cost. */
  share: number
  cost: number
  exclusiveCost: number
  actualRows: number | null
  planRows: number
  loops: number
  /** actual / estimated (> 1 = more rows than expected); null when not meaningful */
  misestimate: number | null
  neverExecuted: boolean
  buffers: { hit: number; read: number; written: number; temp: number }
  warnings: string[]
}

export interface Plan {
  root: PlanNode
  analyze: boolean
  planningMs: number | null
  executionMs: number | null
  jitMs: number | null
  triggers: { name: string; ms: number; calls: number }[]
  settings: Record<string, string>
  nodes: PlanNode[]
  slowest: PlanNode | null
  worstMisestimate: PlanNode | null
  /** shared buffers hit / (hit + read), whole plan */
  cacheHitRatio: number | null
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const str = (v: unknown): string | null =>
  typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : null

export function parsePlan(json: string | unknown[]): Plan {
  const doc = (typeof json === 'string' ? JSON.parse(json) : json) as Raw[]
  const top = doc[0]
  const rawRoot = top['Plan'] as Raw
  const analyze = 'Actual Total Time' in rawRoot || 'Actual Loops' in rawRoot

  let nextId = 0
  const nodes: PlanNode[] = []

  const build = (raw: Raw, depth: number, parallelism: number, parent: Raw | null): PlanNode => {
    const type = String(raw['Node Type'])
    const workers = num(raw['Workers Launched'] ?? raw['Workers Planned'])
    // Children of a Gather run in every launched worker plus the leader.
    const childParallelism = type === 'Gather' || type === 'Gather Merge' ? workers + 1 : parallelism
    const loops = num(raw['Actual Loops'])
    const neverExecuted = analyze && loops === 0

    const node: PlanNode = {
      id: nextId++,
      type,
      title: title(raw),
      detail: detail(raw),
      relationship: str(raw['Parent Relationship']),
      children: [],
      props: Object.entries(raw).filter(([k]) => k !== 'Plans'),
      depth,
      inclusiveMs: analyze ? (num(raw['Actual Total Time']) * loops) / Math.max(1, parallelism) : null,
      exclusiveMs: null,
      share: 0,
      cost: num(raw['Total Cost']),
      exclusiveCost: 0,
      actualRows: analyze ? num(raw['Actual Rows']) : null,
      planRows: num(raw['Plan Rows']),
      loops,
      misestimate: null,
      neverExecuted,
      buffers: {
        hit: num(raw['Shared Hit Blocks']),
        read: num(raw['Shared Read Blocks']),
        written: num(raw['Shared Written Blocks']),
        temp: num(raw['Temp Read Blocks']) + num(raw['Temp Written Blocks']),
      },
      warnings: [],
    }
    nodes.push(node)
    node.children = ((raw['Plans'] as Raw[] | undefined) ?? []).map((c) =>
      build(c, depth + 1, childParallelism, raw),
    )

    const childMs = node.children.reduce((s, c) => s + (c.inclusiveMs ?? 0), 0)
    node.exclusiveMs = node.inclusiveMs == null ? null : Math.max(0, node.inclusiveMs - childMs)
    node.exclusiveCost = Math.max(0, node.cost - node.children.reduce((s, c) => s + c.cost, 0))
    node.misestimate = misestimate(node, parent)
    node.warnings = warnings(raw, node)
    return node
  }

  const root = build(rawRoot, 0, 1, null)
  const totalMs = analyze ? Math.max(root.inclusiveMs ?? 0, 1e-9) : 0
  const totalCost = Math.max(root.cost, 1e-9)
  for (const n of nodes) n.share = analyze ? (n.exclusiveMs ?? 0) / totalMs : n.exclusiveCost / totalCost

  const slowest = nodes.reduce<PlanNode | null>((a, n) => (!a || n.share > a.share ? n : a), null)
  const worstMisestimate = nodes
    .filter((n) => n.misestimate != null)
    .reduce<PlanNode | null>((a, n) => (!a || factor(n.misestimate!) > factor(a.misestimate!) ? n : a), null)
  const hit = nodes.reduce((s, n) => s + n.buffers.hit, 0)
  const read = nodes.reduce((s, n) => s + n.buffers.read, 0)
  const jit = top['JIT'] as Raw | undefined
  const timing = jit?.['Timing'] as Raw | undefined

  return {
    root,
    analyze,
    planningMs: typeof top['Planning Time'] === 'number' ? (top['Planning Time'] as number) : null,
    executionMs: typeof top['Execution Time'] === 'number' ? (top['Execution Time'] as number) : null,
    jitMs: timing ? num(timing['Total']) : null,
    triggers: ((top['Triggers'] as Raw[] | undefined) ?? []).map((t) => ({
      name: String(t['Trigger Name']),
      ms: num(t['Time']),
      calls: num(t['Calls']),
    })),
    settings: (top['Settings'] as Record<string, string> | undefined) ?? {},
    nodes,
    slowest: slowest && slowest.share > 0 ? slowest : null,
    worstMisestimate:
      worstMisestimate && factor(worstMisestimate.misestimate!) >= 10 ? worstMisestimate : null,
    cacheHitRatio: hit + read > 0 ? hit / (hit + read) : null,
  }
}

/** How far off an estimate is, regardless of direction: 0.01 and 100 are both 100×. */
export const factor = (ratio: number) => (ratio >= 1 ? ratio : 1 / ratio)

function misestimate(node: PlanNode, parent: Raw | null): number | null {
  if (node.actualRows == null || node.neverExecuted) return null
  // A scan under Limit or as a Merge Join input stops early — fewer rows than planned is expected there.
  const parentType = parent ? String(parent['Node Type']) : ''
  if (node.actualRows < node.planRows && (parentType === 'Limit' || parentType === 'Merge Join')) return null
  const actual = Math.max(node.actualRows, 1)
  const planned = Math.max(node.planRows, 1)
  return actual / planned
}

function title(raw: Raw): string {
  // ModifyTable says what it modifies in Operation: "Update on users" reads better.
  const type =
    raw['Node Type'] === 'ModifyTable' && raw['Operation']
      ? String(raw['Operation'])
      : String(raw['Node Type'])
  const on = raw['Relation Name']
    ? ` on ${raw['Schema'] ? `${raw['Schema']}.` : ''}${raw['Relation Name']}${raw['Alias'] && raw['Alias'] !== raw['Relation Name'] ? ` ${raw['Alias']}` : ''}`
    : raw['CTE Name']
      ? ` on ${raw['CTE Name']}`
      : raw['Function Name']
        ? ` on ${raw['Function Name']}`
        : ''
  const using = raw['Index Name'] ? ` using ${raw['Index Name']}` : ''
  const join = raw['Join Type'] && raw['Join Type'] !== 'Inner' ? ` (${raw['Join Type']})` : ''
  const strategy =
    type === 'Aggregate' && raw['Strategy'] && raw['Strategy'] !== 'Plain'
      ? ` (${raw['Strategy']}${raw['Partial Mode'] && raw['Partial Mode'] !== 'Simple' ? `, ${raw['Partial Mode']}` : ''})`
      : type === 'Aggregate' && raw['Partial Mode'] && raw['Partial Mode'] !== 'Simple'
        ? ` (${raw['Partial Mode']})`
        : ''
  const workers =
    raw['Workers Launched'] != null
      ? ` (${raw['Workers Launched']} workers)`
      : raw['Workers Planned'] != null
        ? ` (${raw['Workers Planned']} workers planned)`
        : ''
  const parallel = raw['Parallel Aware'] === true ? 'Parallel ' : ''
  return `${parallel}${type}${using}${on}${join}${strategy}${workers}`
}

function detail(raw: Raw): string | null {
  for (const key of [
    'Index Cond',
    'Recheck Cond',
    'Hash Cond',
    'Merge Cond',
    'Join Filter',
    'Filter',
    'Sort Key',
    'Group Key',
    'One-Time Filter',
  ]) {
    const v = str(raw[key])
    if (v) return `${key.replace(' Cond', '')}: ${v}`
  }
  return null
}

function warnings(raw: Raw, node: PlanNode): string[] {
  const w: string[] = []
  if (node.misestimate != null && factor(node.misestimate) >= 10) {
    const dir = node.misestimate > 1 ? 'more' : 'fewer'
    w.push(
      `Returned ${Math.round(factor(node.misestimate)).toLocaleString()}× ${dir} rows than estimated — stale statistics (ANALYZE) or correlated conditions can mislead the planner.`,
    )
  }
  const removed = num(raw['Rows Removed by Filter'])
  const kept = (node.actualRows ?? 0) * Math.max(1, node.loops)
  if (removed > 1000 && removed > kept * 9 && /Seq Scan/.test(node.type))
    w.push(
      `The filter threw away ${removed.toLocaleString()} rows to keep ${Math.round(kept).toLocaleString()} — an index on the filtered columns may help.`,
    )
  if (raw['Sort Space Type'] === 'Disk' || /external/i.test(String(raw['Sort Method'] ?? '')))
    w.push(
      `Sort spilled to disk (${num(raw['Sort Space Used']).toLocaleString()} kB) — more work_mem, or an index matching the sort, would keep it in memory.`,
    )
  if (num(raw['Hash Batches']) > 1)
    w.push(
      `Hash used ${num(raw['Hash Batches'])} batches (spilled to disk) — work_mem is too small for this hash table.`,
    )
  if (node.type === 'Nested Loop' && node.children[1] && node.children[1].loops > 1000)
    w.push(
      `The inner side ran ${node.children[1].loops.toLocaleString()} times — fine with a tight index lookup, slow otherwise.`,
    )
  if (num(raw['Heap Fetches']) > 1000)
    w.push(
      `Index-only scan still fetched ${num(raw['Heap Fetches']).toLocaleString()} rows from the table — VACUUM would update the visibility map.`,
    )
  if (node.buffers.temp > 0 && !w.some((x) => /disk|batches/.test(x)))
    w.push(`Used ${node.buffers.temp.toLocaleString()} temporary blocks on disk.`)
  return w
}
