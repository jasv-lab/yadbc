import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog'
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { catchError, map, of } from 'rxjs'
import { ConnectionProfile } from '../core/protocol'
import { Catalog, qualified } from '../schema/catalog'
import { createTableChange, diffTable, statements } from '../schema-model/diff'
import { SchemaChanges } from '../schema-model/schema-changes'
import { SnapTable } from '../schema-model/snapshot'
import { Icon } from '../ui/icon'
import { Workspace } from '../workspace/workspace'
import { EditModel, fromTable, newTable, NewConstraintKind, nextKey, problems, toTable } from './table-model'

export interface TableEditorData {
  connection: ConnectionProfile
  schema: string
  /** null: a new table in `schema` */
  table: string | null
}

const TYPES = [
  'bigint',
  'integer',
  'smallint',
  'numeric(12,2)',
  'double precision',
  'boolean',
  'text',
  'varchar(255)',
  'uuid',
  'date',
  'timestamptz',
  'timestamp',
  'interval',
  'jsonb',
  'bytea',
  'inet',
  'text[]',
]

/**
 * Change a table's structure (or create one) in a form, and see the SQL it takes as you go. The SQL
 * comes from the same diff as Compare schemas: the edit is the source, the live table the target.
 * Apply runs it in one transaction; prod goes through an editor tab, like every prod change.
 */
