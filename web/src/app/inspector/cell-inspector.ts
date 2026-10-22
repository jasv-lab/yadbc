import { effect, inject, Injectable, signal, untracked } from '@angular/core'
import { Session } from '../core/session'
import { Column } from '../core/protocol'
import { EditorTab, ResultView } from '../workspace/workspace'

export interface CellRef {
  resultId: string
  row: number
  col: number
  column: Column
}

/**
 * State of the right-hand drawer's cell inspector. The grid reports its active cell here all the
 * time; the drawer shows it when open, so the inspector follows the cursor as you walk the rows.
 */
@Injectable({ providedIn: 'root' })
export class CellInspector {
  readonly target = signal<CellRef | null>(null)
  readonly open = signal(false)
  /** One view at a time: the cell inspector or the staged-edits review. */
  readonly view = signal<'cell' | 'edits' | 'search' | 'ai'>('cell')
  /** Whose staged edits the Edits view reviews. */
  readonly editsTarget = signal<{ tab: EditorTab; result: ResultView } | null>(null)
  /** Pinned = push mode (layout makes room); unpinned = overlay that keeps the grid's width stable. */
  readonly pinned = signal(false)
  readonly width = signal(440)

  private readonly session = inject(Session)

  constructor() {
    effect(() => {
      if (!this.session.loaded()) return
      untracked(() => {
        this.pinned.set(this.session.pref('drawerPinned', false))
        this.width.set(this.session.pref('drawerWidth', 440))
      })
    })
  }

  follow(ref: CellRef | null) {
    const t = this.target()
    if (t?.resultId === ref?.resultId && t?.row === ref?.row && t?.col === ref?.col) return
    this.target.set(ref)
  }

  show() {
    this.view.set('cell')
    this.open.set(true)
  }

  showAi() {
    this.view.set('ai')
    this.open.set(true)
  }

  showSearch() {
    this.view.set('search')
    this.open.set(true)
  }

  showEdits(tab: EditorTab, result: ResultView) {
    this.editsTarget.set({ tab, result })
    this.view.set('edits')
    this.open.set(true)
  }

  toggle() {
    this.open.update((v) => !v)
  }

  close() {
    this.open.set(false)
  }

  setPinned(pinned: boolean) {
    this.pinned.set(pinned)
    this.session.setPref('drawerPinned', pinned)
  }

  setWidth(width: number) {
    this.width.set(width)
    this.session.setPref('drawerWidth', Math.round(width))
  }
}
