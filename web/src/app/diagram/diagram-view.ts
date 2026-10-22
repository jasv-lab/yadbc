import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu'
import { DecimalPipe } from '@angular/common'
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core'
import { toObservable, toSignal } from '@angular/core/rxjs-interop'
import { catchError, combineLatest, from, map, Observable, of, shareReplay, startWith, switchMap } from 'rxjs'
import { Catalog } from '../schema/catalog'
import { Icon } from '../ui/icon'
import { DiagramTab, Workspace } from '../workspace/workspace'
import { DiagramApi, DiagramData, DiagramLayout, LaidTable, layoutDiagram, ROW, HEADER } from './diagram'
import { currentTheme, diagramSvg, download, embeddedFonts, ExportedSvg, svgToPng } from './diagram-export'

interface State {
  status: 'loading' | 'layout' | 'ready' | 'error'
  data?: DiagramData
  layout?: DiagramLayout
  error?: string
}

const MIN_ZOOM = 0.1
const MAX_ZOOM = 2.5

/** Compact row estimate: 1234 → 1.2k. */
function compact(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${+(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${+(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
}

/**
 * A schema's tables and foreign keys as a layered diagram filling the central plane. Drag to pan,
 * wheel to zoom (around the cursor), click a table to bring out its relations, double-click to query it.
 */
@Component({
  selector: 'y-diagram-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, DecimalPipe, CdkMenu, CdkMenuItem, CdkMenuTrigger],
  host: { class: 'flex min-h-0 flex-col bg-bg' },
  template: `
    <div class="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-raised px-3">
      <y-icon name="diagram" [size]="14" class="text-accent" />
      <select class="schema" (change)="tab().schema.set($any($event.target).value)">
        @for (s of schemas(); track s) {
          <option [value]="s" [selected]="s === tab().schema()">{{ s }}</option>
        }
      </select>
      @if (state().data; as d) {
        <span class="text-[12px] text-muted">
          {{ ownTables() }} tables · {{ d.relations.length }} relations
        </span>
      }
      <input
        class="search"
        placeholder="Find table…"
        [value]="search()"
        (input)="search.set($any($event.target).value)"
        (keydown.enter)="focusFirstMatch()"
      />
      <button class="chip" [class.chip-on]="keysOnly()" (click)="keysOnly.set(!keysOnly())">Keys only</button>
      <span class="flex-1"></span>
      @if (selected(); as s) {
        <span class="truncate text-[12px] text-muted">
          {{ s }} · {{ relatedEdges().size }} relations · double-click to query
        </span>
      }
      <button class="icon-btn" title="Zoom out" (click)="zoomBy(1 / 1.25)">−</button>
      <span class="w-10 text-center text-[11.5px] text-muted tabular-nums"
        >{{ zoom() * 100 | number: '1.0-0' }}%</span
      >
      <button class="icon-btn" title="Zoom in" (click)="zoomBy(1.25)">+</button>
      <button class="run-btn" title="Fit the whole diagram" (click)="fit()">Fit</button>
      <button class="run-btn" [disabled]="!state().layout" [cdkMenuTriggerFor]="exportMenu">
        <y-icon name="download" [size]="13" /> Export
      </button>
    </div>
    @if (message(); as m) {
      <div class="toast" [class.bad]="m.bad">{{ m.text }}</div>
    }

    <ng-template #exportMenu>
      <div cdkMenu class="menu">
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="copyPng()">Copy as PNG</button>
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="savePng()">Save PNG</button>
        <button cdkMenuItem class="menu-item" (cdkMenuItemTriggered)="saveSvg()">Save SVG</button>
        <div class="menu-sep"></div>
        <div class="menu-label">The whole diagram, current theme</div>
      </div>
    </ng-template>

    <div
      #viewport
      class="viewport relative min-h-0 flex-1 overflow-hidden"
      [style.background-size.px]="24 * zoom()"
      [style.background-position]="pan().x + 'px ' + pan().y + 'px'"
      (pointerdown)="startPan($event)"
      (wheel)="onWheel($event)"
    >
      @switch (state().status) {
        @case ('loading') {
          <p class="msg">Reading {{ tab().schema() }}…</p>
        }
        @case ('layout') {
          <p class="msg">Laying out {{ state().data?.tables?.length }} tables…</p>
        }
        @case ('error') {
          <p class="msg text-danger">{{ state().error }}</p>
        }
      }
      @if (state().layout; as l) {
        @if (!l.tables.length) {
          <p class="msg">No tables in {{ tab().schema() }}.</p>
        }
        <div
          class="stage"
          [style.width.px]="l.width"
          [style.height.px]="l.height"
          [style.transform]="'translate(' + pan().x + 'px, ' + pan().y + 'px) scale(' + zoom() + ')'"
        >
          <svg class="edges" [attr.width]="l.width" [attr.height]="l.height">
            <defs>
              <!-- many (crow's foot) at the referencing end, one (bar) at the referenced end -->
              <marker
                id="y-many"
                viewBox="0 0 12 12"
                refX="12"
                refY="6"
                markerWidth="12"
                markerHeight="12"
                orient="auto"
              >
                <path
                  d="M0 6 L12 0 M0 6 L12 6 M0 6 L12 12"
                  fill="none"
                  stroke="context-stroke"
                  stroke-width="1.4"
                />
              </marker>
              <marker
                id="y-one"
                viewBox="0 0 12 12"
                refX="0"
                refY="6"
                markerWidth="12"
                markerHeight="12"
                orient="auto"
              >
                <path d="M5 1 L5 11" fill="none" stroke="context-stroke" stroke-width="1.6" />
              </marker>
            </defs>
            @for (e of l.edges; track $index) {
              <path
                class="edge"
                [attr.d]="e.path"
                [class.optional]="e.relation.nullable"
                [class.hot]="relatedEdges().has(e.relation.name)"
                [class.dim]="!!selected() && !relatedEdges().has(e.relation.name)"
                marker-start="url(#y-one)"
                marker-end="url(#y-many)"
              >
                <title>
                  {{ e.relation.name }}: {{ e.relation.from.table }}({{ e.relation.from.columns.join(', ') }})
                  → {{ e.relation.to.table }}({{ e.relation.to.columns.join(', ') }})
                </title>
              </path>
            }
          </svg>
          @if (l.looseTop !== null) {
            <div class="loose-label" [style.top.px]="l.looseTop">Not related to other tables</div>
          }
          @for (t of l.tables; track t.table.id) {
            <div
              class="card"
              [class.external]="t.table.external"
              [class.selected]="selected() === t.table.id"
              [class.related]="relatedTables().has(t.table.id) && selected() !== t.table.id"
              [class.dim]="isDimmed(t)"
              [class.match]="matches().has(t.table.id)"
              [style.left.px]="t.x"
              [style.top.px]="t.y"
              [style.width.px]="t.w"
              [style.height.px]="t.h"
              [title]="t.table.comment ?? ''"
              (click)="onCardClick($event, t)"
              (dblclick)="query(t)"
            >
              <div class="head" [style.height.px]="header">
                <y-icon name="table" [size]="13" class="shrink-0 text-accent" />
                <span class="name">{{ t.table.external ? t.table.schema + '.' : '' }}{{ t.table.name }}</span>
                <span class="rows">~{{ compact(t.table.estRows) }}</span>
              </div>
              @for (r of t.rows; track r.name) {
                <div class="col" [style.height.px]="row">
                  @if (r.pk) {
                    <y-icon name="key" [size]="11" class="shrink-0 text-warning" />
                  } @else if (r.fk) {
                    <y-icon name="link" [size]="11" class="shrink-0 text-accent" />
                  } @else {
                    <span class="dot" [class.opt]="!r.notNull"></span>
                  }
                  <span class="cname" [class.pk]="r.pk">{{ r.name }}</span>
                  <span class="ctype">{{ r.type }}</span>
                </div>
              }
              @if (t.more) {
                <div class="more" [style.height.px]="row">+ {{ t.more }} more</div>
              }
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: `
    .viewport {
      cursor: grab;
      background-image: radial-gradient(
        circle,
        color-mix(in srgb, var(--fg-faint) 35%, transparent) 1px,
        transparent 1.2px
      );
      user-select: none;
    }
    .viewport:active {
      cursor: grabbing;
    }
    .stage {
      position: absolute;
      left: 0;
      top: 0;
      transform-origin: 0 0;
    }
    .edges {
      position: absolute;
      inset: 0;
      overflow: visible;
      pointer-events: none;
    }
    .edge {
      fill: none;
      stroke: var(--border-strong);
      stroke-width: 1.5;
      transition:
        opacity 120ms,
        stroke 120ms;
    }
    .edge.optional {
      stroke-dasharray: 5 4;
    }
    .edge.hot {
      stroke: var(--accent);
      stroke-width: 2;
    }
    .edge.dim {
      opacity: 0.12;
    }
    .card {
      position: absolute;
      display: flex;
      flex-direction: column;
      border-radius: 10px;
      border: 1px solid var(--border-strong);
      background: var(--bg-raised);
      box-shadow:
        0 1px 2px rgb(0 0 0 / 0.12),
        0 6px 18px rgb(0 0 0 / 0.1);
      overflow: hidden;
      cursor: pointer;
      transition:
        opacity 120ms,
        box-shadow 120ms,
        border-color 120ms;
    }
    .card:hover {
      border-color: var(--fg-faint);
    }
    .card.selected {
      border-color: var(--accent);
      box-shadow:
        0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent),
        0 8px 24px rgb(0 0 0 / 0.18);
    }
    .card.related {
      border-color: color-mix(in srgb, var(--accent) 55%, var(--border-strong));
    }
    .card.match .head {
      background: color-mix(in srgb, var(--warning) 22%, var(--bg-sunken));
    }
    .card.dim {
      opacity: 0.3;
    }
    .card.external {
      border-style: dashed;
      background: color-mix(in srgb, var(--bg-raised) 70%, transparent);
    }
    .head {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 0 10px;
      border-bottom: 1px solid var(--border);
      background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--accent) 9%, var(--bg-sunken)),
        var(--bg-sunken)
      );
    }
    .name {
      min-width: 0;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
      font-size: 13px;
    }
    .rows {
      font: 11px var(--font-mono);
      color: var(--fg-faint);
    }
    .col {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 0 10px;
      white-space: nowrap;
    }
    .cname {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      font: 12px var(--font-mono);
    }
    .cname.pk {
      font-weight: 600;
    }
    .ctype {
      margin-left: auto;
      padding-left: 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      font: 11px var(--font-mono);
      color: var(--fg-faint);
    }
    .dot {
      width: 11px;
      flex-shrink: 0;
      display: flex;
      justify-content: center;
    }
    .dot::before {
      content: '';
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--fg-faint);
    }
    .dot.opt::before {
      background: transparent;
      border: 1px solid var(--fg-faint);
    }
    .more {
      display: flex;
      align-items: center;
      padding: 0 10px 0 28px;
      font-size: 11.5px;
      color: var(--fg-faint);
    }
    .loose-label {
      position: absolute;
      left: 0;
      font-size: 12px;
      font-weight: 500;
      color: var(--fg-muted);
    }
    .toast {
      position: absolute;
      right: 16px;
      top: 48px;
      z-index: 5;
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg-raised);
      box-shadow: 0 6px 18px rgb(0 0 0 / 0.2);
      font-size: 12px;
      color: var(--fg-muted);
    }
    .toast.bad {
      color: var(--danger);
    }
    .msg {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12.5px;
      color: var(--fg-faint);
    }
    .schema {
      height: 24px;
      padding: 0 6px;
      border-radius: 4px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--fg);
      font-size: 12.5px;
      font-weight: 500;
    }
    .search {
      height: 24px;
      width: 160px;
      padding: 0 8px;
      border-radius: 4px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--fg);
      font-size: 12px;
    }
    .chip {
      height: 22px;
      padding: 0 8px;
      border-radius: 11px;
      border: 1px solid var(--border);
      color: var(--fg-muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .chip-on {
      border-color: var(--accent);
      color: var(--fg);
      background: var(--bg-selected);
    }
  `,
})
export class DiagramView {
  readonly tab = input.required<DiagramTab>()

  private readonly api = inject(DiagramApi)
  private readonly catalog = inject(Catalog)
  private readonly workspace = inject(Workspace)
  private readonly viewport = viewChild.required<ElementRef<HTMLDivElement>>('viewport')

  protected readonly header = HEADER
  protected readonly row = ROW
  protected readonly compact = compact
  protected readonly keysOnly = signal(false)
  protected readonly search = signal('')
  protected readonly selected = signal<string | null>(null)
  protected readonly zoom = signal(1)
  protected readonly pan = signal({ x: 40, y: 40 })
  protected readonly message = signal<{ text: string; bad: boolean } | null>(null)
  private messageTimer?: ReturnType<typeof setTimeout>

  protected readonly schemas = toSignal(
    toObservable(this.tab).pipe(
      switchMap((t) => this.catalog.objects(t.connection.id).pipe(map((o) => o.schemas))),
      catchError(() => of<string[]>([])),
    ),
    { initialValue: [] as string[] },
  )

  // Data per (connection, schema); layout per data and keys-only — toggling doesn't refetch.
  private readonly data$: Observable<{ data?: DiagramData; error?: string; loading: boolean }> = toObservable(
    computed(() => ({ conn: this.tab().connection.id, schema: this.tab().schema() })),
  ).pipe(
    switchMap(({ conn, schema }) =>
      this.api.load(conn, schema).pipe(
        map((data) => ({ data, loading: false })),
        catchError((e) => of({ error: e?.error?.error ?? 'Could not read the schema', loading: false })),
        startWith({ loading: true }),
      ),
    ),
    shareReplay(1),
  )

  protected readonly state = toSignal(
    combineLatest([this.data$, toObservable(this.keysOnly)]).pipe(
      switchMap(([d, keysOnly]): Observable<State> => {
        if (d.loading) return of({ status: 'loading' })
        if (d.error || !d.data) return of({ status: 'error', error: d.error })
        const data = d.data
        return from(layoutDiagram(data, keysOnly)).pipe(
          map((layout): State => ({ status: 'ready', data, layout })),
          catchError((e) => of<State>({ status: 'error', data, error: `Layout failed: ${e?.message ?? e}` })),
          startWith<State>({ status: 'layout', data }),
        )
      }),
    ),
    { initialValue: { status: 'loading' } as State },
  )

  protected readonly ownTables = computed(
    () => this.state().data?.tables.filter((t) => !t.external).length ?? 0,
  )

  protected readonly relatedEdges = computed(() => {
    const id = this.selected()
    const rels = this.state().data?.relations ?? []
    return new Set(id ? rels.filter((r) => r.from.table === id || r.to.table === id).map((r) => r.name) : [])
  })

  protected readonly relatedTables = computed(() => {
    const id = this.selected()
    const set = new Set<string>()
    if (!id) return set
    for (const r of this.state().data?.relations ?? [])
      if (r.from.table === id || r.to.table === id) set.add(r.from.table).add(r.to.table)
    return set
  })

  protected readonly matches = computed(() => {
    const q = this.search().trim().toLowerCase()
    const tables = this.state().layout?.tables ?? []
    return new Set(
      q ? tables.filter((t) => t.table.name.toLowerCase().includes(q)).map((t) => t.table.id) : [],
    )
  })

  constructor() {
    // A new layout (schema switch, keys-only) is fitted to the screen; a new schema clears the selection.
    effect(() => {
      const l = this.state().layout
      if (l) untracked(() => queueMicrotask(() => this.fit()))
    })
    effect(() => {
      this.tab().schema()
      untracked(() => this.selected.set(null))
    })
  }

  protected isDimmed(t: LaidTable) {
    const sel = this.selected()
    if (sel) return !this.relatedTables().has(t.table.id)
    return this.matches().size > 0 && !this.matches().has(t.table.id)
  }

  protected fit() {
    const l = this.state().layout
    const vp = this.viewport().nativeElement
    if (!l || !l.width || !vp.clientWidth) return
    const margin = 48
    const k = Math.min(1, (vp.clientWidth - margin * 2) / l.width, (vp.clientHeight - margin * 2) / l.height)
    const z = Math.max(MIN_ZOOM, k)
    this.zoom.set(z)
    this.pan.set({
      x: (vp.clientWidth - l.width * z) / 2,
      y: Math.max(margin, (vp.clientHeight - l.height * z) / 2),
    })
  }

  protected zoomBy(factor: number, at?: { x: number; y: number }) {
    const vp = this.viewport().nativeElement
    const point = at ?? { x: vp.clientWidth / 2, y: vp.clientHeight / 2 }
    const old = this.zoom()
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, old * factor))
    const p = this.pan()
    // Keep the point under the cursor where it is.
    this.pan.set({ x: point.x - ((point.x - p.x) * z) / old, y: point.y - ((point.y - p.y) * z) / old })
    this.zoom.set(z)
  }

  protected onWheel(e: WheelEvent) {
    e.preventDefault()
    const rect = this.viewport().nativeElement.getBoundingClientRect()
    this.zoomBy(Math.exp(-e.deltaY * 0.0015), { x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  private dragged = false

  /** Drag anywhere (cards included) pans; a press that doesn't move is a click. */
  protected startPan(e: PointerEvent) {
    if (e.button !== 0) return
    const el = this.viewport().nativeElement
    const start = { x: e.clientX, y: e.clientY }
    const origin = this.pan()
    this.dragged = false
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      if (!this.dragged && Math.hypot(dx, dy) < 4) return
      if (!this.dragged) el.setPointerCapture(e.pointerId)
      this.dragged = true
      this.pan.set({ x: origin.x + dx, y: origin.y + dy })
    }
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      // A plain click on the background clears the selection.
      if (!this.dragged && !(ev.target as HTMLElement).closest('.card')) this.selected.set(null)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  protected onCardClick(e: MouseEvent, t: LaidTable) {
    e.stopPropagation()
    if (this.dragged) return
    this.selected.set(this.selected() === t.table.id ? null : t.table.id)
  }

  protected focusFirstMatch() {
    const id = [...this.matches()][0]
    const t = this.state().layout?.tables.find((x) => x.table.id === id)
    if (!t) return
    this.selected.set(t.table.id)
    const vp = this.viewport().nativeElement
    const z = Math.max(this.zoom(), 0.8)
    this.zoom.set(z)
    this.pan.set({
      x: vp.clientWidth / 2 - (t.x + t.w / 2) * z,
      y: vp.clientHeight / 2 - (t.y + t.h / 2) * z,
    })
  }

  // ── Export ─────────────────────────────────────────────────────────────

  private async exportSvg(): Promise<ExportedSvg> {
    const s = this.state()
    const tab = this.tab()
    const tables = s.data?.tables.filter((t) => !t.external).length ?? 0
    const date = new Date().toISOString().slice(0, 10)
    return diagramSvg(
      s.layout!,
      currentTheme(),
      {
        title: tab.schema(),
        subtitle: `${tables} tables · ${s.data?.relations.length ?? 0} relations · ${tab.connection.name} · ${date}`,
      },
      await embeddedFonts(),
    )
  }

  private fileName(ext: string) {
    const safe = (s: string) => s.replace(/[^\w.-]+/g, '-')
    return `${safe(this.tab().connection.name)}-${safe(this.tab().schema())}.${ext}`
  }

  private say(text: string, bad = false) {
    this.message.set({ text, bad })
    clearTimeout(this.messageTimer)
    this.messageTimer = setTimeout(() => this.message.set(null), bad ? 6000 : 2500)
  }

  protected copyPng() {
    if (!this.state().layout) return
    // The promise goes into the ClipboardItem right away, so the click still counts as the user's gesture.
    const png = this.exportSvg().then(svgToPng)
    navigator.clipboard
      .write([new ClipboardItem({ 'image/png': png })])
      .then(() => this.say('Diagram copied as PNG'))
      .catch((e) => this.say(`Couldn't copy: ${e?.message ?? e}`, true))
  }

  protected async savePng() {
    if (!this.state().layout) return
    try {
      download(await svgToPng(await this.exportSvg()), this.fileName('png'))
    } catch (e) {
      this.say(`Couldn't export: ${(e as Error)?.message ?? e}`, true)
    }
  }

  protected async saveSvg() {
    if (!this.state().layout) return
    const { svg } = await this.exportSvg()
    download(new Blob([svg], { type: 'image/svg+xml' }), this.fileName('svg'))
  }

  protected query(t: LaidTable) {
    const ident = (s: string) => (/^[a-z_][a-z0-9_$]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`)
    const name =
      t.table.schema === 'public' ? ident(t.table.name) : `${ident(t.table.schema)}.${ident(t.table.name)}`
    this.workspace.openTab(this.tab().connection, `SELECT *\nFROM ${name}\nLIMIT 100;`, { autoRun: true })
  }
}
