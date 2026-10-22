import { DecimalPipe, NgTemplateOutlet } from '@angular/common'
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core'
import { Icon } from '../ui/icon'
import { formatBytes, formatMs, HypoStatus, Suggestion } from './advisor'

/**
 * Index suggestions as cards: the DDL, why, and — with HypoPG — what it does to the estimated cost.
 * Candidates the planner wouldn't use go to a collapsed "tried" list instead of disappearing, so it's
 * clear they were considered.
 */
@Component({
  selector: 'y-index-suggestions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, DecimalPipe, NgTemplateOutlet],
  host: { class: 'flex flex-col gap-2' },
  template: `
    @if (!hypopg().installed) {
      <div class="banner">
        @if (hypopg().available) {
          <p>
            HypoPG is on this server but not enabled in this database. With it, each suggestion is proven by
            re-planning with the index created hypothetically (nothing is built).
          </p>
          <button class="run-btn mt-1.5" (click)="insert.emit(createHypopg)">
            Insert CREATE EXTENSION hypopg
          </button>
        } @else {
          <p>
            Unverified estimates. With HypoPG (package <code>postgresql-NN-hypopg</code>, then
            <code>CREATE EXTENSION hypopg</code>) each suggestion is proven by re-planning with the index
            created hypothetically.
          </p>
        }
      </div>
    }

    @for (s of useful(); track s.ddl) {
      <ng-container *ngTemplateOutlet="card; context: { $implicit: s }" />
    } @empty {
      @if (!rejected().length) {
        <p class="px-1 py-2 text-[12px] text-faint">{{ empty() }}</p>
      }
    }

    @if (rejected().length) {
      <button
        class="px-1 text-left text-[11.5px] text-faint hover:text-muted"
        (click)="showRejected.set(!showRejected())"
      >
        {{ showRejected() ? '▾' : '▸' }} {{ rejected().length }} tried, the planner wouldn't use
        {{ rejected().length === 1 ? 'it' : 'them' }}
      </button>
      @if (showRejected()) {
        @for (s of rejected(); track s.ddl) {
          <div class="opacity-60">
            <ng-container *ngTemplateOutlet="card; context: { $implicit: s }" />
          </div>
        }
      }
    }

    <ng-template #card let-s>
      <div class="card">
        <div class="flex items-start gap-2">
          <y-icon name="index" [size]="13" class="mt-0.5 shrink-0 text-accent" />
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-baseline gap-x-2">
              <span class="font-medium">{{ s.table }}</span>
              <span class="font-mono text-[12px]">({{ s.columns.join(', ') }})</span>
            </div>
            <div class="mt-0.5 flex flex-wrap gap-x-3 text-[11.5px]">
              @if (s.improvement != null && s.used) {
                <span class="gain">−{{ s.improvement * 100 | number: '1.0-0' }}% cost</span>
                <span class="text-muted"
                  >{{ s.costBefore | number: '1.0-0' }} → {{ s.costAfter | number: '1.0-0' }}</span
                >
              } @else if (s.used === false) {
                <span class="text-muted">not used by the planner</span>
              } @else if (s.savedMs == null) {
                <span class="text-warning">unverified</span>
              }
              @if (s.savedMs) {
                <span class="gain">saves ~{{ ms(s.savedMs) }}</span>
              } @else if (s.attributedMs) {
                <span class="text-muted">targets ~{{ ms(s.attributedMs) }} of scan time</span>
              }
              @if (s.sizeBytes) {
                <span class="text-muted">~{{ bytes(s.sizeBytes) }}</span>
              }
            </div>
          </div>
          <button class="icon-btn" title="Copy" (click)="copy(s.ddl)">
            <y-icon name="copy" [size]="13" />
          </button>
          <button class="run-btn" title="Put the CREATE INDEX into the editor" (click)="insert.emit(s.ddl)">
            Insert
          </button>
        </div>
        @for (r of s.reasons; track $index) {
          <p class="reason">{{ r }}</p>
        }
        @if (s.queries?.length) {
          <details class="mt-1.5">
            <summary class="cursor-pointer text-[11.5px] text-muted">
              {{ s.queries.length }} {{ s.queries.length === 1 ? 'statement' : 'statements' }} ·
              {{ totalCalls(s) | number }} calls · {{ ms(totalMs(s)) }}
            </summary>
            @for (q of s.queries; track $index) {
              <div class="query">
                <div class="flex gap-3 text-[11px] text-muted">
                  <span>{{ q.calls | number }}×</span>
                  <span>{{ ms(q.totalMs) }} total · {{ ms(q.meanMs) }} avg</span>
                  @if (q.costAfter != null) {
                    <span [class.gain]="q.used"
                      >cost {{ q.costBefore | number: '1.0-0' }} → {{ q.costAfter | number: '1.0-0' }}</span
                    >
                  }
                </div>
                <pre>{{ q.query }}</pre>
              </div>
            }
          </details>
        }
      </div>
    </ng-template>
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
    .card {
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg-raised);
      font-size: 12.5px;
    }
    .gain {
      color: var(--conn-local);
      font-weight: 500;
    }
    .reason {
      margin-top: 4px;
      padding-left: 21px;
      font-size: 11.5px;
      color: var(--fg-muted);
      user-select: text;
    }
    .query {
      margin-top: 6px;
      padding-left: 21px;
    }
    pre {
      margin: 2px 0 0;
      padding: 6px 8px;
      max-height: 120px;
      overflow: auto;
      border-radius: 4px;
      background: var(--bg-sunken);
      font: 11.5px var(--font-mono);
      white-space: pre-wrap;
      user-select: text;
    }
  `,
})
export class IndexSuggestions {
  readonly suggestions = input.required<Suggestion[]>()
  readonly hypopg = input.required<HypoStatus>()
  readonly empty = input('No missing index found.')
  readonly insert = output<string>()

  protected readonly createHypopg = 'CREATE EXTENSION IF NOT EXISTS hypopg;'
  protected readonly showRejected = signal(false)
  protected readonly useful = computed(() => this.suggestions().filter((s) => s.used !== false))
  protected readonly rejected = computed(() => this.suggestions().filter((s) => s.used === false))
  protected readonly ms = formatMs
  protected readonly bytes = formatBytes

  protected totalCalls(s: Suggestion) {
    return (s.queries ?? []).reduce((n, q) => n + q.calls, 0)
  }

  protected totalMs(s: Suggestion) {
    return (s.queries ?? []).reduce((n, q) => n + q.totalMs, 0)
  }

  protected copy(text: string) {
    navigator.clipboard.writeText(text)
  }
}