@Component({
  selector: 'y-table-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: {
    class: 'flex h-[86vh] w-[1180px] max-w-[96vw] flex-col rounded-lg border border-line bg-raised shadow-xl',
  },
  template: `
    @let m = model();
    <div class="flex items-center gap-2 border-b border-line px-4 py-2.5">
      <h2 class="text-[15px] font-medium">{{ data.table ? 'Edit table' : 'New table' }}</h2>
      <span class="size-2 rounded-full" [class]="envDot[data.connection.env]"></span>
      <span class="text-[12px] text-muted">{{ data.connection.name }}</span>
      <span class="flex-1"></span>
      <button
        class="grid size-6 place-items-center rounded text-muted hover:bg-hover"
        title="Close"
        (click)="ref.close()"
      >
        <y-icon name="x" [size]="14" />
      </button>
    </div>

    @if (loadError(); as e) {
      <p class="m-4 rounded bg-danger-bg px-3 py-2 text-[12.5px] text-danger">{{ e }}</p>
    } @else if (!m) {
      <p class="m-4 text-[12.5px] text-muted">Reading the table…</p>
    } @else {
      <div class="grid min-h-0 flex-1 grid-cols-[1fr_minmax(300px,32%)]">
        <div class="min-h-0 overflow-y-auto px-4 py-3">
          <div class="flex items-end gap-2">
            <label class="field w-[160px]">
              <span>Schema</span>
              <input [value]="m.schema" list="y-te-schemas" (input)="set(() => (m.schema = val($event)))" />
              <datalist id="y-te-schemas">
                @for (s of schemas(); track s) {
                  <option [value]="s"></option>
                }
              </datalist>
            </label>
            <label class="field flex-1">
              <span>Name</span>
              <input
                [value]="m.name"
                (input)="set(() => (m.name = val($event)))"
                placeholder="order_notes"
                autofocus
              />
            </label>
          </div>

          <h3 class="section">Columns</h3>
          <table class="grid-table">
            <colgroup>
              <col class="w-8" />
              <col class="w-[22%]" />
              <col class="w-[17%]" />
              <col class="w-14" />
              <col class="w-[17%]" />
              <col class="w-[104px]" />
              <col />
              <col class="w-7" />
            </colgroup>
            <thead>
              <tr>
                <th class="w-8" title="Primary key">PK</th>
                <th>Name</th>
                <th>Type</th>
                <th class="w-14" title="NOT NULL">Not null</th>
                <th>Default</th>
                <th class="w-28">Identity</th>
                <th>Comment</th>
                <th class="w-7"></th>
              </tr>
            </thead>
            <tbody>
              @for (c of m.columns; track c.key; let i = $index) {
                <tr [class.new-row]="!c.was">
                  <td class="text-center">
                    <input type="checkbox" [checked]="c.pk" (change)="set(() => (c.pk = checked($event)))" />
                  </td>
                  <td>
                    <input class="mono" [value]="c.name" (input)="set(() => (c.name = val($event)))" />
                    @if (c.was && c.was !== c.name) {
                      <span class="was">was {{ c.was }}</span>
                    }
                  </td>
                  <td>
                    @if (c.generated) {
                      <span
                        class="mono text-muted"
                        [title]="'GENERATED ALWAYS AS (' + c.generated + ') STORED'"
                        >{{ c.type }} (generated)</span
                      >
                    } @else {
                      <input
                        class="mono"
                        [value]="c.type"
                        list="y-te-types"
                        (input)="set(() => (c.type = val($event)))"
                      />
                    }
                  </td>
                  <td class="text-center">
                    <input
                      type="checkbox"
                      [checked]="c.notNull || c.pk"
                      [disabled]="c.pk || !!c.identity"
                      (change)="set(() => (c.notNull = checked($event)))"
                    />
                  </td>
                  <td>
                    <input
                      class="mono"
                      [value]="c.identity || c.generated ? '' : c.default"
                      [disabled]="!!c.identity || !!c.generated"
                      [placeholder]="c.identity ? 'identity' : ''"
                      (input)="set(() => (c.default = val($event)))"
                    />
                  </td>
                  <td>
                    <select
                      [value]="c.identity"
                      [disabled]="!!c.generated"
                      (change)="set(() => (c.identity = $any(val($event))))"
                    >
                      <option value="" [selected]="!c.identity">—</option>
                      <option value="a" [selected]="c.identity === 'a'">always</option>
                      <option value="d" [selected]="c.identity === 'd'">by default</option>
                    </select>
                  </td>
                  <td><input [value]="c.comment" (input)="set(() => (c.comment = val($event)))" /></td>
                  <td>
                    <button
                      class="x"
                      [title]="c.was ? 'Drop column ' + c.was + ' (its data goes with it)' : 'Remove'"
                      (click)="set(() => m.columns.splice(i, 1))"
                    >
                      <y-icon name="x" [size]="12" />
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
          <datalist id="y-te-types">
            @for (t of types; track t) {
              <option [value]="t"></option>
            }
          </datalist>
          <button class="add" (click)="addColumn()"><y-icon name="plus" [size]="12" /> Add column</button>

          <h3 class="section">Indexes</h3>
          @for (i of m.indexes; track i.name) {
            <div class="item" [class.removed]="i.removed">
              <span class="mono min-w-0 flex-1 truncate" [title]="i.definition">{{ i.definition }}</span>
              <button class="link" (click)="set(() => (i.removed = !i.removed))">
                {{ i.removed ? 'Keep' : 'Drop' }}
              </button>
            </div>
          }
          @for (i of m.newIndexes; track i.key; let n = $index) {
            <div class="item new-row">
              <input
                class="mono w-[200px]"
                [value]="i.name"
                placeholder="name (optional)"
                (input)="set(() => (i.name = val($event)))"
              />
              <input
                class="mono flex-1"
                [value]="i.columns"
                placeholder="columns: status, placed_at"
                (input)="set(() => (i.columns = val($event)))"
              />
              <label class="flex items-center gap-1 text-[12px]"
                ><input
                  type="checkbox"
                  [checked]="i.unique"
                  (change)="set(() => (i.unique = checked($event)))"
                />
                unique</label
              >
              <button class="x" (click)="set(() => m.newIndexes.splice(n, 1))">
                <y-icon name="x" [size]="12" />
              </button>
            </div>
          }
          <button class="add" (click)="addIndex()"><y-icon name="plus" [size]="12" /> Add index</button>

          <h3 class="section">Constraints</h3>
          @for (c of m.constraints; track c.name) {
            <div class="item" [class.removed]="c.removed">
              <span class="kind">{{ kindLabel[c.type] }}</span>
              <span class="mono w-[200px] truncate">{{ c.name }}</span>
              <span class="mono min-w-0 flex-1 truncate" [title]="c.definition">{{ c.definition }}</span>
              <button class="link" (click)="set(() => (c.removed = !c.removed))">
                {{ c.removed ? 'Keep' : 'Drop' }}
              </button>
            </div>
          }
          @for (c of m.newConstraints; track c.key; let n = $index) {
            <div class="item new-row flex-wrap">
              <select [value]="c.kind" (change)="set(() => (c.kind = $any(val($event))))">
                <option value="foreign" [selected]="c.kind === 'foreign'">foreign key</option>
                <option value="unique" [selected]="c.kind === 'unique'">unique</option>
                <option value="check" [selected]="c.kind === 'check'">check</option>
              </select>
              <input
                class="mono w-[170px]"
                [value]="c.name"
                placeholder="name (optional)"
                (input)="set(() => (c.name = val($event)))"
              />
              @if (c.kind === 'check') {
                <input
                  class="mono min-w-[200px] flex-1"
                  [value]="c.expression"
                  placeholder="total >= 0"
                  (input)="set(() => (c.expression = val($event)))"
                />
              } @else {
                <input
                  class="mono w-[150px]"
                  [value]="c.columns"
                  placeholder="columns"
                  (input)="set(() => (c.columns = val($event)))"
                />
                @if (c.kind === 'foreign') {
                  <span class="text-[12px] text-muted">→</span>
                  <input
                    class="mono w-[170px]"
                    [value]="c.refTable"
                    list="y-te-tables"
                    placeholder="shop.customers"
                    (input)="set(() => (c.refTable = val($event)))"
                  />
                  <input
                    class="mono w-[90px]"
                    [value]="c.refColumns"
                    placeholder="(its key)"
                    (input)="set(() => (c.refColumns = val($event)))"
                  />
                  <select
                    [value]="c.onDelete"
                    (change)="set(() => (c.onDelete = $any(val($event))))"
                    title="On delete"
                  >
                    @for (a of onDelete; track a) {
                      <option [value]="a" [selected]="c.onDelete === a">
                        on delete {{ a.toLowerCase() }}
                      </option>
                    }
                  </select>
                }
              }
              <button class="x" (click)="set(() => m.newConstraints.splice(n, 1))">
                <y-icon name="x" [size]="12" />
              </button>
            </div>
          }
          <datalist id="y-te-tables">
            @for (t of tables(); track t) {
              <option [value]="t"></option>
            }
          </datalist>
          <button class="add" (click)="addConstraint()">
            <y-icon name="plus" [size]="12" /> Add constraint
          </button>

          <h3 class="section">Comment</h3>
          <textarea
            rows="2"
            class="w-full"
            [value]="m.comment"
            (input)="set(() => (m.comment = val($event)))"
          ></textarea>
          @if (m.rest.triggers.length || m.rest.partitioned || m.rest.partitionOf) {
            <p class="mt-2 text-[11.5px] text-faint">
              Triggers and partitioning are kept as they are; change them in SQL.
            </p>
          }
        </div>

        <div class="flex min-h-0 flex-col border-l border-line bg-sunken">
          <div class="flex items-center gap-2 border-b border-line px-3 py-2 text-[12px]">
            <span class="font-medium">SQL</span>
            <span class="text-muted"
              >{{ script().length }} {{ script().length === 1 ? 'statement' : 'statements' }}</span
            >
            @if (destructive()) {
              <span class="text-danger">· drops data</span>
            }
          </div>
          @if (issues().length) {
            <ul class="border-b border-line px-3 py-2 text-[12px] text-danger">
              @for (p of issues(); track p) {
                <li>{{ p }}</li>
              }
            </ul>
          }
          <pre class="code min-h-0 flex-1">{{ scriptText() || '-- No changes yet.' }}</pre>
          @if (result(); as r) {
            <p class="border-t border-line px-3 py-2 text-[12px]" [class.text-danger]="!r.ok">{{ r.text }}</p>
          }
          <div class="flex flex-wrap justify-end gap-2 border-t border-line px-3 py-2">
            <button class="btn" (click)="ref.close()">Cancel</button>
            <button class="btn" [disabled]="!script().length || issues().length > 0" (click)="openInTab()">
              Open in new tab
            </button>
            <button
              class="btn btn-primary"
              [disabled]="
                !script().length || issues().length > 0 || data.connection.env === 'prod' || applying()
              "
              [title]="
                data.connection.env === 'prod'
                  ? 'Prod changes run from an editor tab (Open in new tab)'
                  : 'Run it in one transaction'
              "
              (click)="apply()"
            >
              {{ applying() ? 'Applying…' : 'Apply' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    .field {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .field > span {
      font-size: 12px;
      color: var(--fg-muted);
    }
    input:not([type='checkbox']),
    select,
    textarea {
      height: 26px;
      min-width: 0;
      padding: 0 6px;
      border-radius: 4px;
      border: 1px solid var(--border-strong);
      background: var(--bg);
      color: var(--fg);
      font-size: 12.5px;
    }
    textarea {
      height: auto;
      padding: 4px 6px;
    }
    input:focus,
    select:focus,
    textarea:focus {
      outline: 2px solid var(--accent);
      outline-offset: -1px;
    }
    input:disabled,
    select:disabled {
      opacity: 0.5;
    }
    .mono {
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .section {
      margin: 16px 0 6px;
      font-size: 11px;
      font-weight: 600;
      color: var(--fg-faint);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .grid-table {
      width: 100%;
      border-collapse: collapse;
    }
    .grid-table th {
      padding: 0 4px 4px;
      text-align: left;
      font-size: 11.5px;
      font-weight: 500;
      color: var(--fg-muted);
    }
    .grid-table td {
      padding: 2px 4px;
      vertical-align: middle;
    }
    .grid-table td input:not([type='checkbox']),
    .grid-table td select {
      width: 100%;
    }
    .was {
      display: block;
      font-size: 10.5px;
      color: var(--warning);
    }
    .new-row {
      box-shadow: inset 2px 0 0 var(--conn-local);
    }
    .item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 3px 6px;
      border-radius: 4px;
    }
    .item.removed > span {
      text-decoration: line-through;
      color: var(--danger);
    }
    .kind {
      width: 72px;
      flex-shrink: 0;
      font-size: 11px;
      color: var(--fg-muted);
    }
    .x {
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      border-radius: 4px;
      color: var(--fg-faint);
    }
    .x:hover {
      background: var(--bg-hover);
      color: var(--danger);
    }
    .add {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-top: 4px;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 12px;
      color: var(--accent);
    }
    .add:hover {
      background: var(--bg-hover);
    }
    .link {
      font-size: 12px;
      color: var(--accent);
    }
    .code {
      margin: 0;
      padding: 10px 12px;
      overflow: auto;
      font: 12px/1.5 var(--font-mono);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .btn {
      height: 28px;
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
      opacity: 0.55;
    }
    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-fg);
    }
    .btn-primary:hover:not(:disabled) {
      background: var(--accent);
      filter: brightness(1.08);
    }
  `,
})
export class TableEditor {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef)
  protected readonly data = inject<TableEditorData>(DIALOG_DATA)
  private readonly changesApi = inject(SchemaChanges)
  private readonly catalog = inject(Catalog)
  private readonly workspace = inject(Workspace)

  protected readonly envDot = { local: 'bg-env-local', dev: 'bg-env-dev', prod: 'bg-env-prod' } as const
  protected readonly types = TYPES
  protected readonly onDelete = ['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT'] as const
  protected readonly kindLabel: Record<string, string> = {
    u: 'unique',
    c: 'check',
    f: 'foreign key',
    x: 'exclusion',
  }

  protected readonly model = signal<EditModel | null>(null)
  protected readonly loadError = signal<string | null>(null)
  protected readonly applying = signal(false)
  protected readonly result = signal<{ ok: boolean; text: string } | null>(null)
  /** Bumped on every edit: the model is mutated in place, this makes the SQL follow. */
  private readonly version = signal(0)
  private live: SnapTable | null = null

  private readonly objects = toSignal(
    this.catalog.objects(this.data.connection.id).pipe(catchError(() => of(null))),
    {
      initialValue: null,
    },
  )
  protected readonly schemas = computed(() =>
    (this.objects()?.schemas ?? []).filter((s) => !/^(pg_|information_schema)/.test(s)),
  )
  protected readonly tables = computed(() =>
    (this.objects()?.objects ?? []).filter((o) => o.kind === 'table').map((o) => qualified(o)),
  )

  protected readonly issues = computed(() => {
    this.version()
    const m = this.model()
    return m ? problems(m) : []
  })

  private readonly changes = computed(() => {
    this.version()
    const m = this.model()
    if (!m || problems(m).length) return []
    const { table, renamed } = toTable(m)
    return this.live ? diffTable(table, this.live, renamed) : [createTableChange(table)]
  })
  protected readonly script = computed(() => statements(this.changes()))
  protected readonly scriptText = computed(() =>
    this.script()
      .map((s) => s + ';')
      .join('\n\n'),
  )
  protected readonly destructive = computed(() => this.changes().some((c) => c.destructive))

  constructor() {
    if (!this.data.table) {
      this.model.set(newTable(this.data.schema))
      return
    }
    this.changesApi
      .table(this.data.connection.id, this.data.schema, this.data.table)
      .pipe(
        map((s) => s.tables[0] ?? null),
        catchError((e: Error) => {
          this.loadError.set(e.message)
          return of(null)
        }),
      )
      .subscribe((t) => {
        if (!t) {
          if (!this.loadError())
            this.loadError.set(`${this.data.schema}.${this.data.table} isn't there any more.`)
          return
        }
        this.live = t
        this.model.set(fromTable(t))
      })
  }

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value
  }

  protected checked(e: Event) {
    return (e.target as HTMLInputElement).checked
  }

  /** Run an edit on the model and let the SQL follow. */
  protected set(edit: () => unknown) {
    edit()
    this.result.set(null)
    this.version.update((v) => v + 1)
  }

  protected addColumn() {
    this.set(() =>
      this.model()!.columns.push({
        key: nextKey(),
        was: null,
        name: '',
        type: 'text',
        notNull: false,
        default: '',
        identity: '',
        generated: null,
        collation: null,
        comment: '',
        pk: false,
      }),
    )
  }

  protected addIndex() {
    this.set(() => this.model()!.newIndexes.push({ key: nextKey(), name: '', columns: '', unique: false }))
  }

  protected addConstraint(kind: NewConstraintKind = 'foreign') {
    this.set(() =>
      this.model()!.newConstraints.push({
        key: nextKey(),
        kind,
        name: '',
        columns: '',
        expression: '',
        refTable: '',
        refColumns: '',
        onDelete: 'NO ACTION',
      }),
    )
  }

  protected openInTab() {
    this.workspace.openTab(this.data.connection, `${this.scriptText()}\n`)
    this.ref.close(false)
  }

  protected apply() {
    this.applying.set(true)
    const list = this.script()
    this.changesApi.apply(this.data.connection.id, list).subscribe((r) => {
      this.applying.set(false)
      if (r.ok) {
        this.catalog.refresh(this.data.connection.id)
        this.ref.close(true)
        return
      }
      const failed = r.statementIndex != null ? `\nIn: ${list[r.statementIndex].slice(0, 200)}` : ''
      this.result.set({ ok: false, text: `Nothing changed: ${r.error}${failed}` })
    })
  }
}
