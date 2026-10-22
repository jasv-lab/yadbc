import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog'
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import {
  AbstractControl,
  NonNullableFormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms'
import {
  catchError,
  debounceTime,
  distinctUntilChanged,
  filter,
  map,
  Observable,
  of,
  startWith,
  switchMap,
  take,
} from 'rxjs'
import { ConnectionEnv, ConnectionInput, ConnectionProfile, TunnelConfig, TunnelKind } from '../core/protocol'
import { Connections, KubeList, KubeScope, TestResult } from './connections'

const ENVS: { value: ConnectionEnv; label: string; dot: string }[] = [
  { value: 'local', label: 'Local', dot: 'bg-env-local' },
  { value: 'dev', label: 'Dev', dot: 'bg-env-dev' },
  { value: 'prod', label: 'Prod', dot: 'bg-env-prod' },
]

const ROUTES: { value: TunnelKind | ''; label: string }[] = [
  { value: '', label: 'Direct' },
  { value: 'ssh', label: 'SSH tunnel' },
  { value: 'kubernetes', label: 'Kubernetes' },
]

const NONE: KubeList = { items: [], error: null }

/** Host is required unless kubectl picks the target; each tunnel kind has its one must-have field. */
function routeValid(g: AbstractControl): ValidationErrors | null {
  const v = g.getRawValue()
  const t = v.tunnel
  if (t.kind !== 'kubernetes' && !v.host?.trim()) return { host: true }
  if (t.kind === 'ssh' && !t.sshHost?.trim()) return { sshHost: true }
  if (t.kind === 'kubernetes' && !t.kubeTarget?.trim()) return { kubeTarget: true }
  return null
}

@Component({
  selector: 'y-connection-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  host: { class: 'block w-[440px] rounded-lg border border-line bg-raised shadow-xl' },
  template: `
    <form [formGroup]="form" (ngSubmit)="save()" class="flex max-h-[90vh] flex-col gap-3 overflow-y-auto p-5">
      <h2 class="text-[15px] font-medium">{{ existing ? 'Edit connection' : 'New connection' }}</h2>

      @if (shared; as s) {
        <p class="shared-note" [class.warn]="s.orphaned">
          @if (s.orphaned) {
            No longer shared — it was removed from the broker. Keep it as a local connection (connection menu)
            or uninstall it.
          } @else if (s.canEdit) {
            Shared by {{ s.owners.join(', ') }}. Your changes here reach everyone who installed it.
          } @else {
            Shared by {{ s.owners.join(', ') }}. The connection details come from the share; your own settings
            ({{
              kind() === 'ssh'
                ? 'SSH user and key, '
                : kind() === 'kubernetes'
                  ? 'kubeconfig and context, '
                  : ''
            }}{{ s.loginMode === 'own' ? 'your login, ' : '' }}Claude access) stay yours.
          }
        </p>
        @if (existing?.needsLogin) {
          <p class="shared-note">Everyone uses their own login here: enter yours to connect.</p>
        }
      }

      <label class="field">
        <span>Name</span>
        <input formControlName="name" placeholder="billing-dev" autofocus />
      </label>

      <div class="field">
        <span>Connect</span>
        <div class="seg-group" role="radiogroup">
          @for (r of routes; track r.value) {
            <button
              type="button"
              role="radio"
              class="seg"
              [attr.aria-checked]="kind() === r.value"
              [class.seg-on]="kind() === r.value"
              [disabled]="tunnel.controls.kind.disabled"
              (click)="tunnel.controls.kind.setValue(r.value)"
            >
              {{ r.label }}
            </button>
          }
        </div>
      </div>

      @if (kind() === 'ssh') {
        <div class="tunnel-box" formGroupName="tunnel">
          <div class="grid grid-cols-[1fr_96px] gap-3">
            <label class="field">
              <span>SSH server</span>
              <input formControlName="sshHost" placeholder="bastion or ~/.ssh/config alias" />
            </label>
            <label class="field">
              <span>SSH port</span><input formControlName="sshPort" type="number" placeholder="22" />
            </label>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <label class="field">
              <span>SSH user</span><input formControlName="sshUser" placeholder="from ssh config" />
            </label>
            <label class="field">
              <span>Key file</span
              ><input formControlName="sshIdentityFile" placeholder="agent / ssh config" />
            </label>
          </div>
          <p class="hint">
            Runs your OpenSSH, so the SSH agent (1Password) and ~/.ssh/config apply. The host key must already
            be trusted: connect once in a terminal.
          </p>
        </div>
      }

      @if (kind() === 'kubernetes') {
        <div class="tunnel-box" formGroupName="tunnel">
          <label class="field">
            <span>Kubeconfig</span>
            <input
              formControlName="kubeconfig"
              list="y-kubeconfigs"
              placeholder="default (KUBECONFIG / ~/.kube/config)"
            />
            <datalist id="y-kubeconfigs">
              @for (f of kubeConfigs(); track f) {
                <option [value]="f"></option>
              }
            </datalist>
          </label>
          <div class="grid grid-cols-2 gap-3">
            <label class="field">
              <span>Context</span>
              <input formControlName="kubeContext" list="y-kubecontexts" placeholder="current" />
              <datalist id="y-kubecontexts">
                @for (c of contexts().items; track c) {
                  <option [value]="c"></option>
                }
              </datalist>
            </label>
            <label class="field">
              <span>Namespace</span>
              <input formControlName="kubeNamespace" list="y-kubenamespaces" placeholder="default" />
              <datalist id="y-kubenamespaces">
                @for (n of namespaces().items; track n) {
                  <option [value]="n"></option>
                }
              </datalist>
            </label>
          </div>
          @if (kubeError(); as err) {
            <p class="hint text-danger">{{ err }}</p>
          } @else {
            <p class="hint">Runs <code>kubectl port-forward</code> with your kubeconfig and RBAC.</p>
          }
        </div>
      }

      <div class="grid grid-cols-[1fr_96px] gap-3">
        @if (kind() === 'kubernetes') {
          <label class="field" [formGroup]="tunnel">
            <span>Target</span>
            <input formControlName="kubeTarget" list="y-kubetargets" placeholder="svc/postgres" />
            <datalist id="y-kubetargets">
              @for (t of services().items; track t) {
                <option [value]="t"></option>
              }
            </datalist>
          </label>
          <label class="field"
            ><span>Port on target</span><input formControlName="port" type="number"
          /></label>
        } @else {
          <label class="field">
            <span>{{ kind() === 'ssh' ? 'Host, as the SSH server sees it' : 'Host' }}</span>
            <input formControlName="host" [placeholder]="kind() === 'ssh' ? 'db.internal' : 'localhost'" />
          </label>
          <label class="field"><span>Port</span><input formControlName="port" type="number" /></label>
        }
      </div>
      <label class="field"
        ><span>Database</span><input formControlName="database" placeholder="postgres"
      /></label>
      <div class="grid grid-cols-2 gap-3">
        <label class="field"><span>User</span><input formControlName="username" /></label>
        <label class="field">
          <span>Password</span>
          <input
            formControlName="password"
            type="password"
            [placeholder]="existing?.needsLogin ? 'Your password' : existing ? 'Unchanged' : ''"
            autocomplete="off"
          />
        </label>
      </div>

      <div class="field">
        <span>Environment</span>
        <div class="flex gap-1 rounded-md border border-line bg-sunken p-0.5" role="radiogroup">
          @for (env of envs; track env.value) {
            <button
              type="button"
              role="radio"
              [attr.aria-checked]="form.controls.env.value === env.value"
              class="flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-muted"
              [class.bg-selected]="form.controls.env.value === env.value"
              [class.text-fg]="form.controls.env.value === env.value"
              [disabled]="form.controls.env.disabled"
              (click)="form.controls.env.setValue(env.value)"
            >
              <span class="size-1.5 rounded-full" [class]="env.dot"></span>{{ env.label }}
            </button>
          }
        </div>
        @if (form.controls.env.value === 'prod') {
          <p class="text-[12px] text-muted">
            Prod sessions start read-only. Unlock per tab when you need to write.
          </p>
        }
      </div>

      <label class="flex items-start gap-2 text-[12.5px]" [class.opacity-60]="mcpRuledOut">
        <input
          type="checkbox"
          class="mt-0.5"
          [checked]="mcpAllowed() && !mcpRuledOut"
          [disabled]="mcpRuledOut"
          (change)="mcp.set($any($event.target).checked)"
        />
        <span>
          Allow Claude (MCP) to read this database
          <span class="block text-[11.5px] text-faint">
            Read-only queries through yadbc's MCP server, when it's switched on.
            {{
              mcpRuledOut
                ? 'The owner of this shared connection doesn’t allow it.'
                : mcp() === null
                  ? 'Default for ' + form.controls.env.value + '.'
                  : ''
            }}
          </span>
        </span>
      </label>

      @if (testResult(); as t) {
        <p
          class="rounded-md px-3 py-2 text-[12px]"
          [class]="t.ok ? 'bg-sunken text-muted' : 'bg-danger-bg text-danger'"
        >
          {{
            t.ok
              ? 'Connected · PostgreSQL ' + t.serverVersion + (t.tunnel ? ' · through the tunnel' : '')
              : t.error
          }}
        </p>
      }

      <div class="mt-2 flex items-center gap-2">
        <button type="button" class="btn" (click)="test()" [disabled]="testing() || form.invalid">
          {{ testing() ? (kind() ? 'Opening tunnel…' : 'Testing…') : 'Test' }}
        </button>
        <span class="flex-1"></span>
        <button type="button" class="btn" (click)="ref.close()">Cancel</button>
        <button type="submit" class="btn btn-primary" [disabled]="form.invalid">Save</button>
      </div>
    </form>
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
    .seg-group {
      display: flex;
      gap: 4px;
      padding: 2px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg-sunken);
    }
    .seg {
      flex: 1;
      padding: 4px 8px;
      border-radius: 4px;
      color: var(--fg-muted);
    }
    .seg-on {
      background: var(--bg-selected);
      color: var(--fg);
    }
    .shared-note {
      padding: 8px 10px;
      border-radius: 6px;
      background: var(--bg-sunken);
      font-size: 12px;
      color: var(--fg-muted);
    }
    .shared-note.warn {
      color: var(--warning);
      background: var(--warning-bg);
    }
    input:disabled {
      opacity: 0.6;
    }
    .tunnel-box {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 10px 12px;
      border-left: 2px solid var(--accent);
      border-radius: 4px;
      background: var(--bg-sunken);
    }
    .hint {
      font-size: 11.5px;
      color: var(--fg-faint);
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
export class ConnectionDialog {
  protected readonly ref = inject<DialogRef<ConnectionProfile>>(DialogRef)
  private readonly connections = inject(Connections)
  protected readonly existing = inject<ConnectionProfile | null>(DIALOG_DATA, { optional: true })
  protected readonly envs = ENVS
  protected readonly routes = ROUTES
  protected readonly testing = signal(false)
  protected readonly testResult = signal<TestResult | null>(null)
  /** null = follow the environment's default until the user decides. */
  protected readonly mcp = signal<boolean | null>(this.existing?.mcp ?? null)

  private readonly fb = inject(NonNullableFormBuilder)
  private readonly t: TunnelConfig | null = this.existing?.tunnel ?? null

  protected readonly form = this.fb.group(
    {
      name: [this.existing?.name ?? '', Validators.required],
      host: [this.existing?.host ?? 'localhost'],
      port: [this.existing?.port ?? 5432, [Validators.required, Validators.min(1), Validators.max(65535)]],
      database: [this.existing?.database ?? 'postgres', Validators.required],
      username: [this.existing?.username ?? 'postgres', Validators.required],
      password: [''],
      env: [this.existing?.env ?? ('dev' as ConnectionEnv)],
      tunnel: this.fb.group({
        kind: [(this.t?.kind ?? '') as TunnelKind | ''],
        sshHost: [this.t?.sshHost ?? ''],
        sshUser: [this.t?.sshUser ?? ''],
        sshPort: [this.t?.sshPort ?? (null as number | null)],
        sshIdentityFile: [this.t?.sshIdentityFile ?? ''],
        kubeconfig: [this.t?.kubeconfig ?? ''],
        kubeContext: [this.t?.kubeContext ?? ''],
        kubeNamespace: [this.t?.kubeNamespace ?? ''],
        kubeTarget: [this.t?.kubeTarget ?? ''],
      }),
    },
    { validators: routeValid },
  )
  protected readonly tunnel = this.form.controls.tunnel
  protected readonly shared = this.existing?.shared ?? null
  protected readonly mcpRuledOut = this.shared?.mcpAllowed === false

  constructor() {
    // A share's details belong to its owners: others (and a share that's gone) keep only their own settings.
    const s = this.shared
    if (s && (!s.canEdit || s.orphaned)) {
      const c = this.form.controls
      for (const control of [c.name, c.host, c.port, c.database, c.env, this.tunnel.controls.kind])
        control.disable()
      for (const f of ['sshHost', 'sshPort', 'kubeNamespace', 'kubeTarget'] as const)
        this.tunnel.controls[f].disable()
      if (s.loginMode === 'included') {
        c.username.disable()
        c.password.disable()
      }
    }
  }

  private readonly tunnel$ = this.tunnel.valueChanges.pipe(
    startWith(null),
    map(() => this.tunnel.getRawValue()),
  )
  protected readonly kind = toSignal(this.tunnel$.pipe(map((t) => t.kind)), {
    initialValue: this.tunnel.controls.kind.value,
  })

  // Suggestions for the Kubernetes fields, each driven by the fields before it. The cluster lookups
  // (namespaces, services) wait for an explicit context, so opening the dialog never queries
  // whichever cluster happens to be kubectl's current one.
  private readonly kube$ = this.tunnel$.pipe(filter((t) => t.kind === 'kubernetes'))
  protected readonly kubeConfigs = toSignal(
    this.kube$.pipe(
      take(1),
      switchMap(() => this.connections.kubeConfigs().pipe(catchError(() => of([])))),
    ),
    { initialValue: [] as string[] },
  )
  protected readonly contexts = this.lookup('contexts', (t) => ({ kubeconfig: t.kubeconfig }))
  protected readonly namespaces = this.lookup('namespaces', (t) =>
    t.kubeContext ? { kubeconfig: t.kubeconfig, context: t.kubeContext } : null,
  )
  protected readonly services = this.lookup('services', (t) =>
    t.kubeContext && t.kubeNamespace
      ? { kubeconfig: t.kubeconfig, context: t.kubeContext, ns: t.kubeNamespace }
      : null,
  )
  protected readonly kubeError = computed(
    () => this.contexts().error ?? this.namespaces().error ?? this.services().error,
  )

  private readonly env = toSignal(this.form.controls.env.valueChanges, {
    initialValue: this.form.controls.env.value,
  })
  protected readonly mcpAllowed = computed(() => this.mcp() ?? this.env() !== 'prod')

  private lookup(what: 'contexts' | 'namespaces' | 'services', scope: (t: TunnelValue) => KubeScope | null) {
    const list$: Observable<KubeList> = this.kube$.pipe(
      map(scope),
      distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      debounceTime(350),
      switchMap((s) =>
        s
          ? this.connections
              .kube(what, s)
              .pipe(catchError(() => of({ items: [], error: `Couldn't list ${what}` })))
          : of(NONE),
      ),
    )
    return toSignal(list$, { initialValue: NONE })
  }

  private input(): ConnectionInput {
    const { tunnel, ...v } = this.form.getRawValue()
    return { ...v, password: v.password || null, mcp: this.mcp(), tunnel: tunnelConfig(tunnel) }
  }

  protected test() {
    this.testing.set(true)
    this.testResult.set(null)
    this.connections.test(this.input(), this.existing?.id).subscribe({
      next: (r) => this.testResult.set(r),
      error: () => this.testResult.set({ ok: false, error: 'Test request failed' }),
      complete: () => this.testing.set(false),
    })
  }

  protected save() {
    if (this.form.invalid) return
    this.connections.save(this.input(), this.existing?.id).subscribe((saved) => this.ref.close(saved))
  }
}

interface TunnelValue {
  kind: TunnelKind | ''
  sshHost: string
  sshUser: string
  sshPort: number | null
  sshIdentityFile: string
  kubeconfig: string
  kubeContext: string
  kubeNamespace: string
  kubeTarget: string
}

/** Only the chosen kind's fields; blanks become null so ssh / kubectl use their own defaults. */
function tunnelConfig(t: TunnelValue): TunnelConfig | null {
  const s = (x: string) => x.trim() || null
  if (t.kind === 'ssh')
    return {
      kind: 'ssh',
      sshHost: s(t.sshHost),
      sshUser: s(t.sshUser),
      sshPort: t.sshPort || null,
      sshIdentityFile: s(t.sshIdentityFile),
    }
  if (t.kind === 'kubernetes')
    return {
      kind: 'kubernetes',
      kubeconfig: s(t.kubeconfig),
      kubeContext: s(t.kubeContext),
      kubeNamespace: s(t.kubeNamespace),
      kubeTarget: s(t.kubeTarget),
    }
  return null
}
