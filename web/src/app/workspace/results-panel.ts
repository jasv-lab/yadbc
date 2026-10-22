import { Dialog } from '@angular/cdk/dialog'
import { CdkContextMenuTrigger, CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu'
import { DecimalPipe } from '@angular/common'
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core'
import { toObservable, toSignal } from '@angular/core/rxjs-interop'
import { of, switchMap } from 'rxjs'
import { Commands } from '../core/commands'
import { Edits } from '../editing/edits'
import { CellInspector } from '../inspector/cell-inspector'
import { ExportDialog, ExportDialogData, ExportDialogResult } from '../export/export-dialog'
import { ExportFormat, Exporter, FORMATS, scopeFor, toMessage } from '../export/export'
import { ResultGrid } from '../grid/result-grid'
import { PlanView } from '../explain/plan-view'
import { Icon } from '../ui/icon'
import { EditorTab, ResultView, Workspace } from './workspace'
import { ColumnRelations, Relations } from '../navigation/relations'
import { Direction, Navigator } from '../navigation/navigator'
import { searchable, ValueSearch } from '../search/value-search'
import { age, BlockingWatch, TabBlocking } from '../blocking/blocking-watch'
import { defaultSpec } from '../chart/chart'
import { QuickChart } from '../chart/quick-chart'

/** Results area: a fixed 30px header (counts, result chips, messages) over the grid or error card. */
@Component({
  selector: 'y-results-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ResultGrid,
    QuickChart,
    PlanView,
    Icon,
    DecimalPipe,
    CdkMenu,
    CdkMenuItem,
    CdkMenuTrigger,
    CdkContextMenuTrigger,
  ],
  host: { class: 'flex h-full min-h-0 flex-col bg-raised' },
  template: `
    @let t = tab();
    @if (blocking.byTab().get(t.id); as b) {
      @if (b.blocked.length) {
        <div class="blocking">
          <span class="dot"></span>
          <span class="min-w-0 flex-1 truncate">
            This tab's open transaction{{ b.xactSeconds !== null ? ' (' + age(b.xactSeconds) + ')' : '' }} is
            blocking
            <b>{{ b.blocked.length }} {{ b.blocked.length === 1 ? 'session' : 'sessions' }}</b>
            — longest waiting {{ age(longestWait(b)) }}:
            <span class="font-mono" [title]="b.blocked[0].query ?? ''"
              >{{ b.blocked[0].user }}@{{ b.blocked[0].application || '?' }} · {{ b.blocked[0].query }}</span
            >
          </span>
          <button
            class="run-btn"
            (click)="blocking.endTransaction(t, false)"
            title="ROLLBACK — your changes in it are undone"
          >
            Rollback
          </button>
          <button
            class="run-btn"
            (click)="blocking.endTransaction(t, true)"
            title="COMMIT — your changes in it are kept"
          >
            Commit
          </button>
          <button class="run-btn" (click)="workspace.openActivity(t.connection)">Show</button>
        </div>
      }
    }
    <div class="flex h-[30px] shrink-0 items-center gap-3 border-b border-line px-3 text-[12px] text-muted">
      @if (t.plan(); as plan) {
        <span class="text-fg">{{ plan.analyze ? 'EXPLAIN ANALYZE' : 'EXPLAIN' }}</span>
        @if (t.lastRun(); as run) {
          <span>{{ run.elapsedMs }} ms</span>
        }
      } @else if (active(); as r) {
        <span class="text-fg">
          @if (r.capped) {
            <span class="text-warning"
              >{{ r.rowCount | number }} of {{ r.totalRows | number }} rows (capped)</span
            >
          } @else {
            {{ r.rowCount | number }} {{ r.rowCount === 1 ? 'row' : 'rows' }}{{ r.done ? '' : '…' }}
          }
        </span>
        @if (r.done && r.queryMs !== undefined) {
          <span [title]="'query ' + r.queryMs + ' ms · fetch ' + r.fetchMs + ' ms'"
            >{{ r.queryMs! + r.fetchMs! }} ms</span
          >
        }
      } @else if (t.status() === 'running') {
        <span>Running…</span>
      } @else if (t.lastRun(); as run) {
        <span [class.text-danger]="!run.ok && !run.cancelled">
          {{ run.cancelled ? 'Cancelled' : run.ok ? 'Done' : 'Failed' }} · {{ run.elapsedMs }} ms
        </span>
      }

      @if (t.results().length > 1 || t.commands().length) {
        <div class="flex min-w-0 items-center gap-1 overflow-x-auto">
          @for (r of t.results(); track r.resultId; let i = $index) {
            <button
              class="chip"
              [class.chip-active]="t.activeResult() === i"
              (click)="t.activeResult.set(i); showMessages.set(false); errorDismissed.set(true)"
            >
              {{ r.index + 1 }} · {{ r.rowCount | number }}
            </button>
          }
          @for (c of t.commands(); track c.index) {
            <span class="chip">{{ c.index + 1 }} · {{ c.tag }} · {{ c.elapsedMs }} ms</span>
          }
        </div>
      }

      <span class="flex-1"></span>
      @if (edits.message() ?? flash(); as f) {
        <span class="truncate" [class.text-danger]="f.error">{{ f.text }}</span>
      }
      @if (stagedCount(); as n) {
        <div class="pill">
          <span>{{ n }} {{ n === 1 ? 'change' : 'changes' }}</span>
          <button [title]="commands.tooltip('edits.review')" (click)="review()">Review</button>
          <button (click)="discardEdits()">Discard</button>
          <button class="font-medium" (click)="applyEdits()">Apply</button>
        </div>
      }
      @if (t.notices().length) {
        <button class="chip" [class.chip-active]="showMessages()" (click)="showMessages.set(!showMessages())">
          Messages <span class="text-warning">{{ t.notices().length }}</span>
        </button>
      }
      @if (active(); as r) {
        <button
          class="chip"
          [class.chip-active]="!!t.chart()"
          [attr.aria-pressed]="!!t.chart()"
          [title]="commands.tooltip('result.chart')"
          (click)="toggleChart(t, r)"
        >
          Chart
        </button>
        <div class="flex items-stretch rounded border border-line">
          <button class="split-main" [title]="commands.tooltip('result.copy')" (click)="quick('tsv')">
            <y-icon name="copy" [size]="13" /> Copy
          </button>
          <button
            class="split-arrow"
            [title]="commands.tooltip('result.export')"
            [cdkMenuTriggerFor]="exportMenu"
            aria-label="Copy as…"
          >
            <y-icon name="chevron-down" [size]="13" />
          </button>
        </div>
      }
    </div>

    <!-- Right-click in the grid: follow the column's relations, then the usual Copy as. -->
    <ng-template #gridMenu>
      <div cdkMenu class="menu">
        @if (findMenu(); as fv) {
          <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="findEverywhere()">
            <y-icon name="search" [size]="13" /> Find
            <span class="truncate text-muted">{{ fv }}</span> everywhere
          </button>
          <div class="menu-sep"></div>
        }
        @if (filterMenu(); as fm) {
          <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="filter(false)">
            <y-icon name="filter" [size]="13" /> Filter <span class="truncate text-muted">{{ fm.keep }}</span>
          </button>
          @if (fm.exclude) {
            <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="filter(true)">
              <y-icon name="filter-x" [size]="13" /> Exclude
              <span class="truncate text-muted">{{ fm.exclude }}</span>
            </button>
          }
          <div class="menu-sep"></div>
        }
        @if (nav(); as n) {
          @if (n.rel.references; as fk) {
            <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="goTo(n.col, 'references')">
              <y-icon name="goto" [size]="13" /> Go to {{ fk.table.name }} where {{ fk.column }} {{ n.where }}
            </button>
            @if (n.joinable) {
              <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="join(n.col, 'references')">
                <y-icon name="join" [size]="13" /> Join {{ fk.table.name }}
                <span class="menu-key">on {{ n.rel.column }}</span>
              </button>
            }
          }
          @for (ref of n.incoming; track ref.constraint) {
            <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="goTo(n.col, ref)">
              <y-icon name="goto-back" [size]="13" /> {{ ref.table.name }} where {{ ref.column }}
              {{ n.where }}
            </button>
          }
          @if (n.joinable) {
            @for (ref of n.incoming; track ref.constraint) {
              <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="join(n.col, ref)">
                <y-icon name="join" [size]="13" /> Join {{ ref.table.name }}
                <span class="menu-key">on {{ ref.column }}</span>
              </button>
            }
          }
          <div class="menu-sep"></div>
        }
        <div class="menu-label">Copy as</div>
        @for (f of formats; track f.id) {
          <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="quick(f.id)">{{ f.label }}</button>
        }
        <div class="menu-sep"></div>
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="openDialog()">
          Export options… <span class="menu-key">Ctrl+Shift+C</span>
        </button>
      </div>
    </ng-template>

    <ng-template #exportMenu>
      <div cdkMenu class="menu">
        <div class="menu-label">Copy as</div>
        @for (f of formats; track f.id) {
          <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="quick(f.id)">{{ f.label }}</button>
        }
        <div class="menu-sep"></div>
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="openDialog()">
          Export options… <span class="menu-key">Ctrl+Shift+C</span>
        </button>
      </div>
    </ng-template>

    <div class="relative min-h-0 flex-1">
      @if (!errorDismissed() && t.error(); as err) {
        <div class="absolute inset-0 overflow-auto p-4">
          <button
            class="block w-full max-w-3xl rounded-md border border-danger/40 bg-danger-bg px-4 py-3 text-left"
            (click)="err.position != null && revealError.emit(err.position)"
          >
            <div class="flex items-center gap-2 text-danger">
              <y-icon name="alert" />
              <span class="font-medium">{{ err.messageText }}</span>
              @if (err.sqlState) {
                <span class="ml-auto font-mono text-[11px] opacity-80">{{ err.sqlState }}</span>
              }
            </div>
            @if (err.detail) {
              <p class="mt-2 text-fg"><span class="text-muted">Detail</span> {{ err.detail }}</p>
            }
            @if (err.hint) {
              <p class="mt-1 text-fg"><span class="text-muted">Hint</span> {{ err.hint }}</p>
            }
            @if (err.where) {
              <p class="mt-1 font-mono text-[11.5px] whitespace-pre-wrap text-muted">{{ err.where }}</p>
            }
            @if (err.position != null) {
              <p class="mt-2 text-[11.5px] text-muted">Click to jump to the error position</p>
            }
          </button>
          <button
            class="run-btn mt-2"
            (click)="inspector.showAi()"
            title="Explain or fix it with the AI assistant (Ctrl+I)"
          >
            Ask AI
          </button>
        </div>
      } @else if (t.plan(); as plan) {
        <y-plan-view
          class="absolute inset-0"
          [result]="plan"
          [connectionId]="t.connection.id"
          [sql]="t.lastStatements[0]?.sql ?? null"
          (insertSql)="workspace.insertIntoEditor(t, $event)"
        />
      } @else if (showMessages()) {
        <div class="absolute inset-0 overflow-auto p-3 font-mono text-[12px]">
          @for (n of t.notices(); track $index) {
            <div class="py-0.5">
              <span class="text-warning">{{ n.severity }}</span> {{ n.message }}
            </div>
          }
        </div>
      } @else if (active(); as r) {
        <div class="absolute inset-0 flex">
          <div class="relative min-w-0 flex-1">
            <y-result-grid
              class="absolute inset-0"
              [result]="r"
              [editBlock]="editBlock()"
              [cdkContextMenuTriggerFor]="gridMenu"
              (contextmenu)="
                menuColumn.set(grid()?.selectionColumn() ?? null);
                menuSelection.set(grid()?.selection() ?? null)
              "
            />
          </div>
          @if (t.chart()) {
            <y-quick-chart class="w-[48%] min-w-[320px] border-l border-line" [tab]="t" [result]="r" />
          }
        </div>
      } @else if (t.status() !== 'running') {
        <div class="absolute inset-0 flex items-center justify-center text-[12px] text-faint">
          Ctrl+Enter or F5 runs the statement under the cursor · Ctrl+Shift+Enter runs everything
        </div>
      }
    </div>
  `,
  styles: `
    .blocking {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 10px;
      border-bottom: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
      background: var(--danger-bg);
      color: var(--danger);
      font-size: 12px;
    }
    .blocking .dot {
      width: 8px;
      height: 8px;
      flex-shrink: 0;
      border-radius: 50%;
      background: var(--danger);
      animation: pulse 1.4s ease-in-out infinite;
    }
    @keyframes pulse {
      50% {
        opacity: 0.35;
      }
    }
    .chip {
      white-space: nowrap;
      border-radius: 4px;
      padding: 1px 8px;
      border: 1px solid var(--border);
      color: var(--fg-muted);
    }
    .chip:hover {
      background: var(--bg-hover);
    }
    .split-main {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 0 8px;
      color: var(--fg);
    }
    .split-arrow {
      display: inline-flex;
      align-items: center;
      padding: 0 4px;
      border-left: 1px solid var(--border);
      color: var(--fg-muted);
    }
    .split-main:hover,
    .split-arrow:hover {
      background: var(--bg-hover);
    }
    .pill {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 0 2px 0 8px;
      height: 22px;
      border-radius: 4px;
      background: var(--warning-bg);
      color: var(--warning);
      white-space: nowrap;
    }
    .pill button {
      padding: 0 6px;
      border-radius: 3px;
    }
    .pill button:hover {
      background: rgb(0 0 0 / 0.06);
    }
    .chip-active {
      background: var(--bg-selected);
      color: var(--fg);
      border-color: transparent;
    }
  `,
})
export class ResultsPanel {
  readonly tab = input.required<EditorTab>()
  readonly revealError = output<number>()

