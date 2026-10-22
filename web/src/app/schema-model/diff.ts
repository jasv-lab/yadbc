import { ident } from '../schema/catalog'
import {
  addConstraintSql,
  columnSql,
  commentOnColumnSql,
  commentOnTableSql,
  createEnumSql,
  createSequenceSql,
  createTableSql,
  createViewSql,
  dropConstraintSql,
  dropViewSql,
  normalize,
  q,
  sequenceOptions,
  str,
  withoutName,
} from './ddl'
import {
  SchemaSnapshot,
  SnapColumn,
  SnapConstraint,
  SnapFunction,
  SnapIndex,
  SnapSequence,
  SnapTable,
  SnapTrigger,
  SnapView,
} from './snapshot'

/**
 * What it takes to make a target schema look like a source one (compare dev → prod), or a live table
 * look like an edited one (the table editor: the edit is the source). One Change per object, each with
 * its statements tagged by phase; the script is the selected changes' statements in phase order, so
 * tables exist before their foreign keys, functions before the views using them, and drops come last.
 */

export type ChangeStatus = 'create' | 'drop' | 'alter'

export type ObjectKind =
  | 'schema'
  | 'enum'
  | 'sequence'
  | 'table'
  | 'column'
  | 'constraint'
  | 'index'
  | 'trigger'
  | 'view'
  | 'function'

export interface Statement {
  phase: number
  sql: string
}

export interface Change {
  /** Stable across re-compares, for selection. */
  id: string
  kind: ObjectKind
  status: ChangeStatus
  /** Display name: shop.orders, shop.orders.total, shop.orders_pkey… */
  name: string
  /** The table it belongs to (columns, constraints, indexes, triggers), for grouping. */
  table?: string
  summary: string
  /** Definitions on each side, for the side-by-side view. */
  source?: string
  target?: string
  /** Drops (and drop + re-create of data-holding things): not selected by default. */
  destructive: boolean
  /** Something the script can't do, or a caveat. */
  note?: string
  statements: Statement[]
}

const P = {
  renameTable: 0,
  schema: 1,
  enum: 2,
  sequence: 3,
  table: 4,
  partition: 5,
  column: 6,
  constraint: 7,
  index: 8,
  foreignKey: 9,
  ownedBy: 10,
  function: 11,
  view: 12,
  trigger: 13,
  comment: 14,
  dropTrigger: 20,
  dropView: 21,
  dropFunction: 22,
  dropForeignKey: 23,
  dropConstraint: 24,
  dropIndex: 25,
  dropColumn: 26,
  dropTable: 27,
  dropSequence: 28,
  dropEnum: 29,
  dropSchema: 30,
}

const key = (o: { schema: string; name: string }) => `${o.schema}.${o.name}`
const fnKey = (f: SnapFunction) => `${f.schema}.${f.name}(${f.arguments})`

function byKey<T>(items: T[], k: (t: T) => string): Map<string, T> {
  return new Map(items.map((t) => [k(t), t]))
}

// --- whole snapshots ----------------------------------------------------------------------------

export function diffSnapshots(source: SchemaSnapshot, target: SchemaSnapshot): Change[] {
  const changes: Change[] = []

  const targetSchemas = new Set(target.schemas)
  const sourceSchemas = new Set(source.schemas)
  for (const s of source.schemas)
    if (!targetSchemas.has(s))
      changes.push(
        change('schema', 'create', s, undefined, 'missing in target', [
          { phase: P.schema, sql: `CREATE SCHEMA ${ident(s)}` },
        ]),
      )
  for (const s of target.schemas)
    if (!sourceSchemas.has(s))
      changes.push(
        change(
          'schema',
          'drop',
          s,
          undefined,
          'only in target',
          [{ phase: P.dropSchema, sql: `DROP SCHEMA ${ident(s)}` }],
          true,
        ),
      )

  changes.push(...diffEnums(source, target))
  changes.push(...diffSequences(source.sequences, target.sequences))

  const targetTables = byKey(target.tables, key)
  const sourceTables = byKey(source.tables, key)
  for (const t of source.tables) {
    const other = targetTables.get(key(t))
    if (other) changes.push(...diffTable(t, other))
    else changes.push(createTableChange(t))
  }
  for (const t of target.tables)
    if (!sourceTables.has(key(t)))
      changes.push(
        change(
          'table',
          'drop',
          key(t),
          undefined,
          'only in target',
          [{ phase: P.dropTable, sql: `DROP TABLE ${q(t)}` }],
          true,
          {
            target: createTableSql(t),
          },
        ),
      )

  changes.push(...diffViews(source.views, target.views))
  changes.push(...diffFunctions(source.functions, target.functions))
  return changes
}

