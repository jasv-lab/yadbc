import { DialogRef } from '@angular/cdk/dialog'
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { Ai } from './ai'

/** Endpoint, key and model for the assistant. */
@Component({
  selector: 'y-ai-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block w-[460px] rounded-lg border border-line bg-raised shadow-xl' },
  template: `
    <div class="flex flex-col gap-3 p-5">
      <h2 class="text-[15px] font-medium">AI assistant</h2>
      <p class="text-[12px] text-muted">
        Any OpenAI-compatible endpoint — e.g. your LiteLLM. Requests go through yadbc's backend and carry your
        SQL, errors, plans and the schema (tables and columns), never result rows.
      </p>
      @if (team(); as t) {
        <div class="team">
          <div class="font-medium text-fg">Team settings{{ usingTeam() ? ' — in use' : '' }}</div>
          <div>
            {{ t.model }} at {{ t.endpoint }} · shared by {{ t.updatedBy }}
            {{ t.hasKey ? '· key included' : '· bring your own key' }}
          </div>
          @if (!usingTeam()) {
            <div class="text-faint">Your own endpoint below overrides them; clear it to use the team's.</div>
          }
        </div>
      }
      <label class="field">
        <span>Endpoint{{ team() ? ' (empty = the team’s)' : '' }}</span>
        <input
          [value]="endpoint()"
          (input)="endpoint.set(val($event))"
          [placeholder]="team()?.endpoint ?? 'https://llm.example.com'"
        />
      </label>
      <label class="field">
        <span>API key {{ hasKey() ? '· stored' : '' }}</span>
        <input
          type="password"
          autocomplete="off"
          [value]="key()"
          (input)="key.set(val($event))"
          [placeholder]="hasKey() ? 'Unchanged' : team()?.hasKey ? 'the team’s key' : 'sk-…'"
        />
        <span class="hint">
          Kept in Windows Credential Manager.
          @if (hasKey()) {
            <button class="link" (click)="clearKey.set(true); key.set('')">
              {{ clearKey() ? 'Will be removed' : 'Remove' }}
            </button>
          }
        </span>
      </label>
      <div class="grid grid-cols-[1fr_110px] gap-3">
        <label class="field">
          <span>Model</span>
          <input
            [value]="model()"
            (input)="model.set(val($event))"
            list="y-ai-models"
            [placeholder]="team()?.model ?? 'qwen3.6-27b'"
          />
          <datalist id="y-ai-models">
            @for (m of models(); track m) {
              <option [value]="m"></option>
            }
          </datalist>
        </label>
        <label class="field">
          <span>Max tokens</span>
          <input type="number" [value]="maxTokens()" (input)="maxTokens.set(+val($event))" />
        </label>
      </div>
      @if (status(); as s) {
        <p
          class="rounded-md px-3 py-2 text-[12px]"
          [class]="s.ok ? 'bg-sunken text-muted' : 'bg-danger-bg text-danger'"
        >
          {{ s.text }}
        </p>
      }
      <div class="mt-1 flex items-center gap-2">
        <button class="btn" (click)="test()" [disabled]="testing() || (!endpoint() && !team())">
          {{ testing() ? 'Testing…' : 'Test & list models' }}
        </button>
        <span class="flex-1"></span>
        <button class="btn" (click)="ref.close()">Cancel</button>
        <button class="btn btn-primary" (click)="save()" [disabled]="!canSave()">Save</button>
      </div>
      @if (canShare()) {
        <div class="team mt-1">
          <div class="font-medium text-fg">Share with the team (admin)</div>
          <div class="text-faint">
            Your saved endpoint and model become everyone's default after they sign in to the broker.
          </div>
          <label class="flex items-center gap-2">
            <input
              type="checkbox"
              class="!h-auto"
              [checked]="shareKey()"
              (change)="shareKey.set($any($event.target).checked)"
            />
            Include your key (otherwise everyone uses their own)
          </label>
          <div class="flex gap-2">
            <button class="btn" (click)="share()" [disabled]="sharing() || !ownSaved()">
              {{ team() ? 'Update the team settings' : 'Share with the team' }}
            </button>
            @if (team()) {
              <button class="btn" (click)="stopSharing()" [disabled]="sharing()">Stop sharing</button>
            }
          </div>
        </div>
      }
    </div>
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
    .team {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 10px;
      border-radius: 6px;
      background: var(--bg-sunken);
      font-size: 12px;
      color: var(--fg-muted);
    }
    .hint {
      font-size: 11.5px;
      color: var(--fg-faint) !important;
    }
    .link {
      margin-left: 6px;
      color: var(--accent);
    }
    input {
      height: 30px;
      padding: 0 8px;
      border-radius: 4px;
      border: 1px solid var(--border-strong);
      background: var(--bg);
      color: var(--fg);
      font: inherit;
    }
    input:focus {
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
export class AiSettingsDialog {
  protected readonly ref = inject(DialogRef)
  private readonly ai = inject(Ai)

  // The form edits your own settings; the team's (if any) show as hints and apply when yours are empty.
  private readonly own = this.ai.config()?.own
  protected readonly team = computed(() => this.ai.config()?.team ?? null)
  protected readonly canShare = computed(() => !!this.ai.config()?.canShare)
  protected readonly endpoint = signal(this.own?.endpoint ?? '')
  protected readonly model = signal(this.own?.model ?? '')
  protected readonly maxTokens = signal(this.own?.maxTokens ?? 8192)
  protected readonly hasKey = signal(this.own?.hasKey ?? false)
  protected readonly usingTeam = computed(() => !this.endpoint().trim() && !!this.team())
  /** Your own needs both; leaving both empty means "use the team's". */
  protected readonly canSave = computed(
    () => (!!this.endpoint() && !!this.model()) || (!this.endpoint() && !this.model() && !!this.team()),
  )
  protected readonly ownSaved = computed(
    () => !!this.ai.config()?.own.endpoint && !!this.ai.config()?.own.model,
  )
  protected readonly shareKey = signal(true)
  protected readonly sharing = signal(false)
  protected readonly key = signal('')
  protected readonly clearKey = signal(false)
  protected readonly models = signal<string[]>([])
  protected readonly testing = signal(false)
  protected readonly status = signal<{ ok: boolean; text: string } | null>(null)

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value
  }

  protected async test() {
    this.testing.set(true)
    this.status.set(null)
    const r = await this.ai.models(this.endpoint(), this.key() || null)
    this.testing.set(false)
    if (r.error) return this.status.set({ ok: false, text: r.error })
    this.models.set(r.models ?? [])
    this.status.set({ ok: true, text: `Connected · ${r.models?.length ?? 0} models` })
    if (!this.model() && r.models?.length) this.model.set(r.models[0])
  }

  protected async share() {
    this.sharing.set(true)
    try {
      await this.ai.share(this.shareKey())
      this.status.set({ ok: true, text: 'Shared with the team.' })
    } catch (e) {
      this.status.set({
        ok: false,
        text: (e as { error?: { error?: string } })?.error?.error ?? 'Could not share',
      })
    }
    this.sharing.set(false)
  }

  protected async stopSharing() {
    this.sharing.set(true)
    await this.ai.stopSharing().catch(() => undefined)
    this.sharing.set(false)
    this.status.set({ ok: true, text: 'The team settings are no longer shared.' })
  }

  protected async save() {
    await this.ai.saveConfig({
      endpoint: this.endpoint(),
      model: this.model(),
      maxTokens: this.maxTokens(),
      key: this.clearKey() ? '' : this.key() || null,
    })
    this.ref.close()
  }
}
