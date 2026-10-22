import { Dialog } from '@angular/cdk/dialog'
import { CdkMenu, CdkMenuItemCheckbox, CdkMenuTrigger } from '@angular/cdk/menu'
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  Signal,
  signal,
  untracked,
} from '@angular/core'
import { toObservable, toSignal } from '@angular/core/rxjs-interop'
import { catchError, forkJoin, lastValueFrom, map, of, startWith, switchMap } from 'rxjs'
import { Connections } from '../connections/connections'
import { ConnectionProfile } from '../core/protocol'
import { Catalog } from '../schema/catalog'
import { Change, diffSnapshots, statements } from '../schema-model/diff'
import { SchemaChanges } from '../schema-model/schema-changes'
import { ConfirmData, ConfirmDialog } from '../ui/confirm-dialog'
import { Icon } from '../ui/icon'
import { CompareTab, Workspace } from '../workspace/workspace'
import { sideBySide } from './line-diff'

const ENV_DOT = { local: 'bg-env-local', dev: 'bg-env-dev', prod: 'bg-env-prod' } as const
const GLYPH = { create: '+', drop: '−', alter: '~' } as const
const KIND_ORDER = ['schema', 'enum', 'sequence', 'table', 'view', 'function'] as const
const KIND_LABEL: Record<string, string> = {
  schema: 'Schemas',
  enum: 'Enums',
  sequence: 'Sequences',
  table: 'Tables',
  view: 'Views',
  function: 'Functions',
}
const TABLE_PARTS = new Set(['table', 'column', 'constraint', 'index', 'trigger'])

type Filter = 'all' | 'create' | 'drop' | 'alter'

interface Group {
  key: string
  label: string
  /** For a table group: the table's own changes; children are its columns, constraints, indexes… */
  rows: { change?: Change; heading?: string; child: boolean }[]
}

interface CompareResult {
  loading: boolean
  error: string | null
  changes: Change[]
  ms: number
}

/**
 * Two connections side by side: what differs between their schemas, and the script that makes the
 * target look like the source. Drops are listed but not selected; nothing runs until you say so — and
 * on prod only through an editor tab, where the read-only lock applies.
 */
