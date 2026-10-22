import { ident } from '../schema/catalog'
import { SnapColumn, SnapConstraint, SnapIndex, SnapTable } from '../schema-model/snapshot'

/**
 * The table editor's working copy. Columns remember what they were called (`was`) so a rename becomes
 * RENAME COLUMN, not a drop and an add; the primary key is a per-column tick; existing indexes and
 * constraints are kept or removed as they are, new ones are built from a few fields.
 */

export interface EditColumn {
  key: number
  /** Name in the live table; null for a new column. */
  was: string | null
  name: string
  type: string
  notNull: boolean
  default: string
  identity: '' | 'a' | 'd'
  /** Stored generated expression — shown, kept, not edited here. */
  generated: string | null
  collation: string | null
  comment: string
  pk: boolean
}

export type NewConstraintKind = 'unique' | 'check' | 'foreign'

export interface NewConstraint {
  key: number
  kind: NewConstraintKind
  name: string
  /** unique / foreign: column list; check: the expression */
  columns: string
  expression: string
  refTable: string
  refColumns: string
  onDelete: 'NO ACTION' | 'CASCADE' | 'SET NULL' | 'RESTRICT'
}

export interface NewIndex {
  key: number
  name: string
  columns: string
  unique: boolean
}

export interface EditModel {
  schema: string
  name: string
  comment: string
  columns: EditColumn[]
  /** Existing constraints other than the primary key: kept unless removed. */
  constraints: (SnapConstraint & { removed: boolean })[]
  indexes: (SnapIndex & { removed: boolean })[]
  newConstraints: NewConstraint[]
  newIndexes: NewIndex[]
  /** The live primary key's name, reused when the key's columns change. */
  pkName: string | null
  /** Kept as they are: partitioning, triggers. */
  rest: Pick<SnapTable, 'partitioned' | 'partitionKey' | 'partitionOf' | 'partitionBound' | 'triggers'>
}

let seq = 0
export const nextKey = () => ++seq

/** `PRIMARY KEY (a, "B c")` → ['a', 'B c'] */
export function keyColumns(definition: string): string[] {
  const inner = /\(([^)]*)\)/.exec(definition)?.[1] ?? ''
  return inner
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s))
}

export function fromTable(t: SnapTable): EditModel {
  const pk = t.constraints.find((c) => c.type === 'p')
  const pkCols = new Set(pk ? keyColumns(pk.definition) : [])
  return {
    schema: t.schema,
    name: t.name,
    comment: t.comment ?? '',
    columns: t.columns.map((c) => ({
      key: nextKey(),
      was: c.name,
      name: c.name,
      type: c.type,
      notNull: c.notNull,
      default: c.default ?? '',
      identity: c.identity,
      generated: c.generated,
      collation: c.collation,
      comment: c.comment ?? '',
      pk: pkCols.has(c.name),
    })),
    constraints: t.constraints.filter((c) => c.type !== 'p').map((c) => ({ ...c, removed: false })),
    indexes: t.indexes.map((i) => ({ ...i, removed: false })),
    newConstraints: [],
    newIndexes: [],
    pkName: pk?.name ?? null,
    rest: {
      partitioned: t.partitioned,
      partitionKey: t.partitionKey,
      partitionOf: t.partitionOf,
      partitionBound: t.partitionBound,
      triggers: t.triggers,
    },
  }
}

export function newTable(schema: string): EditModel {
  return {
    schema,
    name: '',
    comment: '',
    columns: [
      {
        key: nextKey(),
        was: null,
        name: 'id',
        type: 'bigint',
        notNull: true,
        default: '',
        identity: 'a',
        generated: null,
        collation: null,
        comment: '',
        pk: true,
      },
    ],
    constraints: [],
    indexes: [],
    newConstraints: [],
    newIndexes: [],
    pkName: null,
    rest: { partitioned: false, partitionKey: null, partitionOf: null, partitionBound: null, triggers: [] },
  }
}

const cols = (list: string) =>
  list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(ident)
    .join(', ')

