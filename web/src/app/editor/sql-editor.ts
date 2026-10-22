import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  untracked,
} from '@angular/core'
import type * as Monaco from 'monaco-editor'
import { RunError, Statement } from '../core/protocol'
import { splitSql, statementAt } from '../core/sql-splitter'
import { Catalog } from '../schema/catalog'
import { Workspace } from '../workspace/workspace'
import { EditorTab } from '../workspace/workspace'
import { loadMonaco, MonacoApi } from './monaco'
import { registerSqlCompletion } from './sql-completion'

export type RunMode = 'statement' | 'all'

/**
 * One Monaco instance for the whole app; each tab owns a model plus saved view state.
 * (Twenty editor instances would cost hundreds of MB.)
 */
@Component({
  selector: 'y-sql-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block h-full w-full' },
  template: `<div class="h-full w-full"></div>`,
})
export class SqlEditor {
  readonly tab = input<EditorTab | null>(null)

  private readonly host = inject(ElementRef<HTMLElement>)
  private readonly catalog = inject(Catalog)
  private readonly workspace = inject(Workspace)
  /** Model URI → tab, so completion knows which connection's catalog to use. */
  private readonly tabsByModel = new Map<string, EditorTab>()
  private monaco: MonacoApi | null = null
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null
  private readonly models = new Map<string, Monaco.editor.ITextModel>()
  private readonly viewStates = new Map<string, Monaco.editor.ICodeEditorViewState | null>()
  private current: EditorTab | null = null
  private runDecorations: Monaco.editor.IEditorDecorationsCollection | null = null

  constructor() {
    const destroyRef = inject(DestroyRef)

    afterNextRender(async () => {
      this.monaco = await loadMonaco()
      const el = (this.host.nativeElement as HTMLElement).firstElementChild as HTMLElement
      this.editor = this.monaco.editor.create(el, {
        theme: 'yadbc',
        language: 'pgsql',
        fontFamily: 'JetBrains Mono',
        fontSize: 13,
        lineHeight: 20,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: 'line',
        padding: { top: 8 },
        automaticLayout: false,
        fixedOverflowWidgets: true,
        // Suggestions come from the catalog; words from the document would just add noise.
        wordBasedSuggestions: 'off',
        quickSuggestions: { other: true, comments: false, strings: false },
        suggest: { showWords: false },
        model: null,
      })
      const inserts = this.workspace.inserts$.subscribe(({ tabId, text }) => this.append(tabId, text))
      const replaces = this.workspace.replaces$.subscribe((r) =>
        r.done(this.replace(r.tabId, r.offset, r.expected, r.text)),
      )
      const completion = registerSqlCompletion(this.monaco, this.catalog, (model) =>
        this.tabsByModel.get(model.uri.toString()),
      )
      this.runDecorations = this.editor.createDecorationsCollection()
      // Cursor and scroll go with the saved workspace.
      const remember = () => {
        if (!this.current || !this.editor) return
        this.current.viewState = this.editor.saveViewState()
        this.workspace.touched$.next()
        this.workspace.cursor.update((n) => n + 1)
      }
      this.workspace.currentStatement = () => this.collect('statement', false)[0] ?? null
      this.editor.onDidChangeCursorSelection(remember)
      this.editor.onDidScrollChange(remember)

      // One observer, one layout() per frame — automaticLayout polls and thrashes during splitter drags.
      let frame = 0
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => this.editor?.layout())
      })
      ro.observe(el)
      destroyRef.onDestroy(() => {
        ro.disconnect()
        completion.dispose()
        inserts.unsubscribe()
        replaces.unsubscribe()
        this.editor?.dispose()
        this.models.forEach((m) => m.dispose())
      })