@Component({
  selector: 'y-compare-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, CdkMenu, CdkMenuItemCheckbox, CdkMenuTrigger],
  host: { class: 'flex min-h-0 flex-col bg-raised' },
  template: `
    @let t = tab();
    <div class="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-[12.5px]">
      <span class="text-muted">From</span>
      <span class="size-2 rounded-full" [class]="envDot[t.source().env]"></span>
      <select
        class="pick"
        [value]="t.source().id"
        (change)="setSource(val($event))"
        title="Source: the schema to copy"
      >
        @for (c of connections.list(); track c.id) {
          <option [value]="c.id" [selected]="c.id === t.source().id">{{ c.name }}</option>
        }
      </select>
      <button class="icon-btn" title="Swap source and target" (click)="swap()">⇄</button>
      <span class="text-muted">to</span>
      <span class="size-2 rounded-full" [class]="envDot[t.target().env]"></span>
      <select
        class="pick"
        [value]="t.target().id"
        (change)="setTarget(val($event))"
        title="Target: the database the script changes"
      >
        @for (c of connections.list(); track c.id) {
          <option [value]="c.id" [selected]="c.id === t.target().id">{{ c.name }}</option>
        }
      </select>
      <button class="pick-btn" [cdkMenuTriggerFor]="schemaMenu">
        {{ t.schemas() ? t.schemas()!.join(', ') : 'All schemas' }}
        <y-icon name="chevron-down" [size]="12" />
      </button>
      <button class="run-btn" (click)="compare()" [disabled]="result().loading">
        <y-icon name="refresh" [size]="13" /> {{ result().loading ? 'Comparing…' : 'Compare' }}
      </button>
      <span class="flex-1"></span>
      @if (ran()) {
        <span class="text-muted">
          {{ result().changes.length ? result().changes.length + ' differences' : 'No differences' }} ·
          {{ result().ms }} ms
        </span>
      }
    </div>

    <ng-template #schemaMenu>
      <div cdkMenu class="menu min-w-[200px]">
        <button
          cdkMenuItemCheckbox
          class="menu-item"
          [cdkMenuItemChecked]="!t.schemas()"
          (cdkMenuItemTriggered)="setSchemas(null)"
        >
          All schemas
        </button>
        <div class="menu-sep"></div>
        @for (s of schemaChoices(); track s) {
          <button
            cdkMenuItemCheckbox
            class="menu-item"
            [cdkMenuItemChecked]="!!t.schemas()?.includes(s)"
            (cdkMenuItemTriggered)="toggleSchema(s)"
          >
            {{ s }}
          </button>
        }
      </div>
    </ng-template>

    @if (result().error; as e) {
      <p class="m-3 rounded bg-danger-bg px-3 py-2 text-[12.5px] text-danger">{{ e }}</p>
    } @else if (!ran()) {
      <div class="flex flex-1 flex-col items-center justify-center gap-2 text-[12.5px] text-muted">
        <y-icon name="diagram" [size]="26" class="text-faint" />
        <p>Pick what to compare: the script makes the <b>target</b> look like the <b>source</b>.</p>
        <p class="text-faint">Read-only until you apply it — and on prod only from an editor tab.</p>
      </div>
    } @else if (!result().changes.length && !result().loading) {
      <div class="flex flex-1 flex-col items-center justify-center gap-1 text-[12.5px] text-muted">
        <y-icon name="check" [size]="26" class="text-env-local" />
        <p>The schemas match.</p>
      </div>
    } @else {
      <div class="grid min-h-0 flex-1 grid-cols-[minmax(320px,440px)_1fr]">
        <div class="flex min-h-0 flex-col border-r border-line">
          <div class="flex items-center gap-1 px-2 py-1.5 text-[12px]">
            @for (f of filters(); track f.id) {
              <button class="chip" [class.chip-on]="filter() === f.id" (click)="filter.set(f.id)">
                {{ f.label }} <span class="text-faint">{{ f.count }}</span>
              </button>
            }
            <input
              #q
              class="ml-1 h-6 min-w-0 flex-1 rounded border border-line bg-bg px-2 text-[12px] outline-none"
              placeholder="Filter"
              (input)="search.set(q.value)"
            />
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto pb-2">
            @for (g of groups(); track g.key) {
              <div class="group-head">{{ g.label }}</div>
              @for (r of g.rows; track r.change?.id ?? 'h:' + r.heading) {
                @if (r.heading) {
                  <div class="row font-mono text-[12px] text-muted">
                    <span class="glyph"></span><span class="glyph"></span>{{ r.heading }}
                  </div>
                }
                @if (r.change; as c) {
                  <div
                    class="row"
                    [class.row-child]="r.child"
                    [class.row-on]="selectedId() === c.id"
                    (click)="selectedId.set(c.id)"
                  >
                    <input
                      type="checkbox"
                      [checked]="picked().has(c.id)"
                      [disabled]="!c.statements.length"
                      [title]="c.statements.length ? 'Include in the script' : 'Nothing the script can do'"
                      (click)="$event.stopPropagation()"
                      (change)="toggle(c.id)"
                    />
                    <span class="glyph" [class]="'glyph-' + c.status">{{ glyph[c.status] }}</span>
                    <span
                      class="min-w-0 shrink-0 truncate font-mono text-[12px]"
                      [class.text-danger]="c.destructive"
                      >{{ r.child ? c.name.slice((c.table ?? '').length + 1) : c.name }}</span
                    >
                    <span class="min-w-0 flex-1 truncate text-[11.5px] text-muted">{{ c.summary }}</span>
                    @if (c.note) {
                      <y-icon name="alert" [size]="12" class="shrink-0 text-warning" />
                    }
                  </div>
                }
              }
            } @empty {
              <p class="px-3 py-4 text-[12px] text-faint">Nothing matches the filter.</p>
            }
          </div>
        </div>

        <div class="flex min-h-0 flex-col">
          <div class="flex items-center gap-1 border-b border-line px-3 py-1.5 text-[12px]">
            <button class="chip" [class.chip-on]="pane() === 'change'" (click)="pane.set('change')">
              Change
            </button>
            <button class="chip" [class.chip-on]="pane() === 'script'" (click)="pane.set('script')">
              Script <span class="text-faint">{{ script().length }}</span>
            </button>
          </div>
          @if (pane() === 'script') {
            <pre class="code min-h-0 flex-1">{{ scriptText() || '-- Nothing selected.' }}</pre>
          } @else if (selected(); as c) {
            <div class="min-h-0 flex-1 overflow-auto p-3 text-[12.5px]">
              <div class="flex items-baseline gap-2">
                <span class="glyph" [class]="'glyph-' + c.status">{{ glyph[c.status] }}</span>
                <span class="font-mono">{{ c.name }}</span>
                <span class="text-muted">{{ c.summary }}</span>
              </div>
              @if (c.note) {
                <p class="mt-2 rounded bg-warning-bg px-3 py-2 text-warning">{{ c.note }}</p>
              }
              @if (c.source !== undefined || c.target !== undefined) {
                <table class="diff mt-3">
                  <thead>
                    <tr>
                      <th>{{ tab().source().name }} <span class="text-faint">(source)</span></th>
                      <th>{{ tab().target().name }} <span class="text-faint">(target)</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of diffRows(); track $index) {
                      <tr [class.changed]="!row.same">
                        <td [class.empty]="row.left === null">{{ row.left }}</td>
                        <td [class.empty]="row.right === null">{{ row.right }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              }
              @if (c.statements.length) {
                <div class="mt-3 text-[11.5px] text-muted">Statements</div>
                <pre class="code mt-1 rounded border border-line">{{ changeSql(c) }}</pre>
              }
            </div>
          } @else {
            <p class="p-3 text-[12px] text-faint">Pick a difference to see both sides.</p>
          }
        </div>
      </div>

      <div class="flex items-center gap-2 border-t border-line px-3 py-2 text-[12.5px]">
        <span class="text-muted">
          {{ picked().size }} of {{ selectable().length }} selected · {{ script().length }}
          {{ script().length === 1 ? 'statement' : 'statements' }}
        </span>
        @if (applyMessage(); as m) {
          <span class="truncate" [class.text-danger]="m.error">{{ m.text }}</span>
        }
        <span class="flex-1"></span>
        <button class="btn" (click)="selectSafe()">Select all but drops</button>
        <button class="btn" [disabled]="!script().length" (click)="copy()">Copy script</button>
        <button class="btn" [disabled]="!script().length" (click)="openInTab()">Open in new tab</button>
        <button
          class="btn btn-primary"
          [disabled]="!script().length || tab().target().env === 'prod' || applying()"
          [title]="
            tab().target().env === 'prod'
              ? 'Prod changes run from an editor tab (Open in new tab), where the read-only lock applies'
              : 'Run the script on ' + tab().target().name + ' in one transaction'
          "
          (click)="apply()"
        >
          {{ applying() ? 'Applying…' : 'Apply to ' + tab().target().name }}
        </button>
      </div>
    }
  `,
  styles: `
    .pick {
      height: 26px;
      max-width: 200px;
      padding: 0 6px;
      border-radius: 4px;
      border: 1px solid var(--border-strong);
      background: var(--bg);
      color: var(--fg);
    }
    .pick-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 26px;
      max-width: 240px;
      padding: 0 8px;
      border-radius: 4px;
      border: 1px solid var(--border);
      color: var(--fg-muted);
      overflow: hidden;
      white-space: nowrap;
    }
    .icon-btn {
      width: 26px;
      height: 26px;
      border-radius: 4px;
      color: var(--fg-muted);
    }
    .icon-btn:hover,
    .pick-btn:hover {
      background: var(--bg-hover);
      color: var(--fg);
    }
    .chip {
      padding: 1px 8px;
      border-radius: 4px;
      border: 1px solid var(--border);
      color: var(--fg-muted);
      white-space: nowrap;
    }
    .chip-on {
      background: var(--bg-selected);
      color: var(--fg);
      border-color: transparent;
    }
    .group-head {
      position: sticky;
      top: 0;
      z-index: 1;
      padding: 6px 10px 3px;
      background: var(--bg-raised);
      font-size: 11px;
      font-weight: 600;
      color: var(--fg-faint);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      cursor: default;
    }
    .row:hover {
      background: var(--bg-hover);
    }
    .row-on {
      background: var(--bg-selected);
    }
    .row-child {
      padding-left: 28px;
    }
    .glyph {
      width: 12px;
      flex-shrink: 0;
      text-align: center;
      font-weight: 700;
      font-family: var(--font-mono);
    }
    .glyph-create {
      color: var(--conn-local);
    }
    .glyph-drop {
      color: var(--danger);
    }
    .glyph-alter {
      color: var(--warning);
    }
    .code {
      margin: 0;
      padding: 10px 12px;
      overflow: auto;
      font: 12px/1.5 var(--font-mono);
      white-space: pre;
      background: var(--bg);
    }
    .diff {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font: 12px/1.5 var(--font-mono);
    }
    .diff th {
      padding: 4px 8px;
      text-align: left;
      font: 600 11.5px var(--font-ui, inherit);
      border-bottom: 1px solid var(--border);
    }
    .diff td {
      padding: 0 8px;
      white-space: pre-wrap;
      word-break: break-word;
      vertical-align: top;
    }
    .diff td + td,
    .diff th + th {
      border-left: 1px solid var(--border);
    }
    .diff tr.changed td {
      background: color-mix(in srgb, var(--warning) 12%, transparent);
    }
    .diff tr.changed td.empty {
      background: var(--bg-sunken);
    }
    .btn {
      height: 28px;
      padding: 0 10px;
      border-radius: 4px;
      border: 1px solid var(--border-strong);
      background: var(--bg-raised);
      color: var(--fg);
    }
    .btn:hover {
      background: var(--bg-hover);
    }
    .btn:disabled {
      opacity: 0.55;
    }
    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-fg);
    }
    .btn-primary:hover:not(:disabled) {
      background: var(--accent);
      filter: brightness(1.08);
    }
  `,
})
export class CompareView {
  readonly tab = input.required<CompareTab>()

