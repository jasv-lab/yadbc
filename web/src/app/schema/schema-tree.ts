import { CdkContextMenuTrigger, CdkMenu, CdkMenuItem } from '@angular/cdk/menu'
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core'
import { toObservable, toSignal } from '@angular/core/rxjs-interop'
import { catchError, combineLatest, map, of, startWith, switchMap } from 'rxjs'
import { ConnectionProfile } from '../core/protocol'
import { Icon, IconName } from '../ui/icon'
import { Catalog, CatalogObject, ObjectKind, Relation } from './catalog'
import { SchemaActions } from './schema-actions'
import { Workspace } from '../workspace/workspace'

const ROW = 24
const GROUPS: { kind: ObjectKind; label: string; icon: IconName }[] = [
  { kind: 'table', label: 'Tables', icon: 'table' },
  { kind: 'view', label: 'Views', icon: 'view' },
  { kind: 'matview', label: 'Materialized views', icon: 'matview' },
  { kind: 'foreign', label: 'Foreign tables', icon: 'table' },
  { kind: 'function', label: 'Functions', icon: 'function' },
  { kind: 'procedure', label: 'Procedures', icon: 'function' },
  { kind: 'sequence', label: 'Sequences', icon: 'sequence' },
  { kind: 'enum', label: 'Enums', icon: 'enum' },
]
const RELATIONS = new Set<ObjectKind>(['table', 'view', 'matview', 'foreign'])

interface TreeNode {
  key: string
  depth: number
  label: string
  icon: IconName
  meta?: string
  title?: string
  expandable: boolean
  expanded: boolean
  /** Muted styling: groups, index/constraint rows, loading lines. */
  quiet?: boolean
  accent?: 'key' | 'link'
  object?: CatalogObject
  parentKey?: string
  /** Set on schema rows. */
  schema?: string
}

type RelationState = Relation | 'loading' | { error: string }

