/**
 * An EXPLAIN (FORMAT JSON) plan as compact indented text for the model: one line per node with what
 * matters for tuning (rows estimated vs actual, time, loops, conditions) — the raw JSON would eat the
 * context window of a 16k-token model.
 */
export function planText(json: string, max = 8000): string {
  let root: Record<string, unknown>
  try {
    root = (JSON.parse(json) as Record<string, unknown>[])[0]
  } catch {
    return ''
  }
  const lines: string[] = []
  const conds = [
    'Index Cond',
    'Recheck Cond',
    'Filter',
    'Join Filter',
    'Hash Cond',
    'Merge Cond',
    'Sort Key',
    'Group Key',
  ]
  const walk = (n: Record<string, unknown>, depth: number) => {
    const name = [
      n['Node Type'],
      n['Index Name'] ? `using ${n['Index Name']}` : '',
      n['Relation Name']
        ? `on ${n['Relation Name']}${n['Alias'] && n['Alias'] !== n['Relation Name'] ? ` ${n['Alias']}` : ''}`
        : '',
    ]
      .filter(Boolean)
      .join(' ')
    const stats: string[] = [`est ${n['Plan Rows']} rows`, `cost ${n['Total Cost']}`]
    if (n['Actual Rows'] !== undefined)
      stats.push(`actual ${n['Actual Rows']} rows`, `${n['Actual Total Time']} ms`)
    if ((n['Actual Loops'] as number) > 1) stats.push(`× ${n['Actual Loops']} loops`)
    if (n['Rows Removed by Filter']) stats.push(`removed by filter ${n['Rows Removed by Filter']}`)
    if (n['Sort Method'])
      stats.push(`sort ${n['Sort Method']}${n['Sort Space Type'] === 'Disk' ? ' on disk' : ''}`)
    const pad = '  '.repeat(depth)
    lines.push(`${pad}${name} (${stats.join(', ')})`)
    for (const c of conds) {
      const v = n[c]
      if (v) lines.push(`${pad}  ${c}: ${Array.isArray(v) ? v.join(', ') : v}`)
    }
    for (const child of (n['Plans'] as Record<string, unknown>[] | undefined) ?? []) walk(child, depth + 1)
  }
  walk(root['Plan'] as Record<string, unknown>, 0)
  if (root['Execution Time'] !== undefined) lines.push(`Execution time: ${root['Execution Time']} ms`)
  const text = lines.join('\n')
  return text.length > max ? text.slice(0, max) + '\n…(cut)' : text
}