  protected readonly connections = inject(Connections)
  private readonly catalog = inject(Catalog)
  private readonly changesApi = inject(SchemaChanges)
  private readonly workspace = inject(Workspace)
  private readonly dialog = inject(Dialog)

  protected readonly envDot = ENV_DOT
  protected readonly glyph = GLYPH
  protected readonly filter = signal<Filter>('all')
  protected readonly search = signal('')
  protected readonly selectedId = signal<string | null>(null)
  protected readonly picked = signal<ReadonlySet<string>>(new Set())
  protected readonly pane = signal<'change' | 'script'>('change')
  protected readonly ran = signal(false)
  protected readonly applying = signal(false)
  protected readonly applyMessage = signal<{ text: string; error: boolean } | null>(null)
  private readonly run = signal(0)

  /** Schemas to offer: the source's (the target's may lack some — that's a difference to show). */
  protected readonly schemaChoices = toSignal(
    toObservable(computed(() => this.tab().source().id)).pipe(
      switchMap((id) =>
        this.catalog.objects(id).pipe(
          map((o) => o.schemas.filter((s) => !/^(pg_|information_schema)/.test(s))),
          catchError(() => of([] as string[])),
        ),
      ),
    ),
    { initialValue: [] as string[] },
  )

  /** Kept on screen while a re-compare runs, so the list doesn't blink away. */
  private lastChanges: Change[] = []

