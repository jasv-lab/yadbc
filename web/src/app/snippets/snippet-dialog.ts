import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog'
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { of, switchMap, tap } from 'rxjs'
import { ConnectionProfile } from '../core/protocol'
import { Sharing, sharingError } from '../sharing/sharing'
import { Snippet, Snippets } from './snippets'

export interface SnippetDialogData {
  sql: string
  connection: ConnectionProfile
  /** Editing an existing snippet (rename, move between scopes). */
  existing?: Snippet
}

/** Name and scope of a snippet; saves it and closes with it (undefined on cancel). */
@Component({
  selector: 'y-snippet-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block w-[480px] max-w-[92vw] rounded-lg border border-line bg-raised shadow-xl' },
  template: `
    <form class="flex flex-col gap-3 p-5" (submit)="$event.preventDefault(); save()">
      <h2 class="text-[15px] font-medium">{{ data.existing ? 'Edit snippet' : 'Save as snippet' }}</h2>
      <label class="field">
        <span>Name</span>
        <input
          #nameInput
          [value]="name()"
          (input)="name.set(nameInput.value)"
          placeholder="Orders of a customer"
        />
      </label>
      <div class="field">
        <span>Offered on</span>
        <label class="flex items-center gap-2 text-[12.5px]">
          <input type="radio" name="scope" [checked]="!global()" (change)="global.set(false)" />
          {{
            data.existing?.shared ? 'Everyone using ' + data.connection.name : data.connection.name + ' only'
          }}
        </label>
        <label class="flex items-center gap-2 text-[12.5px]">
          <input type="radio" name="scope" [checked]="global()" (change)="global.set(true)" />
          {{ data.existing?.shared ? 'Everyone on the team, on every connection' : 'Every connection' }}
        </label>
      </div>
      @if (!data.existing && signedIn()) {
        <label class="flex items-start gap-2 text-[12.5px]" [class.text-faint]="!shareable()">
          <input
            type="checkbox"
            class="mt-0.5"
            [checked]="share() && shareable()"
            [disabled]="!shareable()"
            (change)="share.set(!share())"
          />
          <span>
            Share with
            {{ global() ? 'the team' : 'everyone using ' + data.connection.name }}
            @if (!shareable()) {
              <span class="block text-[11.5px]"
                >{{ data.connection.name }} isn’t shared: share the connection first, or offer the snippet on
                every connection.</span
              >
            }
          </span>
        </label>
      }
      <pre
        class="max-h-[160px] overflow-auto rounded border border-line bg-sunken p-2 font-mono text-[12px]"
        >{{ data.sql }}</pre>
      @if (error()) {
        <p class="text-[12px] text-danger">{{ error() }}</p>
      }
      <div class="flex flex-row-reverse gap-2">
        <button type="submit" class="btn btn-primary" [disabled]="!name().trim() || busy()">Save</button>
        <button type="button" class="btn" (click)="ref.close()">Cancel</button>
      </div>
    </form>
  `,
  styles: `
    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .field > span {
      font-size: 12px;
      color: var(--fg-muted);
    }
    input:not([type]) {
      height: 30px;
      padding: 0 8px;
      border-radius: 4px;
      border: 1px solid var(--border-strong);
      background: var(--bg);
      color: var(--fg);
      font: inherit;
    }
    input:not([type]):focus {
      outline: 2px solid var(--accent);
      outline-offset: -1px;
    }
    .btn {
      height: 30px;
      padding: 0 12px;
      border-radius: 4px;
      border: 1px solid var(--border-strong);
      background: var(--bg-raised);
      color: var(--fg);
    }
    .btn:disabled {
      opacity: 0.6;
    }
    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-fg);
    }
  `,
})
export class SnippetDialog {
  protected readonly ref = inject<DialogRef<Snippet>>(DialogRef)
  protected readonly data = inject<SnippetDialogData>(DIALOG_DATA)
  private readonly snippets = inject(Snippets)
  private readonly sharing = inject(Sharing)
  protected readonly signedIn = computed(() => this.sharing.status().signedIn)
  /** Saved but sharing it failed: Save again shares that one instead of saving a second copy. */
  private savedId: string | undefined

  protected readonly name = signal(this.data.existing?.name ?? '')
  protected readonly global = signal(this.data.existing ? this.data.existing.connectionId === null : false)
  protected readonly share = signal(false)
  /** A shared snippet sits on a shared connection or on every connection. */
  protected readonly shareable = computed(
    () => this.global() || (!!this.data.connection.shared && !this.data.connection.shared.orphaned),
  )
  protected readonly busy = signal(false)
  protected readonly error = signal('')

  protected save() {
    if (!this.name().trim()) return
    this.busy.set(true)
    this.snippets
      .save(
        {
          name: this.name().trim(),
          sql: this.data.sql,
          connectionId: this.global() ? null : (this.data.existing?.connectionId ?? this.data.connection.id),
        },
        this.data.existing?.id ?? this.savedId,
      )
      .pipe(
        tap((s) => (this.savedId = s.id)),
        switchMap((s) => (this.share() && this.shareable() ? this.snippets.share(s.id) : of(s))),
      )
      .subscribe({
        next: (s) => this.ref.close(s),
        error: (e) => {
          this.busy.set(false)
          this.error.set(sharingError(e))
        },
      })
  }
}