/** What's wrong with the model, in words; empty when it can be scripted. */
export function problems(m: EditModel): string[] {
  const out: string[] = []
  if (!m.name.trim()) out.push('The table needs a name.')
  if (!m.columns.length) out.push('A table needs at least one column.')
  const names = m.columns.map((c) => c.name.trim())
  if (names.some((n) => !n)) out.push('Every column needs a name.')
  const dup = names.find((n, i) => n && names.indexOf(n) !== i)
  if (dup) out.push(`Two columns are called ${dup}.`)
  if (m.columns.some((c) => !c.type.trim())) out.push('Every column needs a type.')
  for (const c of m.newConstraints) {
    if (c.kind === 'check' && !c.expression.trim()) out.push('A new check needs its expression.')
    if (c.kind !== 'check' && !c.columns.trim())
      out.push(`A new ${c.kind === 'unique' ? 'unique constraint' : 'foreign key'} needs its columns.`)
    if (c.kind === 'foreign' && !c.refTable.trim())
      out.push('A new foreign key needs the table it points at.')
  }
  for (const i of m.newIndexes) if (!i.columns.trim()) out.push('A new index needs its columns.')
  return out
}

/**
 * The table as the edit wants it, plus which columns were renamed (new name → live name), ready for
 * diffTable(desired, live, renamed) — or for createTableChange when the table is new.
 */
export function toTable(m: EditModel): { table: SnapTable; renamed: Map<string, string> } {
  const name = m.name.trim()
  const columns: SnapColumn[] = m.columns.map((c) => ({
    name: c.name.trim(),
    type: c.type.trim(),
    notNull: c.notNull || c.pk,
    identity: c.identity,
    generated: c.generated,
    default: c.identity || c.generated ? null : c.default.trim() || null,
    collation: c.collation,
    comment: c.comment.trim() || null,
  }))
  const pkCols = m.columns.filter((c) => c.pk).map((c) => c.name.trim())
  const constraints: SnapConstraint[] = []
  if (pkCols.length)
    constraints.push({
      name: m.pkName ?? `${name}_pkey`,
      type: 'p',
      definition: `PRIMARY KEY (${cols(pkCols.join(','))})`,
    })
  constraints.push(...m.constraints.filter((c) => !c.removed).map(({ removed: _, ...c }) => c))
  for (const c of m.newConstraints) {
    // Postgres' own naming: orders_customer_id_fkey, orders_code_key, orders_check.
    const auto =
      c.kind === 'check'
        ? `${name}_check`
        : `${name}_${c.columns.split(',')[0].trim()}_${c.kind === 'foreign' ? 'fkey' : 'key'}`
    const cname = c.name.trim() || auto
    if (c.kind === 'unique')
      constraints.push({ name: cname, type: 'u', definition: `UNIQUE (${cols(c.columns)})` })
    else if (c.kind === 'check')
      constraints.push({ name: cname, type: 'c', definition: `CHECK (${c.expression.trim()})` })
    else
      constraints.push({
        name: cname,
        type: 'f',
        definition:
          `FOREIGN KEY (${cols(c.columns)}) REFERENCES ${c.refTable.trim()}` +
          (c.refColumns.trim() ? `(${cols(c.refColumns)})` : '') +
          (c.onDelete !== 'NO ACTION' ? ` ON DELETE ${c.onDelete}` : ''),
      })
  }
  const table = { schema: m.schema.trim(), name } as const
  const indexes: SnapIndex[] = [
    ...m.indexes.filter((i) => !i.removed).map(({ removed: _, ...i }) => i),
    ...m.newIndexes.map((i) => {
      const iname =
        i.name.trim() ||
        `${name}_${i.columns
          .split(',')
          .map((s) => s.trim())
          .join('_')}_idx`
      return {
        name: iname,
        definition: `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${ident(iname)} ON ${ident(table.schema)}.${ident(name)} USING btree (${cols(i.columns)})`,
      }
    }),
  ]
  const renamed = new Map<string, string>()
  for (const c of m.columns) if (c.was && c.was !== c.name.trim()) renamed.set(c.name.trim(), c.was)
  return {
    table: { ...table, ...m.rest, comment: m.comment.trim() || null, columns, constraints, indexes },
    renamed,
  }
}