  protected readonly result: Signal<CompareResult> = toSignal(
    toObservable(this.run).pipe(
      switchMap((n) => {
        if (!n) return of<CompareResult>({ loading: false, error: null, changes: [], ms: 0 })
        const t = untracked(() => this.tab())
        const started = performance.now()
        const schemas = t.schemas()
        return forkJoin([
          this.changesApi.snapshot(t.source().id, schemas),
          this.changesApi.snapshot(t.target().id, schemas),
        ]).pipe(
          map(([source, target]): CompareResult => ({
            loading: false,
            error: null,
            changes: diffSnapshots(source, target),
            ms: Math.round(performance.now() - started),
          })),
          catchError((e: Error) =>
            of<CompareResult>({ loading: false, error: e.message, changes: [], ms: 0 }),
          ),
          startWith<CompareResult>({ loading: true, error: null, changes: this.lastChanges, ms: 0 }),
        )
      }),
    ),
    { initialValue: { loading: false, error: null, changes: [], ms: 0 } as CompareResult },
  )

  protected readonly selectable = computed(() => this.result().changes.filter((c) => c.statements.length))

  protected readonly filters = computed(() => {
    const all = this.result().changes
    const count = (s: Filter) => all.filter((c) => s === 'all' || c.status === s).length
    return (
      [
        { id: 'all', label: 'All' },
        { id: 'create', label: '+ Missing' },
        { id: 'alter', label: '~ Different' },
        { id: 'drop', label: '− Extra' },
      ] as const
    ).map((f) => ({ ...f, count: count(f.id) }))
  })

