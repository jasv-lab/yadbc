import { DatePipe, DecimalPipe } from '@angular/common'
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core'
import { toObservable, toSignal } from '@angular/core/rxjs-interop'
import { catchError, combineLatest, map, of, scan, startWith, Subject, switchMap } from 'rxjs'
import { ConnectionProfile } from '../core/protocol'
import { Icon } from '../ui/icon'
import { Workspace } from '../workspace/workspace'
import { AdvisorApi, formatBytes, WorkloadAdvice } from './advisor'
import { IndexSuggestions } from './index-suggestions'

interface State {
  loading: boolean
  advice?: WorkloadAdvice
  error?: string
}

/**
 * Index advice from what actually ran: the costliest statements in pg_stat_statements, planned and run
 * through the same analysis as a single EXPLAIN, merged, and ranked by the time each index would save.
 */
@Component({
  selector: 'y-workload-advisor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IndexSuggestions, Icon, DecimalPipe, DatePipe],
  host: { class: 'block min-h-0 overflow-auto' },
  template: `
    <div class="mx-auto flex max-w-[980px] flex-col gap-4 p-4">
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <h2 class="text-[14px] font-medium">Index advisor</h2>
          <p class="text-[12px] text-muted">
            From the statements that took the most time on {{ connection().database }}, per
            pg_stat_statements.
            @if (advice()?.statements; as st) {
              @if (st.state === 'ok') {
                {{ st.analyzed }} analyzed{{ st.skipped ? ', ' + st.skipped + ' skipped' : '' }}
                @if (st.since) {
                  · statistics since {{ st.since | date: 'd MMM y, HH:mm' }}
                }
              }
            }
          </p>
        </div>
        <button class="run-btn" [disabled]="state().loading" (click)="run$.next()">
          <y-icon name="refresh" [size]="13" /> {{ state().loading ? 'Analyzing…' : 'Analyze again' }}
        </button>
      </div>

      @if (error(); as e) {
        <p class="rounded-md bg-danger-bg px-3 py-2 text-[12px] text-danger">{{ e }}</p>
      }

      @if (advice(); as a) {
        @if (a.statements.state !== 'ok') {
          <div class="banner">
            @if (a.statements.state === 'missing') {
              <p>
                pg_stat_statements isn't enabled in this database, so there's no workload to learn from. It
                needs
                <code>shared_preload_libraries = 'pg_stat_statements'</code> (server restart), then:
              </p>
              <button
                class="run-btn mt-1.5"
                (click)="insert('CREATE EXTENSION IF NOT EXISTS pg_stat_statements;')"
              >
                Insert CREATE EXTENSION pg_stat_statements
              </button>
            } @else {
              <p>
                pg_stat_statements is installed but not loaded: add it to
                <code>shared_preload_libraries</code> and restart the server.
              </p>
            }
          </div>
        }

        <y-index-suggestions
          [suggestions]="a.suggestions"
          [hypopg]="a.hypopg"
          [empty]="a.statements.state === 'ok' ? 'No missing index found in the recorded statements.' : ''"
          (insert)="insert($event)"
        />

        @if (a.notes.length || a.errors.length) {
          <details class="text-[12px] text-muted">
            <summary class="cursor-pointer">{{ a.notes.length + a.errors.length }} notes</summary>
            @for (n of a.notes; track $index) {
              <p class="mt-1">{{ n }}</p>
            }
            @for (e of a.errors; track $index) {
              <p class="mt-1 text-faint">Couldn't plan: {{ e }}</p>
            }
          </details>
        }

        @if (a.tables.length) {
          <section>
            <h3>Tables read by sequential scans</h3>
            <table>
              <thead>
                <tr>
                  <th>table</th>
                  <th class="num">seq scans</th>
                  <th class="num">rows read by them</th>
                  <th class="num">index scans</th>
                  <th class="num">live rows</th>
                </tr>
              </thead>
              <tbody>
                @for (t of a.tables; track t.table) {
                  <tr>
                    <td class="mono">{{ t.table }}</td>
                    <td class="num">{{ t.seqScans | number }}</td>
                    <td class="num">{{ t.seqRowsRead | number }}</td>
                    <td class="num">{{ t.indexScans | number }}</td>
                    <td class="num">{{ t.liveRows | number }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }

        @if (a.unusedIndexes.length) {
          <section>
            <h3>Never-used indexes</h3>
            <p class="mb-1.5 text-[11.5px] text-faint">
              Not scanned on this server since its statistics were reset — replicas keep their own counts, so
              check them before dropping anything.
            </p>
            <table>
              <thead>
                <tr>
                  <th>index</th>
                  <th>table</th>
                  <th class="num">size</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (u of a.unusedIndexes; track u.index) {
                  <tr>
                    <td class="mono" [title]="u.definition">{{ u.index }}</td>
                    <td class="mono">{{ u.table }}</td>
                    <td class="num">{{ bytes(u.sizeBytes) }}</td>
                    <td class="text-right">
                      <button
                        class="icon-btn"
                        title="Insert DROP INDEX CONCURRENTLY"
                        (click)="insert(dropDdl(u.table, u.index))"
                      >
                        <y-icon name="trash" [size]="12" />
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }
      } @else if (state().loading) {
        <p class="text-[12px] text-faint">Planning the recorded statements…</p>
      }
    </div>
  `,
  styles: `
    .banner {
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg-sunken);
      font-size: 12px;
      color: var(--fg-muted);
    }
    code {
      font-family: var(--font-mono);
      font-size: 11.5px;
    }
    h3 {
      margin-bottom: 6px;
      font-size: 12.5px;
      font-weight: 500;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th {
      padding: 4px 8px;
      text-align: left;
      font-weight: 500;
      color: var(--fg-muted);
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 3px 8px;
      border-bottom: 1px solid var(--border);
    }
    .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .mono {
      font-family: var(--font-mono);
      font-size: 11.5px;
    }
  `,
})
export class WorkloadAdvisor {
  readonly connection = input.required<ConnectionProfile>()

  private readonly api = inject(AdvisorApi)
  private readonly workspace = inject(Workspace)
  protected readonly run$ = new Subject<void>()
  protected readonly bytes = formatBytes

  // Runs once when shown, and again on demand; a new connection starts over.
  protected readonly state = toSignal(
    combineLatest([toObservable(this.connection), this.run$.pipe(startWith(undefined))]).pipe(
      switchMap(([c]) =>
        this.api.workload(c.id).pipe(
          map((advice): State => ({ loading: false, advice })),
          catchError((e) =>
            of<State>({ loading: false, error: e?.error?.error ?? 'Could not analyze the workload' }),
          ),
          startWith<State>({ loading: true }),
        ),
      ),
      // While re-analyzing, the previous result stays on screen.
      scan((prev: State, next: State): State => (next.loading ? { ...next, advice: prev.advice } : next)),
    ),
    { initialValue: { loading: true } as State },
  )
  protected readonly advice = computed(() => this.state().advice ?? null)
  protected readonly error = computed(() => this.state().error ?? null)

  protected insert(sql: string) {
    this.workspace.openTab(this.connection(), sql)
  }

  protected dropDdl(table: string, index: string) {
    const ident = (s: string) => (/^[a-z_][a-z0-9_$]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`)
    return `DROP INDEX CONCURRENTLY ${ident(table.split('.')[0])}.${ident(index)};`
  }
}
