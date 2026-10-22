using System.Runtime.CompilerServices;
using Npgsql;
using Yadbc.Host.Connections;
using Yadbc.Host.Export;
using Yadbc.Host.Query;

namespace Yadbc.Host.Navigation;

/// <summary>A table as both parts (for matching against SQL text) and a ready, quoted reference.</summary>
public sealed record TableRef(string Schema, string Name)
{
    public string Sql => $"{Export.Sql.Ident(Schema)}.{Export.Sql.Ident(Name)}";
}

public sealed record EnumInfo(string Type, List<string> Values);

/// <summary>This column → another table's key (a single-column foreign key).</summary>
public sealed record OutgoingKey(string Constraint, TableRef Table, string Column, string? LabelColumn, double EstRows);

/// <summary>Another table's column → this column.</summary>
public sealed record IncomingKey(string Constraint, TableRef Table, string Column);

public sealed record ColumnRelations(
    TableRef? Table,
    string? Column,
    EnumInfo? Enum,
    OutgoingKey? References,
    List<IncomingKey> ReferencedBy);

public sealed record PickValue(string Value, string? Label);

/// <summary>
/// What each result column is related to: its source column (from the row description, so aliases and
/// joins don't matter), enum labels, the single-column foreign key it holds, and the foreign keys that
/// point at it. Composite keys are left out — "go to" one column of them would be wrong. Resolved once
/// per result over the read-only catalog pool and cached with the buffer.
/// </summary>
public sealed class RelationReader(DataSourceCache dataSources)
{
    /// <summary>Above this many rows a referenced table is searched, not listed.</summary>
    public const int ListLimit = 100;

    /// <summary>Columns that read well as the human side of a key, in order of preference.</summary>
    static readonly string[] LabelNames =
        ["name", "title", "label", "display_name", "display", "code", "username", "email", "description", "slug"];

    readonly ConditionalWeakTable<ResultBuffer, Task<List<ColumnRelations>>> _cache = new();

    public Task<List<ColumnRelations>> Get(ResultBuffer buffer, CancellationToken ct)
    {
        if (_cache.TryGetValue(buffer, out var cached) && !cached.IsFaulted && !cached.IsCanceled) return cached;
        var task = Resolve(buffer, ct);
        _cache.AddOrUpdate(buffer, task);
        return task;
    }