  /** Tables with their parts underneath, then the other kinds; filtered by status and text. */
  protected readonly groups = computed((): Group[] => {
    const q = this.search().trim().toLowerCase()
    const f = this.filter()
    const shown = this.result().changes.filter(
      (c) => (f === 'all' || c.status === f) && (!q || `${c.name} ${c.summary}`.toLowerCase().includes(q)),
    )
    const groups: Group[] = []
    for (const kind of KIND_ORDER) {
      if (kind !== 'table') {
        const rows = shown.filter((c) => c.kind === kind).map((change) => ({ change, child: false }))
        if (rows.length) groups.push({ key: kind, label: KIND_LABEL[kind], rows })
        continue
      }
      const byTable = new Map<string, Change[]>()
      for (const c of shown.filter((c) => TABLE_PARTS.has(c.kind))) {
        const t = c.table ?? c.name
        byTable.set(t, [...(byTable.get(t) ?? []), c])
      }
      const rows: Group['rows'] = []
      for (const [, list] of [...byTable].sort(([a], [b]) => a.localeCompare(b))) {
        const own = list.filter((c) => c.kind === 'table')
        const parts = list.filter((c) => c.kind !== 'table')
        // A table with only part-level differences still gets its name above them.
        if (!own.length) rows.push({ heading: parts[0].table ?? parts[0].name, child: false })
        for (const c of own) rows.push({ change: c, child: false })
        for (const c of parts) rows.push({ change: c, child: true })
      }
      if (rows.length) groups.push({ key: 'table', label: KIND_LABEL['table'], rows })
    }
    return groups
  })

  protected readonly selected = computed(
    () => this.result().changes.find((c) => c.id === this.selectedId()) ?? null,
  )

  protected readonly diffRows = computed(() => {
    const c = this.selected()
    return c ? sideBySide(c.source ?? '', c.target ?? '') : []
  })

  protected readonly script = computed(() =>
    statements(this.result().changes.filter((c) => this.picked().has(c.id))),
  )
  protected readonly scriptText = computed(() =>
    this.script()
      .map((s) => s + ';')
      .join('\n\n'),
  )

