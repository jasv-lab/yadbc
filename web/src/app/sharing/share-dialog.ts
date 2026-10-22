import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog'
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { forkJoin, of } from 'rxjs'
import { ConnectionProfile } from '../core/protocol'
import { Person, Sharing, sharingError } from './sharing'

/**
 * Share a local connection through the broker, or (owners) change how it's shared: the login, Claude's
 * access and the co-owners. Sharing turns the connection into the installed copy of the share, so your
 * later edits reach everyone. Closes with the saved connection.
 */
@Component({
  selector: 'y-share-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'flex max-h-[85vh] w-[500px] max-w-[94vw] flex-col rounded-lg border border-line bg-raised shadow-xl',
  },
  template: `
    <form class="flex min-h-0 flex-col gap-4 overflow-y-auto p-5" (submit)="$event.preventDefault(); save()">
      <div>
        <h2 class="text-[15px] font-medium">{{ shared ? 'Sharing settings' : 'Share ' + data.name }}</h2>
        <p class="mt-1 text-[12px] text-muted">
          Everyone signed in to the broker sees it in the catalog and can install it.
          @if (!shared) {
            Your connection becomes the shared one: your later changes reach everyone.
          }
        </p>
      </div>

      <div class="field">
        <span>Login</span>
        <label class="choice">
          <input type="radio" name="login" [checked]="includeLogin()" (change)="includeLogin.set(true)" />
          <span>
            Include the login <span class="font-mono">{{ data.username }}</span>
            <span class="sub"
              >Everyone connects as it; the password travels encrypted and is never shown.</span
            >
          </span>
        </label>
        <label class="choice">
          <input type="radio" name="login" [checked]="!includeLogin()" (change)="includeLogin.set(false)" />
          <span>
            Everyone uses their own login
            <span class="sub"
              >The connection details only; each person enters their own user and password.</span
            >
          </span>
        </label>
        @if (data.env === 'prod' && includeLogin()) {
          <p class="sub text-warning">
            Prod: what people can do is what this login can do. Share a read-only login if that's the intent.
          </p>
        }
      </div>

      <label class="choice">
        <input
          type="checkbox"
          [checked]="mcpAllowed()"
          (change)="mcpAllowed.set($any($event.target).checked)"
        />
        <span>
          Allow Claude (MCP) to read it
          <span class="sub">The limit for everyone; each person can still switch it off for themselves.</span>
        </span>
      </label>

      <div class="field min-h-0">
        <span>Co-owners <span class="text-faint">· can change and stop sharing it</span></span>
        @if (people().length) {
          <input class="filter" placeholder="Filter people" (input)="filter.set($any($event.target).value)" />
          <div class="people">
            @for (p of shownPeople(); track p.id) {
              <label class="flex items-center gap-2 px-2 py-1 text-[12.5px]">
                <input
                  type="checkbox"
                  [checked]="owners().has(p.id)"
                  (change)="toggleOwner(p.id)"
                  [disabled]="p.id === me"
                />
                <span class="min-w-0 flex-1 truncate">{{ p.name }}{{ p.id === me ? ' (you)' : '' }}</span>
                <span class="truncate text-[11.5px] text-faint">{{ p.email }}</span>
              </label>
            }
          </div>
        } @else {
          <p class="sub">People appear here once they've signed in to the broker.</p>
        }
      </div>

      @if (error(); as e) {
        <p class="text-[12px] text-danger">{{ e }}</p>
      }
      <div class="flex items-center gap-2">
        @if (shared) {
          <button type="button" class="link-danger" (click)="stop()" [disabled]="busy()">Stop sharing</button>
        }
        <span class="flex-1"></span>
        <button type="button" class="btn" (click)="ref.close()">Cancel</button>
        <button type="submit" class="btn btn-primary" [disabled]="busy()">
          {{ shared ? 'Save' : 'Share' }}
        </button>
      </div>
    </form>
  `,
  styles: `
    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .field > span {
      font-size: 12px;
      color: var(--fg-muted);
    }
    .choice {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      font-size: 12.5px;
    }
    .choice input {
      margin-top: 3px;
    }
    .sub {
      display: block;
      font-size: 11.5px;
      color: var(--fg-faint);
    }
    .filter {
      height: 28px;
      padding: 0 8px;
      border-radius: 4px;
      border: 1px solid var(--border-strong);
      background: var(--bg);
      color: var(--fg);
    }
    .people {
      max-height: 180px;
      overflow-y: auto;
      border: 1px solid var(--border);
      border-radius: 4px;
    }
    .link-danger {
      color: var(--danger);
      font-size: 12.5px;
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
      opacity: 0.6;
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
export class ShareDialog {
  protected readonly ref = inject<DialogRef<ConnectionProfile>>(DialogRef)
  protected readonly data = inject<ConnectionProfile>(DIALOG_DATA)
  private readonly sharing = inject(Sharing)

  protected readonly shared = this.data.shared ?? null
  protected readonly me = this.sharing.status().user?.id ?? null
  protected readonly includeLogin = signal(this.shared ? this.shared.loginMode === 'included' : true)
  protected readonly mcpAllowed = signal(this.shared ? this.shared.mcpAllowed : this.data.env !== 'prod')
  protected readonly people = signal<Person[]>([])
  protected readonly owners = signal<ReadonlySet<string>>(new Set(this.me ? [this.me] : []))
  protected readonly filter = signal('')
  protected readonly busy = signal(false)
  protected readonly error = signal<string | null>(null)

  protected readonly shownPeople = computed(() => {
    const q = this.filter().trim().toLowerCase()
    return this.people().filter((p) => !q || `${p.name} ${p.email ?? ''}`.toLowerCase().includes(q))
  })

  constructor() {
    // An existing share's owners come from the catalog (the installed link only keeps their names).
    forkJoin([this.sharing.users(), this.shared ? this.sharing.catalog() : of([])]).subscribe({
      next: ([people, catalog]) => {
        this.people.set(people)
        const entry = catalog.find((e) => e.share.id === this.shared?.shareId)
        if (entry) this.owners.set(new Set(entry.share.owners.map((o) => o.id)))
      },
      error: (e) => this.error.set(sharingError(e)),
    })
  }

  protected toggleOwner(id: string) {
    this.owners.update((set) => {
      const next = new Set(set)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  protected save() {
    this.busy.set(true)
    this.error.set(null)
    const owners = [...this.owners()]
    this.sharing
      .share(this.data.id, {
        includeLogin: this.includeLogin(),
        mcpAllowed: this.mcpAllowed(),
        owners: owners.length ? owners : null,
      })
      .subscribe({
        next: (saved) => this.ref.close(saved),
        error: (e) => {
          this.busy.set(false)
          this.error.set(sharingError(e))
        },
      })
  }

  protected stop() {
    if (
      !confirm(
        `Stop sharing "${this.data.name}"? It leaves the catalog; whoever installed it keeps a copy marked "no longer shared". Yours stays as a local connection.`,
      )
    )
      return
    this.busy.set(true)
    this.sharing.stop(this.data.id).subscribe({
      next: (saved) => this.ref.close(saved),
      error: (e) => {
        this.busy.set(false)
        this.error.set(sharingError(e))
      },
    })
  }
}
