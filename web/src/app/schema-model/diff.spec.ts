import { describe, expect, it } from 'vitest'
import { diffSnapshots, diffTable, script, statements, tableDefinition } from './diff'
import { SchemaSnapshot, SnapColumn, SnapTable } from './snapshot'

const col = (name: string, type: string, extra: Partial<SnapColumn> = {}): SnapColumn => ({
  name,
  type,
  notNull: false,
  identity: '',
  generated: null,
  default: null,
  collation: null,
  comment: null,
  ...extra,
})

const table = (name: string, extra: Partial<SnapTable> = {}): SnapTable => ({
  schema: 'shop',
  name,
  partitioned: false,
  partitionKey: null,
  partitionOf: null,
  partitionBound: null,
  comment: null,
  columns: [col('id', 'bigint', { notNull: true, identity: 'a' })],
  constraints: [{ name: `${name}_pkey`, type: 'p', definition: 'PRIMARY KEY (id)' }],
  indexes: [],
  triggers: [],
  ...extra,
})

const snapshot = (extra: Partial<SchemaSnapshot> = {}): SchemaSnapshot => ({
  serverVersion: '18',
  schemas: ['shop'],
  tables: [],
  views: [],
  functions: [],
  enums: [],
  sequences: [],
  ...extra,
})

describe('diffSnapshots', () => {
  it('creates a missing table before the foreign key that points at it, drops nothing by default', () => {
    const customers = table('customers')
    const orders = table('orders', {
      columns: [
        col('id', 'bigint', { notNull: true, identity: 'a' }),
        col('customer_id', 'bigint', { notNull: true }),
      ],
      constraints: [
        { name: 'orders_pkey', type: 'p', definition: 'PRIMARY KEY (id)' },
        {
          name: 'orders_customer_id_fkey',
          type: 'f',
          definition: 'FOREIGN KEY (customer_id) REFERENCES shop.customers(id)',
        },
      ],
      indexes: [
        {
          name: 'orders_customer_idx',
          definition: 'CREATE INDEX orders_customer_idx ON shop.orders USING btree (customer_id)',
        },
      ],
    })
    const changes = diffSnapshots(
      snapshot({ tables: [orders, customers] }),
      snapshot({ tables: [table('legacy')] }),
    )
    expect(changes.map((c) => [c.status, c.name, c.destructive])).toEqual([
      ['create', 'shop.orders', false],
      ['create', 'shop.customers', false],
      ['drop', 'shop.legacy', true],
    ])
    const sql = statements(changes.filter((c) => !c.destructive))
    expect(sql.findIndex((s) => s.startsWith('CREATE TABLE shop.customers'))).toBeLessThan(
      sql.findIndex((s) => s.includes('orders_customer_id_fkey')),
    )
    expect(sql[0]).toBe(
      'CREATE TABLE shop.orders (\n    id bigint GENERATED ALWAYS AS IDENTITY,\n    customer_id bigint NOT NULL,\n    CONSTRAINT orders_pkey PRIMARY KEY (id)\n)',
    )
  })

  it('alters columns in place: type, default, nullability; drops are separate and destructive', () => {
    const source = table('orders', {
      columns: [
        col('id', 'bigint', { notNull: true, identity: 'a' }),
        col('status', 'varchar(20)', { notNull: true, default: "'new'::character varying" }),
        col('total', 'numeric(12,2)'),
      ],
    })
    const target = table('orders', {
      columns: [
        col('id', 'bigint', { notNull: true, identity: 'a' }),
        col('status', 'text', { default: "'new'::text" }),
        col('legacy', 'text'),
      ],
    })
    const changes = diffSnapshots(snapshot({ tables: [source] }), snapshot({ tables: [target] }))
    expect(changes.map((c) => [c.status, c.name, c.summary])).toEqual([
      ['alter', 'shop.orders.status', "type text → varchar(20), default 'new'::character varying, NOT NULL"],
      ['create', 'shop.orders.total', 'missing in target'],
      ['drop', 'shop.orders.legacy', 'only in target — its data goes with it'],
    ])
    expect(statements(changes.slice(0, 2))).toEqual([
      'ALTER TABLE shop.orders ALTER COLUMN status DROP DEFAULT',
      'ALTER TABLE shop.orders ALTER COLUMN status TYPE varchar(20) USING status::varchar(20)',
      "ALTER TABLE shop.orders ALTER COLUMN status SET DEFAULT 'new'::character varying",
      'ALTER TABLE shop.orders ALTER COLUMN status SET NOT NULL',
      'ALTER TABLE shop.orders ADD COLUMN total numeric(12,2)',
    ])
  })

  it('sees an index under another name as a rename, and a changed one as drop + create', () => {
    const def = (name: string, cols: string) => ({
      name,
      definition: `CREATE INDEX ${name} ON shop.orders USING btree (${cols})`,
    })
    const changes = diffSnapshots(
      snapshot({
        tables: [
          table('orders', {
            indexes: [def('orders_placed_idx', 'placed_at'), def('orders_status_idx', 'status, placed_at')],
          }),
        ],
      }),
      snapshot({
        tables: [
          table('orders', {
            indexes: [def('idx_old_name', 'placed_at'), def('orders_status_idx', 'status')],
          }),
        ],
      }),
    )
    expect(changes.map((c) => c.summary)).toEqual(['renamed from idx_old_name', 'definition differs'])
    expect(statements(changes)).toEqual([
      'ALTER INDEX shop.idx_old_name RENAME TO orders_placed_idx',
      'DROP INDEX shop.orders_status_idx',
      'CREATE INDEX orders_status_idx ON shop.orders USING btree (status, placed_at)',
    ])
  })

  it('adds enum values in place, and says what it cannot do', () => {
    const changes = diffSnapshots(
      snapshot({ enums: [{ schema: 'shop', name: 'status', labels: ['new', 'paid', 'shipped'] }] }),
      snapshot({ enums: [{ schema: 'shop', name: 'status', labels: ['new', 'shipped', 'void'] }] }),
    )
    expect(statements(changes)).toEqual(["ALTER TYPE shop.status ADD VALUE 'paid' AFTER 'new'"])
    expect(changes[0].note).toContain("can't remove enum values (void)")
  })

  it('replaces a view that only gains columns, rebuilds one that loses some', () => {
    const view = (columns: string[], definition: string) => ({
      schema: 'shop',
      name: 'v',
      materialized: false,
      columns,
      definition,
      comment: null,
      indexes: [],
    })
    const grows = diffSnapshots(
      snapshot({ views: [view(['a', 'b'], ' SELECT 1 AS a, 2 AS b;')] }),
      snapshot({ views: [view(['a'], ' SELECT 1 AS a;')] }),
    )
    expect(statements(grows)).toEqual(['CREATE OR REPLACE VIEW shop.v AS\nSELECT 1 AS a, 2 AS b'])
    const shrinks = diffSnapshots(
      snapshot({ views: [view(['b'], ' SELECT 2 AS b;')] }),
      snapshot({ views: [view(['a', 'b'], ' SELECT 1 AS a, 2 AS b;')] }),
    )
    expect(statements(shrinks)).toEqual(['DROP VIEW shop.v', 'CREATE VIEW shop.v AS\nSELECT 2 AS b'])
  })

  it('finds nothing to do between equal snapshots', () => {
    const s = snapshot({ tables: [table('orders')], enums: [{ schema: 'shop', name: 'e', labels: ['a'] }] })
    expect(diffSnapshots(s, structuredClone(s))).toEqual([])
  })
})