  constructor() {
    // A fresh comparison selects everything except drops (and notes the script can't act on).
    effect(() => {
      const r = this.result()
      if (r.loading) return
      this.lastChanges = r.changes
      untracked(() => {
        this.picked.set(
          new Set(r.changes.filter((c) => c.statements.length && !c.destructive).map((c) => c.id)),
        )
        if (!r.changes.some((c) => c.id === this.selectedId())) this.selectedId.set(r.changes[0]?.id ?? null)
      })
    })
    // Opening the tab compares straight away when there's something to compare.
    queueMicrotask(() => {
      const t = this.tab()
      if (t.source().id !== t.target().id) this.compare()
    })
  }

  protected val(e: Event) {
    return (e.target as HTMLSelectElement).value
  }

  protected compare() {
    this.ran.set(true)
    this.applyMessage.set(null)
    this.run.update((n) => n + 1)
  }

  protected setSource(id: string) {
    const c = this.connections.get(id)
    if (c) this.tab().source.set(c)
    this.workspace.tabs.update((tabs) => [...tabs])
  }

  protected setTarget(id: string) {
    const c = this.connections.get(id)
    if (c) this.tab().target.set(c)
    // The tab strip (title, colour) follows the target.
    this.workspace.tabs.update((tabs) => [...tabs])
  }

  protected swap() {
    const t = this.tab()
    const source = t.source()
    t.source.set(t.target())
    t.target.set(source)
    this.workspace.tabs.update((tabs) => [...tabs])
    if (this.ran()) this.compare()
  }

  protected setSchemas(schemas: string[] | null) {
    this.tab().schemas.set(schemas)
  }

  protected toggleSchema(s: string) {
    const current = this.tab().schemas() ?? []
    const next = current.includes(s) ? current.filter((x) => x !== s) : [...current, s]
    this.tab().schemas.set(next.length ? next : null)
  }

  protected toggle(id: string) {
    this.picked.update((set) => {
      const next = new Set(set)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  protected selectSafe() {
    this.picked.set(
      new Set(
        this.selectable()
          .filter((c) => !c.destructive)
          .map((c) => c.id),
      ),
    )
  }

  protected changeSql(c: Change) {
    return statements([c])
      .map((s) => s + ';')
      .join('\n\n')
  }

  protected copy() {
    navigator.clipboard.writeText(this.scriptText())
    this.applyMessage.set({ text: `Copied ${this.script().length} statements`, error: false })
  }

  /** On the target, as a script to read and run — the way changes reach prod. */
  protected openInTab() {
    const t = this.tab()
    this.workspace.openTab(
      t.target(),
      `-- Make ${t.target().name} look like ${t.source().name} (yadbc compare)\n\n${this.scriptText()}\n`,
    )
  }

  protected async apply() {
    const t = this.tab()
    const n = this.script().length
    const drops = this.result().changes.filter((c) => this.picked().has(c.id) && c.destructive).length
    const choice = await lastValueFrom(
      this.dialog.open<string, ConfirmData>(ConfirmDialog, {
        data: {
          title: `Apply ${n} ${n === 1 ? 'statement' : 'statements'} to ${t.target().name}?`,
          message: `They run in one transaction: all of them, or none if one fails.${drops ? ` ${drops} of the selected changes drop something.` : ''}`,
          actions: [
            { id: 'apply', label: 'Apply' },
            { id: 'cancel', label: 'Cancel' },
          ],
        },
      }).closed,
    )
    if (choice !== 'apply') return
    this.applying.set(true)
    const statementsToRun = this.script()
    this.changesApi.apply(t.target().id, statementsToRun).subscribe((r) => {
      this.applying.set(false)
      if (r.ok) {
        this.applyMessage.set({ text: `Applied ${n} statements to ${t.target().name}.`, error: false })
        this.catalog.refresh(t.target().id)
        this.run.update((x) => x + 1)
      } else {
        const failed =
          r.statementIndex != null ? ` — in: ${statementsToRun[r.statementIndex].slice(0, 120)}` : ''
        this.applyMessage.set({ text: `Nothing changed: ${r.error}${failed}`, error: true })
      }
    })
  }
}
