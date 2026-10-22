/** A schema's structure as the backend reads it (SchemaChanges/SnapshotReader.cs). Names in definitions are schema-qualified. */

export interface SnapColumn {
  name: string
  type: string
  notNull: boolean
  /** '' none, 'a' GENERATED ALWAYS AS IDENTITY, 'd' BY DEFAULT */
  identity: '' | 'a' | 'd'
  /** expression of a stored generated column */
  generated: string | null
  default: string | null
  collation: string | null
  comment: string | null
}

export interface SnapConstraint {
  name: string
  /** p primary key, u unique, c check, f foreign key, x exclusion */
  type: 'p' | 'u' | 'c' | 'f' | 'x'
  definition: string
}

export interface SnapIndex {
  name: string
  definition: string
}

export interface SnapTrigger {
  name: string
  definition: string
}

export interface SnapTable {
  schema: string
  name: string
  partitioned: boolean
  partitionKey: string | null
  partitionOf: string | null
  partitionBound: string | null
  comment: string | null
  columns: SnapColumn[]
  constraints: SnapConstraint[]
  indexes: SnapIndex[]
  triggers: SnapTrigger[]
}

export interface SnapView {
  schema: string
  name: string
  materialized: boolean
  definition: string
  columns: string[]
  comment: string | null
  indexes: SnapIndex[]
}

export interface SnapFunction {
  schema: string
  name: string
  arguments: string
  kind: 'f' | 'p'
  result: string | null
  definition: string
}

export interface SnapEnum {
  schema: string
  name: string
  labels: string[]
}

export interface SnapSequence {
  schema: string
  name: string
  type: string
  start: number
  increment: number
  min: number
  max: number
  cache: number
  cycle: boolean
  /** schema.table.column (quoted) of the serial column it belongs to */
  ownedBy: string | null
}

export interface SchemaSnapshot {
  serverVersion: string
  schemas: string[]
  tables: SnapTable[]
  views: SnapView[]
  functions: SnapFunction[]
  enums: SnapEnum[]
  sequences: SnapSequence[]
}
