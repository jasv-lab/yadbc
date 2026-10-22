import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog'
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  signal,
} from '@angular/core'
import { ParamMode, ParamValue } from '../core/params'

export interface ParamsData {
  names: string[]
  /** What the tab used last time, per name. */
  remembered: Record<string, ParamValue>
  /** 'Run' or 'Explain' — what the button does. */
  action: string
}

const MODES: { id: ParamMode; label: string; title: string }[] = [
  {
    id: 'text',
    label: 'Value',
    title: "Sent as a quoted literal ('42'); Postgres casts it to the column's type",
  },
  { id: 'null', label: 'NULL', title: 'NULL' },
  { id: 'raw', label: 'SQL', title: 'Pasted as-is: lists for in (…), expressions like now() - interval …' },
]

/** Asks for the values of a run's `:name` parameters; closes with them (undefined on Esc / Cancel). */
@Component({
  selector: 'y-params-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block w-[520px] max-w-[92vw] rounded-lg border border-line bg-raised shadow-xl' },
  template: `
    <form class="flex flex-col gap-3 p-5" (submit)="$event.preventDefault(); ref.close(values())">
      <h2 class="text-[15px] font-medium">Parameters</h2>
      <div class="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2">
        @for (name of data.names; track name; let i = $index) {
          @let p = values()[name];
          <label class="font-mono text-[12.5px] text-muted" [attr.for]="'y-param-' + i">:{{ name }}</label>
          <input
            [id]="'y-param-' + i"
            class="font-mono"
            autocomplete="off"
            spellcheck="false"
            [disabled]="p.mode === 'null'"
            [value]="p.mode === 'null' ? '' : p.value"
            [placeholder]="p.mode === 'null' ? 'NULL' : p.mode === 'raw' ? 'SQL, e.g. 1, 2, 3' : 'value'"
            (input)="set(name, { value: val($event) })"
          />
          <div class="seg-group" role="radiogroup" [attr.aria-label]="name + ' mode'">
            @for (m of modes; track m.id) {
              <button
                type="button"
                role="radio"
                class="seg"
                [class.seg-on]="p.mode === m.id"
                [attr.aria-checked]="p.mode === m.id"
                [title]="m.title"
                (click)="set(name, { mode: m.id })"
              >
                {{ m.label }}
              </button>
            }
          </div>
        }
      </div>
      <p class="text-[11.5px] text-faint">
        Values go in as quoted literals — Postgres casts them, so '42' works for a number. Remembered for this
        tab.
      </p>
      <div class="flex flex-row-reverse gap-2">
        <button type="submit" class="btn btn-primary">{{ data.action }}</button>
        <button type="button" class="btn" (click)="ref.close()">Cancel</button>
      </div>
    </form>
  `,
  styles: `
    input {
      height: 30px;
      min-width: 0;
      padding: 0 8px;
      border-radius: 4px;
      border: 1px solid var(--border-strong);
      background: var(--bg);
      color: var(--fg);
      font-size: 12.5px;
    }
    input:focus {
      outline: 2px solid var(--accent);
      outline-offset: -1px;
    }
    input:disabled {
      opacity: 0.55;
    }
    .seg-group {
      display: flex;
      padding: 2px;
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 11.5px;
    }
    .seg {
      padding: 1px 7px;
      border-radius: 3px;
      color: var(--fg-muted);
    }
    .seg-on {
      background: var(--bg-selected);
      color: var(--fg);
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
    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-fg);
    }
    .btn-primary:hover {
      background: var(--accent);
      filter: brightness(1.08);
    }
  `,
})
export class ParamsDialog {
  protected readonly ref = inject<DialogRef<Record<string, ParamValue>>>(DialogRef)
  protected readonly data = inject<ParamsData>(DIALOG_DATA)
  protected readonly modes = MODES
  protected readonly values = signal<Record<string, ParamValue>>(
    Object.fromEntries(
      this.data.names.map((n) => [n, this.data.remembered[n] ?? { mode: 'text' as ParamMode, value: '' }]),
    ),
  )

  constructor() {
    // The first field, its value selected: Enter re-runs with the same values, typing replaces them.
    const host = inject<ElementRef<HTMLElement>>(ElementRef)
    afterNextRender(() => {
      const first = host.nativeElement.querySelector<HTMLElement>('input:not(:disabled), button[type=submit]')
      first?.focus()
      if (first instanceof HTMLInputElement) first.select()
    })
  }

  protected set(name: string, patch: Partial<ParamValue>) {
    this.values.update((v) => ({ ...v, [name]: { ...v[name], ...patch } }))
  }

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value
  }
}