/** A table that isn't there yet: CREATE TABLE plus its indexes, foreign keys, triggers and comments. */
export function createTableChange(t: SnapTable): Change {
  const statements: Statement[] = [{ phase: t.partitionOf ? P.partition : P.table, sql: createTableSql(t) }]
  for (const c of t.constraints.filter((c) => c.type === 'f'))
    statements.push({ phase: P.foreignKey, sql: addConstraintSql(t, c.name, c.definition) })
  for (const i of t.indexes) statements.push({ phase: P.index, sql: i.definition })
  for (const tr of t.triggers) statements.push({ phase: P.trigger, sql: tr.definition })
  if (t.comment) statements.push({ phase: P.comment, sql: commentOnTableSql(t) })
  for (const c of t.columns)
    if (c.comment) statements.push({ phase: P.comment, sql: commentOnColumnSql(t, c) })
  return change('table', 'create', key(t), undefined, 'missing in target', statements, false, {
    source: createTableSql(t),
  })
}

/** The full definition script of one table (and its serial sequences): "Show definition" for tables. */
export function tableDefinition(t: SnapTable, sequences: SnapSequence[] = []): string {
  const seq = sequences.flatMap((s) => createSequenceChange(s).statements)
  return script([...seq.map((s) => ({ ...s })), ...createTableChange(t).statements])
}

// --- one table ----------------------------------------------------------------------------------

/**
 * Make `target` (live) look like `source`. `renamed` maps a source column name to the target column it
 * was renamed from (the table editor knows; a comparison doesn't, and sees a drop plus an add).
 */
export function diffTable(
  source: SnapTable,
  target: SnapTable,
  renamed: Map<string, string> = new Map(),
): Change[] {
  const changes: Change[] = []
  const name = key(source)
  const t = source // statements address the table by its (new) name

  if (key(target) !== name)
    changes.push(
      change(
        'table',
        'alter',
        name,
        name,
        `renamed from ${key(target)}`,
        [
          {
            phase: P.renameTable,
            sql:
              target.schema !== source.schema
                ? `ALTER TABLE ${q(target)} SET SCHEMA ${ident(source.schema)}`
                : `ALTER TABLE ${q(target)} RENAME TO ${ident(source.name)}`,
          },
        ],
        false,
        { id: 'rename' },
      ),
    )

  if (
    normalize(source.partitionKey ?? '') !== normalize(target.partitionKey ?? '') ||
    (source.partitionOf ?? '') !== (target.partitionOf ?? '')
  )
    changes.push(
      change('table', 'alter', name, name, 'partitioning differs', [], false, {
        id: 'partitioning',
        note: 'Partitioning can only be changed by rebuilding the table (or detaching / attaching partitions) by hand.',
      }),
    )
  else if (
    source.partitionOf &&
    normalize(source.partitionBound ?? '') !== normalize(target.partitionBound ?? '')
  )
    changes.push(
      change('table', 'alter', name, name, 'partition bounds differ', [], false, {
        id: 'partitioning',
        note: 'Detach the partition and attach it again with the new bounds.',
        source: source.partitionBound ?? '',
        target: target.partitionBound ?? '',
      }),
    )

  // Columns: renames first, so later statements see the new names.
  const targetCols = byKey(target.columns, (c) => c.name)
  const matched = new Set<string>()
  for (const c of source.columns) {
    const from = renamed.get(c.name)
    const other = targetCols.get(from ?? c.name)
    if (!other) {
      changes.push(
        change(
          'column',
          'create',
          `${name}.${c.name}`,
          name,
          'missing in target',
          [
            { phase: P.column, sql: `ALTER TABLE ${q(t)} ADD COLUMN ${columnSql(c)}` },
            ...(c.comment ? [{ phase: P.comment, sql: commentOnColumnSql(t, c) }] : []),
          ],
          false,
          { source: columnSql(c) },
        ),
      )
      continue
    }
    matched.add(other.name)
    const alter = alterColumn(t, other, c)
    if (from && from !== c.name)
      alter.statements.unshift({
        phase: P.column,
        sql: `ALTER TABLE ${q(t)} RENAME COLUMN ${ident(from)} TO ${ident(c.name)}`,
      })
    if (alter.statements.length || alter.note)
      changes.push(
        change(
          'column',
          'alter',
          `${name}.${c.name}`,
          name,
          [from && from !== c.name ? `renamed from ${from}` : '', ...alter.what].filter(Boolean).join(', '),
          alter.statements,
          alter.destructive,
          {
            source: columnSql(c),
            target: columnSql(other),
            note: alter.note,
          },
        ),
      )
  }
  for (const c of target.columns)
    if (!matched.has(c.name))
      changes.push(
        change(
          'column',
          'drop',
          `${name}.${c.name}`,
          name,
          'only in target — its data goes with it',
          [{ phase: P.dropColumn, sql: `ALTER TABLE ${q(t)} DROP COLUMN ${ident(c.name)}` }],
          true,
          { target: columnSql(c) },
        ),
      )

  changes.push(...diffConstraints(t, source.constraints, target.constraints))
  changes.push(
    ...diffNamed(
      'index',
      t,
      source.indexes,
      target.indexes,
      P.index,
      P.dropIndex,
      (i) => `DROP INDEX ${ident(source.schema)}.${ident(i.name)}`,
      (from, to) => `ALTER INDEX ${ident(source.schema)}.${ident(from)} RENAME TO ${ident(to)}`,
    ),
  )
  changes.push(
    ...diffNamed(
      'trigger',
      t,
      source.triggers,
      target.triggers,
      P.trigger,
      P.dropTrigger,
      (tr) => `DROP TRIGGER ${ident(tr.name)} ON ${q(t)}`,
      (from, to) => `ALTER TRIGGER ${ident(from)} ON ${q(t)} RENAME TO ${ident(to)}`,
    ),
  )

  if ((source.comment ?? null) !== (target.comment ?? null))
    changes.push(
      change(
        'table',
        'alter',
        name,
        name,
        'comment differs',
        [{ phase: P.comment, sql: commentOnTableSql(source) }],
        false,
        {
          id: 'comment',
          source: source.comment ?? '',
          target: target.comment ?? '',
        },
      ),
    )
  return changes
}

