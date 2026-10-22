export interface FuzzyMatch {
  score: number
  /** Indexes of matched characters in the text, for highlighting. */
  positions: number[]
}

const isBoundary = (text: string, i: number) =>
  i === 0 || /[\s_.\-/(:]/.test(text[i - 1]) || (/[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i]))

/**
 * Subsequence match with the usual preferences: consecutive runs, word starts (`ua` → *u*sers_*a*udit),
 * an early first hit and shorter texts score higher. Case-insensitive. Null when not every query
 * character appears in order.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase()
  if (!q) return { score: 0, positions: [] }
  const t = text.toLowerCase()

  // A substring starting at a word beats everything; one buried mid-word ranks below initials
  // (`ua` → users_audit over quartz).
  const sub = t.indexOf(q)
  if (sub >= 0) {
    const positions = Array.from({ length: q.length }, (_, i) => sub + i)
    return { score: (isBoundary(text, sub) ? 1200 : 300) - sub - text.length / 10, positions }
  }

  const positions: number[] = []
  let score = 0
  let ti = 0
  let prev = -2
  for (const ch of q) {
    // Prefer the next occurrence at a word boundary, else the next occurrence at all.
    let found = -1
    for (let j = ti; j < t.length; j++) {
      if (t[j] !== ch) continue
      if (found < 0) found = j
      if (isBoundary(text, j) || j === prev + 1) {
        found = j
        break
      }
    }
    if (found < 0) return null
    score += found === prev + 1 ? 30 : isBoundary(text, found) ? 20 : 1
    positions.push(found)
    prev = found
    ti = found + 1
  }
  // Every letter on a word start: an acronym-style match, which is intentional typing.
  const initials = positions.every((p, i) => isBoundary(text, p) || (i > 0 && p === positions[i - 1] + 1))
  return { score: score + (initials ? 400 : 0) - positions[0] - text.length / 10, positions }
}

/** Splits text into highlighted / plain runs for rendering. */
export function highlight(text: string, positions: number[]): { text: string; hit: boolean }[] {
  const hits = new Set(positions)
  const out: { text: string; hit: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i)
    const last = out[out.length - 1]
    if (last && last.hit === hit) last.text += text[i]
    else out.push({ text: text[i], hit })
  }
  return out
}
