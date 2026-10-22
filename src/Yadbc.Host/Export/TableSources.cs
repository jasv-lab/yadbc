using Npgsql;
using Yadbc.Host.Connections;
using Yadbc.Host.Query;

namespace Yadbc.Host.Export;

/// <summary>Where a result's columns come from.</summary>
public sealed class ResultSource(IReadOnlyList<string?> columnTables, IReadOnlyList<string?> baseColumns,
    IReadOnlyDictionary<string, IReadOnlyList<int>> primaryKeys)
{
    public static readonly ResultSource Unknown = new([], [], new Dictionary<string, IReadOnlyList<int>>());

    /// <summary>Qualified, quoted table per result column; null for computed columns.</summary>
    public IReadOnlyList<string?> ColumnTables { get; } = columnTables;

    /// <summary>Real column name behind each result column (aliases resolved); null for computed columns.</summary>
    public IReadOnlyList<string?> BaseColumns { get; } = baseColumns;

    /// <summary>The single table all given columns come from, or null (mixed, computed, unknown).</summary>
    public string? TableOf(IEnumerable<int> columns)
    {
        var tables = columns.Select(c => c < ColumnTables.Count ? ColumnTables[c] : null).Distinct().ToList();
        return tables is [{ } t] ? t : null;
    }

    /// <summary>Result column indexes of the table's primary key, if all of them are present in the result.</summary>
    public IReadOnlyList<int>? PrimaryKey(string table) => primaryKeys.GetValueOrDefault(table);
}

/// <summary>
/// Resolves table OIDs from the row description to names and primary keys — on demand, once per
/// result, over its own short-lived connection so it never runs inside the tab's transaction.
/// </summary>
public sealed class TableSources(DataSourceCache dataSources)
{
    public Task<ResultSource> Get(ResultBuffer buffer, CancellationToken ct)
    {
        // Don't cache a failure (e.g. connection blip) forever.
        if (buffer.Source is { IsFaulted: true } or { IsCanceled: true }) buffer.Source = null;
        return buffer.Source ??= Resolve(buffer, ct);
    }

    async Task<ResultSource> Resolve(ResultBuffer buffer, CancellationToken ct)
    {
        var oids = buffer.Columns.Select(c => c.TableOid).Where(o => o != 0).Distinct().Select(o => (long)o).ToArray();
        if (oids.Length == 0) return ResultSource.Unknown;

        await using var conn = await dataSources.OpenCatalogAsync(buffer.ConnectionId, ct);

        var tables = new Dictionary<uint, (string Name, short[] Pk)>();
        await using (var cmd = new NpgsqlCommand("""
            select c.oid, n.nspname, c.relname,
                   coalesce((select array_agg(k.attnum order by k.ord)
                             from pg_index i, unnest(i.indkey) with ordinality k(attnum, ord)
                             where i.indrelid = c.oid and i.indisprimary), '{}')::int2[]
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where c.oid = any($1::oid[])
            """, conn))
        {
            cmd.Parameters.Add(new NpgsqlParameter { Value = oids });
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
                tables[r.GetFieldValue<uint>(0)] = ($"{Sql.Ident(r.GetString(1))}.{Sql.Ident(r.GetString(2))}", r.GetFieldValue<short[]>(3));
        }

        var names = new Dictionary<(uint, short), string>();
        await using (var cmd = new NpgsqlCommand(
            "select attrelid, attnum, attname from pg_attribute where attrelid = any($1::oid[]) and attnum > 0", conn))
        {
            cmd.Parameters.Add(new NpgsqlParameter { Value = oids });
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
                names[(r.GetFieldValue<uint>(0), r.GetInt16(1))] = r.GetString(2);
        }

        var cols = buffer.Columns;
        var columnTables = cols.Select(c => tables.TryGetValue(c.TableOid, out var t) ? t.Name : null).ToList();
        var baseColumns = cols.Select(c => names.GetValueOrDefault((c.TableOid, c.ColumnAttr))).ToList();

        var primaryKeys = new Dictionary<string, IReadOnlyList<int>>();
        foreach (var (oid, t) in tables)
        {
            if (t.Pk.Length == 0) continue;
            var indexes = t.Pk.Select(att => IndexOf(cols, oid, att)).ToList();
            if (indexes.All(i => i >= 0)) primaryKeys[t.Name] = indexes;
        }

        return new ResultSource(columnTables, baseColumns, primaryKeys);
    }

    static int IndexOf(IReadOnlyList<ColumnInfo> cols, uint tableOid, short attnum)
    {
        for (var i = 0; i < cols.Count; i++)
            if (cols[i].TableOid == tableOid && cols[i].ColumnAttr == attnum) return i;
        return -1;
    }
}
