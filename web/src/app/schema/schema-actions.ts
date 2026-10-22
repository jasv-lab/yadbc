import { Dialog } from '@angular/cdk/dialog'
import { inject, Injectable } from '@angular/core'
import { catchError, of } from 'rxjs'
import { tableDefinition } from '../schema-model/diff'
import { SchemaChanges } from '../schema-model/schema-changes'
import { TableEditor, TableEditorData } from '../table-editor/table-editor'
import { ConnectionProfile } from '../core/protocol'
import { Edits } from '../editing/edits'
import { Workspace } from '../workspace/workspace'
import { Catalog, CatalogObject, ident, ObjectKind, qualified } from './catalog'

const RELATIONS = new Set<ObjectKind>(['table', 'view', 'matview', 'foreign'])
const DEFINITIONS = new Set<ObjectKind>(['table', 'view', 'matview', 'function', 'procedure'])

/** What you can do with a catalog object — shared by the schema tree and the command palette. */
@Injectable({ providedIn: 'root' })
export class SchemaActions {
  private readonly catalog = inject(Catalog)
  private readonly workspace = inject(Workspace)
  private readonly edits = inject(Edits)
  private readonly schemaChanges = inject(SchemaChanges)
  private readonly dialog = inject(Dialog)

  isRelation(o?: CatalogObject) {
    return !!o && RELATIONS.has(o.kind)
  }

  hasDefinition(o?: CatalogObject) {
    return !!o && DEFINITIONS.has(o.kind)
  }

  /** The natural "open": data for tables and views, the definition for functions. */
  open(conn: ConnectionProfile, o: CatalogObject) {
    if (this.isRelation(o)) this.openData(conn, o)
    else if (this.hasDefinition(o)) this.openDefinition(conn, o)
    else this.copyName(o)
  }

  /** Data tab: SELECT * ordered by the primary key (stable paging, uses the index), run immediately. */
  openData(conn: ConnectionProfile, o: CatalogObject) {
    this.catalog
      .relation(conn.id, o.oid)
      .pipe(catchError(() => of(null)))
      .subscribe((r) => {
        const order =
          o.kind === 'table' && r?.primaryKey.length ? `\nORDER BY ${r.primaryKey.map(ident).join(', ')}` : ''
        this.workspace.openTab(conn, `SELECT *\nFROM ${qualified(o)}${order}\nLIMIT 1000`, { autoRun: true })
      })
  }

  selectScript(conn: ConnectionProfile, o: CatalogObject) {
    this.catalog
      .relation(conn.id, o.oid)
      .pipe(catchError(() => of(null)))
      .subscribe((r) => {
        const cols = r?.columns.length ? r.columns.map((c) => ident(c.name)).join(',\n       ') : '*'
        this.workspace.openTab(conn, `SELECT ${cols}\nFROM ${qualified(o)}\nWHERE `)
      })
  }

  openDefinition(conn: ConnectionProfile, o: CatalogObject) {
    // Postgres has no pg_get_tabledef: a table's CREATE script is built like Compare schemas builds one.
    if (o.kind === 'table') {
      this.schemaChanges.table(conn.id, o.schema, o.name).subscribe({
        next: (s) => {
          const t = s.tables[0]
          if (t) this.workspace.openTab(conn, `${tableDefinition(t, s.sequences)}\n`)
        },
        error: (e: Error) => this.edits.say(e.message, true),
      })
      return
    }
    this.catalog.definition(conn.id, o.kind, o.oid).subscribe({
      next: (sql) => this.workspace.openTab(conn, sql),
      error: (e) => this.edits.say(e instanceof Error ? e.message : 'Could not load the definition', true),
    })
  }

  /** Edit an existing table (`table` given) or create one in `schema`. */
  editTable(conn: ConnectionProfile, schema: string, table: string | null) {
    this.dialog.open<boolean, TableEditorData>(TableEditor, { data: { connection: conn, schema, table } })
  }

  copyName(o: CatalogObject) {
    // Functions are listed with their signature; the name alone is what you paste into SQL.
    const name =
      o.kind === 'function' || o.kind === 'procedure' ? o.name.slice(0, o.name.indexOf('(')) : o.name
    navigator.clipboard.writeText(qualified({ schema: o.schema, name }))
  }
}