  protected readonly commands = inject(Commands)
  protected readonly workspace = inject(Workspace)
  protected readonly edits = inject(Edits)
  protected readonly inspector = inject(CellInspector)
  protected readonly blocking = inject(BlockingWatch)
  protected readonly age = age

  protected longestWait(b: TabBlocking) {
    return Math.max(...b.blocked.map((x) => x.waitSeconds))
  }
  private readonly exporter = inject(Exporter)
  private readonly dialog = inject(Dialog)
  private readonly grid = viewChild(ResultGrid)

  protected readonly formats = FORMATS
  private readonly relations = inject(Relations)
  private readonly navigator = inject(Navigator)
  private readonly valueSearch = inject(ValueSearch)

  /** The column a right-click landed in (single-column selection), for the relation items. */
  protected readonly menuColumn = signal<number | null>(null)
  /** The selection a right-click landed in, for Filter / Exclude. */
  protected readonly menuSelection = signal<{ r0: number; r1: number; c0: number; c1: number } | null>(null)

  /** "Find … everywhere" for a single non-null cell of a searchable type. */
  protected readonly findMenu = computed(() => {
    const sel = this.menuSelection()
    const result = this.active()
    if (!sel || !result || sel.r0 !== sel.r1 || sel.c0 !== sel.c1) return null
    if (!searchable(result.columns[sel.c0].type)) return null
    const first = this.grid()?.selectionPreview(sel.c0).first
    return typeof first === 'string' && first !== '' ? short(first) : null
  })

