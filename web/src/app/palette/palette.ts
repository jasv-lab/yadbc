import { Dialog } from '@angular/cdk/dialog'
import { Overlay } from '@angular/cdk/overlay'
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injectable,
  signal,
  viewChild,
} from '@angular/core'
import { toObservable, toSignal } from '@angular/core/rxjs-interop'
import { DialogRef, DIALOG_DATA } from '@angular/cdk/dialog'
import { catchError, debounceTime, map, of, startWith, switchMap } from 'rxjs'
import { Connections } from '../connections/connections'
import { Commands } from '../core/commands'
import { ConnectionProfile } from '../core/protocol'
import { History, HistoryEntry } from '../history/history'
import { Snippets } from '../snippets/snippets'
import { Catalog, CatalogObject } from '../schema/catalog'
import { SchemaActions } from '../schema/schema-actions'
import { Icon, IconName } from '../ui/icon'
import { Workspace } from '../workspace/workspace'
import { fuzzyMatch, highlight } from './fuzzy'

export interface PaletteData {
  /** '>' starts in command mode (Ctrl+K); '' in go-to mode (Ctrl+P). */
  initial: string
  openConnection: (c: ConnectionProfile) => void
}

interface Item {
  key: string
  section: string
  label: string
  detail?: string
  icon: IconName
  /** alt = Alt+Enter: the "in a new tab" variant where there is one */
  run: (alt: boolean) => void
  score: number
  positions: number[]
}

const KIND_ICON: Record<string, IconName> = {
  table: 'table',
  view: 'view',
  matview: 'matview',
  foreign: 'table',
  function: 'function',
  procedure: 'function',
  sequence: 'sequence',
  enum: 'enum',
}
const MAX_ITEMS = 60

/**
 * One palette, two modes. `>` prefix: commands from the registry (only those available right now,
 * with their shortcuts). Otherwise: go to objects of the active connection, history and connections.
 */
@Component({
  selector: 'y-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: {
    class:
      'flex w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-line-strong bg-raised shadow-2xl',
  },
  template: `
    <div class="flex items-center gap-2 border-b border-line px-3">
      <y-icon [name]="commandMode() ? 'chevron-right' : 'search'" [size]="15" class="text-faint" />
      <input
        #input
        class="h-11 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint"
        [placeholder]="
          commandMode() ? 'Run a command' : 'Go to a table, function or recent query — type > for commands'
        "
        [value]="query()"
        (input)="query.set(input.value)"
        (keydown)="onKey($event)"
        spellcheck="false"
        autocomplete="off"
      />
    </div>
    <div #list class="max-h-[420px] overflow-y-auto py-1" role="listbox">
      @for (row of rows(); track row.key) {
        @if (row.header) {
          <div class="px-3 pt-2 pb-1 text-[11px] text-faint">{{ row.header }}</div>
        } @else if (row.item; as it) {
          <div
            class="item"
            role="option"
            [attr.data-index]="row.index"
            [attr.aria-selected]="row.index === active()"
            [class.active]="row.index === active()"
            (mousemove)="active.set(row.index!)"
            (click)="choose(it, $event.altKey)"
          >
            <y-icon [name]="it.icon" [size]="14" class="shrink-0 text-muted" />
            <span class="label">
              @for (part of parts(it); track $index) {
                <span [class.hit]="part.hit">{{ part.text }}</span>
              }
            </span>
            @if (it.detail) {
              <span class="detail">{{ it.detail }}</span>
            }
          </div>
        }
      } @empty {
        <p class="px-3 py-3 text-[12.5px] text-faint">{{ busy() ? 'Searching…' : 'No matches.' }}</p>
      }
    </div>
    <div class="flex gap-4 border-t border-line bg-sunken px-3 py-1.5 text-[11px] text-faint">
      <span>↑↓ navigate</span>
      <span>Enter open</span>
      @if (!commandMode()) {
        <span>Alt+Enter in new tab</span>
        <span>&gt; commands</span>
      }
      <span class="ml-auto">Esc close</span>
    </div>
  `,
  styles: `
    .item {
      display: flex;
      align-items: center;
      gap: 10px;
      height: 30px;
      margin: 0 4px;
      padding: 0 8px;
      border-radius: 5px;
      cursor: default;
    }
    .item.active {
      background: var(--bg-selected);
    }
    .label {
      min-width: 0;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .hit {
      color: var(--accent);
      font-weight: 600;
    }
    .detail {
      flex-shrink: 0;
      max-width: 45%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11.5px;
      color: var(--fg-faint);
    }
  `,
})
export class PaletteDialog {
  private readonly ref = inject<DialogRef<void>>(DialogRef)
  private readonly data = inject<PaletteData>(DIALOG_DATA)
  private readonly commands = inject(Commands)
  private readonly connections = inject(Connections)
  private readonly workspace = inject(Workspace)
  private readonly catalog = inject(Catalog)
  private readonly actions = inject(SchemaActions)
  private readonly history = inject(History)
  private readonly snippets = inject(Snippets)
  private readonly list = viewChild.required<ElementRef<HTMLDivElement>>('list')

