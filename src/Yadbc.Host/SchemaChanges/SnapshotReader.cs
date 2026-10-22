using Npgsql;

namespace Yadbc.Host.SchemaChanges;

// A schema's structure, as the UI compares and scripts it (web/src/app/schema-model). Definitions come
// from Postgres' own pg_get_*def functions, read with search_path = pg_catalog so that every name in
// them is schema-qualified and the scripts built from them run whatever the target's search_path is.

public sealed record SnapColumn(
    string Name,
    string Type,
    bool NotNull,
    /// <summary>"" none, "a" GENERATED ALWAYS AS IDENTITY, "d" BY DEFAULT.</summary>
    string Identity,
    /// <summary>The expression of a stored generated column.</summary>
    string? Generated,
    string? Default,
    /// <summary>Only when it differs from the type's default collation.</summary>
    string? Collation,
    string? Comment);

public sealed record SnapConstraint(string Name, string Type, string Definition);

public sealed record SnapIndex(string Name, string Definition);

public sealed record SnapTrigger(string Name, string Definition);

public sealed record SnapTable(
    string Schema,
    string Name,
    bool Partitioned,
    string? PartitionKey,
    /// <summary>For a partition: its parent (qualified) and FOR VALUES bound.</summary>
    string? PartitionOf,
    string? PartitionBound,
    string? Comment,
    List<SnapColumn> Columns,
    List<SnapConstraint> Constraints,
    List<SnapIndex> Indexes,
    List<SnapTrigger> Triggers);

public sealed record SnapView(
    string Schema,
    string Name,
    bool Materialized,
    string Definition,
    List<string> Columns,
    string? Comment,
    List<SnapIndex> Indexes);

public sealed record SnapFunction(
    string Schema,
    string Name,
    string Arguments,
    /// <summary>"f" function, "p" procedure.</summary>
    string Kind,
    string? Result,
    string Definition);

public sealed record SnapEnum(string Schema, string Name, List<string> Labels);

public sealed record SnapSequence(
    string Schema,
    string Name,
    string Type,
    long Start,
    long Increment,
    long Min,
    long Max,
    long Cache,
    bool Cycle,
    /// <summary>schema.table.column (quoted) of a serial column it belongs to.</summary>
    string? OwnedBy);

public sealed record SchemaSnapshot(
    string ServerVersion,
    List<string> Schemas,
    List<SnapTable> Tables,
    List<SnapView> Views,
    List<SnapFunction> Functions,
    List<SnapEnum> Enums,
    List<SnapSequence> Sequences);

public static class SnapshotReader
{
    // Objects an extension created (pg_stat_statements' views, hypopg's functions…) aren't the user's schema.
    const string NotFromExtension = "not exists (select 1 from pg_depend e where e.objid = {0} and e.deptype = 'e')";

    const string UserSchema = "n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'";