/** The statements turning column `from` into `to` (same name by now). */
function alterColumn(
  t: SnapTable,
  from: SnapColumn,
  to: SnapColumn,
): { statements: Statement[]; what: string[]; destructive: boolean; note?: string } {
  const at = `ALTER TABLE ${q(t)} ALTER COLUMN ${ident(to.name)}`
  const s: Statement[] = []
  const what: string[] = []
  const add = (sql: string) => s.push({ phase: P.column, sql })

  if ((from.generated ?? '') !== (to.generated ?? '')) {
    // A generated column can't be turned into a plain one (or get a new expression) in place everywhere.
    what.push('generated expression differs')
    return {
      statements: [
        { phase: P.column, sql: `ALTER TABLE ${q(t)} DROP COLUMN ${ident(to.name)}` },
        { phase: P.column, sql: `ALTER TABLE ${q(t)} ADD COLUMN ${columnSql(to)}` },
      ],
      what,
      destructive: true,
      note: 'Re-created: the column is dropped and added again.',
    }
  }
  if (from.identity && !to.identity) {
    add(`${at} DROP IDENTITY`)
    what.push('no longer identity')
  }
  const typeChanged = from.type !== to.type || (from.collation ?? '') !== (to.collation ?? '')
  const defaultChanged = !to.identity && (from.default ?? '') !== (to.default ?? '')
  if (typeChanged && from.default && defaultChanged) add(`${at} DROP DEFAULT`)
  if (typeChanged) {
    add(
      `${at} TYPE ${to.type}${to.collation ? ` COLLATE ${to.collation}` : ''} USING ${ident(to.name)}::${to.type}`,
    )
    what.push(from.type !== to.type ? `type ${from.type} → ${to.type}` : 'collation differs')
  }
  if (defaultChanged) {
    if (to.default) add(`${at} SET DEFAULT ${to.default}`)
    else if (!typeChanged || !from.default) add(`${at} DROP DEFAULT`)
    what.push(to.default ? `default ${to.default}` : 'no default')
  }
  if (to.identity && !from.identity) {
    add(`${at} ADD GENERATED ${to.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`)
    what.push('identity')
  } else if (to.identity && from.identity !== to.identity) {
    add(`${at} SET GENERATED ${to.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'}`)
    what.push(`identity ${to.identity === 'a' ? 'always' : 'by default'}`)
  }
  if (from.notNull !== to.notNull && !to.identity) {
    add(`${at} ${to.notNull ? 'SET' : 'DROP'} NOT NULL`)
    what.push(to.notNull ? 'NOT NULL' : 'nullable')
  }
  if ((from.comment ?? null) !== (to.comment ?? null)) {
    s.push({ phase: P.comment, sql: commentOnColumnSql(t, to) })
    what.push('comment')
  }
  return {
    statements: s,
    what,
    destructive: false,
    note: typeChanged
      ? "Changing the type rewrites the table and fails if a value doesn't convert."
      : undefined,
  }
}