  protected async findEverywhere() {
    const sel = this.menuSelection()
    const result = this.active()
    if (!sel || !result) return
    const [value] = (await this.grid()?.selectedValues(sel.c0)) ?? []
    if (value == null) return
    this.valueSearch.start(this.tab().connection, value, result.columns[sel.c0].type)
    this.inspector.showSearch()
  }

  /** Filter / Exclude labels: one column (its value or "in (n values)"), or one row across columns. */
  protected readonly filterMenu = computed(() => {
    const sel = this.menuSelection()
    const result = this.active()
    if (!sel || !result || !this.navigator.joinable(result.resultId)) return null
    const names = result.columns.map((c) => c.name)
    if (sel.c0 === sel.c1) {
      const { rows, first } = this.grid()?.selectionPreview(sel.c0) ?? { rows: 0, first: undefined }
      if (!rows) return null
      const name = names[sel.c0]
      const one = first === undefined ? '…' : first === null ? null : short(first)
      return {
        keep:
          rows > 1 ? `${name} in (${rows} values)` : one === null ? `${name} is null` : `${name} = ${one}`,
        exclude:
          rows > 1
            ? `${name} not in (${rows} values)`
            : one === null
              ? `${name} is not null`
              : `${name} ≠ ${one}`,
      }
    }
    if (sel.r0 !== sel.r1) return null
    return { keep: `${names.slice(sel.c0, sel.c1 + 1).join(', ')} = row ${sel.r0 + 1}`, exclude: null }
  })
  private readonly columnRelations = toSignal(
    toObservable(computed(() => this.active()?.resultId ?? null)).pipe(
      switchMap((id) => (id ? this.relations.of(id) : of<ColumnRelations[]>([]))),
    ),
    { initialValue: [] as ColumnRelations[] },
  )

