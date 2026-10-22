using Npgsql;
using Yadbc.Host.Connections;
using Yadbc.Host.Export;

namespace Yadbc.Host.Catalog;

/// <summary>
/// "Where else is this value?" — across every user table of the connection. Columns are picked by type
/// family (a uuid is looked for in uuid columns, a number in number columns…); integers only in key-like
/// columns (primary/foreign keys, indexed, named id / *_id), or every quantity column would "match" 3.
/// The UI asks for the plan once, then searches table by table, so it can show progress and stop.
/// </summary>
public static class ValueSearch
{
    static readonly Dictionary<string, string[]> Families = new()
    {
        ["uuid"] = ["uuid"],
        ["int"] = ["int2", "int4", "int8", "oid"],
        ["decimal"] = ["numeric", "float4", "float8", "money"],
        ["text"] = ["text", "varchar", "bpchar", "citext", "name"],
        ["date"] = ["date"],
        ["timestamp"] = ["timestamp"],
        ["timestamptz"] = ["timestamptz"],
        ["inet"] = ["inet", "cidr"],
    };

    /// <summary>The family a result column's type belongs to, or null when searching for it makes no sense (json, bool…).</summary>
    public static string? FamilyOf(string type) =>
        Families.FirstOrDefault(f => f.Value.Contains(type)).Key;

    public sealed record Candidate(string Schema, string Table, List<string> Columns, double EstRows);

    public static async Task<List<Candidate>> PlanAsync(NpgsqlConnection conn, string family, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("""
            select n.nspname, c.relname, a.attname, greatest(c.reltuples, 0)::float8,
                   exists (select 1 from pg_index i where i.indrelid = c.oid and a.attnum = any(i.indkey))
                or exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype in ('p', 'u', 'f') and a.attnum = any(k.conkey))
                or a.attname ~* '(^id$|_id$)'
            from pg_attribute a
            join pg_class c on c.oid = a.attrelid
            join pg_namespace n on n.oid = c.relnamespace
            join pg_type t on t.oid = a.atttypid
            -- A domain searches like its base type.
            left join pg_type b on b.oid = t.typbasetype
            where c.relkind in ('r', 'p', 'm') and not c.relispartition
              and a.attnum > 0 and not a.attisdropped
              and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'
              and coalesce(b.typname, t.typname) = any($1)
              and has_table_privilege(c.oid, 'select')
            order by n.nspname, c.relname, a.attnum
            """, conn) { Parameters = { new() { Value = Families[family] } } };
        var list = new List<Candidate>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
        {
            if (family == "int" && !r.GetBoolean(4)) continue;
            var (schema, table) = (r.GetString(0), r.GetString(1));
            if (list.LastOrDefault() is { } last && last.Schema == schema && last.Table == table) last.Columns.Add(r.GetString(2));
            else list.Add(new Candidate(schema, table, [r.GetString(2)], r.GetDouble(3)));
        }
        return list;
    }

    public sealed record Hit(string Column, int Rows);

    /// <summary>
    /// Rows of one table where any of the columns equals the value (up to 101 counted), per column.
    /// Table and columns come from the client, so they're checked against the catalog and quoted here;
    /// the value is a parameter cast to each column's own type, so indexes apply. Read-only, 5 s timeout.
    /// </summary>
    public static async Task<(List<Hit> Hits, string? Error)> SearchTableAsync(
        DataSourceCache sources, string connectionId, string schema, string table, List<string> columns, string value, CancellationToken ct)
    {
        await using var conn = await sources.OpenCatalogAsync(connectionId, ct);
        var types = new Dictionary<string, string>();
        await using (var cmd = new NpgsqlCommand("""
            select a.attname, format_type(a.atttypid, a.atttypmod)
            from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = $1 and c.relname = $2 and a.attname = any($3) and a.attnum > 0 and not a.attisdropped
            """, conn) { Parameters = { new() { Value = schema }, new() { Value = table }, new() { Value = columns.ToArray() } } })
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct)) types[r.GetString(0)] = r.GetString(1);
        var cols = columns.Where(types.ContainsKey).ToList();
        if (cols.Count == 0) return ([], null);

        var conds = cols.Select(c => $"{Sql.Ident(c)} = $1::{types[c]}").ToList();
        var sql = $"select {string.Join(", ", conds.Select((c, i) => $"({c}) as m{i}"))} " +
                  $"from {Sql.Ident(schema)}.{Sql.Ident(table)} where {string.Join(" or ", conds)} limit 101";
        try
        {
            await using var tx = await conn.BeginTransactionAsync(ct);
            await using (var t = new NpgsqlCommand("set local statement_timeout = '5s'", conn, tx)) await t.ExecuteNonQueryAsync(ct);
            await using var cmd = new NpgsqlCommand(sql, conn, tx) { Parameters = { new() { Value = value } } };
            var counts = new int[cols.Count];
            await using (var r = await cmd.ExecuteReaderAsync(ct))
                while (await r.ReadAsync(ct))
                    for (var i = 0; i < cols.Count; i++)
                        if (!r.IsDBNull(i) && r.GetBoolean(i)) counts[i]++;
            await tx.CommitAsync(ct);
            return (cols.Select((c, i) => new Hit(c, counts[i])).Where(h => h.Rows > 0).ToList(), null);
        }
        catch (PostgresException pg) when (pg.SqlState == PostgresErrorCodes.QueryCanceled)
        {
            return ([], "timed out after 5 s");
        }
        catch (PostgresException pg) when (pg.SqlState is PostgresErrorCodes.InvalidTextRepresentation or PostgresErrorCodes.InvalidDatetimeFormat
                                               or PostgresErrorCodes.NumericValueOutOfRange or PostgresErrorCodes.StringDataRightTruncation)
        {
            // The value can't even be this column's type (an id too big for int4, text longer than varchar(n)).
            return ([], null);
        }
    }
}
