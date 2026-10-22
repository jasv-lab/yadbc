import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog'
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { toObservable, toSignal } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import { catchError, debounceTime, map, of, startWith, switchMap } from 'rxjs'
import { ResultView } from '../workspace/workspace'
import {
  ExportFormat,
  ExportOptions,
  Exporter,
  ExportResult,
  ExportScope,
  FORMATS,
  scopeFor,
  Selection,
  toMessage,
} from './export'

export interface ExportDialogData {
  result: ResultView
  selection: Selection | null
  format: ExportFormat
}

/** Closes with a status line for the results header ("Copied 12 rows as INSERT"). */
export type ExportDialogResult = string | undefined

const PREVIEW_ROWS = 20

@Component({
  selector: 'y-export-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  host: { class: 'flex w-[780px] max-w-[92vw] flex-col rounded-lg border border-line bg-raised shadow-xl' },
  template: `
    <div class="flex items-baseline gap-3 border-b border-line px-5 py-3">
      <h2 class="text-[15px] font-medium">Export</h2>
      <span class="text-[12px] text-muted">{{ scope().label }}</span>
      @if (data.result.capped) {
        <span class="text-[12px] text-warning">
          Result capped at {{ data.result.rowCount.toLocaleString() }} of
          {{ data.result.totalRows?.toLocaleString() }} rows
        </span>
      }
    </div>

    <div class="flex min-h-0">
      <nav class="flex w-[150px] shrink-0 flex-col gap-0.5 border-r border-line p-2" role="tablist">
        @for (f of formats; track f.id) {
          <button
            role="tab"
            class="fmt"
            [class.fmt-on]="format() === f.id"
            [attr.aria-selected]="format() === f.id"
            (click)="format.set(f.id)"
          >
            {{ f.label }}
          </button>
        }
      </nav>

      <div class="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px]">
          @if (hasRangeSelection()) {
            <label class="flex items-center gap-1.5">
              <input
                type="checkbox"
                [ngModel]="onlySelection()"
                (ngModelChange)="onlySelection.set($event)"
              />
              Selection only
            </label>
          }
          @if (format() === 'tsv' || format() === 'csv') {
            <label class="flex items-center gap-1.5">
              <input
                type="checkbox"
                [ngModel]="options().header"
                (ngModelChange)="patch({ header: $event })"
              />
              Header row
            </label>
          }
          @if (format() === 'insert' || format() === 'update') {
            <label class="flex items-center gap-2">
              <span class="text-muted">Table</span>
              <input
                class="field w-[220px] font-mono"
                [ngModel]="options().table ?? ''"
                (ngModelChange)="patch({ table: $event })"
                [placeholder]="source()?.table ?? 'schema.table'"
              />
            </label>
          }
          @if (format() === 'insert') {
            <div class="seg-group">
              <button
                class="seg"
                [class.seg-on]="options().insertMode === 'row'"
                (click)="patch({ insertMode: 'row' })"
              >
                One per row
              </button>
              <button
                class="seg"
                [class.seg-on]="options().insertMode === 'multi'"
                (click)="patch({ insertMode: 'multi' })"
              >
                Multi-row
              </button>
            </div>
            <div class="seg-group" title="ON CONFLICT">
              <button
                class="seg"
                [class.seg-on]="options().onConflict === 'none'"
                (click)="patch({ onConflict: 'none' })"
              >
                Plain
              </button>
              <button
                class="seg"
                [class.seg-on]="options().onConflict === 'nothing'"
                (click)="patch({ onConflict: 'nothing' })"
              >
                Skip existing
              </button>
              <button
                class="seg"
                [class.seg-on]="options().onConflict === 'update'"
                (click)="patch({ onConflict: 'update' })"
              >
                Upsert
              </button>
            </div>
          }
        </div>

        <div class="relative min-h-[240px] flex-1 overflow-hidden rounded border border-line bg-sunken">
          @if (preview(); as p) {
            @if (p.error) {
              <p class="p-3 text-[12.5px] text-danger">{{ p.error }}</p>
            } @else {
              <pre class="preview">{{ p.text }}</pre>
              @if (p.more) {
                <span class="absolute right-2 bottom-1 text-[11px] text-faint"
                  >preview · first {{ previewRows }} rows</span
                >
              }
            }
          }
        </div>

        <div class="flex items-center gap-2">
          @if (busy()) {
            <span class="text-[12px] text-muted">Exporting…</span>
          } @else if (error()) {
            <span class="text-[12px] text-danger">{{ error() }}</span>
          }
          <span class="flex-1"></span>
          <button class="btn" (click)="ref.close()">Cancel</button>
          <button class="btn" (click)="finish('save')" [disabled]="busy() || !!preview()?.error">
            Save to file…
          </button>
          <button class="btn btn-primary" (click)="finish('copy')" [disabled]="busy() || !!preview()?.error">
            Copy
          </button>
        </div>
      </div>
    </div>
  `,
  styles: `
    .fmt {
      text-align: left;
      padding: 4px 10px;
      border-radius: 4px;
      color: var(--fg-muted);
    }
    .fmt:hover {
      background: var(--bg-hover);
    }
    .fmt-on {
      background: var(--bg-selected);
      color: var(--fg);
    }
    .seg-group {
      display: flex;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px;
    }
    .seg {
      padding: 1px 8px;
      border-radius: 3px;
      color: var(--fg-muted);
    }
    .seg-on {
      background: var(--bg-selected);
      color: var(--fg);
    }
    .field {
      height: 26px;
      padding: 0 8px;
      border-radius: 4px;
      border: 1px solid var(--border-strong);
      background: var(--bg);
      color: var(--fg);
    }
    .preview {
      margin: 0;
      padding: 10px 12px;
      height: 100%;
      max-height: 320px;
      overflow: auto;
      font: 12px/18px var(--font-mono);
      white-space: pre;
      user-select: text;
    }
    .btn {
      height: 30px;
      padding: 0 12px;
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
  `,
})
export class ExportDialog {
  protected readonly ref = inject<DialogRef<ExportDialogResult>>(DialogRef)
  protected readonly data = inject<ExportDialogData>(DIALOG_DATA)
  private readonly exporter = inject(Exporter)

