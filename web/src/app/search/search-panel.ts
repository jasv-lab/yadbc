import { DecimalPipe } from '@angular/common'
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core'
import { goToSql } from '../navigation/sql-nav'
import { Icon } from '../ui/icon'
import { Workspace } from '../workspace/workspace'
import { SearchHit, ValueSearch } from './value-search'

/** The drawer's "Find everywhere" view: progress, then where the value turned up. */
@Component({
  selector: 'y-search-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, DecimalPipe],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    @if (search.state(); as s) {
      <div class="border-b border-line px-3 py-2">
        <div class="text-[11.5px] text-faint">Where else is</div>
        <div class="value">{{ s.value }}</div>
        <div class="mt-1.5 flex items-center gap-2 text-[11.5px] text-muted">
          @if (s.family === null && !s.running) {
            <span>{{ s.type }} values can't be searched for.</span>
          } @else {
            <div class="bar"><span [style.width.%]="s.tables ? (s.done / s.tables) * 100 : 0"></span></div>
            <span class="whitespace-nowrap tabular-nums">{{ s.done }} / {{ s.tables }} tables</span>
            @if (s.running) {
              <button class="run-btn" (click)="search.stop()">Stop</button>
            }
          }
        </div>
        @if (s.family === 'int') {
          <p class="mt-1 text-[11px] text-faint">
            Numbers are looked for in key-like columns: keys, indexed, id / *_id.
          </p>
        }
        @if (s.stopped) {
          <p class="mt-1 text-[11px] text-warning">Stopped — not every table was searched.</p>
        }
      </div>
      <div class="min-h-0 flex-1 overflow-auto py-1">
        @for (g of groups(); track g.table) {
          <div class="group">
            <div class="flex items-center gap-1.5 px-3 pt-2 pb-0.5">
              <y-icon name="table" [size]="13" class="text-accent" />
              <span class="font-medium">{{ g.table }}</span>
            </div>
            @for (h of g.hits; track h.column) {
              <button class="hit" (click)="open(h)" title="Open these rows in a new tab">
                <span class="font-mono text-[12px]">{{ h.column }}</span>
                <span class="flex-1"></span>
                <span class="text-muted tabular-nums"
                  >{{ h.rows > 100 ? '100+' : (h.rows | number) }} {{ h.rows === 1 ? 'row' : 'rows' }}</span
                >
                <y-icon name="goto" [size]="12" class="text-faint" />
              </button>
            }
          </div>
        } @empty {
          @if (!s.running && s.family !== null) {
            <p class="px-3 py-3 text-[12px] text-faint">Not found in any searched column.</p>
          }
        }
        @if (s.problems.length) {
          <details class="mx-3 mt-3 text-[11.5px] text-faint">
            <summary class="cursor-pointer">
              {{ s.problems.length }} {{ s.problems.length === 1 ? 'table' : 'tables' }} not searched
            </summary>
            @for (p of s.problems; track $index) {
              <div class="mt-1">{{ p.table }} — {{ p.error }}</div>
            }
          </details>
        }
      </div>
    } @else {
      <p class="p-4 text-[12px] text-faint">Right-click a cell → Find everywhere.</p>
    }
  `,
  styles: `
    .value {
      font: 12.5px var(--font-mono);
      word-break: break-all;
      user-select: text;
    }
    .bar {
      flex: 1;
      height: 4px;
      border-radius: 2px;
      background: var(--bg-sunken);
      overflow: hidden;
    }
    .bar > span {
      display: block;
      height: 100%;
      background: var(--accent);
      transition: width 120ms;
    }
    .hit {
      display: flex;
      width: 100%;
      align-items: center;
      gap: 8px;
      padding: 3px 12px 3px 31px;
      text-align: left;
      font-size: 12px;
    }
    .hit:hover {
      background: var(--bg-hover);
    }
  `,
})
export class SearchPanel {
  protected readonly search = inject(ValueSearch)
  private readonly workspace = inject(Workspace)

  /** Hits by table, in the order found. */
  protected readonly groups = computed(() => {
    const out: { table: string; hits: SearchHit[] }[] = []
    for (const h of this.search.state()?.hits ?? []) {
      const key = `${h.schema}.${h.table}`
      const g = out.find((x) => x.table === key) ?? (out.push({ table: key, hits: [] }), out[out.length - 1])
      g.hits.push(h)
    }
    return out
  })

  protected open(h: SearchHit) {
    const s = this.search.state()
    if (!s) return
    const sql = goToSql({ schema: h.schema, name: h.table }, h.column, [s.value], s.type)
    this.workspace.openTab(s.connection, sql + ';', { autoRun: true })
  }
}