  /** Relation items for the right-clicked column: go to / join, with the selected value(s) in the label. */
  protected readonly nav = computed(() => {
    const col = this.menuColumn()
    const rel = col === null ? undefined : this.columnRelations()[col]
    const result = this.active()
    if (col === null || !rel || !result || (!rel.references && !rel.referencedBy.length)) return null
    const { rows, first } = this.grid()?.selectionPreview(col) ?? { rows: 0, first: undefined }
    const where =
      rows > 1
        ? `in (${rows} values)`
        : first === null
          ? 'is null'
          : first === undefined
            ? '= …'
            : `= ${short(first)}`
    return {
      col,
      rel,
      where,
      incoming: rel.referencedBy.slice(0, 6),
      joinable: this.navigator.joinable(result.resultId),
    }
  })
  /** Short-lived status after a copy/export ("Copied 12 rows as INSERT"). */
  protected readonly flash = signal<{ text: string; error: boolean } | null>(null)
  private flashTimer = 0

  protected readonly showMessages = signal(false)
  /** Picking a result chip after a failed statement shows that result instead of the error card. */
  protected readonly errorDismissed = signal(false)

  protected readonly stagedCount = computed(() => {
    const r = this.active()
    return r ? this.edits.for(r.resultId).count() : 0
  })

