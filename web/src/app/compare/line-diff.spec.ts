import { describe, expect, it } from 'vitest'
import { sideBySide } from './line-diff'

describe('sideBySide', () => {
  it('lines up equal lines and pairs changed ones', () => {
    expect(sideBySide('a\nb\nc\nd', 'a\nB\nc\nd\ne')).toEqual([
      { left: 'a', right: 'a', same: true },
      { left: 'b', right: 'B', same: false },
      { left: 'c', right: 'c', same: true },
      { left: 'd', right: 'd', same: true },
      { left: null, right: 'e', same: false },
    ])
  })

  it('shows a one-sided definition as all changes', () => {
    expect(sideBySide('x', '')).toEqual([{ left: 'x', right: '', same: false }])
  })
})
