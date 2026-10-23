import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core'
import { toObservable, toSignal } from '@angular/core/rxjs-interop'
import { catchError, debounceTime, map, of, startWith, switchMap } from 'rxjs'
import { EditorTab, ResultView } from '../workspace/workspace'
import { Edits } from './edits'

/** Drawer view: the exact SQL Apply will run, with Apply / Discard. */
@Component({
  selector: 'y-edits-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <div class="flex items-center gap-2 border-b border-line px-3 py-2">
      <div class="min-w-0 flex-1">
        <div class="font-medium">{{ count() }} staged {{ count() === 1 ? 'change' : 'changes' }}</div>
        <div class="text-[11.5px] text-faint">
          Runs as one transaction; any conflict rolls back everything.
        </div>
      </div>
      <button class="btn" (click)="discard()" [disabled]="!count() || busy()">Discard</button>
      <button class="btn btn-primary" (click)="apply()" [disabled]="!count() || busy()">
        {{ busy() ? 'Applying…' : 'Apply' }}
      </button>
    </div>
    @if (outcome(); as o) {
      <p
        class="border-b border-line px-3 py-2 text-[12.5px]"
        [class]="o.ok ? 'text-muted' : 'bg-danger-bg text-danger'"
      >
        {{ o.message }}
      </p>
    }
    <div class="min-h-0 flex-1 overflow-auto p-3 select-text">
      @if (!count()) {
        <p class="text-[12px] text-faint">No staged changes.</p>
      } @else if (script(); as s) {
        @if (s.error) {
          <p class="text-[12.5px] text-danger">{{ s.error }}</p>
        } @else {
          <pre class="sql">{{ s.sql }}</pre>
        }
      } @else {
        <p class="text-[12px] text-faint">Generating…</p>
      }
    </div>
  `,
  styles: `
    .sql {
      margin: 0;
      font: 12px/19px var(--font-mono);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .btn {
      height: 26px;
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
      opacity: 0.5;
    }
    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-fg);
    }
    /* Outranks .btn:hover, which would swap the accent for the hover tint under dark text. */
    .btn-primary:hover {
      background: var(--accent);
      filter: brightness(1.08);
    }
  `,
})
export class EditsPanel {
  readonly tab = input.required<EditorTab>()
  readonly result = input.required<ResultView>()

  private readonly edits = inject(Edits)
  private readonly staged = computed(() => this.edits.for(this.result().resultId))
  protected readonly count = computed(() => this.staged().count())
  protected readonly busy = signal(false)
  protected readonly outcome = signal<{ ok: boolean; message: string } | null>(null)

  /** Regenerated whenever the staged edits change. */
  protected readonly script = toSignal(
    toObservable(computed(() => ({ id: this.result().resultId, v: this.staged().version() }))).pipe(
      debounceTime(80),
      switchMap(({ id }) =>
        this.edits.preview(id).pipe(
          map((sql) => ({ sql, error: null as string | null })),
          catchError((e) => of({ sql: '', error: e instanceof Error ? e.message : 'Preview failed' })),
          startWith(null),
        ),
      ),
    ),
  )

  protected apply() {
    this.busy.set(true)
    this.edits.apply(this.tab(), this.result()).subscribe((o) => {
      this.busy.set(false)
      this.outcome.set(o)
    })
  }

  protected discard() {
    this.staged().clear()
    this.outcome.set({ ok: true, message: 'Discarded' })
  }
}