  /** Why the grid can't edit right now; shown when someone tries. */
  protected readonly editBlock = computed(() => {
    const t = this.tab()
    if (t.session()?.readOnly) return 'This session is read-only. Click the lock on the tab to allow writes.'
    if (t.status() === 'running') return 'Wait for the running query to finish.'
    if (this.active() && !this.active()!.done) return 'Wait for all rows to load.'
    return null
  })

  constructor() {
    effect(() => {
      this.tab().error()
      this.errorDismissed.set(false)
    })
    const hasEdits = () => this.stagedCount() > 0
    this.commands.register(
      {
        id: 'edits.review',
        label: 'Review staged edits',
        shortcut: 'Ctrl+S',
        when: hasEdits,
        run: () => this.review(),
      },
      { id: 'edits.apply', label: 'Apply staged edits', when: hasEdits, run: () => this.applyEdits() },
      { id: 'edits.discard', label: 'Discard staged edits', when: hasEdits, run: () => this.discardEdits() },
    )
    const hasResult = () => !!this.active()
    this.commands.register(
      { id: 'result.copy', label: 'Copy as TSV with header', when: hasResult, run: () => this.quick('tsv') },
      {
        id: 'result.export',
        label: 'Copy as…',
        shortcut: 'Ctrl+Shift+C',
        when: hasResult,
        run: () => this.openDialog(),
      },
      {
        id: 'result.chart',
        label: 'Chart the result',
        shortcut: 'Ctrl+Shift+G',
        when: hasResult,
        run: () => this.toggleChart(this.tab(), this.active()!),
      },
    )
  }