  protected readonly query = signal(this.data.initial)
  protected readonly active = signal(0)
  protected readonly commandMode = computed(() => this.query().startsWith('>'))
  private readonly term = computed(() => (this.commandMode() ? this.query().slice(1) : this.query()).trim())
  private readonly conn = computed(() => this.workspace.current()?.connection ?? null)

  private readonly objects = toSignal(
    toObservable(this.conn).pipe(
      switchMap((c) =>
        c
          ? this.catalog.objects(c.id).pipe(
              map((d) => d.objects),
              catchError(() => of([])),
            )
          : of([]),
      ),
    ),
    { initialValue: [] as CatalogObject[] },
  )

  /** History is searched on the server (it can be large); recent entries when the query is empty. */
  private readonly historyResult = toSignal(
    toObservable(computed(() => ({ conn: this.conn(), q: this.term(), commands: this.commandMode() }))).pipe(
      debounceTime(120),
      switchMap(({ conn, q, commands }) =>
        !conn || commands
          ? of({ busy: false, entries: [] as HistoryEntry[] })
          : this.history.list(conn.id, q, undefined, q ? 15 : 6).pipe(
              map((entries) => ({ busy: false, entries })),
              catchError(() => of({ busy: false, entries: [] as HistoryEntry[] })),
              startWith({ busy: true, entries: [] as HistoryEntry[] }),
            ),
      ),
    ),
  )
  protected readonly busy = computed(() => !!this.historyResult()?.busy)

  private readonly items = computed((): Item[] => {
    const term = this.term()
    const scored = (item: Omit<Item, 'score' | 'positions'>, text = item.label): Item | null => {
      const m = fuzzyMatch(term, text)
      return m ? { ...item, score: m.score, positions: text === item.label ? m.positions : [] } : null
    }
    const sorted = (items: (Item | null)[]) =>
      items.filter((i): i is Item => !!i).sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))

    if (this.commandMode()) {
      return sorted(
        this.commands.list().map((c) =>
          scored({
            key: `cmd:${c.id}`,
            section: 'Commands',
            label: c.label,
            detail: c.shortcut,
            icon: 'chevron-right',
            run: () => this.commands.execute(c.id),
          }),
        ),
      )
    }

    const conn = this.conn()
    const objects = conn
      ? sorted(
          this.objects().map((o) =>
            scored({
              key: `obj:${o.oid}`,
              section: o.kind === 'function' || o.kind === 'procedure' ? 'Functions' : 'Tables & views',
              label: o.name,
              detail: `${o.schema} · ${o.kind}${o.estRows != null ? ` · ~${o.estRows.toLocaleString()}` : ''}`,
              icon: KIND_ICON[o.kind] ?? 'table',
              run: () => this.actions.open(conn, o),
            }),
          ),
        )
          .slice(0, term ? 40 : 12)
          // Sections in a fixed order (sorting by score alone would interleave them); best first within each.
          .sort((a, b) => (a.section === b.section ? 0 : a.section === 'Tables & views' ? -1 : 1))
      : []