function diffConstraints(t: SnapTable, source: SnapConstraint[], target: SnapConstraint[]): Change[] {
  const out: Change[] = []
  const name = key(t)
  const targets = byKey(target, (c) => c.name)
  for (const c of source) {
    const other = targets.get(c.name)
    const phase = c.type === 'f' ? P.foreignKey : P.constraint
    if (!other)
      out.push(
        change(
          'constraint',
          'create',
          `${name}.${c.name}`,
          name,
          'missing in target',
          [{ phase, sql: addConstraintSql(t, c.name, c.definition) }],
          false,
          { source: c.definition },
        ),
      )
    else if (normalize(other.definition) !== normalize(c.definition))
      out.push(
        change(
          'constraint',
          'alter',
          `${name}.${c.name}`,
          name,
          'definition differs',
          [
            { phase, sql: dropConstraintSql(t, c.name) },
            { phase, sql: addConstraintSql(t, c.name, c.definition) },
          ],
          false,
          { source: c.definition, target: other.definition },
        ),
      )
  }
  const sources = new Set(source.map((c) => c.name))
  for (const c of target)
    if (!sources.has(c.name))
      out.push(
        change(
          'constraint',
          'drop',
          `${name}.${c.name}`,
          name,
          'only in target',
          [
            {
              phase: c.type === 'f' ? P.dropForeignKey : P.dropConstraint,
              sql: dropConstraintSql(t, c.name),
            },
          ],
          true,
          { target: c.definition },
        ),
      )
  return out
}

/** Indexes and triggers: by name, definitions compared without the name, same definition under another name = a rename. */
function diffNamed(
  kind: 'index' | 'trigger',
  t: SnapTable,
  source: (SnapIndex | SnapTrigger)[],
  target: (SnapIndex | SnapTrigger)[],
  phase: number,
  dropPhase: number,
  dropSql: (x: SnapIndex | SnapTrigger) => string,
  renameSql: (from: string, to: string) => string,
): Change[] {
  const out: Change[] = []
  const name = key(t)
  const targets = byKey(target, (x) => x.name)
  const sourceNames = new Set(source.map((x) => x.name))
  const unmatchedTargets = target.filter((x) => !sourceNames.has(x.name))
  for (const x of source) {
    const other = targets.get(x.name)
    if (other) {
      if (withoutName(other.definition, other.name) !== withoutName(x.definition, x.name))
        out.push(
          change(
            kind,
            'alter',
            `${name}.${x.name}`,
            name,
            'definition differs',
            [
              { phase, sql: dropSql(other) },
              { phase, sql: x.definition },
            ],
            false,
            { source: x.definition, target: other.definition },
          ),
        )
      continue
    }
    const twin = unmatchedTargets.find(
      (o) => withoutName(o.definition, o.name) === withoutName(x.definition, x.name),
    )
    if (twin) {
      unmatchedTargets.splice(unmatchedTargets.indexOf(twin), 1)
      out.push(
        change(
          kind,
          'alter',
          `${name}.${x.name}`,
          name,
          `renamed from ${twin.name}`,
          [{ phase, sql: renameSql(twin.name, x.name) }],
          false,
          {
            source: x.definition,
            target: twin.definition,
          },
        ),
      )
    } else
      out.push(
        change(
          kind,
          'create',
          `${name}.${x.name}`,
          name,
          'missing in target',
          [{ phase, sql: x.definition }],
          false,
          { source: x.definition },
        ),
      )
  }
  for (const x of unmatchedTargets)
    out.push(
      change(
        kind,
        'drop',
        `${name}.${x.name}`,
        name,
        'only in target',
        [{ phase: dropPhase, sql: dropSql(x) }],
        true,
        { target: x.definition },
      ),
    )
  return out
}

// --- other objects ------------------------------------------------------------------------------

