import { DialogRef } from '@angular/cdk/dialog'
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { Connections } from '../connections/connections'
import { Session } from '../core/session'
import { ConnectionProfile } from '../core/protocol'
import { Icon } from '../ui/icon'
import { CatalogEntry, Sharing, sharingError } from './sharing'

const ENV_DOT = { local: 'bg-env-local', dev: 'bg-env-dev', prod: 'bg-env-prod' } as const

/**
 * The shared-connections catalog: sign in to the broker, browse what the team shares, install what you
 * need into your connection list. Closes with a connection to open (Install & open), or nothing.
 */
@Component({
  selector: 'y-catalog-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: {
    class:
      'flex max-h-[80vh] w-[680px] max-w-[94vw] flex-col rounded-lg border border-line bg-raised shadow-xl',
  },
  template: `
    @let s = sharing.status();
    <div class="flex items-center gap-3 border-b border-line px-5 py-3">
      <h2 class="text-[15px] font-medium">Shared connections</h2>
      <span class="flex-1"></span>
      @if (s.signedIn) {
        <span class="truncate text-[12px] text-muted" [title]="s.brokerUrl ?? ''">
          {{ s.user?.name }}{{ s.isAdmin ? ' · admin' : '' }}
        </span>
        <button class="link" (click)="signOut()">Sign out</button>
      }
      <button
        class="grid size-6 place-items-center rounded text-muted hover:bg-hover"
        title="Close"
        (click)="ref.close()"
      >
        <y-icon name="x" [size]="14" />
      </button>
    </div>

    @if (!s.signedIn) {
      <form class="flex flex-col gap-3 p-5" (submit)="$event.preventDefault(); signIn(urlInput.value)">
        <p class="text-[12.5px] text-muted">
          Connections your team shares through a yadbc broker: install the ones you need and they appear in
          your list, logins included. Optional — everything else works without it.
        </p>
        <label class="field">
          <span>Broker</span>
          <input
            #urlInput
            cdkFocusInitial
            [value]="s.brokerUrl ?? ''"
            placeholder="https://yadbc.example.com"
            autocomplete="url"
          />
        </label>
        @if (signingIn()) {
          <p class="text-[12px] text-muted">Finish signing in in your browser…</p>
        }
        @if (error() ?? s.error; as e) {
          <p class="text-[12px] text-danger">{{ e }}</p>
        }
        <div class="flex flex-row-reverse gap-2">
          <button type="submit" class="btn btn-primary" [disabled]="signingIn()">Sign in</button>
        </div>
      </form>
    } @else {
      <div class="flex items-center gap-2 px-5 pt-3 pb-2">
        <div
          class="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded border border-line bg-bg px-2 text-faint"
        >
          <y-icon name="search" [size]="13" />
          <input
            #q
            class="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-faint"
            placeholder="Search by name, database, host or owner"
            (input)="search.set(q.value)"
            cdkFocusInitial
          />
        </div>
        <label
          class="flex items-center gap-1.5 text-[12px] text-muted"
          title="The group in your connection list that installs go into"
        >
          Install into
          <input
            class="h-7 w-[140px] rounded border border-line bg-bg px-2 text-[12.5px] text-fg outline-none"
            list="y-catalog-groups"
            placeholder="no group"
            [value]="installGroup()"
            (input)="setInstallGroup($any($event.target).value)"
          />
          <datalist id="y-catalog-groups">
            @for (g of connections.groupNames(); track g) {
              <option [value]="g"></option>
            }
          </datalist>
        </label>
      </div>
      <div class="min-h-[120px] flex-1 overflow-y-auto px-2 pb-2">
        @for (e of shown(); track e.share.id) {
          @let sh = e.share;
          <div class="row">
            <span
              class="mt-1.5 size-2 shrink-0 rounded-full"
              [class]="envDot[sh.env]"
              [title]="sh.env"
            ></span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate font-medium">{{ sh.name }}</span>
                @if (sh.env === 'prod') {
                  <span class="badge badge-prod">prod</span>
                }
              </div>
              <div class="truncate font-mono text-[11.5px] text-faint">
                {{ sh.database }} ·
                {{ sh.tunnel?.kind === 'kubernetes' ? sh.tunnel?.kubeTarget + ' (k8s)' : sh.host
                }}{{ sh.tunnel?.kind === 'ssh' ? ' via ' + sh.tunnel?.sshHost : '' }}
              </div>
              <div class="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted">
                <span>{{ ownerNames(e) }}</span>
                <span class="text-faint">·</span>
                @if (sh.loginMode === 'own') {
                  <span>your own login</span>
                } @else if (sh.hasLogin) {
                  <span>login included{{ sh.username ? ' (' + sh.username + ')' : '' }}</span>
                } @else {
                  <span class="text-warning">no login stored yet</span>
                }
                <span class="text-faint">·</span>
                <span>{{ sh.installs }} {{ sh.installs === 1 ? 'install' : 'installs' }}</span>
              </div>
            </div>
            @if (e.installedAs; as id) {
              <button class="btn btn-sm" (click)="open(id)">Open</button>
              <button class="link text-[12px]" (click)="uninstall(e)" [disabled]="busy() === sh.id">
                Uninstall
              </button>
            } @else {
              <button class="btn btn-sm btn-primary" (click)="install(e)" [disabled]="busy() === sh.id">
                {{ busy() === sh.id ? 'Installing…' : 'Install' }}
              </button>
            }
          </div>
        } @empty {
          <p class="px-3 py-6 text-center text-[12px] text-faint">
            @if (loading()) {
              Loading…
            } @else if (search()) {
              Nothing matches.
            } @else {
              Nothing shared yet. Share one of your connections from the connection menu (Share…).
            }
          </p>
        }
      </div>
      @if (error(); as e) {
        <p class="border-t border-line px-5 py-2 text-[12px] text-danger">{{ e }}</p>
      }
    }
  `,
  styles: `
    .row {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 6px;
    }
    .row:hover {
      background: var(--bg-hover);
    }
    .row > .btn,
    .row > .link {
      align-self: center;
    }
    .badge {
      padding: 0 5px;
      border-radius: 3px;
      font-size: 10.5px;
    }
    .badge-prod {
      background: color-mix(in srgb, var(--conn-prod) 15%, transparent);
      color: var(--conn-prod);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .field > span {
      font-size: 12px;
      color: var(--fg-muted);
    }
    .field input {
      height: 30px;
      padding: 0 8px;
      border-radius: 4px;
      border: 1px solid var(--border-strong);
      background: var(--bg);
      color: var(--fg);
      font: inherit;
    }
    .field input:focus {
      outline: 2px solid var(--accent);
      outline-offset: -1px;
    }
    .link {
      color: var(--accent);
      font-size: 12px;
    }
    .link:disabled {
      opacity: 0.6;
    }
    .btn {
      height: 30px;
      padding: 0 12px;
      border-radius: 4px;
      border: 1px solid var(--border-strong);
      background: var(--bg-raised);
      color: var(--fg);
      white-space: nowrap;
    }
    .btn-sm {
      height: 26px;
      padding: 0 10px;
      font-size: 12px;
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
export class CatalogDialog {
  protected readonly ref = inject<DialogRef<ConnectionProfile>>(DialogRef)
  protected readonly sharing = inject(Sharing)
  protected readonly connections = inject(Connections)
  private readonly session = inject(Session)
  /** Remembered between installs and sessions. */
  protected readonly installGroup = signal(this.session.pref<string>('installGroup', ''))
  protected readonly envDot = ENV_DOT

  protected readonly entries = signal<CatalogEntry[]>([])
  protected readonly loading = signal(false)
  protected readonly search = signal('')
  protected readonly busy = signal<string | null>(null)
  protected readonly error = signal<string | null>(null)
  protected readonly signingIn = signal(false)

  protected readonly shown = computed(() => {
    const q = this.search().trim().toLowerCase()
    const all = this.entries()
    if (!q) return all
    return all.filter((e) =>
      [
        e.share.name,
        e.share.database,
        e.share.host,
        e.share.tunnel?.kubeTarget ?? '',
        ...e.share.owners.map((o) => o.name),
      ]
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
  })

  constructor() {
    this.sharing.refreshStatus().subscribe((s) => {
      if (s.signedIn) this.load()
    })
  }

  private load() {
    this.loading.set(true)
    this.sharing.catalog().subscribe({
      next: (list) => {
        this.entries.set(list)
        this.loading.set(false)
      },
      error: (e) => {
        this.error.set(sharingError(e))
        this.loading.set(false)
        this.sharing.refreshStatus().subscribe()
      },
    })
  }

  protected setInstallGroup(group: string) {
    this.installGroup.set(group)
    this.session.setPref('installGroup', group.trim())
  }

  protected ownerNames(e: CatalogEntry) {
    const names = e.share.owners.map((o) => o.name)
    return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ')
  }

  protected signIn(url: string) {
    if (!url.trim()) return this.error.set('Enter the broker address.')
    this.error.set(null)
    this.signingIn.set(true)
    this.sharing.signIn(url).subscribe({
      next: (s) => {
        if (s.signedIn) this.load()
      },
      error: (e) => {
        this.error.set(sharingError(e))
        this.signingIn.set(false)
      },
      complete: () => this.signingIn.set(false),
    })
  }

  protected signOut() {
    this.sharing.signOut().subscribe(() => this.entries.set([]))
  }

  protected install(e: CatalogEntry) {
    this.busy.set(e.share.id)
    this.error.set(null)
    this.sharing.install(e.share.id, this.installGroup().trim() || null).subscribe({
      next: (profile) => {
        this.busy.set(null)
        this.entries.update((list) =>
          list.map((x) =>
            x.share.id === e.share.id
              ? {
                  share: { ...x.share, installs: x.share.installs + 1, installedByMe: true },
                  installedAs: profile.id,
                }
              : x,
          ),
        )
      },
      error: (err) => {
        this.busy.set(null)
        this.error.set(sharingError(err))
      },
    })
  }

  protected uninstall(e: CatalogEntry) {
    this.busy.set(e.share.id)
    this.connections.remove(e.installedAs!).subscribe({
      next: () => {
        this.busy.set(null)
        this.entries.update((list) =>
          list.map((x) =>
            x.share.id === e.share.id
              ? {
                  share: { ...x.share, installs: Math.max(0, x.share.installs - 1), installedByMe: false },
                  installedAs: null,
                }
              : x,
          ),
        )
      },
      error: () => this.busy.set(null),
    })
  }

  protected open(id: string) {
    const profile = this.connections.get(id)
    if (profile) this.ref.close(profile)
  }
}
