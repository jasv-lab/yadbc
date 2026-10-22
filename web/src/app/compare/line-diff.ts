/** One row of a side-by-side diff: a line on either side, or both when they're equal. */
export interface DiffRow {
  left: string | null
  right: string | null
  same: boolean
}

/**
 * Line-by-line diff (longest common subsequence) laid out side by side: equal lines line up, and a run
 * of changes pairs removed lines with added ones row by row. Definitions are short; O(n·m) is fine.
 */
export function sideBySide(left: string, right: string): DiffRow[] {
  const a = left.split('\n')
  const b = right.split('\n')
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])

  const rows: DiffRow[] = []
  let dels: string[] = []
  let adds: string[] = []
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++)
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null, same: false })
    dels = []
    adds = []
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush()
      rows.push({ left: a[i], right: b[j], same: true })
      i++
      j++
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) adds.push(b[j++])
    else dels.push(a[i++])
  }
  flush()
  return rows
}
