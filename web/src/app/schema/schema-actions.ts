import { inject, Injectable } from '@angular/core'
import { catchError, of } from 'rxjs'
import { ConnectionProfile } from '../core/protocol'
import { Edits } from '../editing/edits'
import { Workspace } from '../workspace/workspace'
import { Catalog, CatalogObject, ident, ObjectKind, qualified } from './catalog'

const RELATIONS = new Set<ObjectKind>(['table', 'view', 'matview', 'foreign'])
const DEFINITIONS = new Set<ObjectKind>(['view', 'matview', 'function', 'procedure'])

/** What you can do with a catalog object — shared by the schema tree and the command palette. */
@Injectable({ providedIn: 'root' })
export class SchemaActions {
  private readonly catalog = inject(Catalog)
  private readonly workspace = inject(Workspace)
  private readonly edits = inject(Edits)

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
    this.catalog.definition(conn.id, o.kind, o.oid).subscribe({
      next: (sql) => this.workspace.openTab(conn, sql),
      error: (e) => this.edits.say(e instanceof Error ? e.message : 'Could not load the definition', true),
    })
  }

  copyName(o: CatalogObject) {
    // Functions are listed with their signature; the name alone is what you paste into SQL.
    const name =
      o.kind === 'function' || o.kind === 'procedure' ? o.name.slice(0, o.name.indexOf('(')) : o.name
    navigator.clipboard.writeText(qualified({ schema: o.schema, name }))
  }
}
