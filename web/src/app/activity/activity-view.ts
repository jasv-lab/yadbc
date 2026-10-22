import { Dialog } from '@angular/cdk/dialog'
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core'
import { toObservable, toSignal } from '@angular/core/rxjs-interop'
import {
  catchError,
  combineLatest,
  EMPTY,
  exhaustMap,
  filter,
  map,
  merge,
  Observable,
  of,
  share,
  Subject,
  switchMap,
  timer,
} from 'rxjs'
import { ConfirmData, ConfirmDialog } from '../ui/confirm-dialog'
import { WorkloadAdvisor } from '../advisor/workload-advisor'
import { Icon } from '../ui/icon'
import { ActivityTab, Workspace } from '../workspace/workspace'
import {
  ActivityApi,
  ActivitySnapshot,
  ageSeverity,
  blockingTree,
  formatAge,
  PgLock,
  PgSession,
  sessionAge,
} from './activity'

const REFRESH_MS = 2000

interface Poll {
  connectionId: string
  snapshot?: ActivitySnapshot
  error?: string
  at: number
}

@Component({
  selector: 'y-activity-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, WorkloadAdvisor],
  host: { class: 'flex min-h-0 flex-col bg-raised' },
  template: `
    <div class="flex h-9 shrink-0 items-center gap-2 overflow-hidden border-b border-line px-3">
      <div class="flex rounded border border-line p-0.5" role="tablist">
        <button role="tab" class="seg" [class.seg-on]="view() === 'sessions'" (click)="view.set('sessions')">
          Sessions <span class="count">{{ rows().length }}</span>
        </button>
        <button role="tab" class="seg" [class.seg-on]="view() === 'locks'" (click)="view.set('locks')">
          Locks <span class="count">{{ locks().length }}</span>
        </button>
        <button role="tab" class="seg" [class.seg-on]="view() === 'advisor'" (click)="view.set('advisor')">
          Index advisor
        </button>
      </div>
      @if (view() !== 'advisor') {
        <button class="chip" [class.chip-on]="thisDb()" (click)="thisDb.set(!thisDb())">
          {{ tab().connection.database }} only
        </button>
        @if (view() === 'sessions') {
          <button class="chip" [class.chip-on]="hideIdle()" (click)="hideIdle.set(!hideIdle())">
            Hide idle
          </button>
        } @else {
          <button class="chip" [class.chip-on]="waitingOnly()" (click)="waitingOnly.set(!waitingOnly())">
            Waiting only
          </button>
        }
        <input
          class="search"
          placeholder="Filter: user, app, query, pid…"
          [value]="search()"
          (input)="search.set($any($event.target).value)"
        />
      }
      <span class="flex-1"></span>
      @if (message(); as m) {
        <span class="truncate text-[12px]" [class]="m.bad ? 'text-danger' : 'text-muted'">{{ m.text }}</span>
      }
      <span class="summary min-w-0 truncate">
        @if (view() !== 'advisor' && summary(); as s) {
          @if (s.blocked) {
            <span class="text-warning">{{ s.blocked }} waiting</span> ·
          }
          {{ s.active }} active · {{ s.idleInTx }} idle in tx
        }
      </span>
      <button
        class="icon-btn"
        [title]="paused() ? 'Resume refreshing' : 'Pause refreshing (every ' + refreshSeconds + ' s)'"
        (click)="paused.set(!paused())"
      >
        <y-icon [name]="paused() ? 'play' : 'pause'" [size]="13" />
      </button>
      <button class="icon-btn" title="Refresh now" (click)="refresh$.next()">
        <y-icon name="refresh" [size]="13" />
      </button>
    </div>

    @if (poll()?.error; as err) {
      <div class="flex items-center gap-2 border-b border-danger/40 bg-danger-bg px-3 py-1.5 text-danger">
        <y-icon name="alert" [size]="13" /> {{ err }}
      </div>
    }

    @if (view() === 'advisor') {
      <y-workload-advisor class="min-h-0 flex-1" [connection]="tab().connection" />
    }
    <div class="min-h-0 flex-1 overflow-auto" [class.hidden]="view() === 'advisor'">
      @if (view() === 'sessions') {
        <table>
          <thead>
            <tr>
              <th class="w-[96px]">pid</th>
              <th class="w-[96px]">user</th>
              <th class="w-[130px]">application</th>
              @if (!thisDb()) {
                <th class="w-[110px]">database</th>
              }
              <th class="w-[140px]">state</th>
              <th class="w-[170px]">waiting on</th>
              <th class="w-[68px] text-right">time</th>
              <th>query</th>
              <th class="w-[60px]"></th>
            </tr>
          </thead>
          <tbody>
            @for (r of rows(); track r.session.pid) {
              @let s = r.session;
              <tr
                class="row"
                [class.row-open]="expanded() === s.pid"
                [class.row-blocker]="r.blocking > 0"
                (click)="expanded.set(expanded() === s.pid ? null : s.pid)"
              >
                <td class="mono">
                  <span class="flex items-center" [style.padding-left.px]="r.depth * 14">
                    @if (r.depth) {
                      <y-icon name="tree-child" [size]="12" class="mr-1 shrink-0 text-warning" />
                    }
                    {{ s.pid }}
                  </span>
                </td>
                <td class="truncate">{{ s.user ?? s.backendType }}</td>
                <td class="truncate">
                  @if (ownTabs().get(s.pid); as title) {
                    <span class="own" [title]="'yadbc tab: ' + title">tab · {{ title }}</span>
                  } @else {
                    {{ s.application || (s.client ?? '') }}
                  }
                </td>
                @if (!thisDb()) {
                  <td class="truncate">{{ s.database }}</td>
                }
                <td>
                  <span class="flex items-center gap-1.5">
                    <span class="size-1.5 shrink-0 rounded-full" [class]="stateDot(s)"></span>
                    <span class="truncate">{{ stateLabel(s) }}</span>
                  </span>
                </td>
                <td class="truncate" [class.text-warning]="s.waitType === 'Lock'">
                  @if (r.blocking) {
                    <span class="badge-block" [title]="r.blocking + ' sessions wait on this one'">
                      blocks {{ r.blocking }}
                    </span>
                  }
                  {{ s.wait ? (s.waitType === 'Lock' ? 'lock: ' : '') + s.wait : '' }}
                </td>
                <td class="mono text-right" [class]="'age-' + severity(s)">{{ age(s) }}</td>
                <td class="mono truncate" [class.text-faint]="!s.query || s.query.startsWith('<')">
                  {{ oneLine(s.query) }}
                </td>
                <td class="actions" (click)="$event.stopPropagation()">
                  @if (s.canSignal && s.state === 'active') {
                    <button class="icon-btn" title="Cancel the running query" (click)="signal(s, 'cancel')">
                      <y-icon name="stop" [size]="12" />
                    </button>
                  }
                  @if (s.canSignal) {
                    <button
                      class="icon-btn hover:!text-danger"
                      title="Terminate the session (rolls back its transaction)"
                      (click)="signal(s, 'terminate')"
                    >
                      <y-icon name="terminate" [size]="13" />
                    </button>
                  }
                </td>
              </tr>
              @if (expanded() === s.pid) {
                <tr class="detail">
                  <td [attr.colspan]="thisDb() ? 8 : 9">
                    <div class="flex gap-6">
                      <dl>
                        <dt>Client</dt>
                        <dd>{{ s.client ?? 'local socket' }}</dd>
                        <dt>Connected</dt>
                        <dd>{{ ago(s.backendSeconds) }}</dd>
                        <dt>Transaction</dt>
                        <dd>{{ s.xactSeconds == null ? 'none' : 'open ' + fmt(s.xactSeconds) }}</dd>
                        <dt>State since</dt>
                        <dd>{{ ago(s.stateSeconds) }}</dd>
                        @if (s.blockedBy.length) {
                          <dt>Waits for</dt>
                          <dd class="text-warning">pid {{ s.blockedBy.join(', ') }}</dd>
                        }
                      </dl>
                      <div class="min-w-0 flex-1">
                        <pre class="query">{{ s.query || '—' }}</pre>
                        @if (locksOf(s.pid); as ls) {
                          @if (ls.length) {
                            <p class="mt-2 text-[11.5px] text-muted">
                              @for (l of ls; track $index) {
                                <span class="lock" [class.lock-wait]="!l.granted">
                                  {{ l.granted ? '' : 'waiting: ' }}{{ l.mode }}
                                  {{ l.relation ?? l.lockType }}
                                </span>
                              }
                            </p>
                          }
                        }
                        <div class="mt-2 flex gap-2">
                          @if (s.query && !s.query.startsWith('<')) {
                            <button class="run-btn" (click)="openInEditor(s)">Open in editor</button>
                            <button class="run-btn" (click)="copy(s.query)">Copy query</button>
                          }
                          @if (s.canSignal && s.state === 'active') {
                            <button class="run-btn" (click)="signal(s, 'cancel')">Cancel query</button>
                          }
                          @if (s.canSignal) {
                            <button class="run-btn !text-danger" (click)="signal(s, 'terminate')">
                              Terminate session…
                            </button>
                          }
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
              }
            } @empty {
              <tr>
                <td colspan="9" class="py-6 text-center text-faint">
                  {{ poll() ? 'Nothing matches.' : 'Loading…' }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      } @else {
        <table>
          <thead>
            <tr>
              <th class="w-[90px]">pid</th>
              <th class="w-[260px]">on</th>
              <th class="w-[190px]">mode</th>
              <th class="w-[120px]">status</th>
              <th class="w-[110px]">type</th>
              <th>session</th>
            </tr>
          </thead>
          <tbody>
            @for (l of locks(); track $index) {
              @let owner = sessionsByPid().get(l.pid);
              <tr class="row" (click)="showSession(l.pid)" title="Show this session">
                <td class="mono">{{ l.pid }}</td>
                <td class="mono truncate">{{ l.relation ?? '—' }}</td>
                <td class="truncate">{{ l.mode }}</td>
                <td [class.text-warning]="!l.granted">
                  {{ l.granted ? 'held' : 'waiting ' + fmt(l.waitSeconds) }}
                </td>
                <td class="text-muted">{{ l.lockType }}</td>
                <td class="mono truncate text-muted">
                  {{ owner ? (owner.user ?? owner.backendType) + ' · ' + oneLine(owner.query) : '' }}
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="6" class="py-6 text-center text-faint">No locks match.</td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
  styles: `
    .seg {
      white-space: nowrap;
      padding: 2px 10px;
      border-radius: 3px;
      color: var(--fg-muted);
      font-size: 12px;
    }
    .seg-on {
      background: var(--bg-selected);
      color: var(--fg);
    }
    .count {
      margin-left: 4px;
      color: var(--fg-faint);
      font-variant-numeric: tabular-nums;
    }
    .chip {
      flex-shrink: 0;
      white-space: nowrap;
      height: 22px;
      padding: 0 8px;
      border-radius: 11px;
      border: 1px solid var(--border);
      color: var(--fg-muted);
      font-size: 12px;
    }
    .chip-on {
      border-color: var(--accent);
      color: var(--fg);
      background: var(--bg-selected);
    }
    .search {
      height: 24px;
      width: 220px;
      min-width: 90px;
      flex-shrink: 1;
      padding: 0 8px;
      border-radius: 4px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--fg);
      font-size: 12px;
    }
    .search:focus {
      outline: 2px solid var(--accent);
      outline-offset: -1px;
    }
    .summary {
      font-size: 12px;
      color: var(--fg-muted);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    table {
      width: 100%;
      min-width: 980px;
      table-layout: fixed;
      border-collapse: collapse;
      font-size: 12.5px;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      height: 26px;
      padding: 0 8px;
      text-align: left;
      font-weight: 500;
      font-size: 11.5px;
      color: var(--fg-muted);
      background: var(--bg-sunken);
      border-bottom: 1px solid var(--border);
    }
    td {
      height: 26px;
      padding: 0 8px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      border-bottom: 1px solid var(--border);
    }
    .mono {
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .row {
      cursor: pointer;
    }
    .row:hover,
    .row-open {
      background: var(--bg-hover);
    }
    .row-blocker td:first-child {
      box-shadow: inset 2px 0 0 var(--danger);
    }
    .badge-block {
      margin-right: 6px;
      padding: 0 5px;
      border-radius: 8px;
      font-size: 10.5px;
      color: var(--danger);
      background: var(--danger-bg);
    }
    .own {
      color: var(--accent);
    }
    .actions {
      text-align: right;
      opacity: 0;
    }
    .row:hover .actions,
    .row-open .actions {
      opacity: 1;
    }
    .age-warn {
      color: var(--warning);
    }
    .age-bad {
      color: var(--danger);
      font-weight: 600;
    }
    .detail td {
      height: auto;
      padding: 10px 12px 12px 22px;
      white-space: normal;
      background: var(--bg-sunken);
      cursor: default;
    }
    dl {
      display: grid;
      grid-template-columns: auto auto;
      gap: 3px 12px;
      font-size: 12px;
      align-content: start;
      flex-shrink: 0;
    }
    dt {
      color: var(--fg-faint);
    }
    pre.query {
      max-height: 220px;
      overflow: auto;
      margin: 0;
      padding: 8px 10px;
      border-radius: 4px;
      border: 1px solid var(--border);
      background: var(--bg);
      font-family: var(--font-mono);
      font-size: 12px;
      white-space: pre-wrap;
      user-select: text;
    }
    .lock {
      display: inline-block;
      margin: 0 6px 4px 0;
      padding: 1px 6px;
      border-radius: 3px;
      background: var(--bg-hover);
      font-family: var(--font-mono);
    }
    .lock-wait {
      color: var(--warning);
      background: var(--warning-bg);
    }
  `,
})
export class ActivityView {
  readonly tab = input.required<ActivityTab>()

  private readonly api = inject(ActivityApi)
  private readonly workspace = inject(Workspace)
  private readonly dialog = inject(Dialog)

  protected readonly refreshSeconds = REFRESH_MS / 1000
  protected readonly view = signal<'sessions' | 'locks' | 'advisor'>('sessions')
  protected readonly thisDb = signal(true)
  protected readonly hideIdle = signal(true)
  protected readonly waitingOnly = signal(false)
  protected readonly search = signal('')
  protected readonly paused = signal(false)
  protected readonly expanded = signal<number | null>(null)
  protected readonly message = signal<{ text: string; bad: boolean } | null>(null)
  protected readonly refresh$ = new Subject<void>()

  // Poll while the tab is shown (the component only exists then) and not paused; a slow server never gets
  // overlapping requests (exhaustMap). A failed poll keeps the last good snapshot on screen.
  private readonly polls$: Observable<Poll> = combineLatest([
    toObservable(this.tab),
    toObservable(this.paused),
  ]).pipe(
    switchMap(([tab, paused]) =>
      paused
        ? EMPTY
        : merge(timer(0, REFRESH_MS), this.refresh$).pipe(
            exhaustMap(() =>
              this.api.snapshot(tab.connection.id).pipe(
                map((snapshot): Poll => ({ connectionId: tab.connection.id, snapshot, at: Date.now() })),
                catchError((e) =>
                  of<Poll>({
                    connectionId: tab.connection.id,
                    error: e?.error?.error ?? 'Could not read activity',
                    at: Date.now(),
                  }),
                ),
              ),
            ),
          ),
    ),
    share(),
  )
  private readonly lastGood = toSignal(this.polls$.pipe(filter((p) => !!p.snapshot)), { initialValue: null })
  protected readonly poll = toSignal(this.polls$, { initialValue: null })

  private readonly snapshot = computed(() => {
    const good = this.lastGood()
    return good && good.connectionId === this.tab().connection.id ? good.snapshot! : null
  })

  protected readonly sessionsByPid = computed(
    () => new Map((this.snapshot()?.sessions ?? []).map((s) => [s.pid, s])),
  )

  /** yadbc's own editor tabs on this connection, by backend pid. */
  protected readonly ownTabs = computed(() => {
    const id = this.tab().connection.id
    const map = new Map<number, string>()
    for (const t of this.workspace.editorTabs())
      if (t.connection.id === id && t.session()) map.set(t.session()!.pid, t.title)
    return map
  })

  private readonly scoped = computed(() => {
    const db = this.tab().connection.database
    const all = this.snapshot()?.sessions ?? []
    return this.thisDb() ? all.filter((s) => s.database === db || s.database === null) : all
  })

  protected readonly rows = computed(() => {
    const sessions = this.scoped()
    const q = this.search().trim().toLowerCase()
    const blockers = new Set(sessions.flatMap((s) => s.blockedBy))
    const keep = (s: PgSession) =>
      // A session others wait on always stays, idle or not (session-level advisory locks).
      blockers.has(s.pid) ||
      ((!this.hideIdle() || s.state !== 'idle') &&
        (!q ||
          String(s.pid) === q ||
          [s.user, s.application, s.query, s.client, s.database, s.wait].some((v) =>
            v?.toLowerCase().includes(q),
          )))
    return blockingTree(sessions.filter(keep))
  })

  protected readonly locks = computed(() => {
    const q = this.search().trim().toLowerCase()
    return (this.snapshot()?.locks ?? []).filter(
      (l) =>
        (!this.waitingOnly() || !l.granted) &&
        (!q ||
          String(l.pid) === q ||
          [l.relation, l.mode, l.lockType].some((v) => v?.toLowerCase().includes(q))),
    )
  })

  protected readonly summary = computed(() => {
    if (!this.snapshot()) return null
    const s = this.scoped()
    return {
      active: s.filter((x) => x.state === 'active').length,
      idleInTx: s.filter((x) => x.state?.startsWith('idle in transaction')).length,
      blocked: s.filter((x) => x.blockedBy.length).length,
    }
  })

  protected readonly fmt = formatAge
  protected readonly severity = ageSeverity

  protected age(s: PgSession) {
    return formatAge(sessionAge(s))
  }

  protected ago(seconds: number | null) {
    return seconds == null ? '—' : `${formatAge(seconds)} ago`
  }

  protected stateLabel(s: PgSession) {
    if (s.backendType === 'autovacuum worker') return 'autovacuum'
    return s.state ?? '—'
  }

  protected stateDot(s: PgSession) {
    if (s.waitType === 'Lock') return 'bg-warning'
    if (s.state === 'active') return 'bg-env-local'
    if (s.state === 'idle in transaction (aborted)') return 'bg-danger'
    if (s.state?.startsWith('idle in transaction')) return 'bg-env-dev'
    return 'bg-faint'
  }

  protected oneLine(query: string | null) {
    return query ? query.replace(/\s+/g, ' ').trim().slice(0, 400) : ''
  }

  protected locksOf(pid: number): PgLock[] {
    return (this.snapshot()?.locks ?? []).filter((l) => l.pid === pid)
  }

  protected showSession(pid: number) {
    this.view.set('sessions')
    this.expanded.set(pid)
  }

  protected openInEditor(s: PgSession) {
    this.workspace.openTab(this.tab().connection, s.query ?? '')
  }

  protected copy(text: string) {
    navigator.clipboard.writeText(text).then(() => this.say('Query copied'))
  }

  /** Cancel is one click; terminate asks first — it ends the session and rolls back its transaction. */
  protected signal(s: PgSession, action: 'cancel' | 'terminate') {
    const go = () =>
      this.api.signal(this.tab().connection.id, s.pid, action).subscribe({
        next: (r) => {
          this.say(
            r.ok ? `${action === 'cancel' ? 'Cancelled the query of' : 'Terminated'} pid ${s.pid}` : r.error!,
            !r.ok,
          )
          this.refresh$.next()
        },
        error: (e) => this.say(e?.error?.error ?? `Could not ${action} pid ${s.pid}`, true),
      })
    if (action === 'cancel') {
      go()
      return
    }

    const own = this.ownTabs().get(s.pid)
    const prod = this.tab().connection.env === 'prod'
    this.dialog
      .open<string, ConfirmData>(ConfirmDialog, {
        data: {
          title: `Terminate session ${s.pid}?`,
          message:
            (own
              ? `That's yadbc's own tab "${own}"; it will reconnect on its next run. `
              : `${s.user ?? s.backendType}@${s.application || '?'} is disconnected. `) +
            (s.state?.startsWith('idle in transaction') || s.xactSeconds != null
              ? 'Its open transaction rolls back.'
              : '') +
            (prod ? ' This is a PROD database.' : ''),
          actions: [
            { id: 'terminate', label: 'Terminate' },
            { id: 'cancel', label: 'Keep it' },
          ],
        },
      })
      .closed.subscribe((choice) => choice === 'terminate' && go())
  }

  private sayTimer?: ReturnType<typeof setTimeout>
  private say(text: string, bad = false) {
    this.message.set({ text, bad })
    clearTimeout(this.sayTimer)
    this.sayTimer = setTimeout(() => this.message.set(null), 5000)
  }
}