    /// <summary>
    /// The given schemas (null = every user schema), or just one table and its sequences (table definition,
    /// table editor). Read-only, in one transaction so it's a consistent picture.
    /// </summary>
    public static async Task<SchemaSnapshot> ReadAsync(
        NpgsqlConnection conn,
        string[]? schemas,
        (string Schema, string Name)? table,
        CancellationToken ct)
    {
        await using var tx = await conn.BeginTransactionAsync(ct);
        await Exec(conn, "set local search_path = pg_catalog", ct);
        if (table is { } t) schemas = [t.Schema];

        var schemaNames = await List(conn, $"""
            select n.nspname from pg_namespace n
            where {UserSchema} and ($1::text[] is null or n.nspname = any($1)) and {string.Format(NotFromExtension, "n.oid")}
            order by n.nspname
            """, r => r.GetString(0), ct, Param(schemas));

        var tableRows = await List(conn, $"""
            select c.oid, n.nspname, c.relname, c.relkind = 'p',
                   case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end,
                   case when c.relispartition then (select h.inhparent::regclass::text from pg_inherits h where h.inhrelid = c.oid) end,
                   case when c.relispartition then pg_get_expr(c.relpartbound, c.oid) end,
                   obj_description(c.oid, 'pg_class')
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where c.relkind in ('r', 'p') and {UserSchema} and n.nspname = any($1)
              and ($2::text is null or c.relname = $2) and {string.Format(NotFromExtension, "c.oid")}
            order by c.relispartition, c.oid
            """,
            r => (Oid: r.GetFieldValue<uint>(0), Table: new SnapTable(r.GetString(1), r.GetString(2), r.GetBoolean(3),
                Str(r, 4), Str(r, 5), Str(r, 6), Str(r, 7), [], [], [], [])),
            ct, Param(schemaNames.ToArray()), Param(table?.Name));
        var tables = tableRows.ToDictionary(x => x.Oid, x => x.Table);
        var oids = tables.Keys.ToArray();

        foreach (var (rel, col) in await List(conn, """
            select a.attrelid, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attidentity::text,
                   a.attgenerated::text, pg_get_expr(d.adbin, d.adrelid),
                   case when a.attcollation <> 0 and a.attcollation <> t.typcollation then a.attcollation::regcollation::text end,
                   col_description(a.attrelid, a.attnum)
            from pg_attribute a
            join pg_type t on t.oid = a.atttypid
            left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
            where a.attrelid = any($1) and a.attnum > 0 and not a.attisdropped
            order by a.attrelid, a.attnum
            """,
            r =>
            {
                var generated = r.GetString(5) == "s";
                var expr = Str(r, 6);
                return (r.GetFieldValue<uint>(0), new SnapColumn(r.GetString(1), r.GetString(2), r.GetBoolean(3), r.GetString(4),
                    generated ? expr : null, generated ? null : expr, Str(r, 7), Str(r, 8)));
            }, ct, Oids(oids)))
            tables[rel].Columns.Add(col);

        // Not-null constraints (PG 18 lists them here too) are the columns' NOT NULL; partitions'
        // cloned constraints belong to their parent.
        foreach (var (rel, con) in await List(conn, """
            select conrelid, conname, contype::text, pg_get_constraintdef(oid, true)
            from pg_constraint
            where conrelid = any($1) and contype in ('p', 'u', 'c', 'f', 'x') and conparentid = 0 and conislocal
            order by conrelid, contype, conname
            """, r => (r.GetFieldValue<uint>(0), new SnapConstraint(r.GetString(1), r.GetString(2), r.GetString(3))), ct, Oids(oids)))
            tables[rel].Constraints.Add(con);

        var viewRows = table is null
            ? await List(conn, $"""
                select c.oid, n.nspname, c.relname, c.relkind = 'm', pg_get_viewdef(c.oid, true),
                       array(select a.attname::text from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped order by a.attnum),
                       obj_description(c.oid, 'pg_class')
                from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where c.relkind in ('v', 'm') and n.nspname = any($1) and {string.Format(NotFromExtension, "c.oid")}
                order by c.oid
                """,
                r => (Oid: r.GetFieldValue<uint>(0), View: new SnapView(r.GetString(1), r.GetString(2), r.GetBoolean(3),
                    r.GetString(4), [.. r.GetFieldValue<string[]>(5)], Str(r, 6), [])),
                ct, Param(schemaNames.ToArray()))
            : [];
        var views = viewRows.ToDictionary(x => x.Oid, x => x.View);

        // Indexes of their own, not the ones behind a PK / unique / exclusion constraint (those come with it),
        // and not a partition's copy of its parent's index.
        foreach (var (rel, idx) in await List(conn, """
            select x.indrelid, i.relname, pg_get_indexdef(x.indexrelid)
            from pg_index x join pg_class i on i.oid = x.indexrelid
            where x.indrelid = any($1)
              and not exists (select 1 from pg_constraint k where k.conindid = x.indexrelid and k.contype in ('p', 'u', 'x'))
              and not exists (select 1 from pg_inherits h where h.inhrelid = x.indexrelid)
            order by x.indrelid, i.relname
            """, r => (r.GetFieldValue<uint>(0), new SnapIndex(r.GetString(1), r.GetString(2))), ct, Oids([.. oids, .. views.Keys])))
        {
            if (tables.TryGetValue(rel, out var tbl)) tbl.Indexes.Add(idx);
            else views[rel].Indexes.Add(idx);
        }

        foreach (var (rel, trg) in await List(conn, """
            select tgrelid, tgname, pg_get_triggerdef(oid, true)
            from pg_trigger where tgrelid = any($1) and not tgisinternal and tgparentid = 0
            order by tgrelid, tgname
            """, r => (r.GetFieldValue<uint>(0), new SnapTrigger(r.GetString(1), r.GetString(2))), ct, Oids(oids)))
            tables[rel].Triggers.Add(trg);

        var functions = table is null
            ? await List(conn, $"""
                select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), p.prokind::text,
                       pg_get_function_result(p.oid), pg_get_functiondef(p.oid)
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where p.prokind in ('f', 'p') and n.nspname = any($1) and {string.Format(NotFromExtension, "p.oid")}
                order by n.nspname, p.proname, 3
                """, r => new SnapFunction(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), Str(r, 4), r.GetString(5)),
                ct, Param(schemaNames.ToArray()))
            : [];