function diffEnums(source: SchemaSnapshot, target: SchemaSnapshot): Change[] {
  const out: Change[] = []
  const targets = byKey(target.enums, key)
  for (const e of source.enums) {
    const other = targets.get(key(e))
    if (!other) {
      out.push(
        change(
          'enum',
          'create',
          key(e),
          undefined,
          'missing in target',
          [{ phase: P.enum, sql: createEnumSql(e) }],
          false,
          { source: createEnumSql(e) },
        ),
      )
      continue
    }
    if (e.labels.join('\u0000') === other.labels.join('\u0000')) continue
    const statements: Statement[] = []
    const have = [...other.labels]
    e.labels.forEach((label, i) => {
      if (have.includes(label)) return
      const after = e.labels
        .slice(0, i)
        .reverse()
        .find((l) => have.includes(l))
      const before = e.labels.slice(i + 1).find((l) => have.includes(l))
      const where =
        after !== undefined ? ` AFTER ${str(after)}` : before !== undefined ? ` BEFORE ${str(before)}` : ''
      statements.push({ phase: P.enum, sql: `ALTER TYPE ${q(e)} ADD VALUE ${str(label)}${where}` })
      have.splice(
        after !== undefined
          ? have.indexOf(after) + 1
          : before !== undefined
            ? have.indexOf(before)
            : have.length,
        0,
        label,
      )
    })
    const extra = other.labels.filter((l) => !e.labels.includes(l))
    const reordered = have.filter((l) => e.labels.includes(l)).join('\u0000') !== e.labels.join('\u0000')
    out.push(
      change(
        'enum',
        'alter',
        key(e),
        undefined,
        statements.length
          ? `adds ${statements.length} value${statements.length === 1 ? '' : 's'}`
          : 'values differ',
        statements,
        false,
        {
          source: createEnumSql(e),
          target: createEnumSql(other),
          note:
            extra.length || reordered
              ? `Postgres can't ${extra.length ? `remove enum values (${extra.join(', ')})` : 'reorder enum values'}: that takes a new type and converting the columns by hand.`
              : undefined,
        },
      ),
    )
  }
  const sources = new Set(source.enums.map(key))
  for (const e of target.enums)
    if (!sources.has(key(e)))
      out.push(
        change(
          'enum',
          'drop',
          key(e),
          undefined,
          'only in target',
          [{ phase: P.dropEnum, sql: `DROP TYPE ${q(e)}` }],
          true,
          { target: createEnumSql(e) },
        ),
      )
  return out
}

function createSequenceChange(s: SnapSequence): Change {
  const statements: Statement[] = [{ phase: P.sequence, sql: createSequenceSql(s) }]
  if (s.ownedBy) statements.push({ phase: P.ownedBy, sql: `ALTER SEQUENCE ${q(s)} OWNED BY ${s.ownedBy}` })
  return change('sequence', 'create', key(s), undefined, 'missing in target', statements, false, {
    source: createSequenceSql(s),
  })
}

function diffSequences(source: SnapSequence[], target: SnapSequence[]): Change[] {
  const out: Change[] = []
  const targets = byKey(target, key)
  for (const s of source) {
    const other = targets.get(key(s))
    if (!other) {
      out.push(createSequenceChange(s))
      continue
    }
    const statements: Statement[] = []
    if (sequenceOptions(s) !== sequenceOptions(other))
      statements.push({ phase: P.sequence, sql: `ALTER SEQUENCE ${q(s)} ${sequenceOptions(s)}` })
    if ((s.ownedBy ?? '') !== (other.ownedBy ?? ''))
      statements.push({ phase: P.ownedBy, sql: `ALTER SEQUENCE ${q(s)} OWNED BY ${s.ownedBy ?? 'NONE'}` })
    if (statements.length)
      out.push(
        change('sequence', 'alter', key(s), undefined, 'settings differ', statements, false, {
          source: createSequenceSql(s),
          target: createSequenceSql(other),
        }),
      )
  }
  const sources = new Set(source.map(key))
  for (const s of target)
    if (!sources.has(key(s)))
      out.push(
        change(
          'sequence',
          'drop',
          key(s),
          undefined,
          'only in target',
          [{ phase: P.dropSequence, sql: `DROP SEQUENCE ${q(s)}` }],
          true,
          { target: createSequenceSql(s) },
        ),
      )
  return out
}

