import { DecimalPipe, NgTemplateOutlet } from '@angular/common'
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core'
import { toObservable, toSignal } from '@angular/core/rxjs-interop'
import { catchError, map, of, startWith, switchMap } from 'rxjs'
import { AdvisorApi, StatementAdvice } from '../advisor/advisor'
import { IndexSuggestions } from '../advisor/index-suggestions'
import { Icon } from '../ui/icon'
import { CellInspector } from '../inspector/cell-inspector'
import { factor, parsePlan, Plan, PlanNode } from './plan'
import { CARD_H, CARD_W, edgePath, layoutPlan } from './plan-layout'

export interface PlanResult {
  json: string
  analyze: boolean
  rolledBack: boolean
}

interface AdviceState {
  state: 'none' | 'loading' | 'ok' | 'error'
  data?: StatementAdvice
  error?: string
}

const ms = (v: number) =>
  v >= 1000 ? `${(v / 1000).toFixed(2)} s` : v >= 10 ? `${v.toFixed(0)} ms` : `${v.toFixed(2)} ms`
const rows = (v: number) =>
  v >= 10 ? Math.round(v).toLocaleString() : (Math.round(v * 100) / 100).toLocaleString()

/** Visual EXPLAIN: tree of node cards with time share heat, row-weighted edges, warnings, details. */
@Component({
  selector: 'y-plan-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, DecimalPipe, IndexSuggestions, NgTemplateOutlet],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    @if (parsed(); as p) {
      @if (p.error) {
        <p class="p-4 text-[12.5px] text-danger">Couldn't read the plan: {{ p.error }}</p>
      } @else if (p.plan; as plan) {
        <!-- Summary -->
        <div
          class="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 border-b border-line bg-sunken px-3 py-2 text-[12px]"
        >
          @if (plan.analyze) {
            <span><span class="text-muted">Execution</span> {{ fmtMs(plan.executionMs ?? 0) }}</span>
          } @else {
            <span><span class="text-muted">Estimated cost</span> {{ plan.root.cost | number: '1.0-0' }}</span>
          }
          @if (plan.planningMs != null) {
            <span><span class="text-muted">Planning</span> {{ fmtMs(plan.planningMs) }}</span>
          }
          @if (plan.jitMs) {
            <span><span class="text-muted">JIT</span> {{ fmtMs(plan.jitMs) }}</span>
          }
          @if (plan.slowest; as s) {
            <button class="hint" (click)="selectNode(s)">
              <span class="text-muted">{{ plan.analyze ? 'Slowest' : 'Costliest' }}</span>
              {{ s.title }} · {{ s.share * 100 | number: '1.0-0' }}%
            </button>
          }
          @if (plan.worstMisestimate; as w) {
            <button class="hint text-warning" (click)="selectNode(w)">
              <span>Misestimate</span> {{ w.type }} · {{ fmtFactor(w.misestimate!) }}
            </button>
          }
          @if (plan.cacheHitRatio != null) {
            <span
              ><span class="text-muted">Cache hits</span>
              {{ plan.cacheHitRatio * 100 | number: '1.0-1' }}%</span
            >
          }
          @if (advice().state === 'loading') {
            <span class="text-faint">Looking for missing indexes…</span>
          } @else if (bestSuggestion(); as best) {
            <button class="hint text-accent" (click)="aside.set('indexes')">
              <y-icon name="index" [size]="12" class="inline align-[-1px]" />
              {{ usefulCount() }} index {{ usefulCount() === 1 ? 'suggestion' : 'suggestions' }}
              @if (best.improvement != null) {
                · up to −{{ best.improvement * 100 | number: '1.0-0' }}% cost
              }
            </button>
          }
          <span class="flex-1"></span>
          <button
            class="hint"
            (click)="inspector.showAi()"
            title="Explain this plan with the AI assistant (Ctrl+I)"
          >
            Ask AI
          </button>
          @if (result().rolledBack) {
            <span
              class="text-faint"
              title="EXPLAIN ANALYZE executes the statement; yadbc rolled its effects back. Sequence increments and external side effects can't be undone."
            >
              ran in a rolled-back transaction
            </span>
          }
          <button class="icon-btn" title="Copy plan JSON (e.g. for explain.dalibo.com)" (click)="copyJson()">
            <y-icon [name]="copied() ? 'check' : 'copy'" [size]="14" />
          </button>
        </div>

        <div class="flex min-h-0 flex-1">
          <!-- Canvas -->
          <div #canvas class="canvas relative min-w-0 flex-1 overflow-auto" (pointerdown)="startPan($event)">
            @if (layout(); as l) {
              <div class="relative" [style.width.px]="l.width" [style.height.px]="l.height">
                <svg
                  class="pointer-events-none absolute inset-0"
                  [attr.width]="l.width"
                  [attr.height]="l.height"
                >
                  @for (e of l.edges; track e.to.node.id) {
                    <path [attr.d]="path(e)" [attr.stroke-width]="e.width" class="edge" />
                  }
                </svg>
                @for (p of l.placed; track p.node.id) {
                  <button
                    class="card"
                    [class.selected]="selected()?.id === p.node.id"
                    [class.idle]="p.node.neverExecuted"
                    [style.left.px]="p.x"
                    [style.top.px]="p.y"
                    [style.width.px]="cardW"
                    [style.height.px]="cardH"
                    (click)="selectNode(p.node)"
                  >
                    <div class="flex items-center gap-1.5">
                      <span class="min-w-0 flex-1 truncate font-medium">{{ p.node.title }}</span>
                      @if (p.node.warnings.length) {
                        <y-icon name="alert" [size]="13" class="text-warning" />
                      }
                      <span class="share" [class]="heat(p.node.share)"
                        >{{ p.node.share * 100 | number: '1.0-0' }}%</span
                      >
                    </div>
                    <div class="truncate font-mono text-[11px] text-faint">{{ p.node.detail ?? ' ' }}</div>
                    <div class="flex items-center gap-2 text-[11.5px] text-muted">
                      @if (p.node.neverExecuted) {
                        <span>never executed</span>
                      } @else if (plan.analyze) {
                        <span class="text-fg">{{ fmtMs(p.node.exclusiveMs ?? 0) }}</span>
                        <span>{{ fmtRows(p.node.actualRows ?? 0) }} rows</span>
                        @if (p.node.misestimate != null && factor(p.node.misestimate) >= 10) {
                          <span class="text-warning">est {{ fmtRows(p.node.planRows) }}</span>
                        }
                        @if (p.node.loops > 1) {
                          <span>× {{ p.node.loops | number }}</span>
                        }
                      } @else {
                        <span class="text-fg">cost {{ p.node.exclusiveCost | number: '1.0-0' }}</span>
                        <span>{{ fmtRows(p.node.planRows) }} rows</span>
                      }
                    </div>
                    <div class="bar">
                      <span [class]="heat(p.node.share)" [style.width.%]="p.node.share * 100"></span>
                    </div>
                  </button>
                }
              </div>
            }
          </div>

          <!-- Details -->
          @if (aside() === 'indexes') {
            <aside class="flex w-[380px] shrink-0 flex-col border-l border-line bg-raised">
              <ng-container *ngTemplateOutlet="asideTabs" />
              <div class="min-h-0 flex-1 overflow-auto p-2">
                @switch (advice().state) {
                  @case ('loading') {
                    <p class="p-2 text-[12px] text-faint">Re-planning with candidate indexes…</p>
                  }
                  @case ('error') {
                    <p class="p-2 text-[12px] text-danger">{{ advice().error }}</p>
                  }
                  @default {
                    @if (advice().data; as a) {
                      <y-index-suggestions
                        [suggestions]="a.suggestions"
                        [hypopg]="a.hypopg"
                        (insert)="insertSql.emit($event)"
                      />
                      @for (n of a.notes; track $index) {
                        <p class="mt-2 px-1 text-[11.5px] text-muted">{{ n }}</p>
                      }
                    }
                  }
                }
              </div>
            </aside>
          } @else if (selected(); as n) {
            <aside class="flex w-[320px] shrink-0 flex-col border-l border-line bg-raised">
              <ng-container *ngTemplateOutlet="asideTabs" />
              <div class="border-b border-line px-3 py-2">
                <div class="font-medium">{{ n.title }}</div>
                @if (n.relationship) {
                  <div class="text-[11.5px] text-faint">{{ n.relationship }} input</div>
                }
              </div>
              <div class="min-h-0 flex-1 overflow-auto px-3 py-2 text-[12px] select-text">
                @for (w of n.warnings; track $index) {
                  <p class="mb-2 rounded bg-warning-bg px-2 py-1.5 text-warning">{{ w }}</p>
                }
                <dl class="props">
                  @if (plan.analyze && !n.neverExecuted) {
                    <dt>Own time</dt>
                    <dd>{{ fmtMs(n.exclusiveMs ?? 0) }} ({{ n.share * 100 | number: '1.0-1' }}%)</dd>
                    <dt>Including children</dt>
                    <dd>{{ fmtMs(n.inclusiveMs ?? 0) }}</dd>
                    <dt>Rows</dt>
                    <dd>
                      {{ fmtRows(n.actualRows ?? 0) }} actual · {{ fmtRows(n.planRows) }} estimated
                      @if (n.misestimate != null) {
                        <span [class.text-warning]="factor(n.misestimate) >= 10"
                          >({{ fmtFactor(n.misestimate) }})</span
                        >
                      }
                    </dd>
                    @if (n.loops > 1) {
                      <dt>Loops</dt>
                      <dd>{{ n.loops | number }}</dd>
                    }
                    <dt>Buffers</dt>
                    <dd>
                      {{ n.buffers.hit | number }} hit · {{ n.buffers.read | number }} read
                      @if (n.buffers.temp) {
                        · {{ n.buffers.temp | number }} temp
                      }
                    </dd>
                  }
                  <dt>Cost</dt>
                  <dd>{{ n.exclusiveCost | number: '1.0-2' }} own · {{ n.cost | number: '1.0-2' }} total</dd>
                </dl>
                <div class="my-2 border-t border-line"></div>
                <dl class="props">
                  @for (kv of n.props; track kv[0]) {
                    @if (!skip(kv[0])) {
                      <dt>{{ kv[0] }}</dt>
                      <dd class="font-mono text-[11.5px]">{{ fmtValue(kv[1]) }}</dd>
                    }
                  }
                </dl>
              </div>
            </aside>
          }
        </div>
      }
    }

    <ng-template #asideTabs>
      @if (sql()) {
        <div class="flex border-b border-line p-1 text-[12px]" role="tablist">
          <button role="tab" class="tab" [class.tab-on]="aside() === 'node'" (click)="aside.set('node')">
            Node
          </button>
          <button
            role="tab"
            class="tab"
            [class.tab-on]="aside() === 'indexes'"
            (click)="aside.set('indexes')"
          >
            Indexes
            @if (usefulCount()) {
              <span class="ml-1 text-accent">{{ usefulCount() }}</span>
            }
          </button>
        </div>
      }
    </ng-template>
  `,
  styles: `
    .tab {
      flex: 1;
      padding: 3px 8px;
      border-radius: 4px;
      color: var(--fg-muted);
    }
    .tab-on {
      background: var(--bg-selected);
      color: var(--fg);
    }
    .canvas {
      background: var(--bg);
      cursor: grab;
    }
    .canvas:active {
      cursor: grabbing;
    }
    .edge {
      fill: none;
      stroke: var(--border-strong);
    }
    .card {
      position: absolute;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 2px;
      padding: 8px 10px 0;
      text-align: left;
      border-radius: 8px;
      border: 1px solid var(--border-strong);
      background: var(--bg-raised);
      color: var(--fg);
      font-size: 12.5px;
      cursor: pointer;
      overflow: hidden;
      box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
    }
    .card:hover {
      border-color: var(--fg-faint);
    }
    .card.selected {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    .card.idle {
      opacity: 0.55;
    }
    .share {
      font: 500 11px var(--font-mono);
      padding: 0 5px;
      border-radius: 3px;
    }
    .share.h-hot {
      background: var(--danger-bg);
      color: var(--danger);
    }
    .share.h-warm {
      background: var(--warning-bg);
      color: var(--warning);
    }
    .share.h-mild,
    .share.h-cold {
      color: var(--fg-muted);
    }
    .bar {
      height: 3px;
      margin: 0 -10px;
      background: var(--bg-sunken);
    }
    .bar > span {
      display: block;
      height: 100%;
    }
    .bar > .h-hot {
      background: var(--danger);
    }
    .bar > .h-warm {
      background: var(--warning);
    }
    .bar > .h-mild {
      background: var(--accent);
    }
    .bar > .h-cold {
      background: var(--fg-faint);
    }
    .hint {
      border-radius: 4px;
      padding: 0 4px;
    }
    .hint:hover {
      background: var(--bg-hover);
    }
    .props {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 3px 10px;
    }
    .props dt {
      color: var(--fg-muted);
    }
    .props dd {
      margin: 0;
      word-break: break-word;
    }
  `,
})
export class PlanView {
  readonly result = input.required<PlanResult>()
  /** For index suggestions: the explained statement and its connection (none → no suggestions). */
  readonly connectionId = input<string | null>(null)
  readonly sql = input<string | null>(null)
  readonly insertSql = output<string>()

  private readonly advisor = inject(AdvisorApi)
  protected readonly inspector = inject(CellInspector)
  protected readonly aside = signal<'node' | 'indexes'>('node')

  /** Asked again for every new plan (same SQL after CREATE INDEX should come back clean). */
  protected readonly advice = toSignal(
    toObservable(computed(() => ({ plan: this.result(), conn: this.connectionId(), sql: this.sql() }))).pipe(
      switchMap(({ conn, sql }) =>
        !conn || !sql?.trim()
          ? of<AdviceState>({ state: 'none' })
          : this.advisor.statement(conn, sql).pipe(
              map((data): AdviceState =>
                data.error ? { state: 'error', error: data.error } : { state: 'ok', data },
              ),
              catchError((e) =>
                of<AdviceState>({ state: 'error', error: e?.error?.error ?? 'Index advice failed' }),
              ),
              startWith<AdviceState>({ state: 'loading' }),
            ),
      ),
    ),
    { initialValue: { state: 'none' } as AdviceState },
  )
  protected readonly useful = computed(
    () => this.advice().data?.suggestions.filter((s) => s.used !== false) ?? [],
  )
  protected readonly usefulCount = computed(() => this.useful().length)
  protected readonly bestSuggestion = computed(() => this.useful()[0] ?? null)

  protected readonly cardW = CARD_W
  protected readonly cardH = CARD_H
  protected readonly factor = factor
  protected readonly copied = signal(false)
  private readonly canvas = viewChild<ElementRef<HTMLDivElement>>('canvas')

  protected readonly parsed = computed((): { plan: Plan | null; error: string | null } => {
    try {
      return { plan: parsePlan(this.result().json), error: null }
    } catch (e) {
      return { plan: null, error: e instanceof Error ? e.message : String(e) }
    }
  })

  protected readonly layout = computed(() => {
    const plan = this.parsed().plan
    return plan ? layoutPlan(plan.root) : null
  })

  /** Starts on the most expensive node — usually the first thing you want to look at. */
  protected readonly selected = linkedSignal<PlanNode | null>(
    () => this.parsed().plan?.slowest ?? this.parsed().plan?.root ?? null,
  )

  constructor() {
    // Centre the root horizontally on first paint.
    afterNextRender(() => {
      const el = this.canvas()?.nativeElement
      const l = this.layout()
      if (el && l) el.scrollLeft = Math.max(0, (l.width - el.clientWidth) / 2)
    })
  }

  protected path = edgePath
  protected fmtMs = ms
  protected fmtRows = rows

  protected fmtFactor(ratio: number) {
    const f = factor(ratio)
    return `${f >= 100 ? Math.round(f).toLocaleString() : f.toFixed(1)}× ${ratio >= 1 ? 'more' : 'fewer'}`
  }

  protected heat(share: number) {
    return share >= 0.5 ? 'h-hot' : share >= 0.2 ? 'h-warm' : share >= 0.05 ? 'h-mild' : 'h-cold'
  }

  protected selectNode(n: PlanNode) {
    this.selected.set(n)
    this.aside.set('node')
  }

  /** Properties shown above, or not useful on their own. */
  protected skip(key: string) {
    return (
      [
        'Node Type',
        'Actual Total Time',
        'Actual Startup Time',
        'Actual Rows',
        'Actual Loops',
        'Plan Rows',
        'Total Cost',
        'Startup Cost',
        'Parent Relationship',
        'Async Capable',
      ].includes(key) || /Blocks$/.test(key)
    )
  }

  protected fmtValue(v: unknown): string {
    if (Array.isArray(v)) return v.join(', ')
    if (v !== null && typeof v === 'object') return JSON.stringify(v)
    return String(v)
  }

  protected copyJson() {
    navigator.clipboard.writeText(this.result().json)
    this.copied.set(true)
    setTimeout(() => this.copied.set(false), 1200)
  }

  /** Drag the background to pan. */
  protected startPan(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('.card') || e.button !== 0) return
    const el = this.canvas()!.nativeElement
    el.setPointerCapture(e.pointerId)
    const sx = e.clientX
    const sy = e.clientY
    const left = el.scrollLeft
    const top = el.scrollTop
    const move = (ev: PointerEvent) => {
      el.scrollLeft = left - (ev.clientX - sx)
      el.scrollTop = top - (ev.clientY - sy)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
}
