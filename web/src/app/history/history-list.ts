import { CdkContextMenuTrigger, CdkMenu, CdkMenuItem } from '@angular/cdk/menu'
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core'
import { toObservable, toSignal } from '@angular/core/rxjs-interop'
import { catchError, combineLatest, debounceTime, map, of, startWith, switchMap } from 'rxjs'
import { ConnectionProfile } from '../core/protocol'
import { Icon } from '../ui/icon'
import { Workspace } from '../workspace/workspace'
import { History, HistoryEntry } from './history'

const PAGE = 100

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  const d = new Date(iso)
  return s < 7 * 86400
    ? d.toLocaleDateString(undefined, { weekday: 'short' }) +
        ' ' +
        d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString()
}

const duration = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`)

/**
 * Sidebar history for the active connection: newest first, searchable, paged. Double-click opens an
 * entry in a new tab; Enter puts it into the current editor (appended — nothing of yours is replaced).
 */
@Component({
  selector: 'y-history-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, CdkContextMenuTrigger, CdkMenu, CdkMenuItem],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <div class="flex items-center gap-1 px-2 pb-1.5">
      <div
        class="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded border border-line bg-bg px-2 text-faint"
      >
        <y-icon name="search" [size]="13" />
        <input
          #searchInput
          class="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-faint"
          placeholder="Search history"
          [value]="search()"
          (input)="search.set(searchInput.value)"
          (keydown.escape)="search.set(''); searchInput.blur()"
          (keydown.arrowdown)="$event.preventDefault(); list.focus(); move(1)"
        />
      </div>
    </div>

    <div
      #list
      class="min-h-0 flex-1 overflow-y-auto outline-none"
      tabindex="0"
      role="listbox"
      (keydown)="onKey($event)"
      (scroll)="onScroll(list)"
    >
      @for (e of entries(); track e.id) {
        <div
          class="entry"
          role="option"
          [attr.aria-selected]="e.id === selected()"
          [class.selected]="e.id === selected()"
          [title]="e.sql"
          (mousedown)="selected.set(e.id)"
          (dblclick)="openInNewTab(e)"
          [cdkContextMenuTriggerFor]="menu"
          [cdkContextMenuTriggerData]="{ entry: e }"
        >
          <div class="sql">{{ e.sql }}</div>
          <div class="meta">
            <span class="dot" [class]="e.outcome"></span>
            @if (e.kind !== 'run') {
              <span class="kind">{{ kindLabel(e.kind) }}</span>
            }
            <span>{{ ago(e.startedAt) }}</span>
            @if (e.outcome === 'error') {
              <span class="truncate text-danger">{{ e.error }}</span>
            } @else if (e.outcome === 'cancelled') {
              <span>cancelled</span>
            } @else {
              @if (e.kind !== 'edit') {
                <span>{{ duration(e.durationMs) }}</span>
              }
              @if (e.rows != null) {
                <span
                  >{{ e.rows.toLocaleString() }}
                  {{ e.kind === 'edit' ? 'statements' : e.rows === 1 ? 'row' : 'rows' }}</span
                >
              }
            }
          </div>
        </div>
      } @empty {
        @if (!loading()) {
          <p class="px-3 py-2 text-[12px] text-faint">
            {{ search() ? 'Nothing matches.' : 'Queries you run here show up in this list.' }}
          </p>
        }
      }
      @if (loading()) {
        <p class="px-3 py-2 text-[12px] text-faint">Loading…</p>
      }
    </div>

    <ng-template #menu let-entry="entry">
      <div cdkMenu class="menu">
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="openInNewTab(entry)">
          Open in new tab <span class="menu-key">Double-click</span>
        </button>
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="insert(entry)">
          Insert into editor <span class="menu-key">Enter</span>
        </button>
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="runInNewTab(entry)">
          Run in new tab
        </button>
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="copy(entry)">Copy SQL</button>
        <div class="menu-sep"></div>
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="remove(entry)">
          Delete from history
        </button>
      </div>
    </ng-template>
  `,
  styles: `
    .entry {
      padding: 5px 10px 6px;
      border-bottom: 1px solid var(--border);
      cursor: default;
    }
    .entry:hover {
      background: var(--bg-hover);
    }
    .entry.selected {
      background: var(--bg-selected);
    }
    .sql {
      font: 12px/17px var(--font-mono);
      color: var(--fg);
      white-space: pre-wrap;
      word-break: break-word;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .meta {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 3px;
      font-size: 11px;
      color: var(--fg-faint);
      white-space: nowrap;
      overflow: hidden;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
      background: var(--conn-local);
    }
    .dot.error {
      background: var(--danger);
    }
    .dot.cancelled {
      background: var(--fg-faint);
    }
    .kind {
      padding: 0 4px;
      border-radius: 3px;
      background: var(--bg-sunken);
      color: var(--fg-muted);
    }
  `,
})
export class HistoryList {
  readonly connection = input<ConnectionProfile | null>(null)