  protected readonly formats = FORMATS
  protected readonly previewRows = PREVIEW_ROWS
  protected readonly format = signal<ExportFormat>(this.data.format)
  protected readonly options = signal<ExportOptions>(this.exporter.loadOptions())
  protected readonly onlySelection = signal(true)
  protected readonly busy = signal(false)
  protected readonly error = signal<string | null>(null)

  protected readonly hasRangeSelection = computed(() => {
    const s = this.data.selection
    return !!s && (s.r0 !== s.r1 || s.c0 !== s.c1)
  })

  protected readonly scope = computed(() =>
    scopeFor(this.data.result, this.onlySelection() ? this.data.selection : null, this.format()),
  )

  /** Resolved source table for the current columns — the Table field's placeholder and default. */
  protected readonly source = toSignal(
    toObservable(this.scope).pipe(
      switchMap((scope) =>
        this.exporter.source(this.data.result.resultId, scope.columns).pipe(catchError(() => of(null))),
      ),
    ),
  )

  protected readonly preview = toSignal(
    toObservable(
      computed(() => ({ format: this.format(), scope: this.scope(), options: this.options() })),
    ).pipe(
      debounceTime(120),
      switchMap(({ format, scope, options }) =>
        this.exporter.run(this.data.result.resultId, format, scope, options, PREVIEW_ROWS).pipe(
          map((r) => ({
            text: trimPreview(r.text),
            more: this.rowsInScope(scope) > PREVIEW_ROWS,
            error: null as string | null,
          })),
          catchError((e) => of({ text: '', more: false, error: toMessage(e) })),
          startWith(null),
        ),
      ),
    ),
  )

  private rowsInScope(scope: ExportScope): number {
    return scope.rows ? scope.rows[1] - scope.rows[0] : this.data.result.rowCount
  }

  protected patch(change: Partial<ExportOptions>) {
    this.options.update((o) => ({ ...o, ...change }))
  }

  protected finish(action: 'copy' | 'save') {
    const format = this.format()
    this.busy.set(true)
    this.error.set(null)
    this.exporter.saveOptions(this.options())
    this.exporter.run(this.data.result.resultId, format, this.scope(), this.options()).subscribe({
      next: (result: ExportResult) => {
        if (action === 'save') {
          this.exporter.save(result, this.exporter.baseName(result))
          this.ref.close(
            `Saved ${result.rowCount.toLocaleString()} rows to ${this.exporter.baseName(result)}.${result.extension}`,
          )
        } else {
          this.exporter.copy(result.text).subscribe({
            complete: () => this.ref.close(this.exporter.copiedMessage(format, result)),
            error: () => {
              this.busy.set(false)
              this.error.set("Couldn't write to the clipboard")
            },
          })
        }
      },
      error: (e) => {
        this.busy.set(false)
        this.error.set(toMessage(e))
      },
    })
  }
}

/** Multi-line values can make even 20 rows long; the preview is a glance, not the export. */
function trimPreview(text: string): string {
  const lines = text.split('\n')
  return lines.length > 60 ? lines.slice(0, 60).join('\n') + '\n…' : text
}