function diffViews(source: SnapView[], target: SnapView[]): Change[] {
  const out: Change[] = []
  const targets = byKey(target, key)
  for (const v of source) {
    const other = targets.get(key(v))
    const indexes = v.indexes.map((i) => ({ phase: P.view, sql: i.definition }))
    if (!other) {
      out.push(
        change(
          'view',
          'create',
          key(v),
          undefined,
          'missing in target',
          [{ phase: P.view, sql: createViewSql(v) }, ...indexes],
          false,
          { source: createViewSql(v) },
        ),
      )
      continue
    }
    const sameKind = v.materialized === other.materialized
    const sameQuery = normalize(v.definition) === normalize(other.definition)
    const sameIndexes =
      normalize(v.indexes.map((i) => i.definition).join(';')) ===
      normalize(other.indexes.map((i) => i.definition).join(';'))
    if (sameKind && sameQuery && sameIndexes) continue
    // CREATE OR REPLACE VIEW can only append columns; anything else (and any materialized view) is rebuilt.
    const replaceable = sameKind && !v.materialized && other.columns.every((c, i) => v.columns[i] === c)
    out.push(
      change(
        'view',
        'alter',
        key(v),
        undefined,
        sameQuery ? 'indexes differ' : 'definition differs',
        replaceable
          ? [{ phase: P.view, sql: createViewSql(v, true) }]
          : [
              { phase: P.view, sql: dropViewSql(other) },
              { phase: P.view, sql: createViewSql(v) },
              ...indexes,
            ],
        false,
        {
          source: createViewSql(v),
          target: createViewSql(other),
          note: replaceable
            ? undefined
            : 'Dropped and created again: views depending on it have to be re-created too.',
        },
      ),
    )
  }
  const sources = new Set(source.map(key))
  for (const v of target)
    if (!sources.has(key(v)))
      out.push(
        change(
          'view',
          'drop',
          key(v),
          undefined,
          'only in target',
          [{ phase: P.dropView, sql: dropViewSql(v) }],
          true,
          { target: createViewSql(v) },
        ),
      )
  return out
}

function diffFunctions(source: SnapFunction[], target: SnapFunction[]): Change[] {
  const out: Change[] = []
  const targets = byKey(target, fnKey)
  const drop = (f: SnapFunction) =>
    `DROP ${f.kind === 'p' ? 'PROCEDURE' : 'FUNCTION'} ${q(f)}(${f.arguments})`
  for (const f of source) {
    const other = targets.get(fnKey(f))
    if (!other) {
      out.push(
        change(
          'function',
          'create',
          fnKey(f),
          undefined,
          'missing in target',
          [{ phase: P.function, sql: f.definition.trim() }],
          false,
          { source: f.definition },
        ),
      )
      continue
    }
    if (normalize(f.definition) === normalize(other.definition)) continue
    // CREATE OR REPLACE can't change a function's return type.
    const statements =
      f.result === other.result && f.kind === other.kind
        ? [{ phase: P.function, sql: f.definition.trim() }]
        : [
            { phase: P.function, sql: drop(other) },
            { phase: P.function, sql: f.definition.trim() },
          ]
    out.push(
      change('function', 'alter', fnKey(f), undefined, 'definition differs', statements, false, {
        source: f.definition,
        target: other.definition,
      }),
    )
  }
  const sources = new Set(source.map(fnKey))
  for (const f of target)
    if (!sources.has(fnKey(f)))
      out.push(
        change(
          'function',
          'drop',
          fnKey(f),
          undefined,
          'only in target',
          [{ phase: P.dropFunction, sql: drop(f) }],
          true,
          { target: f.definition },
        ),
      )
  return out
}

// --- script -------------------------------------------------------------------------------------

/** The statements of the given changes in phase order (stable within a phase), each ending in a semicolon. */
export function statements(changes: Change[]): string[] {
  return changes
    .flatMap((c) => c.statements)
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => a.phase - b.phase || a.i - b.i)
    .map((s) => s.sql.trim().replace(/;$/, ''))
}

export function script(list: Statement[] | Change[]): string {
  const all = (list as (Statement | Change)[]).every((x) => 'phase' in x)
    ? statements([change('table', 'create', '', undefined, '', list as Statement[])])
    : statements(list as Change[])
  return all.map((s) => s + ';').join('\n\n')
}

function change(
  kind: ObjectKind,
  status: ChangeStatus,
  name: string,
  table: string | undefined,
  summary: string,
  statements: Statement[],
  destructive = false,
  extra: { source?: string; target?: string; note?: string; id?: string } = {},
): Change {
  const { id, ...rest } = extra
  return {
    id: `${kind}:${name}${id ? ':' + id : ''}`,
    kind,
    status,
    name,
    table,
    summary,
    statements,
    destructive,
    ...rest,
  }
}