  private readonly history = inject(History)
  private readonly workspace = inject(Workspace)

  protected readonly search = signal('')
  protected readonly selected = signal<number | null>(null)
  protected readonly ago = ago
  protected readonly duration = duration
  private readonly older = signal<HistoryEntry[]>([])
  private readonly exhausted = signal(false)
  private loadingMore = false

  /** First page; reloads on connection change, search, and after every run. */
  private readonly first = toSignal(
    combineLatest([
      toObservable(this.connection),
      toObservable(this.search).pipe(debounceTime(150), startWith('')),
      toObservable(this.history.changed),
    ]).pipe(
      switchMap(([conn, q]) =>
        !conn
          ? of({ loading: false, entries: [] as HistoryEntry[] })
          : this.history.list(conn.id, q, undefined, PAGE).pipe(
              map((entries) => ({ loading: false, entries })),
              catchError(() => of({ loading: false, entries: [] as HistoryEntry[] })),
              startWith({ loading: true, entries: null as HistoryEntry[] | null }),
            ),
      ),
    ),
  )

  /** The newest page; keeps the previous list on screen while a refresh loads (no flicker after each run). */
  private readonly newest = linkedSignal<
    { loading: boolean; entries: HistoryEntry[] | null } | undefined,
    HistoryEntry[]
  >({
    source: this.first,
    computation: (f, previous) => f?.entries ?? previous?.value ?? [],
  })
  protected readonly entries = computed(() => [...this.newest(), ...this.older()])
  protected readonly loading = computed(() => !!this.first()?.loading && !this.newest().length)

  constructor() {
    // A fresh first page resets paging.
    effect(() => {
      this.first()
      untracked(() => {
        this.older.set([])
        this.exhausted.set(false)
      })
    })
  }

  protected kindLabel(kind: HistoryEntry['kind']) {
    if (kind === 'mcp') return 'Claude'
    if (kind === 'activity') return 'activity'
    return kind === 'explain' ? 'explain' : kind === 'explain-analyze' ? 'analyze' : 'grid edit'
  }

  protected onScroll(el: HTMLElement) {
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 200) return
    const conn = this.connection()
    const last = this.entries().at(-1)
    if (!conn || !last || this.loadingMore || this.exhausted() || this.entries().length < PAGE) return
    this.loadingMore = true
    this.history.list(conn.id, this.search(), last.id, PAGE).subscribe({
      next: (more) => {
        this.older.update((o) => [...o, ...more])
        if (more.length < PAGE) this.exhausted.set(true)
      },
      complete: () => (this.loadingMore = false),
      error: () => (this.loadingMore = false),
    })
  }

  protected move(delta: number) {
    const list = this.entries()
    if (!list.length) return
    const i = list.findIndex((e) => e.id === this.selected())
    this.selected.set(list[Math.min(list.length - 1, Math.max(0, i < 0 ? 0 : i + delta))].id)
  }

  protected onKey(e: KeyboardEvent) {
    const entry = this.entries().find((x) => x.id === this.selected())
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      this.move(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Enter' && entry) {
      e.preventDefault()
      if (e.altKey) this.openInNewTab(entry)
      else this.insert(entry)
    } else if (e.key === 'Delete' && entry) {
      e.preventDefault()
      this.remove(entry)
    }
  }

  protected openInNewTab(e: HistoryEntry) {
    const conn = this.connection()
    if (conn) this.workspace.openTab(conn, e.sql)
  }

  protected runInNewTab(e: HistoryEntry) {
    const conn = this.connection()
    if (conn) this.workspace.openTab(conn, e.sql, { autoRun: e.kind === 'run' })
  }

  protected insert(e: HistoryEntry) {
    const tab = this.workspace.activeTab()
    if (tab) this.workspace.insertIntoEditor(tab, e.sql)
    else this.openInNewTab(e)
  }

  protected copy(e: HistoryEntry) {
    navigator.clipboard.writeText(e.sql)
  }

  protected remove(e: HistoryEntry) {
    this.history.remove(e.id).subscribe(() => {
      this.newest.update((n) => n.filter((x) => x.id !== e.id))
      this.older.update((o) => o.filter((x) => x.id !== e.id))
      this.history.changed.update((v) => v + 1)
    })
  }
}
