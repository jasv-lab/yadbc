import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu'
import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core'
import { Connections } from '../connections/connections'
import { Commands } from '../core/commands'
import { Catalog } from '../schema/catalog'
import { ConnectionProfile } from '../core/protocol'
import { SchemaTree } from '../schema/schema-tree'
import { HistoryList } from '../history/history-list'
import { SnippetList } from '../snippets/snippet-list'
import { Icon } from '../ui/icon'
import { NgTemplateOutlet } from '@angular/common'
import { initials } from '../sharing/sharing'

const ENV_DOT = { local: 'bg-env-local', dev: 'bg-env-dev', prod: 'bg-env-prod' } as const

/**
 * Left sidebar: a connection switcher on top (the tree follows the active tab's connection),
 * then the schema tree. With no tab open, it lists connections to start from.
 */
@Component({
  selector: 'y-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Icon,
    NgTemplateOutlet,
    SchemaTree,
    HistoryList,
    SnippetList,
    CdkMenu,
    CdkMenuItem,
    CdkMenuTrigger,
  ],
  host: { class: 'flex w-[260px] shrink-0 flex-col border-r border-line bg-sunken' },
  template: `
    <div class="p-2">
      <button
        class="switcher"
        [cdkMenuTriggerFor]="switcherMenu"
        [title]="current() ? describe(current()!) : 'Choose a connection'"
      >
        @if (current(); as c) {
          <span class="size-2 shrink-0 rounded-full" [class]="envDot[c.env]"></span>
          <span class="min-w-0 flex-1 truncate text-left">{{ c.name }}</span>
          <span class="truncate font-mono text-[11px] text-faint">{{ c.database }}</span>
          <span class="env-label">{{ c.env }}</span>
        } @else {
          <span class="flex-1 text-left text-muted">Choose a connection</span>
        }
        <y-icon name="chevrons-up-down" [size]="13" class="text-faint" />
      </button>
    </div>

    @if (current(); as c) {
      <div class="mx-2 mb-2 flex rounded border border-line p-0.5 text-[12px]" role="tablist">
        <button role="tab" class="seg" [class.seg-on]="view() === 'schema'" (click)="view.set('schema')">
          Schema
        </button>
        <button role="tab" class="seg" [class.seg-on]="view() === 'history'" (click)="view.set('history')">
          History
        </button>
        <button role="tab" class="seg" [class.seg-on]="view() === 'snippets'" (click)="view.set('snippets')">
          Snippets
        </button>
        <button class="seg !flex-none px-2" title="Visualize schema" (click)="diagram.emit(c)">
          <y-icon name="diagram" [size]="13" />
        </button>
        <button
          class="seg !flex-none px-2"
          title="Activity and locks (Ctrl+Shift+A)"
          (click)="activity.emit(c)"
        >
          <y-icon name="activity" [size]="13" />
        </button>
      </div>
      @if (view() === 'schema') {
        <y-schema-tree [connection]="c" />
      } @else if (view() === 'history') {
        <y-history-list [connection]="c" />
      } @else {
        <y-snippet-list [connection]="c" />
      }
    } @else {
      <div class="min-h-0 flex-1 overflow-y-auto px-1.5">
        @for (g of connections.groups(); track g.name) {
          @if (g.name || connections.groups().length > 1) {
            <div class="group-label">{{ g.name ?? 'Other' }}</div>
          }
          @for (c of g.connections; track c.id) {
            <button class="conn-row" [class.indented]="!!g.name" (click)="open.emit(c)" [title]="describe(c)">
              <span class="size-2 shrink-0 rounded-full" [class]="envDot[c.env]"></span>
              <span class="min-w-0 flex-1 truncate text-left">{{ c.name }}</span>
              <span class="env-label">{{ c.env }}</span>
              <ng-container *ngTemplateOutlet="sharedMark; context: { $implicit: c }" />
              @if (c.tunnel) {
                <y-icon name="tunnel" [size]="13" class="text-faint" />
              }
              @if (c.env === 'prod') {
                <y-icon name="lock" [size]="13" class="text-faint" />
              }
            </button>
          }
        } @empty {
          <p class="px-2 py-3 text-[12px] text-faint">No connections yet.</p>
        }
      </div>
    }

    <ng-template #switcherMenu>
      <div cdkMenu class="menu min-w-[244px]">
        @for (g of connections.groups(); track g.name; let first = $first) {
          <div class="menu-label">{{ g.name ?? (first ? 'Connections' : 'Other') }}</div>
          @for (c of g.connections; track c.id) {
            <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="open.emit(c)" [title]="describe(c)">
              <span class="size-2 shrink-0 rounded-full" [class]="envDot[c.env]"></span>
              <span class="min-w-0 flex-1 truncate">{{ c.name }}</span>
              <span class="env-label">{{ c.env }}</span>
              <ng-container *ngTemplateOutlet="sharedMark; context: { $implicit: c }" />
              @if (c.id === current()?.id) {
                <y-icon name="check" [size]="13" class="text-accent" />
              }
            </button>
          }
        }
        <div class="menu-sep"></div>
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="create.emit()">
          <y-icon name="plus" [size]="13" /> New connection…
        </button>
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="catalog.emit()">
          <y-icon name="database" [size]="13" /> Shared connections…
        </button>
        @if (current(); as c) {
          <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="activity.emit(c)">
            <y-icon name="activity" [size]="13" /> Activity and locks
          </button>
          <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="commands.execute('compare.open')">
            <y-icon name="compare" [size]="13" /> Compare schema with…
          </button>
          <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="edit.emit(c)">
            <y-icon name="edit" [size]="13" /> Edit {{ c.name }}…
          </button>
          @if (!c.shared) {
            <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="share.emit(c)">
              <y-icon name="link" [size]="13" /> Share {{ c.name }}…
            </button>
          } @else if (c.shared.orphaned) {
            <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="keepLocal.emit(c)">
              <y-icon name="pin" [size]="13" /> Keep as a local connection
            </button>
          } @else if (c.shared.canEdit) {
            <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="share.emit(c)">
              <y-icon name="link" [size]="13" /> Sharing settings…
            </button>
          }
          <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="remove.emit(c)">
            <y-icon name="trash" [size]="13" /> {{ c.shared ? 'Uninstall' : 'Delete' }} {{ c.name }}…
          </button>
        }
      </div>
    </ng-template>

    <!-- Shared connections carry their owner's initials; a share deleted on the broker says so. -->
    <ng-template #sharedMark let-c>
      @if (c.shared; as s) {
        @if (s.orphaned) {
          <span
            class="mark text-warning"
            title="No longer shared: keep it as a local connection, or uninstall it"
            >unshared</span
          >
        } @else {
          <span class="mark" [title]="'Shared by ' + s.owners.join(', ')">{{
            initials(s.owners[0] ?? '?')
          }}</span>
        }
      }
    </ng-template>
  `,
  styles: `
    /* Two connections often share a name (cmdb, cmdb): the environment says which, not just its dot. */
    .env-label {
      flex-shrink: 0;
      font-size: 11px;
      color: var(--fg-faint);
    }
    .group-label {
      padding: 8px 8px 2px;
      font-size: 11px;
      font-weight: 600;
      color: var(--fg-faint);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .conn-row.indented {
      padding-left: 14px;
    }
    .mark {
      flex-shrink: 0;
      padding: 0 4px;
      border-radius: 3px;
      background: var(--bg-sunken);
      border: 1px solid var(--border);
      color: var(--fg-muted);
      font-size: 10px;
      line-height: 14px;
      font-weight: 500;
    }
    .switcher {
      display: flex;
      width: 100%;
      height: 32px;
      align-items: center;
      gap: 8px;
      padding: 0 8px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg-raised);
    }
    .switcher:hover {
      border-color: var(--border-strong);
    }
    .seg {
      flex: 1;
      border-radius: 3px;
      padding: 1px 0;
      color: var(--fg-muted);
    }
    .seg-on {
      background: var(--bg-selected);
      color: var(--fg);
    }
    .conn-row {
      display: flex;
      width: 100%;
      height: 30px;
      align-items: center;
      gap: 8px;
      padding: 0 8px;
      border-radius: 4px;
    }
    .conn-row:hover {
      background: var(--bg-hover);
    }
  `,
})
export class Sidebar {
  /** The active tab's connection; the tree follows it. */
  readonly current = input<ConnectionProfile | null>(null)
  readonly open = output<ConnectionProfile>()
  readonly create = output<void>()
  readonly edit = output<ConnectionProfile>()
  readonly remove = output<ConnectionProfile>()
  readonly share = output<ConnectionProfile>()
  readonly keepLocal = output<ConnectionProfile>()
  readonly catalog = output<void>()
  readonly activity = output<ConnectionProfile>()
  readonly diagram = output<ConnectionProfile>()