        var enums = table is null
            ? await List(conn, $"""
                select n.nspname, t.typname, array(select e.enumlabel::text from pg_enum e where e.enumtypid = t.oid order by e.enumsortorder)
                from pg_type t join pg_namespace n on n.oid = t.typnamespace
                where t.typtype = 'e' and n.nspname = any($1) and {string.Format(NotFromExtension, "t.oid")}
                order by n.nspname, t.typname
                """, r => new SnapEnum(r.GetString(0), r.GetString(1), [.. r.GetFieldValue<string[]>(2)]), ct, Param(schemaNames.ToArray()))
            : [];

        // Standalone and serial sequences; identity columns' sequences are part of the column.
        var sequences = await List(conn, $"""
            select n.nspname, c.relname, format_type(s.seqtypid, null), s.seqstart, s.seqincrement, s.seqmin, s.seqmax,
                   s.seqcache, s.seqcycle, o.owned_by
            from pg_sequence s
            join pg_class c on c.oid = s.seqrelid
            join pg_namespace n on n.oid = c.relnamespace
            left join lateral (
                select quote_ident(tn.nspname) || '.' || quote_ident(tc.relname) || '.' || quote_ident(a.attname) owned_by, tc.oid table_oid
                from pg_depend d
                join pg_class tc on tc.oid = d.refobjid join pg_namespace tn on tn.oid = tc.relnamespace
                join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
                where d.objid = c.oid and d.classid = 'pg_class'::regclass and d.deptype = 'a'
            ) o on true
            where n.nspname = any($1) and {string.Format(NotFromExtension, "c.oid")}
              and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'i')
              and ($2::oid[] is null or o.table_oid = any($2))
            order by n.nspname, c.relname
            """,
            r => new SnapSequence(r.GetString(0), r.GetString(1), r.GetString(2), r.GetInt64(3), r.GetInt64(4), r.GetInt64(5),
                r.GetInt64(6), r.GetInt64(7), r.GetBoolean(8), Str(r, 9)),
            ct, Param(schemaNames.ToArray()), table is null ? new NpgsqlParameter { Value = DBNull.Value, DataTypeName = "oid[]" } : Oids(oids));

        await tx.CommitAsync(ct);
        return new SchemaSnapshot(conn.PostgreSqlVersion.ToString(), schemaNames, [.. tables.Values], [.. views.Values], functions, enums, sequences);
    }

    static string? Str(NpgsqlDataReader r, int i) => r.IsDBNull(i) ? null : r.GetString(i);

    static NpgsqlParameter Param(object? value) =>
        value switch
        {
            null => new NpgsqlParameter { Value = DBNull.Value },
            string[] a => new NpgsqlParameter { Value = a, DataTypeName = "text[]" },
            _ => new NpgsqlParameter { Value = value },
        };

    static NpgsqlParameter Oids(uint[] oids) => new() { Value = oids, DataTypeName = "oid[]" };

    static async Task Exec(NpgsqlConnection conn, string sql, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand(sql, conn);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    static async Task<List<T>> List<T>(NpgsqlConnection conn, string sql, Func<NpgsqlDataReader, T> map, CancellationToken ct, params NpgsqlParameter[] parameters)
    {
        await using var cmd = new NpgsqlCommand(sql, conn);
        foreach (var p in parameters) cmd.Parameters.Add(p);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        var list = new List<T>();
        while (await r.ReadAsync(ct)) list.Add(map(r));
        return list;
    }
}
