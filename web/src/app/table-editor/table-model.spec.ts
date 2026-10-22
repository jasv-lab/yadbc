import { describe, expect, it } from 'vitest'
import { createTableChange, diffTable, statements } from '../schema-model/diff'
import { SnapTable } from '../schema-model/snapshot'
import { fromTable, keyColumns, newTable, nextKey, problems, toTable } from './table-model'

const live: SnapTable = {
  schema: 'shop',
  name: 'orders',
  partitioned: false,
  partitionKey: null,
  partitionOf: null,
  partitionBound: null,
  comment: null,
  columns: [
    {
      name: 'id',
      type: 'bigint',
      notNull: true,
      identity: 'a',
      generated: null,
      default: null,
      collation: null,
      comment: null,
    },
    {
      name: 'status',
      type: 'text',
      notNull: true,
      identity: '',
      generated: null,
      default: "'new'::text",
      collation: null,
      comment: null,
    },
    {
      name: 'note',
      type: 'text',
      notNull: false,
      identity: '',
      generated: null,
      default: null,
      collation: null,
      comment: null,
    },
  ],
  constraints: [{ name: 'orders_pkey', type: 'p', definition: 'PRIMARY KEY (id)' }],
  indexes: [
    {
      name: 'orders_status_idx',
      definition: 'CREATE INDEX orders_status_idx ON shop.orders USING btree (status)',
    },
  ],
  triggers: [],
}

const sql = (m: ReturnType<typeof fromTable>) => {
  const { table, renamed } = toTable(m)
  return statements(diffTable(table, live, renamed))
}

describe('table model', () => {
  it('round-trips an unchanged table to no statements', () => {
    expect(sql(fromTable(live))).toEqual([])
  })

  it('turns edits into renames and alters, not drops', () => {
    const m = fromTable(live)
    m.columns[2].name = 'remark'
    m.columns[2].notNull = true
    m.indexes[0].removed = true
    m.newIndexes.push({ key: nextKey(), name: '', columns: 'status, remark', unique: false })
    m.newConstraints.push({
      key: nextKey(),
      kind: 'check',
      name: '',
      columns: '',
      expression: "status <> ''",
      refTable: '',
      refColumns: '',
      onDelete: 'NO ACTION',
    })
    expect(sql(m)).toEqual([
      'ALTER TABLE shop.orders RENAME COLUMN note TO remark',
      'ALTER TABLE shop.orders ALTER COLUMN remark SET NOT NULL',
      "ALTER TABLE shop.orders ADD CONSTRAINT orders_check CHECK (status <> '')",
      'CREATE INDEX orders_status_remark_idx ON shop.orders USING btree (status, remark)',
      'DROP INDEX shop.orders_status_idx',
    ])
  })

  it('moves the primary key by dropping and re-adding it under its old name', () => {
    const m = fromTable(live)
    m.columns[1].pk = true
    expect(sql(m)).toEqual([
      'ALTER TABLE shop.orders DROP CONSTRAINT orders_pkey',
      'ALTER TABLE shop.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id, status)',
    ])
  })

  it('builds a new table with a foreign key after it', () => {
    const m = newTable('shop')
    m.name = 'order_notes'
    m.columns.push({
      key: nextKey(),
      was: null,
      name: 'order_id',
      type: 'bigint',
      notNull: true,
      default: '',
      identity: '',
      generated: null,
      collation: null,
      comment: '',
      pk: false,
    })
    m.newConstraints.push({
      key: nextKey(),
      kind: 'foreign',
      name: '',
      columns: 'order_id',
      expression: '',
      refTable: 'shop.orders',
      refColumns: 'id',
      onDelete: 'CASCADE',
    })
    expect(statements([createTableChange(toTable(m).table)])).toEqual([
      'CREATE TABLE shop.order_notes (\n    id bigint GENERATED ALWAYS AS IDENTITY,\n    order_id bigint NOT NULL,\n    CONSTRAINT order_notes_pkey PRIMARY KEY (id)\n)',
      'ALTER TABLE shop.order_notes ADD CONSTRAINT order_notes_order_id_fkey FOREIGN KEY (order_id) REFERENCES shop.orders(id) ON DELETE CASCADE',
    ])
  })

  it('says what is missing', () => {
    const m = newTable('shop')
    m.columns.push({ ...m.columns[0], key: nextKey(), was: null })
    expect(problems(m)).toEqual(['The table needs a name.', 'Two columns are called id.'])
  })

  it('reads quoted key columns', () => {
    expect(keyColumns('PRIMARY KEY (id, "Odd ""name""")')).toEqual(['id', 'Odd "name"'])
  })
})