describe('diffTable (table editor)', () => {
  it('renames a column first, then alters it under its new name', () => {
    const live = table('orders', { columns: [col('id', 'bigint'), col('note', 'text')] })
    const edited = table('orders', {
      columns: [col('id', 'bigint'), col('remark', 'text', { notNull: true })],
    })
    const changes = diffTable(edited, live, new Map([['remark', 'note']]))
    expect(changes.map((c) => c.summary)).toEqual(['renamed from note, NOT NULL'])
    expect(statements(changes)).toEqual([
      'ALTER TABLE shop.orders RENAME COLUMN note TO remark',
      'ALTER TABLE shop.orders ALTER COLUMN remark SET NOT NULL',
    ])
  })

  it('renames the table before anything else touches it', () => {
    const changes = diffTable(
      table('purchases', { columns: [col('id', 'bigint'), col('x', 'int')] }),
      table('orders', { columns: [col('id', 'bigint')] }),
    )
    expect(statements(changes)[0]).toBe('ALTER TABLE shop.orders RENAME TO purchases')
    expect(statements(changes)[1]).toBe('ALTER TABLE shop.purchases ADD COLUMN x int')
  })
})

describe('tableDefinition', () => {
  it('is the whole table: sequence, table, indexes, foreign keys, comments', () => {
    const t = table('items', {
      columns: [
        col('id', 'integer', { notNull: true, default: "nextval('shop.items_id_seq'::regclass)" }),
        col('name', 'text', { comment: "it's the name" }),
      ],
      constraints: [{ name: 'items_pkey', type: 'p', definition: 'PRIMARY KEY (id)' }],
      comment: 'Things',
    })
    const sql = tableDefinition(t, [
      {
        schema: 'shop',
        name: 'items_id_seq',
        type: 'integer',
        start: 1,
        increment: 1,
        min: 1,
        max: 2147483647,
        cache: 1,
        cycle: false,
        ownedBy: 'shop.items.id',
      },
    ])
    expect(sql).toBe(
      [
        'CREATE SEQUENCE shop.items_id_seq AS integer INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 NO CYCLE START WITH 1;',
        "CREATE TABLE shop.items (\n    id integer DEFAULT nextval('shop.items_id_seq'::regclass) NOT NULL,\n    name text,\n    CONSTRAINT items_pkey PRIMARY KEY (id)\n);",
        'ALTER SEQUENCE shop.items_id_seq OWNED BY shop.items.id;',
        "COMMENT ON TABLE shop.items IS 'Things';",
        "COMMENT ON COLUMN shop.items.name IS 'it''s the name';",
      ].join('\n\n'),
    )
    expect(script([])).toBe('')
  })
})