    const snippets = conn
      ? sorted(
          this.snippets.forConnection(conn.id).map((s) =>
            scored({
              key: `snip:${s.id}`,
              section: 'Snippets',
              label: s.name,
              detail: s.sql.replace(/\s+/g, ' ').trim().slice(0, 60),
              icon: 'template' as IconName,
              run: (alt: boolean) =>
                alt ? this.workspace.openTab(conn, s.sql) : this.insertOrOpen(conn, s.sql),
            }),
          ),
        ).slice(0, term ? 10 : 5)
      : []

    const history: Item[] = conn
      ? (this.historyResult()?.entries ?? []).map((e) => ({
          key: `hist:${e.id}`,
          section: 'Recent queries',
          label: e.sql.replace(/\s+/g, ' ').trim(),
          detail:
            e.outcome === 'error'
              ? 'failed'
              : e.outcome === 'cancelled'
                ? 'cancelled'
                : e.rows != null
                  ? `${e.rows.toLocaleString()} rows`
                  : undefined,
          icon: 'history' as IconName,
          run: (alt: boolean) => (alt ? this.workspace.openTab(conn, e.sql) : this.insertOrOpen(conn, e.sql)),
          score: 0,
          positions: [],
        }))
      : []

    const connections = sorted(
      this.connections.list().map((c) =>
        scored(
          {
            key: `conn:${c.id}`,
            section: 'Connections',
            label: c.name,
            detail: `${c.group ? c.group + ' · ' : ''}${c.env} · ${c.database}`,
            icon: 'database',
            run: () => this.data.openConnection(c),
          },
          // "cmdb" finds every connection in the CMDB group.
          c.group ? `${c.name} ${c.group}` : c.name,
        ),
      ),
    )
    return [...objects, ...snippets, ...history, ...connections].slice(0, MAX_ITEMS)
  })

  /** Items with section headers interleaved; `index` counts selectable items only. */
  protected readonly rows = computed(() => {
    const rows: { key: string; header?: string; item?: Item; index?: number }[] = []
    let section = ''
    this.items().forEach((item, index) => {
      if (item.section !== section) {
        section = item.section
        rows.push({ key: `h:${section}`, header: section })
      }
      rows.push({ key: item.key, item, index })
    })
    return rows
  })

  protected parts(item: Item) {
    return highlight(item.label, item.positions)
  }

  protected onKey(e: KeyboardEvent) {
    const count = this.items().length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!count) return
      this.active.update((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + count) % count)
      queueMicrotask(() =>
        this.list()
          .nativeElement.querySelector(`[data-index="${this.active()}"]`)
          ?.scrollIntoView({ block: 'nearest' }),
      )
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = this.items()[this.active()]
      if (item) this.choose(item, e.altKey)
    } else if (e.key !== 'Escape' && e.key.length === 1) {
      // Typing changes the list; start again at the best match.
      queueMicrotask(() => this.active.set(0))
    } else if (e.key === 'Backspace') {
      queueMicrotask(() => this.active.set(0))
    }
  }

  /** Close first, then act — so focus returns to the app before the action runs (editor, new tab…). */
  protected choose(item: Item, alt: boolean) {
    this.ref.close()
    setTimeout(() => item.run(alt))
  }

  private insertOrOpen(conn: ConnectionProfile, sql: string) {
    const tab = this.workspace.activeTab()
    if (tab && tab.connection.id === conn.id) this.workspace.insertIntoEditor(tab, sql)
    else this.workspace.openTab(conn, sql)
  }
}

@Injectable({ providedIn: 'root' })
export class Palette {
  private readonly dialog = inject(Dialog)
  private readonly overlay = inject(Overlay)

  open(data: PaletteData) {
    // One at a time: Ctrl+K inside the palette switches mode instead of stacking another.
    if (this.dialog.openDialogs.some((d) => d.componentInstance instanceof PaletteDialog)) return
    this.dialog.open(PaletteDialog, {
      data,
      positionStrategy: this.overlay.position().global().centerHorizontally().top('12vh'),
      autoFocus: 'input',
      restoreFocus: true,
    })
  }
}