  /** Opens the quick chart beside the grid with defaults picked from the columns, or closes it. */
  protected toggleChart(tab: EditorTab, result: ResultView) {
    tab.chart.set(tab.chart() ? null : { spec: defaultSpec(result.columns), columns: result.columns })
  }

  /**
   * One-click export with the last-used options. INSERT/UPDATE that can't infer their table (joins,
   * computed columns) open the dialog instead of failing.
   */
  protected quick(format: ExportFormat) {
    const result = this.active()
    if (!result) return
    const scope = scopeFor(result, this.grid()?.selection() ?? null, format)
    this.exporter.run(result.resultId, format, scope, this.exporter.loadOptions()).subscribe({
      next: (r) =>
        this.exporter.copy(r.text).subscribe({
          complete: () => this.showFlash(this.exporter.copiedMessage(format, r)),
          error: () => this.showFlash("Couldn't write to the clipboard", true),
        }),
      error: (e) => {
        if (format === 'insert' || format === 'update') this.openDialog(format)
        else this.showFlash(toMessage(e), true)
      },
    })
  }

  protected async goTo(col: number, dir: Direction) {
    const result = this.active()
    const grid = this.grid()
    if (!result || !grid) return
    this.navigator.goTo(result.resultId, col, await grid.selectedValues(col), dir)
  }

  protected async filter(negate: boolean) {
    const result = this.active()
    const cells = await this.grid()?.filterCells()
    if (result && cells) this.navigator.filter(result.resultId, cells, negate)
  }

  protected join(col: number, dir: Direction) {
    const result = this.active()
    if (result) this.navigator.join(result.resultId, col, dir)
  }

  protected openDialog(format: ExportFormat = 'insert') {
    const result = this.active()
    if (!result) return
    const ref = this.dialog.open<ExportDialogResult, ExportDialogData>(ExportDialog, {
      data: { result, selection: this.grid()?.selection() ?? null, format },
      // Enter copies; the format list is one Tab away.
      autoFocus: '.btn-primary',
    })
    ref.closed.subscribe((message) => message && this.showFlash(message))
  }

  protected review() {
    const r = this.active()
    if (r) this.inspector.showEdits(this.tab(), r)
  }

  protected applyEdits() {
    const r = this.active()
    if (!r) return
    this.edits.apply(this.tab(), r).subscribe((o) => {
      this.edits.say(o.message, !o.ok)
      // A failure is easier to understand next to the SQL that failed.
      if (!o.ok) this.inspector.showEdits(this.tab(), r)
    })
  }

  protected discardEdits() {
    const r = this.active()
    if (r) this.edits.for(r.resultId).clear()
  }

  private showFlash(text: string, error = false) {
    clearTimeout(this.flashTimer)
    this.flash.set({ text, error })
    this.flashTimer = window.setTimeout(() => this.flash.set(null), error ? 6000 : 2500)
  }
  protected readonly active = computed(() => {
    const t = this.tab()
    return t.results()[t.activeResult()] ?? null
  })
}

/** A value as it fits in a menu label. */
function short(v: string): string {
  const one = v.replace(/\s+/g, ' ')
  return one.length > 24 ? one.slice(0, 24) + '…' : one
}
