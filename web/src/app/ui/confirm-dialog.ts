import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog'
import { ChangeDetectionStrategy, Component, inject } from '@angular/core'

export interface ConfirmData {
  title: string
  message: string
  /** Rendered right to left in importance; the first is the primary (focused) action. */
  actions: { id: string; label: string }[]
}

/** Small decision dialog; closes with the chosen action id (undefined on Esc). */
@Component({
  selector: 'y-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block w-[420px] rounded-lg border border-line bg-raised p-5 shadow-xl' },
  template: `
    <h2 class="text-[15px] font-medium">{{ data.title }}</h2>
    <p class="mt-2 text-[13px] text-muted">{{ data.message }}</p>
    <div class="mt-5 flex flex-row-reverse gap-2">
      @for (a of data.actions; track a.id; let first = $first) {
        <button class="btn" [class.btn-primary]="first" (click)="ref.close(a.id)">{{ a.label }}</button>
      }
    </div>
  `,
  styles: `
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
  `,
})
export class ConfirmDialog {
  protected readonly ref = inject<DialogRef<string>>(DialogRef)
  protected readonly data = inject<ConfirmData>(DIALOG_DATA)
}
