import { DialogRef } from '@angular/cdk/dialog'
import { HttpClient } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { Connections } from '../connections/connections'
import { Icon } from '../ui/icon'

interface McpStatus {
  enabled: boolean
  listening: boolean
  port: number
  url: string
  token: string
  command: string
}

/** Switch the MCP server on/off and get the one-line `claude mcp add` command. */
@Component({
  selector: 'y-mcp-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'block w-[560px] max-w-[92vw] rounded-lg border border-line bg-raised p-5 shadow-xl' },
  template: `
    <div class="flex items-center gap-3">
      <h2 class="flex-1 text-[15px] font-medium">MCP server for Claude</h2>
      @if (status(); as s) {
        <label class="flex items-center gap-2 text-[13px]">
          <input type="checkbox" [checked]="s.enabled" (change)="setEnabled($any($event.target).checked)" />
          {{ s.enabled ? 'On' : 'Off' }}
        </label>
      }
    </div>
    <p class="mt-2 text-[12.5px] text-muted">
      Lets Claude Code (or any MCP client) list your connections, read schemas, run read-only queries, explain
      them and look at activity — while yadbc is running. Queries run in read-only transactions that are
      always rolled back, and every one is recorded in History.
    </p>

    @if (status(); as s) {
      @if (!s.listening) {
        <p class="mt-3 rounded bg-warning-bg px-3 py-2 text-[12.5px] text-warning">
          Port {{ s.port }} was taken when yadbc started (another yadbc window?), so MCP isn't available in
          this one.
        </p>
      }

      <div class="mt-4 text-[12px] text-muted">Add it to Claude Code (once — the token is kept):</div>
      <div class="mt-1 flex items-start gap-2 rounded border border-line bg-sunken p-2">
        <code class="min-w-0 flex-1 font-mono text-[11.5px] break-all select-text">{{
          revealed() ? s.command : masked()
        }}</code>
        <button
          class="icon-btn"
          [title]="revealed() ? 'Hide token' : 'Show token'"
          (click)="revealed.set(!revealed())"
        >
          <y-icon [name]="revealed() ? 'lock' : 'unlock'" [size]="13" />
        </button>
        <button class="icon-btn" title="Copy command" (click)="copy(s.command)">
          <y-icon [name]="copied() ? 'check' : 'copy'" [size]="13" />
        </button>
      </div>

      <div class="mt-4 text-[12px] text-muted">Connections Claude may use</div>
      <div class="mt-1 flex flex-wrap gap-1.5">
        @for (c of connections.list(); track c.id) {
          <span
            class="rounded px-2 py-0.5 text-[12px]"
            [class]="allowed(c) ? 'bg-selected text-fg' : 'bg-sunken text-faint line-through'"
          >
            {{ c.name }}
          </span>
        } @empty {
          <span class="text-[12px] text-faint">No connections yet.</span>
        }
      </div>
      <p class="mt-1 text-[11.5px] text-faint">
        Change it per connection (Edit connection → Allow Claude). Prod is off unless you switch it on.
      </p>

      <p class="mt-4 text-[11.5px] text-faint">
        Data Claude reads can contain text written by anyone (a row saying "ignore previous instructions…").
        The tools tell it to treat results as data, and they can't write — but keep sensitive databases
        switched off.
      </p>

      <div class="mt-5 flex items-center gap-2">
        <button class="btn" (click)="regenerate()" title="Clients using the old token stop working">
          New token
        </button>
        <span class="flex-1"></span>
        <button class="btn btn-primary" (click)="ref.close()">Done</button>
      </div>
    } @else {
      <p class="mt-4 text-[12px] text-faint">Loading…</p>
    }
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
    /* Outranks .btn:hover, which would swap the accent for the hover tint under dark text. */
    .btn-primary:hover {
      background: var(--accent);
      filter: brightness(1.08);
    }
  `,
})
export class McpDialog {
  protected readonly ref = inject<DialogRef<void>>(DialogRef)
  protected readonly connections = inject(Connections)
  private readonly http = inject(HttpClient)

  protected readonly status = signal<McpStatus | null>(null)
  protected readonly revealed = signal(false)
  protected readonly copied = signal(false)
  protected readonly masked = computed(() => {
    const s = this.status()
    return s ? s.command.replace(s.token, s.token.slice(0, 10) + '…') : ''
  })

  constructor() {
    this.http.get<McpStatus>('/api/mcp').subscribe((s) => this.status.set(s))
  }

  protected allowed(c: { env: string; mcp?: boolean | null }) {
    return c.mcp ?? c.env !== 'prod'
  }

  protected setEnabled(enabled: boolean) {
    this.http.put<McpStatus>('/api/mcp', { enabled }).subscribe((s) => this.status.set(s))
  }

  protected regenerate() {
    this.http.post<McpStatus>('/api/mcp/token', {}).subscribe((s) => this.status.set(s))
  }

  protected copy(text: string) {
    navigator.clipboard.writeText(text)
    this.copied.set(true)
    setTimeout(() => this.copied.set(false), 1200)
  }
}
