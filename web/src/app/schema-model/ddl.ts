import { ident, qualified } from '../schema/catalog'
import { SnapColumn, SnapEnum, SnapSequence, SnapTable, SnapView } from './snapshot'

/**
 * SQL builders for the snapshot model. Everything they emit is schema-qualified; definitions taken
 * from Postgres (constraints, indexes, views, functions, triggers) are used as Postgres wrote them.
 */

export const q = qualified

export function str(s: string | null): string {
  return s === null ? 'NULL' : `'${s.replace(/'/g, "''")}'`
}

/** `name type [COLLATE] [GENERATED …] [DEFAULT …] [NOT NULL]` */
export function columnSql(c: SnapColumn): string {
  let s = `${ident(c.name)} ${c.type}`
  if (c.collation) s += ` COLLATE ${c.collation}`
  if (c.generated) s += ` GENERATED ALWAYS AS (${c.generated}) STORED`
  else if (c.identity) s += ` GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`
  else if (c.default) s += ` DEFAULT ${c.default}`
  if (c.notNull && !c.identity) s += ' NOT NULL'
  return s
}

/** CREATE TABLE with its columns and its own constraints, except foreign keys (they go last, when every table exists). */
export function createTableSql(t: SnapTable): string {
  if (t.partitionOf)
    return `CREATE TABLE ${q(t)} PARTITION OF ${t.partitionOf} ${t.partitionBound ?? 'DEFAULT'}`
  const lines = [
    ...t.columns.map(columnSql),
    ...t.constraints.filter((c) => c.type !== 'f').map((c) => `CONSTRAINT ${ident(c.name)} ${c.definition}`),
  ]
  const body = lines.length ? `(\n    ${lines.join(',\n    ')}\n)` : '()'
  return `CREATE TABLE ${q(t)} ${body}${t.partitioned && t.partitionKey ? ` PARTITION BY ${t.partitionKey}` : ''}`
}

export function addConstraintSql(
  t: { schema: string; name: string },
  name: string,
  definition: string,
): string {
  return `ALTER TABLE ${q(t)} ADD CONSTRAINT ${ident(name)} ${definition}`
}

export function dropConstraintSql(t: { schema: string; name: string }, name: string): string {
  return `ALTER TABLE ${q(t)} DROP CONSTRAINT ${ident(name)}`
}

export function commentOnTableSql(t: SnapTable): string {
  return `COMMENT ON TABLE ${q(t)} IS ${str(t.comment)}`
}

export function commentOnColumnSql(t: { schema: string; name: string }, c: SnapColumn): string {
  return `COMMENT ON COLUMN ${q(t)}.${ident(c.name)} IS ${str(c.comment)}`
}

/** pg_get_viewdef ends its query with a semicolon; a statement around it can't. */
export function viewBody(definition: string): string {
  return definition.trim().replace(/;$/, '')
}

export function createViewSql(v: SnapView, orReplace = false): string {
  const kind = v.materialized ? 'MATERIALIZED VIEW' : 'VIEW'
  return `CREATE ${orReplace ? 'OR REPLACE ' : ''}${kind} ${q(v)} AS\n${viewBody(v.definition)}`
}

export function dropViewSql(v: SnapView): string {
  return `DROP ${v.materialized ? 'MATERIALIZED VIEW' : 'VIEW'} ${q(v)}`
}

export function createEnumSql(e: SnapEnum): string {
  return `CREATE TYPE ${q(e)} AS ENUM (${e.labels.map(str).join(', ')})`
}

export function sequenceOptions(s: SnapSequence): string {
  return `AS ${s.type} INCREMENT BY ${s.increment} MINVALUE ${s.min} MAXVALUE ${s.max} CACHE ${s.cache} ${s.cycle ? 'CYCLE' : 'NO CYCLE'}`
}

export function createSequenceSql(s: SnapSequence): string {
  return `CREATE SEQUENCE ${q(s)} ${sequenceOptions(s)} START WITH ${s.start}`
}

/** Index and trigger definitions name the object; comparing them shouldn't. */
export function withoutName(definition: string, name: string): string {
  return normalize(definition.replace(` ${ident(name)} `, ' ? '))
}

export function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
