import { DecimalPipe } from '@angular/common'
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { toObservable, toSignal } from '@angular/core/rxjs-interop'
import { catchError, debounceTime, map, of, startWith, switchMap } from 'rxjs'
import { QuerySocket } from '../core/query-socket'
import { Direction, Navigator } from '../navigation/navigator'
import { searchable, ValueSearch } from '../search/value-search'
import { ColumnRelations, Relations } from '../navigation/relations'
import { Icon } from '../ui/icon'
import { CellInspector, CellRef } from './cell-inspector'
import { JsonTree } from './json-tree'

interface Loaded {
  ref: CellRef | null
  loading: boolean
  /** undefined = result no longer available on the backend */
  value: string | null | undefined
}

const HEX_ROW = 16
const MAX_HEX_ROWS = 2048

/** Contents of the drawer's "Cell" view: the full, untruncated value of the grid's active cell. */
@Component({
  selector: 'y-inspector-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, JsonTree, DecimalPipe],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    @let s = state();
    @if (!s.ref) {
      <p class="p-4 text-[12px] text-faint">Select a cell in the results to inspect its full value.</p>
    } @else {
      <div class="flex items-center gap-2 border-b border-line px-3 py-2">
        <div class="min-w-0 flex-1">
          <div class="truncate font-medium">{{ s.ref.column.name }}</div>
          <div class="font-mono text-[11px] text-faint">
            {{ s.ref.column.type }} · row {{ s.ref.row + 1 | number }}
            @if (stats(); as st) {
              · {{ st }}
            }
          </div>
        </div>
        @if (json() !== undefined) {
          <div class="flex rounded border border-line p-0.5 text-[11.5px]">
            <button class="seg" [class.seg-on]="jsonView() === 'tree'" (click)="jsonView.set('tree')">
              Tree
            </button>
            <button class="seg" [class.seg-on]="jsonView() === 'text'" (click)="jsonView.set('text')">
              Text
            </button>
          </div>
        }
        @if (canSearch()) {
          <button class="icon-btn" title="Find this value in every table" (click)="findEverywhere()">
            <y-icon name="search" [size]="14" />
          </button>
        }
        <button class="icon-btn" title="Copy value" (click)="copy()" [disabled]="s.value == null">
          <y-icon [name]="copied() ? 'check' : 'copy'" [size]="14" />
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-auto p-3 select-text">
        @if (s.loading) {
          <p class="text-[12px] text-faint">Loading…</p>
        } @else if (s.value === undefined) {
          <p class="text-[12px] text-faint">This result is no longer available. Run the query again.</p>
        } @else if (s.value === null) {
          <span class="font-mono text-faint italic">null</span>
        } @else if (s.value === '') {
          <span class="font-mono text-faint">'' (empty string)</span>
        } @else if (json() !== undefined && jsonView() === 'tree') {
          <y-json-tree [value]="json()!" />
        } @else if (json() !== undefined) {
          <pre class="mono-block">{{ prettyJson() }}</pre>
        } @else if (hex(); as h) {
          <pre class="mono-block">{{ h }}</pre>
        } @else {
          <pre class="mono-block">{{ s.value }}</pre>
        }
      </div>

      @if (related(); as r) {
        <div class="related">
          @if (r.rel.enum; as en) {
            <div class="rel-title">{{ en.type }} — one of</div>
            <div class="flex flex-wrap gap-1">
              @for (v of en.values; track v) {
                <span class="chip" [class.chip-on]="v === s.value">{{ v }}</span>
              }
            </div>
          }
          @if (r.rel.references; as fk) {
            <div class="rel-title">References</div>
            <div class="flex items-center gap-2">
              <y-icon name="goto" [size]="13" class="shrink-0 text-accent" />
              <span class="min-w-0 flex-1 truncate">
                <span class="font-mono text-[12px]">{{ fk.table.name }}.{{ fk.column }}</span>
                @if (r.label) {
                  <span class="text-muted"> · {{ r.label }}</span>
                }
              </span>
              @if (s.value !== null) {
                <button class="run-btn" (click)="goTo(r, 'references')">Go to</button>
              }
              @if (r.joinable) {
                <button class="run-btn" (click)="join(r, 'references')">Join</button>
              }
            </div>
          }
          @if (r.rel.referencedBy.length && s.value !== null) {
            <div class="rel-title">Referenced by</div>
            @for (ref of r.rel.referencedBy; track ref.constraint) {
              <button class="rel-link" (click)="goTo(r, ref)">
                <y-icon name="goto-back" [size]="12" />
                <span class="font-mono text-[12px]">{{ ref.table.name }}.{{ ref.column }}</span>
                <span class="text-faint">= {{ s.value }}</span>
              </button>
            }
          }
        </div>
      }
    }
  `,
  styles: `
    .mono-block {
      margin: 0;
      font: 12.5px/20px var(--font-mono);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .related {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px 12px 12px;
      border-top: 1px solid var(--border);
      font-size: 12.5px;
    }
    .rel-title {
      margin-top: 2px;
      font-size: 11px;
      color: var(--fg-faint);
    }
    .chip {
      padding: 1px 8px;
      border-radius: 10px;
      border: 1px solid var(--border);
      font: 12px var(--font-mono);
      color: var(--fg-muted);
    }
    .chip-on {
      border-color: var(--accent);
      background: var(--bg-selected);
      color: var(--fg);
    }
    .rel-link {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 4px;
      border-radius: 4px;
      text-align: left;
    }
    .rel-link:hover {
      background: var(--bg-hover);
    }
    .seg {
      padding: 0 8px;
      border-radius: 3px;
      color: var(--fg-muted);
    }
    .seg-on {
      background: var(--bg-selected);
      color: var(--fg);
    }
  `,
})
export class InspectorPanel {
  private readonly socket = inject(QuerySocket)
  private readonly inspector = inject(CellInspector)
  private readonly relations = inject(Relations)
  private readonly navigator = inject(Navigator)
  private readonly valueSearch = inject(ValueSearch)

  protected readonly canSearch = computed(() => {
    const s = this.state()
    return !!s.ref && typeof s.value === 'string' && s.value !== '' && searchable(s.ref.column.type)
  })

  protected findEverywhere() {
    const s = this.state()
    const at = s.ref && this.navigator.locate(s.ref.resultId)
    if (!at || typeof s.value !== 'string' || !s.ref) return
    this.valueSearch.start(at.tab.connection, s.value, s.ref.column.type)
    this.inspector.showSearch()
  }

  protected readonly jsonView = signal<'tree' | 'text'>('tree')
  protected readonly copied = signal(false)

  /** Debounced so holding an arrow key in the grid doesn't fire a request per row. */
  protected readonly state = toSignal(
    toObservable(this.inspector.target).pipe(
      debounceTime(40),
      switchMap((ref) =>
        ref
          ? this.socket.cell(ref.resultId, ref.row, ref.col).pipe(
              map((value): Loaded => ({ ref, loading: false, value })),
              startWith<Loaded>({ ref, loading: true, value: undefined }),
            )
          : of<Loaded>({ ref: null, loading: false, value: undefined }),
      ),
    ),
    { initialValue: { ref: null, loading: false, value: undefined } as Loaded },
  )

  /**
   * Enum values, the referenced row's label, and who references this value — for the inspected cell,
   * editable or not (read-only sessions never get the editor's value picker).
   */
  protected readonly related = toSignal(
    toObservable(this.state).pipe(
      switchMap((s) => {
        const ref = s.ref
        if (!ref || s.loading) return of(null)
        return this.relations.of(ref.resultId).pipe(
          switchMap((rels) => {
            const rel: ColumnRelations | undefined = rels[ref.col]
            if (!rel || (!rel.enum && !rel.references && !rel.referencedBy.length)) return of(null)
            const base = { ref, rel, joinable: this.navigator.joinable(ref.resultId) }
            if (!rel.references?.labelColumn || typeof s.value !== 'string')
              return of({ ...base, label: null })
            const value = s.value
            return this.relations.values(ref.resultId, ref.col, value).pipe(
              map((r) => ({ ...base, label: r.values.find((v) => v.value === value)?.label ?? null })),
              catchError(() => of({ ...base, label: null })),
              startWith({ ...base, label: null }),
            )
          }),
        )
      }),
    ),
    { initialValue: null },
  )

  protected goTo(r: { ref: { resultId: string; col: number } }, dir: Direction) {
    const v = this.state().value
    if (v !== undefined) this.navigator.goTo(r.ref.resultId, r.ref.col, [v], dir)
  }

  protected join(r: { ref: { resultId: string; col: number } }, dir: Direction) {
    this.navigator.join(r.ref.resultId, r.ref.col, dir)
  }

  protected readonly json = computed(() => {
    const s = this.state()
    if (!s.ref || typeof s.value !== 'string' || !['json', 'jsonb'].includes(s.ref.column.type))
      return undefined
    try {
      return JSON.parse(s.value)
    } catch {
      return undefined
    }
  })

  protected readonly prettyJson = computed(() => JSON.stringify(this.json(), null, 2))

  protected readonly hex = computed(() => {
    const s = this.state()
    if (s.ref?.column.type !== 'bytea' || typeof s.value !== 'string') return null
    return hexDump(s.value)
  })

  protected readonly stats = computed(() => {
    const v = this.state().value
    if (typeof v !== 'string' || !v) return null
    if (this.state().ref?.column.type === 'bytea') return `${byteCount(v).toLocaleString()} bytes`
    const lines = v.split('\n').length
    return `${v.length.toLocaleString()} chars${lines > 1 ? ` · ${lines.toLocaleString()} lines` : ''}`
  })

  protected copy() {
    const v = this.state().value
    if (typeof v !== 'string') return
    navigator.clipboard.writeText(v)
    this.copied.set(true)
    setTimeout(() => this.copied.set(false), 1200)
  }
}

/** bytea arrives as `\x0a1b…` (possibly with a size note when capped). */
function hexDigits(value: string): string {
  const m = /^\\x([0-9a-f]*)/i.exec(value)
  return m ? m[1] : ''
}

function byteCount(value: string): number {
  const note = /\(([\d,\s ]+) bytes\)$/.exec(value)
  return note ? Number(note[1].replace(/[^\d]/g, '')) : hexDigits(value).length / 2
}

/** Classic offset · hex · ASCII dump. */
function hexDump(value: string): string {
  const hex = hexDigits(value)
  const bytes = hex.length / 2
  const rows = Math.min(Math.ceil(bytes / HEX_ROW), MAX_HEX_ROWS)
  const out: string[] = []
  for (let r = 0; r < rows; r++) {
    const parts: string[] = []
    let ascii = ''
    for (let i = 0; i < HEX_ROW; i++) {
      const b = r * HEX_ROW + i
      if (b < bytes) {
        const pair = hex.substr(b * 2, 2)
        parts.push(pair)
        const code = parseInt(pair, 16)
        ascii += code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : '·'
      } else {
        parts.push('  ')
      }
      if (i === 7) parts.push('')
    }
    out.push(`${(r * HEX_ROW).toString(16).padStart(8, '0')}  ${parts.join(' ')}  ${ascii}`)
  }
  const total = byteCount(value)
  if (total > rows * HEX_ROW) out.push(`… ${(total - rows * HEX_ROW).toLocaleString()} more bytes`)
  return out.join('\n')
}
