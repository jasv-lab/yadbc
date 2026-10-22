import { inject, Injectable } from '@angular/core'
import { firstValueFrom } from 'rxjs'
import { Commands } from '../core/commands'
import { EditorTab, ResultView, Workspace } from '../workspace/workspace'
import { ColumnRelations, IncomingKey, Relations } from './relations'
import { filterSql, goToSql, joinSql, tableSql } from './sql-nav'

/** Which way to follow: the key this column holds, or one of the keys pointing at it. */
export type Direction = 'references' | IncomingKey

/** Statements a JOIN can be added to (as a subquery, a DML … RETURNING couldn't be). */
const JOINABLE = /^\s*(select|with|table|values)\b/i

/**
 * Following relations from a result: "go to" opens the related rows in a new tab and runs it; "join"
 * puts the statement with the related table joined in under the original (nothing of yours is
 * rewritten) and runs it. Used by the grid's context menu and the cell inspector.
 */
@Injectable({ providedIn: 'root' })
export class Navigator {
  private readonly relations = inject(Relations)
  private readonly workspace = inject(Workspace)
  private readonly commands = inject(Commands)

  /** The editor tab and result view a result id belongs to. */
  locate(resultId: string): { tab: EditorTab; result: ResultView } | null {
    for (const tab of this.workspace.editorTabs()) {
      const result = tab.results().find((r) => r.resultId === resultId)
      if (result) return { tab, result }
    }
    return null
  }

  /** The statement a result came from, when a JOIN can be added to it. */
  joinable(resultId: string): boolean {
    const at = this.locate(resultId)
    const sql = at?.tab.lastStatements[at.result.index]?.sql
    return !!sql && JOINABLE.test(sql)
  }

  label(rel: ColumnRelations, dir: Direction): string {
    const target = dir === 'references' ? rel.references! : dir
    return `${tableSql(target.table)}.${target.column}`
  }

  async goTo(resultId: string, col: number, values: (string | null)[], dir: Direction) {
    const at = this.locate(resultId)
    const rel = (await firstValueFrom(this.relations.of(resultId)))[col]
    if (!at || !rel) return
    const target = dir === 'references' ? rel.references : dir
    if (!target) return
    const sql = goToSql(target.table, target.column, values, at.result.columns[col].type)
    this.workspace.openTab(at.tab.connection, sql + ';', { autoRun: true })
  }

  /**
   * Keeps (or excludes) the selected values: the statement the result came from gets the condition in
   * its WHERE — replaced in place when the editor still has it as it ran, so filters stack and Ctrl+Z
   * undoes one; otherwise the filtered statement is appended. Then it runs.
   */
  async filter(resultId: string, cells: { col: number; values: (string | null)[] }[], negate: boolean) {
    const at = this.locate(resultId)
    const statement = at?.tab.lastStatements[at.result.index]
    if (!at || !statement || !JOINABLE.test(statement.sql) || !cells.length) return
    const rels = await firstValueFrom(this.relations.of(resultId))
    const { sql } = filterSql({
      sql: statement.sql,
      negate,
      conditions: cells.map((c) => ({
        table: rels[c.col]?.table ?? null,
        column: rels[c.col]?.column ?? null,
        resultColumn: at.result.columns[c.col].name,
        values: c.values,
        type: at.result.columns[c.col].type,
      })),
    })
    const replaced = await this.workspace.replaceInEditor(at.tab, statement.offset, statement.sql, sql)
    if (!replaced) this.workspace.insertIntoEditor(at.tab, sql + ';')
    this.commands.execute('run.statement')
  }

  async join(resultId: string, col: number, dir: Direction) {
    const at = this.locate(resultId)
    const rel = (await firstValueFrom(this.relations.of(resultId)))[col]
    const statement = at?.tab.lastStatements[at.result.index]?.sql
    if (!at || !rel?.table || !rel.column || !statement) return
    const target = dir === 'references' ? rel.references : dir
    if (!target) return
    const { sql } = joinSql({
      sql: statement,
      from: { table: rel.table, column: rel.column, resultColumn: at.result.columns[col].name },
      to: { table: target.table, column: target.column },
    })
    // Appended under the original and selected, so "run statement" runs exactly this.
    this.workspace.insertIntoEditor(at.tab, sql + ';')
    this.commands.execute('run.statement')
  }
}
