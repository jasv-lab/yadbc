import { Dialog } from '@angular/cdk/dialog'
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core'
import { Icon } from '../ui/icon'
import { EditorTab, Workspace } from '../workspace/workspace'
import { Ai, AiMessage, Anchor } from './ai'
import { AiSettingsDialog } from './ai-settings'
import { parseMarkdown } from './markdown'
import { planText } from './plan-text'

interface QuickAction {
  label: string
  prompt: string
}

/**
 * The drawer's AI view: what context goes along (the statement, its error, its plan — toggleable),
 * quick actions for that context, the conversation, and SQL blocks you can copy, insert or put in place
 * of the statement. Nothing an answer contains is ever run by itself.
 */
@Component({
  selector: 'y-ai-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    @if (ai.config(); as cfg) {
      @if (!cfg.endpoint || !cfg.model) {
        <div class="p-4 text-[12.5px] text-muted">
          <p>
            Connect an OpenAI-compatible endpoint — your LiteLLM, for instance — to ask about queries, errors
            and plans.
          </p>
          <button class="run-btn mt-3" (click)="openSettings()">Set up</button>
        </div>
      } @else {
        <div class="flex items-center gap-1.5 border-b border-line px-3 py-1.5 text-[11.5px]">
          @if (context(); as c) {
            <span class="text-faint">Sends</span>
            @if (c.sql) {
              <button class="ctx" [class.off]="!useSql()" (click)="useSql.set(!useSql())" [title]="c.sql">
                query
              </button>
            }
            @if (c.error) {
              <button
                class="ctx"
                [class.off]="!useError()"
                (click)="useError.set(!useError())"
                [title]="c.error"
              >
                error
              </button>
            }
            @if (c.plan) {
              <button class="ctx" [class.off]="!usePlan()" (click)="usePlan.set(!usePlan())">plan</button>
            }
            <span class="ctx static" title="Tables and columns the question touches — never rows"
              >schema</span
            >
          } @else {
            <span class="text-faint">Open a query tab to ask about it</span>
          }
          <span class="flex-1"></span>
          <span class="truncate text-faint" [title]="cfg.endpoint ?? ''">{{ cfg.model }}</span>
          <button class="icon-btn" title="New chat" (click)="ai.newChat()">
            <y-icon name="plus" [size]="13" />
          </button>
          <button class="icon-btn" title="AI settings" (click)="openSettings()">
            <y-icon name="edit" [size]="13" />
          </button>
        </div>

        <div #scroller class="min-h-0 flex-1 overflow-auto px-3 py-2">
          @if (!ai.messages().length) {
            <div class="flex flex-wrap gap-1.5 py-2">
              @for (q of quick(); track q.label) {
                <button class="quick" (click)="send(q.prompt)">{{ q.label }}</button>
              }
            </div>
            <p class="mt-2 text-[11.5px] text-faint">
              Or ask anything — "write a query that…", "why is this slow", "what does this column mean".
            </p>
          }
          @for (m of ai.messages(); track $index) {
            @if (m.role === 'user') {
              <div class="user">{{ m.content }}</div>
            } @else {
              <div class="answer">
                @if (m.reasoning) {
                  <details class="thinking" [open]="m.streaming && !m.content">
                    <summary>{{ m.streaming && !m.content ? 'Thinking…' : 'Thought it through' }}</summary>
                    <div class="whitespace-pre-wrap">{{ m.reasoning }}</div>
                  </details>
                } @else if (m.streaming && !m.content) {
                  <p class="text-faint">…</p>
                }
                @for (b of blocks(m); track $index) {
                  @switch (b.t) {
                    @case ('h') {
                      <p class="h">
                        @for (s of b.inl; track $index) {
                          <span [class]="s.t">{{ s.v }}</span>
                        }
                      </p>
                    }
                    @case ('p') {
                      <p>
                        @for (s of b.inl; track $index) {
                          <span [class]="s.t">{{ s.v }}</span>
                        }
                      </p>
                    }
                    @case ('list') {
                      <ul [class.ol]="b.ordered">
                        @for (item of b.items; track $index) {
                          <li>
                            @for (s of item; track $index) {
                              <span [class]="s.t">{{ s.v }}</span>
                            }
                          </li>
                        }
                      </ul>
                    }
                    @case ('code') {
                      <div class="code">
                        <pre>{{ b.v }}</pre>
                        @if (
                          !b.open &&
                          (b.lang === 'sql' || b.lang === '' || b.lang === 'pgsql' || b.lang === 'postgresql')
                        ) {
                          <div class="code-actions">
                            <button (click)="copy(b.v)">Copy</button>
                            <button (click)="insert(b.v)" title="Add under your SQL, selected">Insert</button>
                            @if (m.anchor) {
                              <button
                                (click)="replace(m.anchor, b.v)"
                                title="Put it in place of the statement you asked about"
                              >
                                Replace
                              </button>
                            }
                          </div>
                        }
                      </div>
                    }
                  }
                }
                @if (m.error) {
                  <p class="text-danger">{{ m.error }}</p>
                }
              </div>
            }
          }
        </div>

        <div class="border-t border-line p-2">
          <div class="flex items-end gap-1.5">
            <textarea
              #input
              rows="2"
              placeholder="Ask about this query, or describe one to write…"
              [value]="draft()"
              (input)="draft.set($any($event.target).value)"
              (keydown)="onKey($event)"
            ></textarea>
            @if (ai.busy()) {
              <button class="run-btn" (click)="ai.stop()">Stop</button>
            } @else {
              <button class="run-btn" [disabled]="!draft().trim()" (click)="send(draft())">Ask</button>
            }
          </div>
        </div>
      }
    } @else {
      <p class="p-4 text-[12px] text-faint">Loading…</p>
    }
  `,
  styles: `
    .ctx {
      padding: 0 7px;
      border-radius: 9px;
      border: 1px solid var(--accent);
      color: var(--fg);
      background: var(--bg-selected);
    }
    .ctx.off {
      border-color: var(--border);
      background: none;
      color: var(--fg-faint);
      text-decoration: line-through;
    }
    .ctx.static {
      border-color: var(--border);
      background: none;
      color: var(--fg-muted);
    }
    .quick {
      padding: 4px 10px;
      border-radius: 14px;
      border: 1px solid var(--border-strong);
      font-size: 12px;
    }
    .quick:hover {
      border-color: var(--accent);
      background: var(--bg-selected);
    }
    .user {
      margin: 10px 0 6px auto;
      max-width: 85%;
      width: fit-content;
      padding: 6px 10px;
      border-radius: 10px 10px 2px 10px;
      background: var(--bg-selected);
      font-size: 12.5px;
      white-space: pre-wrap;
      user-select: text;
    }
    .answer {
      font-size: 12.5px;
      line-height: 1.5;
      user-select: text;
    }
    .answer p {
      margin: 6px 0;
    }
    .answer .h {
      font-weight: 600;
      margin-top: 10px;
    }
    .answer ul {
      margin: 4px 0 6px 18px;
      list-style: disc;
    }
    .answer ul.ol {
      list-style: decimal;
    }
    .answer .code {
      font-family: var(--font-mono);
      font-size: 11.5px;
      padding: 0 4px;
      border-radius: 3px;
      background: var(--bg-sunken);
    }
    .answer .bold {
      font-weight: 600;
    }
    .answer div.code {
      margin: 8px 0;
      padding: 0;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--bg-sunken);
    }
    .answer pre {
      margin: 0;
      padding: 8px 10px;
      overflow: auto;
      font: 12px/1.45 var(--font-mono);
      white-space: pre;
    }
    .code-actions {
      display: flex;
      gap: 2px;
      justify-content: flex-end;
      padding: 2px 4px;
      border-top: 1px solid var(--border);
    }
    .code-actions button {
      padding: 1px 8px;
      border-radius: 4px;
      font-family: var(--font-sans);
      font-size: 11.5px;
      color: var(--fg-muted);
    }
    .code-actions button:hover {
      background: var(--bg-hover);
      color: var(--fg);
    }
    .thinking {
      margin: 4px 0;
      font-size: 11.5px;
      color: var(--fg-faint);
    }
    .thinking summary {
      cursor: pointer;
    }
    .thinking > div {
      max-height: 160px;
      overflow: auto;
      margin-top: 4px;
      padding-left: 8px;
      border-left: 2px solid var(--border);
    }
    textarea {
      flex: 1;
      min-height: 40px;
      max-height: 140px;
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid var(--border-strong);
      background: var(--bg);
      color: var(--fg);
      font: inherit;
      font-size: 12.5px;
      resize: vertical;
    }
    textarea:focus {
      outline: 2px solid var(--accent);
      outline-offset: -1px;
    }
  `,
})
export class AiPanel {
  protected readonly ai = inject(Ai)
  private readonly workspace = inject(Workspace)
  private readonly dialog = inject(Dialog)
  private readonly scroller = viewChild<ElementRef<HTMLDivElement>>('scroller')

  protected readonly draft = signal('')
  protected readonly useSql = signal(true)
  protected readonly useError = signal(true)
  protected readonly usePlan = signal(true)

  /** The editor tab the conversation is about: the active one, else the last editor tab. */
  private readonly tab = computed<EditorTab | null>(
    () => this.workspace.activeTab() ?? this.workspace.editorTabs().at(-1) ?? null,
  )

  /** The statement under the cursor (or selected), its tab's last error and plan. */
  protected readonly context = computed(() => {
    const tab = this.tab()
    if (!tab) return null
    tab.text() // re-read when the SQL changes…
    this.workspace.cursor() // …or the cursor moves to another statement
    const statement = this.workspace.currentStatement?.() ?? null
    const err = tab.error()
    const error = err
      ? [
          err.messageText,
          err.sqlState ? `(SQLSTATE ${err.sqlState})` : '',
          err.detail ? `Detail: ${err.detail}` : '',
          err.hint ? `Hint: ${err.hint}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : null
    const plan = tab.plan()
    return {
      tab,
      sql: statement?.sql ?? null,
      anchor: statement ? ({ tabId: tab.id, offset: statement.offset, sql: statement.sql } as Anchor) : null,
      error,
      plan: plan ? planText(plan.json) : null,
    }
  })

  protected readonly quick = computed<QuickAction[]>(() => {
    const c = this.context()
    const out: QuickAction[] = []
    if (c?.error) {
      out.push({ label: 'Explain this error', prompt: 'Explain this error and what causes it here.' })
      out.push({ label: 'Fix the query', prompt: 'Fix the statement so it runs. Give the corrected SQL.' })
    }
    if (c?.plan)
      out.push({
        label: 'Explain the plan',
        prompt: 'Explain this execution plan: where does the time go, and why?',
      })
    if (c?.sql) {
      out.push({
        label: 'Make it faster',
        prompt: 'How can this statement run faster here? Be specific: indexes, rewrites, statistics.',
      })
      out.push({ label: 'Explain the query', prompt: 'Explain what this statement does, step by step.' })
    }
    out.push({ label: 'Write a query…', prompt: '' })
    return out
  })

  constructor() {
    this.ai.loadConfig().catch(() => undefined)
    // Follow the answer as it streams in.
    afterRenderEffect(() => {
      this.ai.messages()
      const el = this.scroller()?.nativeElement
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
    })
  }

  private readonly blockCache = new WeakMap<AiMessage, ReturnType<typeof parseMarkdown>>()
  protected blocks(m: AiMessage) {
    let b = this.blockCache.get(m)
    if (!b) {
      b = parseMarkdown(m.content)
      this.blockCache.set(m, b)
    }
    return b
  }

  protected send(prompt: string) {
    const text = prompt.trim()
    const c = this.context()
    if (!text) {
      // "Write a query…": focus the box with a starter.
      this.draft.set('Write a query that ')
      return
    }
    if (!c) return
    this.draft.set('')
    this.ai.ask(text, {
      connectionId: c.tab.connection.id,
      sql: this.useSql() ? c.sql : null,
      error: this.useError() ? c.error : null,
      plan: this.usePlan() ? c.plan : null,
      anchor: this.useSql() ? c.anchor : null,
    })
  }

  protected onKey(e: KeyboardEvent) {
    e.stopPropagation()
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!this.ai.busy()) this.send(this.draft())
    }
  }

  protected copy(sql: string) {
    navigator.clipboard.writeText(sql)
  }

  protected insert(sql: string) {
    const tab = this.tab()
    if (tab) this.workspace.insertIntoEditor(tab, withSemicolon(sql))
  }

  protected async replace(anchor: Anchor, sql: string) {
    const tab = this.workspace.editorTabs().find((t) => t.id === anchor.tabId)
    if (!tab) return
    const done = await this.workspace.replaceInEditor(
      tab,
      anchor.offset,
      anchor.sql,
      sql.trim().replace(/;\s*$/, ''),
    )
    if (!done) this.workspace.insertIntoEditor(tab, withSemicolon(sql))
  }

  protected openSettings() {
    this.dialog.open(AiSettingsDialog)
  }
}

function withSemicolon(sql: string) {
  const s = sql.trim()
  return s.endsWith(';') ? s : s + ';'
}
