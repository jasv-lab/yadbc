import { Dialog } from '@angular/cdk/dialog'
import { CdkContextMenuTrigger, CdkMenu, CdkMenuItem } from '@angular/cdk/menu'
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core'
import { Observable } from 'rxjs'
import { Commands } from '../core/commands'
import { ConnectionProfile } from '../core/protocol'
import { initials, Sharing, sharingError } from '../sharing/sharing'
import { Icon } from '../ui/icon'
import { Workspace } from '../workspace/workspace'
import { SnippetDialog, SnippetDialogData } from './snippet-dialog'
import { Snippet, Snippets } from './snippets'

/**
 * Sidebar snippets for the active connection (its own and the global ones), yours and the team's shared
 * ones. Enter / click inserts into the editor (appended, like history); double-click opens a new tab.
 */
@Component({
  selector: 'y-snippet-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, CdkContextMenuTrigger, CdkMenu, CdkMenuItem],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <div class="flex items-center gap-1 px-2 pb-1.5">
      <div
        class="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded border border-line bg-bg px-2 text-faint"
      >
        <y-icon name="search" [size]="13" />
        <input
          #searchInput
          class="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-faint"
          placeholder="Search snippets"
          [value]="search()"
          (input)="search.set(searchInput.value)"
          (keydown.escape)="search.set(''); searchInput.blur()"
          (keydown.arrowdown)="$event.preventDefault(); list.focus(); move(1)"
        />
      </div>
      <button
        class="grid size-7 place-items-center rounded text-muted hover:bg-hover hover:text-fg"
        [title]="commands.tooltip('snippet.save')"
        (click)="commands.execute('snippet.save')"
      >
        <y-icon name="plus" [size]="14" />
      </button>
    </div>

    @if (error()) {
      <p class="flex items-start gap-1 px-3 pb-1.5 text-[12px] text-danger">
        <span class="flex-1">{{ error() }}</span>
        <button class="text-faint hover:text-fg" title="Dismiss" (click)="error.set('')">
          <y-icon name="x" [size]="12" />
        </button>
      </p>
    }

    <div
      #list
      class="min-h-0 flex-1 overflow-y-auto outline-none"
      tabindex="0"
      role="listbox"
      (keydown)="onKey($event)"
    >
      @for (s of shown(); track s.id) {
        <div
          class="entry"
          role="option"
          [attr.aria-selected]="s.id === selected()"
          [class.selected]="s.id === selected()"
          [title]="s.sql"
          (mousedown)="selected.set(s.id)"
          (dblclick)="openInNewTab(s)"
          [cdkContextMenuTriggerFor]="menu"
          [cdkContextMenuTriggerData]="{ snippet: s }"
        >
          <div class="flex items-center gap-1.5">
            <span class="min-w-0 flex-1 truncate text-[12.5px]">{{ s.name }}</span>
            @if (s.connectionId === null) {
              <span class="badge" title="Offered on every connection">all</span>
            }
            @if (s.shared; as shared) {
              <span class="badge shared" [title]="'Shared by ' + shared.by">{{ initials(shared.by) }}</span>
            }
          </div>
          <div class="sql">{{ s.sql }}</div>
        </div>
      } @empty {
        <p class="px-3 py-2 text-[12px] text-faint">
          @if (search()) {
            Nothing matches.
          } @else {
            Saved statements show up here. Save the one under the cursor with + or from Ctrl+K. Use
            <span class="font-mono">:name</span> placeholders for values you change each time.
          }
        </p>
      }
    </div>

    <ng-template #menu let-snippet="snippet">
      <div cdkMenu class="menu">
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="insert(snippet)">
          Insert into editor <span class="menu-key">Enter</span>
        </button>
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="openInNewTab(snippet)">
          Open in new tab <span class="menu-key">Double-click</span>
        </button>
        @if (!snippet.shared || snippet.shared.canEdit) {
          <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="edit(snippet)">
            Rename or move…
          </button>
        }
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="copy(snippet)">Copy SQL</button>
        @if (!snippet.shared && signedIn()) {
          <div class="menu-sep"></div>
          @if (shareable(snippet)) {
            <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="share(snippet)">
              Share
              {{
                snippet.connectionId === null ? 'with the team' : 'with everyone using ' + connection().name
              }}
            </button>
          } @else {
            <button
              cdkMenuItem
              class="menu-item"
              disabled
              title="Share the connection first, or offer the snippet on every connection"
            >
              Share (the connection isn’t shared)
            </button>
          }
        }
        @if (snippet.shared?.canEdit) {
          <div class="menu-sep"></div>
          <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="stopSharing(snippet)">
            Stop sharing (keep it as mine)
          </button>
        }
        @if (snippet.shared && !snippet.shared.canEdit) {
          <div class="menu-sep"></div>
          <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="copyToMine(snippet)">
            Copy to my snippets
          </button>
        }
        @if (!snippet.shared || snippet.shared.canEdit) {
          <div class="menu-sep"></div>
          <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="remove(snippet)">
            Delete snippet{{ snippet.shared ? ' for everyone' : '' }}
          </button>
        }
      </div>
    </ng-template>
  `,
  styles: `
    .entry {
      padding: 5px 10px 6px;
      border-bottom: 1px solid var(--border);
      cursor: default;
    }
    .entry:hover {
      background: var(--bg-hover);
    }
    .entry.selected {
      background: var(--bg-selected);
    }
    .sql {
      margin-top: 2px;
      font: 11.5px/16px var(--font-mono);
      color: var(--fg-faint);
      white-space: pre-wrap;
      word-break: break-word;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .badge {
      padding: 0 4px;
      border-radius: 3px;
      background: var(--bg-sunken);
      color: var(--fg-muted);
      font-size: 10.5px;
    }
    .badge.shared {
      background: var(--bg-selected);
      color: var(--accent);
    }
  `,
})
export class SnippetList {
  readonly connection = input.required<ConnectionProfile>()

  private readonly snippets = inject(Snippets)
  private readonly workspace = inject(Workspace)
  private readonly dialog = inject(Dialog)
  private readonly sharing = inject(Sharing)
  protected readonly commands = inject(Commands)
  protected readonly initials = initials
  protected readonly signedIn = computed(() => this.sharing.status().signedIn)
  protected readonly error = signal('')

  protected readonly search = signal('')
  protected readonly selected = signal<string | null>(null)
  protected readonly shown = computed(() => {
    const q = this.search().trim().toLowerCase()
    const own = this.snippets.forConnection(this.connection().id)
    return q ? own.filter((s) => s.name.toLowerCase().includes(q) || s.sql.toLowerCase().includes(q)) : own
  })

  protected move(delta: number) {
    const list = this.shown()
    if (!list.length) return
    const i = list.findIndex((s) => s.id === this.selected())
    this.selected.set(list[Math.min(list.length - 1, Math.max(0, i < 0 ? 0 : i + delta))].id)
  }

  protected onKey(e: KeyboardEvent) {
    const s = this.shown().find((x) => x.id === this.selected())
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      this.move(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Enter' && s) {
      e.preventDefault()
      if (e.altKey) this.openInNewTab(s)
      else this.insert(s)
    } else if (e.key === 'Delete' && s && (!s.shared || s.shared.canEdit)) {
      e.preventDefault()
      this.remove(s)
    }
  }

  protected insert(s: Snippet) {
    const tab = this.workspace.activeTab()
    if (tab && tab.connection.id === this.connection().id) this.workspace.insertIntoEditor(tab, s.sql)
    else this.openInNewTab(s)
  }

  protected openInNewTab(s: Snippet) {
    this.workspace.openTab(this.connection(), s.sql)
  }

  protected edit(s: Snippet) {
    this.dialog.open<Snippet, SnippetDialogData>(SnippetDialog, {
      data: { sql: s.sql, connection: this.connection(), existing: s },
    })
  }

  protected copy(s: Snippet) {
    navigator.clipboard.writeText(s.sql)
  }

  protected remove(s: Snippet) {
    this.run(this.snippets.remove(s.id))
  }

  /** A shared snippet sits on a shared connection or on every connection, never on one only this machine has. */
  protected shareable(s: Snippet): boolean {
    const shared = this.connection().shared
    return s.connectionId === null || (!!shared && !shared.orphaned)
  }

  protected share(s: Snippet) {
    this.run(this.snippets.share(s.id))
  }

  protected stopSharing(s: Snippet) {
    this.run(this.snippets.stopSharing(s.id))
  }

  protected copyToMine(s: Snippet) {
    this.run(this.snippets.save({ name: s.name, sql: s.sql, connectionId: s.connectionId }))
  }

  private run(call: Observable<unknown>) {
    this.error.set('')
    call.subscribe({ error: (e) => this.error.set(sharingError(e)) })
  }
}
