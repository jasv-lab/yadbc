using Npgsql;

namespace Yadbc.Host.Catalog;

public sealed record DiagramColumn(string Name, string Type, bool NotNull, bool PrimaryKey, bool ForeignKey);

public sealed record DiagramTable(
    string Id,
    string Schema,
    string Name,
    double EstRows,
    string? Comment,
    /// <summary>In another schema, here because a foreign key crosses over: drawn faded, keys only.</summary>
    bool External,
    List<DiagramColumn> Columns);

public sealed record DiagramKeyRef(string Table, List<string> Columns);

public sealed record DiagramRelation(string Name, DiagramKeyRef From, DiagramKeyRef To, bool Nullable);

/// <summary>
/// One schema as an entity–relationship graph: its tables with their columns, and every foreign key
/// that touches them (composite ones too). Tables of other schemas at either end of such a key come
/// along as external nodes with just their key columns.
/// </summary>
public static class DiagramReader
{
    public static async Task<object> ReadAsync(NpgsqlConnection conn, string schema, CancellationToken ct)
    {
        var tables = new Dictionary<uint, (string Schema, string Name, double Rows, string? Comment)>();
        await using (var cmd = new NpgsqlCommand("""
            select c.oid, n.nspname, c.relname, greatest(c.reltuples, 0)::float8, obj_description(c.oid, 'pg_class')
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = $1 and c.relkind in ('r', 'p') and not c.relispartition
            """, conn) { Parameters = { new() { Value = schema } } })
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct))
                tables[r.GetFieldValue<uint>(0)] = (r.GetString(1), r.GetString(2), r.GetDouble(3), r.IsDBNull(4) ? null : r.GetString(4));

        // Foreign keys from or to this schema's tables; the far end may live elsewhere.
        var fks = new List<(string Name, uint From, short[] FromCols, uint To, short[] ToCols)>();
        if (tables.Count > 0)
        {
            await using var cmd = new NpgsqlCommand("""
                select conname, conrelid, conkey, confrelid, confkey
                from pg_constraint
                where contype = 'f' and (conrelid = any($1) or confrelid = any($1))
                order by conname
                """, conn) { Parameters = { new() { Value = tables.Keys.ToArray(), DataTypeName = "oid[]" } } };
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
                fks.Add((r.GetString(0), r.GetFieldValue<uint>(1), r.GetFieldValue<short[]>(2), r.GetFieldValue<uint>(3), r.GetFieldValue<short[]>(4)));
        }

        var external = fks.SelectMany(f => new[] { f.From, f.To }).Where(o => !tables.ContainsKey(o)).Distinct().ToArray();
        if (external.Length > 0)
        {
            await using var cmd = new NpgsqlCommand("""
                select c.oid, n.nspname, c.relname, greatest(c.reltuples, 0)::float8
                from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = any($1)
                """, conn) { Parameters = { new() { Value = external, DataTypeName = "oid[]" } } };
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
                tables[r.GetFieldValue<uint>(0)] = (r.GetString(1), r.GetString(2), r.GetDouble(3), null);
        }

        var all = tables.Keys.ToArray();
        var columns = new Dictionary<uint, List<(short Num, string Name, string Type, bool NotNull)>>();
        var pks = new Dictionary<uint, HashSet<short>>();
        if (all.Length > 0)
        {
            await using (var cmd = new NpgsqlCommand("""
                select attrelid, attnum, attname, format_type(atttypid, atttypmod), attnotnull
                from pg_attribute where attrelid = any($1) and attnum > 0 and not attisdropped
                order by attrelid, attnum
                """, conn) { Parameters = { new() { Value = all, DataTypeName = "oid[]" } } })
            await using (var r = await cmd.ExecuteReaderAsync(ct))
                while (await r.ReadAsync(ct))
                {
                    var oid = r.GetFieldValue<uint>(0);
                    if (!columns.TryGetValue(oid, out var list)) columns[oid] = list = [];
                    list.Add((r.GetInt16(1), r.GetString(2), r.GetString(3), r.GetBoolean(4)));
                }

            await using (var cmd = new NpgsqlCommand("""
                select indrelid, indkey::int2[] from pg_index where indisprimary and indrelid = any($1)
                """, conn) { Parameters = { new() { Value = all, DataTypeName = "oid[]" } } })
            await using (var r = await cmd.ExecuteReaderAsync(ct))
                while (await r.ReadAsync(ct))
                    pks[r.GetFieldValue<uint>(0)] = [.. r.GetFieldValue<short[]>(1)];
        }

        string Id(uint oid) => $"{tables[oid].Schema}.{tables[oid].Name}";
        string ColName(uint oid, short num) => columns.GetValueOrDefault(oid)?.FirstOrDefault(c => c.Num == num).Name ?? $"#{num}";

        var fkCols = fks.SelectMany(f => f.FromCols.Select(c => (f.From, c))).ToHashSet();
        var referenced = fks.SelectMany(f => f.ToCols.Select(c => (f.To, c))).ToHashSet();

        var outTables = tables.Select(kv =>
        {
            var (oid, t) = (kv.Key, kv.Value);
            var isExternal = t.Schema != schema;
            var pk = pks.GetValueOrDefault(oid) ?? [];
            var cols = (columns.GetValueOrDefault(oid) ?? [])
                // External tables only show what the relations attach to.
                .Where(c => !isExternal || pk.Contains(c.Num) || fkCols.Contains((oid, c.Num)) || referenced.Contains((oid, c.Num)))
                .Select(c => new DiagramColumn(c.Name, c.Type, c.NotNull, pk.Contains(c.Num), fkCols.Contains((oid, c.Num))))
                .ToList();
            return new DiagramTable(Id(oid), t.Schema, t.Name, t.Rows, t.Comment, isExternal, cols);
        }).OrderBy(t => t.External).ThenBy(t => t.Name).ToList();

        var relations = fks.Select(f => new DiagramRelation(
            f.Name,
            new DiagramKeyRef(Id(f.From), f.FromCols.Select(c => ColName(f.From, c)).ToList()),
            new DiagramKeyRef(Id(f.To), f.ToCols.Select(c => ColName(f.To, c)).ToList()),
            // Optional relation: some referencing column may be NULL.
            f.FromCols.Any(c => columns.GetValueOrDefault(f.From)?.FirstOrDefault(x => x.Num == c).NotNull == false))).ToList();

        return new { schema, tables = outTables, relations };
    }
}