      this.switchTo(untracked(this.tab))
    })

    effect(() => {
      const tab = this.tab()
      untracked(() => this.switchTo(tab))
    })

    // Postgres error position → red squiggle at the exact spot.
    effect(() => {
      const tab = this.tab()
      const error = tab?.error() ?? null
      untracked(() => tab && this.showError(tab, error))
    })
  }

  focus() {
    this.editor?.focus()
  }

  /** Statements to run: the one under the cursor, or the selection / whole script. */
  collect(mode: RunMode, flash = true): Statement[] {
    const editor = this.editor
    const model = editor?.getModel()
    if (!editor || !model || !this.monaco) return []

    const selection = editor.getSelection()
    const text = model.getValue()
    let chosen: { sql: string; offset: number }[]
    let range: { start: number; end: number }

    if (selection && !selection.isEmpty()) {
      const start = model.getOffsetAt(selection.getStartPosition())
      const end = model.getOffsetAt(selection.getEndPosition())
      chosen = splitSql(text.slice(start, end)).map((s) => ({ sql: s.sql, offset: start + s.start }))
      range = { start, end }
    } else if (mode === 'all') {
      chosen = splitSql(text).map((s) => ({ sql: s.sql, offset: s.start }))
      range = { start: 0, end: text.length }
    } else {
      const s = statementAt(splitSql(text), model.getOffsetAt(editor.getPosition()!))
      chosen = s ? [{ sql: s.sql, offset: s.start }] : []
      range = s ? { start: s.start, end: s.start + s.sql.length } : { start: 0, end: 0 }
    }

    if (chosen.length && flash) this.flashRange(model, range.start, range.end)
    return chosen
  }

  private switchTo(tab: EditorTab | null) {
    const editor = this.editor
    if (!editor || !this.monaco || tab === this.current) return

    if (this.current && this.models.has(this.current.id))
      this.viewStates.set(this.current.id, editor.saveViewState())

    this.current = tab
    if (!tab) {
      editor.setModel(null)
      return
    }
    let model = this.models.get(tab.id)
    if (!model) {
      model = this.monaco.editor.createModel(tab.initialSql, 'pgsql')
      this.models.set(tab.id, model)
      this.tabsByModel.set(model.uri.toString(), tab)
      const m = model
      m.onDidChangeContent(() => tab.text.set(m.getValue()))
    }
    editor.setModel(model)
    // This session's state, else the one saved with the workspace (restored tab).
    const state = this.viewStates.get(tab.id) ?? (tab.viewState as Monaco.editor.ICodeEditorViewState | null)
    if (state) editor.restoreViewState(state)
    editor.focus()
  }

  /** A short gutter bar on the range that is about to run, so it's clear what ran. */
  private flashRange(model: Monaco.editor.ITextModel, start: number, end: number) {
    const s = model.getPositionAt(start)
    const e = model.getPositionAt(end)
    this.runDecorations?.set([
      {
        range: new this.monaco!.Range(s.lineNumber, 1, e.lineNumber, 1),
        options: { isWholeLine: true, linesDecorationsClassName: 'y-run-bar' },
      },
    ])
    setTimeout(() => this.runDecorations?.clear(), 600)
  }

  private showError(tab: EditorTab, error: RunError | null) {
    const model = this.models.get(tab.id)
    if (!model || !this.monaco) return
    if (!error || error.position == null) {
      this.monaco.editor.setModelMarkers(model, 'yadbc', [])
      return
    }
    const pos = model.getPositionAt(error.position)
    const word = model.getWordAtPosition(pos)
    this.monaco.editor.setModelMarkers(model, 'yadbc', [
      {
        severity: this.monaco.MarkerSeverity.Error,
        message: error.messageText,
        startLineNumber: pos.lineNumber,
        startColumn: word?.startColumn ?? pos.column,
        endLineNumber: pos.lineNumber,
        endColumn: word?.endColumn ?? pos.column + 1,
      },
    ])
  }

  /** Appends text after the current content (blank line between), selects it and scrolls there. */
  private append(tabId: string, text: string) {
    const model = this.models.get(tabId)
    if (!model || !this.monaco || !this.editor) return
    const current = model.getValue()
    const sep = !current.trim() ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n'
    const end = model.getFullModelRange().getEndPosition()
    const body = text.trimEnd()
    const edits = [
      {
        range: new this.monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column),
        text: sep + body,
      },
    ]
    // Statements split on semicolons only: without one, what's added would run as part of the last statement.
    const trimmed = current.trimEnd()
    const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1)
    if (trimmed && !trimmed.endsWith(';') && !lastLine.includes('--') && splitSql(current).length > 0) {
      const at = model.getPositionAt(trimmed.length)
      edits.unshift({
        range: new this.monaco.Range(at.lineNumber, at.column, at.lineNumber, at.column),
        text: ';',
      })
    }
    this.editor.executeEdits('history', edits)
    // Positions, not character offsets: on a CRLF model every inserted \n counts twice and offsets come up short.
    const newlines = sep.length
    const start = newlines ? new this.monaco.Position(end.lineNumber + newlines, 1) : end
    const stop = model.getFullModelRange().getEndPosition()
    this.editor.setSelection(
      new this.monaco.Selection(start.lineNumber, start.column, stop.lineNumber, stop.column),
    )
    this.editor.revealRangeInCenterIfOutsideViewport(
      new this.monaco.Range(start.lineNumber, start.column, stop.lineNumber, stop.column),
    )
    this.editor.focus()
  }

  /** Replaces `expected` at `offset` (undoable), selecting the new text; false if the text there changed. */
  private replace(tabId: string, offset: number, expected: string, text: string): boolean {
    const model = this.models.get(tabId)
    if (!model || !this.monaco || !this.editor) return false
    if (model.getValue().slice(offset, offset + expected.length) !== expected) return false
    const start = model.getPositionAt(offset)
    const end = model.getPositionAt(offset + expected.length)
    this.editor.pushUndoStop()
    this.editor.executeEdits('filter', [
      { range: new this.monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text },
    ])
    this.editor.pushUndoStop()
    // From line/column, not offsets: a CRLF model stores each inserted \n as two characters.
    const lines = text.split('\n')
    const stopLine = start.lineNumber + lines.length - 1
    const stopColumn =
      lines.length === 1 ? start.column + lines[0].length : lines[lines.length - 1].length + 1
    const range = new this.monaco.Selection(start.lineNumber, start.column, stopLine, stopColumn)
    this.editor.setSelection(range)
    this.editor.revealRangeInCenterIfOutsideViewport(range)
    this.editor.focus()
    return true
  }

  /** Called when a tab closes so its model doesn't leak. */
  dropTab(tabId: string) {
    const model = this.models.get(tabId)
    if (model) this.tabsByModel.delete(model.uri.toString())
    model?.dispose()
    this.models.delete(tabId)
    this.viewStates.delete(tabId)
  }

  /** Moves the cursor to an error position (from the error card). */
  reveal(offset: number) {
    const model = this.editor?.getModel()
    if (!model) return
    const pos = model.getPositionAt(offset)
    this.editor!.setPosition(pos)
    this.editor!.revealPositionInCenterIfOutsideViewport(pos)
    this.editor!.focus()
  }
}