/** Compact estimate: 1234 → 1.2k, 50000 → 50k. */
function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${+(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${+(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
}

/**
 * Schema browser for one connection: a flattened, virtualized list (24px rows), so a database with
 * thousands of tables scrolls like ten. Objects arrive in one request; columns, indexes and
 * constraints load when a table is expanded.
 */
@Component({
  selector: 'y-schema-tree',
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
          #filterInput
          class="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-faint"
          placeholder="Filter objects"
          [value]="filter()"
          (input)="filter.set(filterInput.value)"
          (keydown.escape)="filter.set(''); filterInput.blur()"
          (keydown.arrowdown)="$event.preventDefault(); list.focus(); moveSelection(1)"
        />
      </div>
      <button class="icon-btn" title="Refresh schema" (click)="refresh()">
        <y-icon name="refresh" [size]="14" />
      </button>
    </div>

    <div
      #list
      class="relative min-h-0 flex-1 overflow-y-auto outline-none"
      tabindex="0"
      role="tree"
      (scroll)="scrollTop.set(list.scrollTop)"
      (keydown)="onKey($event)"
    >
      @if (state(); as s) {
        @if (s.error) {
          <p class="px-3 py-2 text-[12px] text-danger">{{ s.error }}</p>
        } @else if (s.loading) {
          <p class="px-3 py-2 text-[12px] text-faint">Loading schema…</p>
        } @else if (!nodes().length) {
          <p class="px-3 py-2 text-[12px] text-faint">
            {{ filter() ? 'Nothing matches.' : 'No user schemas.' }}
          </p>
        }
      }
      <div [style.height.px]="nodes().length * rowHeight">
        @for (n of visible(); track n.node.key) {
          <div
            class="row"
            role="treeitem"
            [attr.aria-expanded]="n.node.expandable ? n.node.expanded : null"
            [class.selected]="n.node.key === selected()"
            [class.quiet]="n.node.quiet"
            [style.top.px]="n.index * rowHeight"
            [style.padding-left.px]="8 + n.node.depth * 14"
            [title]="n.node.title ?? ''"
            (mousedown)="select(n.node.key)"
            (click)="onClick($event, n.node)"
            (dblclick)="activate(n.node)"
            [cdkContextMenuTriggerFor]="n.node.object ? objectMenu : n.node.schema ? schemaMenu : null"
            [cdkContextMenuTriggerData]="{ node: n.node }"
          >
            <span class="chev">
              @if (n.node.expandable) {
                <y-icon [name]="n.node.expanded ? 'chevron-down' : 'chevron-right'" [size]="12" />
              }
            </span>
            <y-icon
              [name]="n.node.icon"
              [size]="14"
              class="shrink-0"
              [class.text-warning]="n.node.accent === 'key'"
              [class.text-accent]="n.node.accent === 'link'"
            />
            <span class="label">{{ n.node.label }}</span>
            @if (n.node.meta) {
              <span class="meta">{{ n.node.meta }}</span>
            }
          </div>
        }
      </div>
    </div>

    <ng-template #schemaMenu let-node="node">
      <div cdkMenu class="menu">
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="visualize(node.schema)">
          Visualize schema
        </button>
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="editTable(node.schema, null)">
          New table…
        </button>
        <div class="menu-sep"></div>
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="refresh()">Refresh schema</button>
      </div>
    </ng-template>

    <ng-template #objectMenu let-node="node">
      <div cdkMenu class="menu">
        @if (isRelation(node.object)) {
          <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="openData(node.object)">
            Open data <span class="menu-key">Enter</span>
          </button>
          <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="selectScript(node.object)">
            New query with SELECT
          </button>
        }
        @if (hasDefinition(node.object)) {
          <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="openDefinition(node.object)">
            Show definition
          </button>
        }
        @if (node.object.kind === 'table') {
          <button
            cdkMenuItem
            class="menu-item"
            (cdkMenuItemTriggered)="editTable(node.object.schema, node.object.name)"
          >
            Edit table…
          </button>
        }
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="copyName(node.object)">
          Copy name
        </button>
        <div class="menu-sep"></div>
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="refresh()">Refresh schema</button>
      </div>
    </ng-template>
  `,
  styles: `
    .row {
      position: absolute;
      left: 0;
      right: 0;
      height: ${ROW}px;
      display: flex;
      align-items: center;
      gap: 5px;
      padding-right: 8px;
      white-space: nowrap;
      cursor: default;
      color: var(--fg);
    }
    .row:hover {
      background: var(--bg-hover);
    }
    .row.selected {
      background: var(--bg-selected);
    }
    .row.quiet {
      color: var(--fg-muted);
    }
    .chev {
      display: inline-flex;
      width: 12px;
      flex-shrink: 0;
      color: var(--fg-faint);
    }
    .label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta {
      margin-left: auto;
      padding-left: 8px;
      font: 11px var(--font-mono);
      color: var(--fg-faint);
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 50%;
    }
  `,
})
export class SchemaTree {
  readonly connection = input<ConnectionProfile | null>(null)

  private readonly catalog = inject(Catalog)
  private readonly actions = inject(SchemaActions)
  private readonly workspace = inject(Workspace)
  private readonly list = viewChild.required<ElementRef<HTMLDivElement>>('list')

  protected readonly rowHeight = ROW
  protected readonly filter = signal('')
  protected readonly selected = signal<string | null>(null)
  protected readonly scrollTop = signal(0)
  private readonly viewportHeight = signal(600)
  /** Expanded keys per connection, so switching tabs keeps each tree as you left it. */
  private readonly expandedByConnection = signal(new Map<string, Set<string>>())
  private readonly relations = signal(new Map<string, RelationState>())

  /** Objects for the current connection; reloads on connection change and on catalog refresh. */
  protected readonly state = toSignal(
    combineLatest([toObservable(this.connection), toObservable(this.catalog.changed)]).pipe(
      switchMap(([conn]) =>
        !conn
          ? of({ loading: false, error: null, data: null })
          : this.catalog.objects(conn.id).pipe(
              map((data) => ({ loading: false, error: null as string | null, data })),
              catchError((e) =>
                of({ loading: false, error: e instanceof Error ? e.message : 'Failed', data: null }),
              ),
              startWith({ loading: true, error: null, data: null }),
            ),
      ),
    ),
  )

  private readonly expanded = computed(() => {
    const id = this.connection()?.id
    return (id && this.expandedByConnection().get(id)) || new Set<string>()
  })

  protected readonly nodes = computed(() => this.flatten())

  protected readonly visible = computed(() => {
    const nodes = this.nodes()
    const first = Math.max(0, Math.floor(this.scrollTop() / ROW) - 5)
    const last = Math.min(nodes.length, Math.ceil((this.scrollTop() + this.viewportHeight()) / ROW) + 5)
    return nodes.slice(first, last).map((node, i) => ({ node, index: first + i }))
  })

  constructor() {
    const ro = new ResizeObserver(([entry]) => this.viewportHeight.set(entry.contentRect.height))
    effect(() => ro.observe(this.list().nativeElement))
    inject(DestroyRef).onDestroy(() => ro.disconnect())

    // A database with one user schema (the common case) opens with it and its tables expanded.
    effect(() => {
      const data = this.state()?.data
      const id = this.connection()?.id
      if (!data || !id) return
      untracked(() => {
        if (this.expandedByConnection().has(id)) return
        const schemas = data.schemas.filter((s) => data.objects.some((o) => o.schema === s))
        const initial = new Set<string>()
        if (schemas.length === 1) initial.add(`s:${schemas[0]}`).add(`g:${schemas[0]}:table`)
        this.expandedByConnection.update((m) => new Map(m).set(id, initial))
      })
    })

    // Expanded relations whose details aren't loaded yet: fetch them.
    effect(() => {
      const conn = this.connection()
      const expanded = this.expanded()
      const data = this.state()?.data
      if (!conn || !data) return
      untracked(() => {
        for (const o of data.objects) {
          const key = `${conn.id}:${o.oid}`
          if (!RELATIONS.has(o.kind) || !expanded.has(`o:${o.oid}`) || this.relations().has(key)) continue
          this.setRelation(key, 'loading')
          this.catalog.relation(conn.id, o.oid).subscribe({
            next: (r) => this.setRelation(key, r),
            error: (e) => this.setRelation(key, { error: e instanceof Error ? e.message : 'Failed' }),
          })
        }
      })
    })

    // A catalog refresh drops cached details too.
    effect(() => {
      this.catalog.changed()
      untracked(() => this.relations.set(new Map()))
    })
  }

  private setRelation(key: string, state: RelationState) {
    this.relations.update((m) => new Map(m).set(key, state))
  }

  private flatten(): TreeNode[] {
    const data = this.state()?.data
    const conn = this.connection()
    if (!data || !conn) return []
    const filter = this.filter().trim().toLowerCase()
    const expanded = this.expanded()
    const isOpen = (key: string) => !!filter || expanded.has(key)
    const out: TreeNode[] = []

    for (const schema of data.schemas) {
      const objects = data.objects.filter(
        (o) => o.schema === schema && (!filter || o.name.toLowerCase().includes(filter)),
      )
      if (filter && !objects.length) continue
      const sKey = `s:${schema}`
      out.push({
        key: sKey,
        depth: 0,
        label: schema,
        icon: 'database',
        meta: objects.length ? String(objects.length) : undefined,
        expandable: true,
        expanded: isOpen(sKey),
        schema,
      })
      if (!isOpen(sKey)) continue

      for (const group of GROUPS) {
        const items = objects.filter((o) => o.kind === group.kind)
        if (!items.length) continue
        const gKey = `g:${schema}:${group.kind}`
        out.push({
          key: gKey,
          depth: 1,
          label: group.label,
          icon: isOpen(gKey) ? 'folder-open' : 'folder',
          meta: String(items.length),
          expandable: true,
          expanded: isOpen(gKey),
          quiet: true,
          parentKey: sKey,
        })
        if (!isOpen(gKey)) continue

        for (const o of items) {
          const oKey = `o:${o.oid}`
          const isRel = RELATIONS.has(o.kind)
          // Filtering shows matches, not their columns, unless you expand one.
          const open = expanded.has(oKey)
          out.push({
            key: oKey,
            depth: 2,
            label: o.name,
            icon: group.icon,
            meta: o.estRows != null ? `~${compact(o.estRows)}` : undefined,
            title: o.comment ?? undefined,
            expandable: isRel,
            expanded: open,
            object: o,
            parentKey: gKey,
          })
          if (isRel && open) out.push(...this.relationNodes(conn.id, o, oKey, expanded))
        }
      }
    }
    return out
  }

  private relationNodes(
    connectionId: string,
    o: CatalogObject,
    parentKey: string,
    expanded: Set<string>,
  ): TreeNode[] {
    const state = this.relations().get(`${connectionId}:${o.oid}`)
    if (!state || state === 'loading')
      return [
        {
          key: `${parentKey}:loading`,
          depth: 3,
          label: 'Loading…',
          icon: 'dot',
          expandable: false,
          expanded: false,
          quiet: true,
          parentKey,
        },
      ]
    if ('error' in state)
      return [
        {
          key: `${parentKey}:error`,
          depth: 3,
          label: state.error,
          icon: 'alert',
          expandable: false,
          expanded: false,
          quiet: true,
          parentKey,
        },
      ]

    const out: TreeNode[] = state.columns.map((c) => ({
      key: `c:${o.oid}:${c.name}`,
      depth: 3,
      label: c.name,
      icon: c.primaryKey ? 'key' : c.references ? 'link' : 'column',
      accent: c.primaryKey ? 'key' : c.references ? 'link' : undefined,
      // The sidebar is narrow: type on the row, everything else in the tooltip.
      meta: c.type,
      title: [
        `${c.name} ${c.type}${c.nullable ? '' : ' not null'}`,
        c.default ? `default ${c.default}` : '',
        c.references ? `→ ${c.references}` : '',
        c.comment ?? '',
      ]
        .filter(Boolean)
        .join('\n'),
      expandable: false,
      expanded: false,
      parentKey,
    }))

    const sub = (
      kind: 'idx' | 'con',
      label: string,
      items: { name: string; meta: string; title: string }[],
    ) => {
      if (!items.length) return
      const key = `${kind}:${o.oid}`
      const open = expanded.has(key)
      out.push({
        key,
        depth: 3,
        label,
        icon: open ? 'folder-open' : 'folder',
        meta: String(items.length),
        expandable: true,
        expanded: open,
        quiet: true,
        parentKey,
      })
      if (open)
        for (const i of items)
          out.push({
            key: `${key}:${i.name}`,
            depth: 4,
            label: i.name,
            icon: kind === 'idx' ? 'index' : 'check',
            meta: i.meta,
            title: i.title,
            expandable: false,
            expanded: false,
            quiet: true,
            parentKey: key,
          })
    }
    sub(
      'idx',
      'Indexes',
      state.indexes.map((i) => ({
        name: i.name,
        meta: i.primary ? 'primary' : i.unique ? 'unique' : '',
        title: i.definition,
      })),
    )
    sub(
      'con',
      'Constraints',
      state.constraints
        .filter((c) => c.kind !== 'primary key')
        .map((c) => ({ name: c.name, meta: c.kind, title: c.definition })),
    )
    return out
  }

  // ── Interaction ──────────────────────────────────────────────────────────

  protected select(key: string) {
    this.selected.set(key)
  }

  protected toggle(node: TreeNode) {
    const id = this.connection()?.id
    if (!id || !node.expandable) return
    this.expandedByConnection.update((m) => {
      const set = new Set(m.get(id) ?? [])
      if (set.has(node.key)) set.delete(node.key)
      else set.add(node.key)
      return new Map(m).set(id, set)
    })
  }

  /** Folders (schemas, groups) toggle on click; objects only via their chevron, so a click can just select. */
  protected onClick(e: MouseEvent, node: TreeNode) {
    if (!node.expandable) return
    if (!node.object || (e.target as HTMLElement).closest('.chev')) this.toggle(node)
  }

  /** Double-click / Enter: tables open their data, views and functions their definition, groups toggle. */
  protected activate(node: TreeNode) {
    const o = node.object
    if (o && RELATIONS.has(o.kind)) this.openData(o)
    else if (o && this.hasDefinition(o)) this.openDefinition(o)
    else if (node.expandable) this.toggle(node)
  }

  protected moveSelection(delta: number) {
    const nodes = this.nodes()
    if (!nodes.length) return
    const i = nodes.findIndex((n) => n.key === this.selected())
    const next = nodes[Math.min(nodes.length - 1, Math.max(0, i < 0 ? 0 : i + delta))]
    this.selected.set(next.key)
    this.scrollTo(nodes.indexOf(next))
  }

  protected onKey(e: KeyboardEvent) {
    const nodes = this.nodes()
    const node = nodes.find((n) => n.key === this.selected())
    const handled = () => e.preventDefault()
    switch (e.key) {
      case 'ArrowDown':
        handled()
        return this.moveSelection(1)
      case 'ArrowUp':
        handled()
        return this.moveSelection(-1)
      case 'ArrowRight':
        handled()
        if (node?.expandable && !node.expanded) this.toggle(node)
        else this.moveSelection(1)
        return
      case 'ArrowLeft':
        handled()
        if (node?.expandable && node.expanded) this.toggle(node)
        else if (node?.parentKey) {
          this.selected.set(node.parentKey)
          this.scrollTo(nodes.findIndex((n) => n.key === node.parentKey))
        }
        return
      case 'Enter':
        handled()
        if (node) this.activate(node)
        return
    }
  }

  private scrollTo(index: number) {
    const el = this.list().nativeElement
    const top = index * ROW
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight
  }

  // ── Actions (shared with the command palette) ────────────────────────────

  protected isRelation(o?: CatalogObject) {
    return this.actions.isRelation(o)
  }

  protected hasDefinition(o?: CatalogObject) {
    return this.actions.hasDefinition(o)
  }

  protected openData(o: CatalogObject) {
    const conn = this.connection()
    if (conn) this.actions.openData(conn, o)
  }

  protected selectScript(o: CatalogObject) {
    const conn = this.connection()
    if (conn) this.actions.selectScript(conn, o)
  }

  protected openDefinition(o: CatalogObject) {
    const conn = this.connection()
    if (conn) this.actions.openDefinition(conn, o)
  }

  protected copyName(o: CatalogObject) {
    this.actions.copyName(o)
  }

  protected editTable(schema: string, table: string | null) {
    const conn = this.connection()
    if (conn) this.actions.editTable(conn, schema, table)
  }

  protected visualize(schema: string) {
    const conn = this.connection()
    if (conn) this.workspace.openDiagram(conn, schema)
  }

  protected refresh() {
    const id = this.connection()?.id
    if (id) this.catalog.refresh(id)
  }
}