    async Task<List<ColumnRelations>> Resolve(ResultBuffer buffer, CancellationToken ct)
    {
        var cols = buffer.Columns;
        var tableOids = cols.Select(c => c.TableOid).Where(o => o != 0).Distinct().ToArray();
        var typeOids = cols.Select(c => c.TypeOid).Where(o => o != 0).Distinct().ToArray();
        await using var conn = await dataSources.OpenCatalogAsync(buffer.ConnectionId, ct);

        var tables = new Dictionary<uint, TableRef>();
        var attNames = new Dictionary<(uint, short), string>();
        if (tableOids.Length > 0)
        {
            await using (var cmd = Cmd(conn, """
                select c.oid, n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where c.oid = any($1)
                """, tableOids))
            await using (var r = await cmd.ExecuteReaderAsync(ct))
                while (await r.ReadAsync(ct)) tables[r.GetFieldValue<uint>(0)] = new TableRef(r.GetString(1), r.GetString(2));

            await using (var cmd = Cmd(conn, "select attrelid, attnum, attname from pg_attribute where attrelid = any($1) and attnum > 0", tableOids))
            await using (var r = await cmd.ExecuteReaderAsync(ct))
                while (await r.ReadAsync(ct)) attNames[(r.GetFieldValue<uint>(0), r.GetInt16(1))] = r.GetString(2);
        }

        var enums = new Dictionary<uint, EnumInfo>();
        if (typeOids.Length > 0)
        {
            await using var cmd = Cmd(conn, """
                select t.oid, format_type(t.oid, null), array_agg(e.enumlabel::text order by e.enumsortorder)
                from pg_type t join pg_enum e on e.enumtypid = t.oid
                where t.oid = any($1) group by t.oid
                """, typeOids);
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct)) enums[r.GetFieldValue<uint>(0)] = new EnumInfo(r.GetString(1), [.. r.GetFieldValue<string[]>(2)]);
        }

        var outgoing = new Dictionary<(uint, short), (OutgoingKey Key, uint Target)>();
        var incoming = new Dictionary<(uint, short), List<IncomingKey>>();
        if (tableOids.Length > 0)
        {
            await using (var cmd = Cmd(conn, """
                select c.conrelid, c.conkey[1], c.conname, c.confrelid, n.nspname, t.relname, a.attname, greatest(t.reltuples, 0)::float8
                from pg_constraint c
                join pg_class t on t.oid = c.confrelid
                join pg_namespace n on n.oid = t.relnamespace
                join pg_attribute a on a.attrelid = c.confrelid and a.attnum = c.confkey[1]
                where c.contype = 'f' and cardinality(c.conkey) = 1 and c.conrelid = any($1)
                """, tableOids))
            await using (var r = await cmd.ExecuteReaderAsync(ct))
                while (await r.ReadAsync(ct))
                    outgoing[(r.GetFieldValue<uint>(0), r.GetInt16(1))] = (
                        new OutgoingKey(r.GetString(2), new TableRef(r.GetString(4), r.GetString(5)), r.GetString(6), null, r.GetDouble(7)),
                        r.GetFieldValue<uint>(3));

            await using (var cmd = Cmd(conn, """
                select c.confrelid, c.confkey[1], c.conname, n.nspname, t.relname, a.attname
                from pg_constraint c
                join pg_class t on t.oid = c.conrelid
                join pg_namespace n on n.oid = t.relnamespace
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
                where c.contype = 'f' and cardinality(c.confkey) = 1 and c.confrelid = any($1)
                order by n.nspname, t.relname, a.attname
                """, tableOids))
            await using (var r = await cmd.ExecuteReaderAsync(ct))
                while (await r.ReadAsync(ct))
                {
                    var key = (r.GetFieldValue<uint>(0), r.GetInt16(1));
                    if (!incoming.TryGetValue(key, out var list)) incoming[key] = list = [];
                    list.Add(new IncomingKey(r.GetString(2), new TableRef(r.GetString(3), r.GetString(4)), r.GetString(5)));
                }
        }

        // The label column of each referenced table, so a picker can say "3 · Pro plan" rather than "3".
        var labels = new Dictionary<uint, string?>();
        var targets = outgoing.Values.Select(o => o.Target).Distinct().ToArray();
        if (targets.Length > 0)
        {
            var columnsOf = new Dictionary<uint, List<(string Name, string Type, bool NotNull)>>();
            await using (var cmd = Cmd(conn, """
                select attrelid, attname, format_type(atttypid, null), attnotnull
                from pg_attribute where attrelid = any($1) and attnum > 0 and not attisdropped order by attrelid, attnum
                """, targets))
            await using (var r = await cmd.ExecuteReaderAsync(ct))
                while (await r.ReadAsync(ct))
                {
                    var oid = r.GetFieldValue<uint>(0);
                    if (!columnsOf.TryGetValue(oid, out var l)) columnsOf[oid] = l = [];
                    l.Add((r.GetString(1), r.GetString(2), r.GetBoolean(3)));
                }
            foreach (var (_, (key, target)) in outgoing)
                labels[target] = PickLabel(columnsOf.GetValueOrDefault(target) ?? [], key.Column);
        }

        return cols.Select(c =>
        {
            var at = (c.TableOid, c.ColumnAttr);
            var references = outgoing.TryGetValue(at, out var o) ? o.Key with { LabelColumn = labels.GetValueOrDefault(o.Target) } : null;
            return new ColumnRelations(
                tables.GetValueOrDefault(c.TableOid),
                attNames.GetValueOrDefault(at),
                enums.GetValueOrDefault(c.TypeOid),
                references,
                incoming.GetValueOrDefault(at) ?? []);
        }).ToList();
    }

    /// <summary>A well-known name first, NOT NULL ones before nullable (a label that's often empty labels nothing).</summary>
    static string? PickLabel(List<(string Name, string Type, bool NotNull)> columns, string keyColumn)
    {
        var candidates = columns.Where(c => c.Name != keyColumn).OrderByDescending(c => c.NotNull).ToList();
        var named = candidates
            .Select(c => (c.Name, Rank: Array.FindIndex(LabelNames, n => n.Equals(c.Name, StringComparison.OrdinalIgnoreCase)), c.NotNull))
            .Where(c => c.Rank >= 0)
            .OrderByDescending(c => c.NotNull).ThenBy(c => c.Rank)
            .FirstOrDefault();
        if (named.Name is not null) return named.Name;
        return candidates.FirstOrDefault(c => c.Type is "text" or "character varying" or "character" or "citext").Name;
    }

    /// <summary>
    /// What may go in a column: enum labels, or the referenced table's keys with their label. Small tables
    /// are listed whole; bigger ones are searched by <paramref name="q"/> (key equal, or label/key containing
    /// it). Read-only, with a short timeout — the search may scan a big table.
    /// </summary>
    public async Task<(List<PickValue> Values, bool Truncated)> ValuesAsync(
        ResultBuffer buffer, int column, string? q, CancellationToken ct)
    {
        var rel = (await Get(buffer, ct))[column];
        if (rel.Enum is { } e)
            return (e.Values.Select(v => new PickValue(v, null)).ToList(), false);
        if (rel.References is not { } fk) return ([], false);

        var key = Export.Sql.Ident(fk.Column);
        var label = fk.LabelColumn is null ? null : Export.Sql.Ident(fk.LabelColumn);
        var search = string.IsNullOrWhiteSpace(q) ? null : q.Trim();
        var where = search is null ? "" : label is null
            ? $"where {key}::text ilike $1 || '%'"
            : $"where {key}::text = $1 or {label}::text ilike '%' || $1 || '%'";
        var sortLabel = label is null ? null : $"nullif({label}::text, '')";
        var order = label is null ? $"{key}" : $"({key}::text = $1) desc, {sortLabel} nulls last, {key}";
        if (search is null) order = label is null ? key : $"{sortLabel} nulls last, {key}";

        await using var conn = await dataSources.OpenCatalogAsync(buffer.ConnectionId, ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await using (var timeout = new NpgsqlCommand("set local statement_timeout = '3s'", conn, tx))
            await timeout.ExecuteNonQueryAsync(ct);
        await using var cmd = new NpgsqlCommand(
            $"select {key}::text, {(label is null ? "null" : $"{label}::text")} from {fk.Table.Sql} {where} order by {order} limit {ListLimit + 1}",
            conn, tx);
        if (search is not null) cmd.Parameters.Add(new NpgsqlParameter { Value = search });
        var values = new List<PickValue>();
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct))
                if (!r.IsDBNull(0)) values.Add(new PickValue(r.GetString(0), r.IsDBNull(1) ? null : r.GetString(1)));
        await tx.CommitAsync(ct);
        var truncated = values.Count > ListLimit;
        return (truncated ? values[..ListLimit] : values, truncated);
    }

    static NpgsqlCommand Cmd(NpgsqlConnection conn, string sql, uint[] oids) =>
        new(sql, conn) { Parameters = { new NpgsqlParameter { Value = oids, DataTypeName = "oid[]" } } };
}
