using Npgsql;

namespace Yadbc.Host.Catalog;

public sealed record CatalogObject(string Schema, string Name, uint Oid, string Kind, long? EstRows, string? Comment);

public sealed record CatalogColumn(
    string Name, string Type, bool Nullable, string? Default, bool PrimaryKey, string? References, string? Comment);

public sealed record CatalogIndex(string Name, string Definition, bool Unique, bool Primary);

public sealed record CatalogConstraint(string Name, string Kind, string Definition);

public sealed record CatalogRelation(
    List<CatalogColumn> Columns, List<CatalogIndex> Indexes, List<CatalogConstraint> Constraints, List<string> PrimaryKey);

/// <summary>
/// pg_catalog queries behind the schema tree, autocomplete and the MCP tools. Callers bring the
/// connection (always from the read-only catalog pool).
/// </summary>
public static class CatalogReader
{
    /// <summary>System and temp schemas are noise in a browser.</summary>
    const string UserSchemas = """
        n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname !~ '^pg_(toast|temp)'
        """;

    public static async Task<(List<string> Schemas, List<CatalogObject> Objects)> ObjectsAsync(NpgsqlConnection conn, CancellationToken ct)
    {
        var schemas = new List<string>();
        await using (var cmd = new NpgsqlCommand($"select n.nspname from pg_namespace n where {UserSchemas} order by 1", conn))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct)) schemas.Add(r.GetString(0));

        var objects = new List<CatalogObject>();
        await using (var cmd = new NpgsqlCommand($"""
            select n.nspname, c.relname, c.oid,
                   case c.relkind when 'r' then 'table' when 'p' then 'table' when 'v' then 'view'
                                  when 'm' then 'matview' when 'f' then 'foreign' when 'S' then 'sequence' end,
                   case when c.relkind in ('r', 'p', 'm') and c.reltuples >= 0 then c.reltuples::bigint end,
                   obj_description(c.oid, 'pg_class')
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and not c.relispartition and {UserSchemas}
              -- sequences behind serial/identity columns are an implementation detail of their table
              and not (c.relkind = 'S' and exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype in ('a', 'i')))
            union all
            select n.nspname, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', p.oid,
                   case p.prokind when 'p' then 'procedure' else 'function' end, null, obj_description(p.oid, 'pg_proc')
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where p.prokind in ('f', 'p') and {UserSchemas}
              -- functions installed by extensions (pgcrypto, postgis…) would drown the user's own
              and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
            union all
            select n.nspname, t.typname, t.oid, 'enum', null, obj_description(t.oid, 'pg_type')
            from pg_type t join pg_namespace n on n.oid = t.typnamespace
            where t.typtype = 'e' and {UserSchemas}
            order by 1, 4, 2
            """, conn))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
        {
            while (await r.ReadAsync(ct))
                objects.Add(new CatalogObject(r.GetString(0), r.GetString(1), r.GetFieldValue<uint>(2), r.GetString(3),
                    r.IsDBNull(4) ? null : r.GetInt64(4), r.IsDBNull(5) ? null : r.GetString(5)));
        }
        return (schemas, objects);
    }

    /// <summary>Columns (with PK/FK marks), indexes and constraints of one table, view or materialized view.</summary>
    public static async Task<CatalogRelation> RelationAsync(NpgsqlConnection conn, uint oid, CancellationToken ct)
    {
        var constraints = new List<(CatalogConstraint C, short[] Keys, string? Ref)>();
        await using (var cmd = new NpgsqlCommand("""
            select conname, contype::text, pg_get_constraintdef(oid, true), coalesce(conkey, '{}'),
                   case when contype = 'f' then confrelid::regclass::text end
            from pg_constraint where conrelid = $1
              -- PG 18 lists NOT NULL as constraints; the column already says it
              and contype <> 'n'
            order by contype, conname
            """, conn))
        {
            cmd.Parameters.Add(new NpgsqlParameter { Value = oid, DataTypeName = "oid" });
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
            {
                var kind = r.GetString(1) switch { "p" => "primary key", "f" => "foreign key", "u" => "unique", "c" => "check", "x" => "exclusion", var k => k };
                constraints.Add((new CatalogConstraint(r.GetString(0), kind, r.GetString(2)), r.GetFieldValue<short[]>(3), r.IsDBNull(4) ? null : r.GetString(4)));
            }
        }

        var pk = constraints.Where(c => c.C.Kind == "primary key").SelectMany(c => c.Keys).ToHashSet();
        // Single-column FKs mark the column; composite ones are listed under constraints.
        var fk = constraints.Where(c => c.C.Kind == "foreign key" && c.Keys.Length == 1)
            .GroupBy(c => c.Keys[0]).ToDictionary(g => g.Key, g => g.First().Ref);

        var columns = new List<CatalogColumn>();
        await using (var cmd = new NpgsqlCommand("""
            select a.attnum, a.attname, format_type(a.atttypid, a.atttypmod), not a.attnotnull,
                   case when a.attidentity <> '' then 'identity'
                        when a.attgenerated <> '' then 'generated: ' || pg_get_expr(d.adbin, d.adrelid)
                        else pg_get_expr(d.adbin, d.adrelid) end,
                   col_description(a.attrelid, a.attnum)
            from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
            where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped
            order by a.attnum
            """, conn))
        {
            cmd.Parameters.Add(new NpgsqlParameter { Value = oid, DataTypeName = "oid" });
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
            {
                var att = r.GetInt16(0);
                columns.Add(new CatalogColumn(r.GetString(1), r.GetString(2), r.GetBoolean(3),
                    r.IsDBNull(4) ? null : r.GetString(4), pk.Contains(att), fk.GetValueOrDefault(att),
                    r.IsDBNull(5) ? null : r.GetString(5)));
            }
        }

        var indexes = new List<CatalogIndex>();
        await using (var cmd = new NpgsqlCommand("""
            select i.relname, pg_get_indexdef(x.indexrelid), x.indisunique, x.indisprimary
            from pg_index x join pg_class i on i.oid = x.indexrelid
            where x.indrelid = $1 order by x.indisprimary desc, i.relname
            """, conn))
        {
            cmd.Parameters.Add(new NpgsqlParameter { Value = oid, DataTypeName = "oid" });
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
                indexes.Add(new CatalogIndex(r.GetString(0), r.GetString(1), r.GetBoolean(2), r.GetBoolean(3)));
        }

        return new CatalogRelation(columns, indexes, constraints.Select(c => c.C).ToList(),
            columns.Where(c => c.PrimaryKey).Select(c => c.Name).ToList());
    }

    /// <summary>Source of a view, materialized view or function; null for other kinds.</summary>
    public static async Task<string?> DefinitionAsync(NpgsqlConnection conn, string kind, uint oid, CancellationToken ct)
    {
        var sql = kind switch
        {
            "view" => "select 'CREATE OR REPLACE VIEW ' || $1::regclass::text || E' AS\\n' || pg_get_viewdef($1, true)",
            "matview" => "select 'CREATE MATERIALIZED VIEW ' || $1::regclass::text || E' AS\\n' || pg_get_viewdef($1, true)",
            "function" or "procedure" => "select pg_get_functiondef($1)",
            _ => null,
        };
        if (sql is null) return null;
        await using var cmd = new NpgsqlCommand(sql, conn);
        cmd.Parameters.Add(new NpgsqlParameter { Value = oid, DataTypeName = "oid" });
        return (string?)await cmd.ExecuteScalarAsync(ct);
    }

    /// <summary>
    /// Resolves a relation name the way Postgres does (search_path, quoting rules) — `users`,
    /// `billing.payments`, `"MixedCase"` — to its OID; null when it doesn't exist.
    /// </summary>
    public static async Task<uint?> ResolveRelationAsync(NpgsqlConnection conn, string name, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("select to_regclass($1)::oid", conn);
        cmd.Parameters.AddWithValue(name);
        var result = await cmd.ExecuteScalarAsync(ct);
        return result is uint oid ? oid : null;
    }
}