  protected readonly connections = inject(Connections)
  protected readonly commands = inject(Commands)
  protected readonly envDot = ENV_DOT
  protected readonly initials = initials
  protected readonly view = signal<'schema' | 'history' | 'snippets'>('schema')

  constructor() {
    const catalog = inject(Catalog)
    inject(Commands).register(
      {
        id: 'sidebar.schema',
        label: 'Show schema',
        when: () => !!this.current(),
        run: () => this.view.set('schema'),
      },
      {
        id: 'sidebar.history',
        label: 'Show query history',
        when: () => !!this.current(),
        run: () => this.view.set('history'),
      },
      {
        id: 'schema.refresh',
        label: 'Refresh schema',
        when: () => !!this.current(),
        run: () => catalog.refresh(this.current()!.id),
      },
    )
  }

  protected describe(c: ConnectionProfile) {
    const t = c.tunnel
    if (!t) return `${c.username}@${c.host}:${c.port}/${c.database}`
    if (t.kind === 'ssh') {
      const via = `${t.sshUser ? t.sshUser + '@' : ''}${t.sshHost}${t.sshPort ? ':' + t.sshPort : ''}`
      return `${c.username}@${c.host}:${c.port}/${c.database} via SSH ${via}`
    }
    const where = [t.kubeContext, t.kubeNamespace, t.kubeTarget].filter(Boolean).join(' / ')
    return `${c.username}@${t.kubeTarget}:${c.port}/${c.database} via kubectl port-forward (${where})`
  }
}
