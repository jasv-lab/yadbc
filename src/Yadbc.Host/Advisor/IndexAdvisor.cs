using System.Text.RegularExpressions;
using Npgsql;

namespace Yadbc.Host.Advisor;

public sealed record HypoStatus(bool Installed, bool Available);

/// <summary>One statement a suggestion would speed up (workload mode).</summary>
public sealed record QueryImpact(long? QueryId, string Query, long Calls, double TotalMs, double MeanMs, double CostBefore, double? CostAfter, bool? Used);

public sealed class Suggestion
{
    public required string Table { get; init; }
    public required List<string> Columns { get; init; }
    public required string Ddl { get; init; }
    public required List<string> Reasons { get; init; }
    /// <summary>Estimated cost of the statement now / with this index (HypoPG). Statement mode only.</summary>
    public double? CostBefore { get; set; }
    public double? CostAfter { get; set; }
    /// <summary>1 - after/before; null without HypoPG.</summary>
    public double? Improvement { get; set; }
    /// <summary>Whether the planner picked the hypothetical index at all; null without HypoPG.</summary>
    public bool? Used { get; set; }
    public long? SizeBytes { get; set; }
    public List<QueryImpact>? Queries { get; set; }
    /// <summary>Workload mode: statement time this index would save (sum of total time × cost improvement), or
    /// without HypoPG the time attributable to the scans it targets.</summary>
    public double? SavedMs { get; set; }
    public double? AttributedMs { get; set; }
    public double CostShare { get; set; }
}

/// <summary>
/// Turns plans into index suggestions. With HypoPG each candidate is created hypothetically (in this
/// backend only, nothing is built), the statement re-planned, and the cost difference reported —
/// candidates the planner wouldn't use are marked as such. Runs on a catalog-pool connection: HypoPG
/// works in a read-only session, and EXPLAIN without ANALYZE never executes the statement.
/// </summary>
public static partial class IndexAdvisor
{
    const int WorkloadQueries = 40;
    const int WorkloadCandidates = 12;
    const int QueriesPerCandidate = 8;

    public static async Task<object> StatementAsync(NpgsqlConnection conn, string sql, CancellationToken ct)
    {
        var hypo = await HypoStatusAsync(conn, ct);
        sql = sql.Trim().TrimEnd(';');
        string plan;
        try
        {
            plan = await ExplainAsync(conn, sql, false, ct);
        }
        catch (PostgresException pg)
        {
            // Temp tables or session settings of the tab aren't visible from the advisor's own session.
            return new { hypopg = hypo, suggestions = Array.Empty<Suggestion>(), notes = Array.Empty<string>(), error = $"Couldn't plan it from a separate session: {pg.MessageText}" };
        }

        var rels = await RelationsAsync(conn, PlanAnalyzer.Relations(plan), ct);
        var (candidates, notes) = PlanAnalyzer.Analyze(plan, (s, t) => rels.GetValueOrDefault((s, t)));
        var before = PlanAnalyzer.RootCost(plan);
        var suggestions = candidates.Select(c => ToSuggestion(c, before)).ToList();

        if (hypo.Installed && candidates.Count > 0)
        {
            try
            {
                for (var i = 0; i < candidates.Count; i++)
                {
                    var (oid, name) = await HypoCreateAsync(conn, candidates[i], ct);
                    var after = await ExplainAsync(conn, sql, false, ct);
                    suggestions[i].CostAfter = PlanAnalyzer.RootCost(after);
                    suggestions[i].Used = after.Contains(name);
                    suggestions[i].Improvement = before > 0 ? 1 - suggestions[i].CostAfter / before : null;
                    suggestions[i].SizeBytes = await HypoSizeAsync(conn, oid, ct);
                    await HypoDropAsync(conn, oid, ct);
                }
            }
            finally
            {
                await HypoResetAsync(conn);
            }
        }

        return new
        {
            hypopg = hypo,
            costBefore = before,
            suggestions = Rank(suggestions),
            notes,
            error = (string?)null,
        };
    }

    /// <summary>
    /// The statements pg_stat_statements says take the most time, each planned (generic plan for their $1
    /// parameters), analyzed, and the candidates merged across statements and ranked by the time
    /// they'd save. Plus two cheap context lists: tables read mostly by sequential scans, unused indexes.
    /// </summary>
    public static async Task<object> WorkloadAsync(NpgsqlConnection conn, CancellationToken ct)
    {
        var hypo = await HypoStatusAsync(conn, ct);
        var major = conn.PostgreSqlVersion.Major;
        var errors = new List<string>();
        var notes = new List<string>();
        var (statsState, statements, since) = await StatementsAsync(conn, ct);

        var merged = new Dictionary<string, (Candidate Candidate, List<(StatementRow Row, double Cost, double Share)> Hits)>();
        int analyzed = 0, skipped = 0;
        foreach (var row in statements)
        {
            var hasParams = Param().IsMatch(row.Query);
            string plan;
            try
            {
                plan = await ExplainAsync(conn, row.Query, hasParams, ct);
            }
            catch (PostgresException pg)
            {
                skipped++;
                if (errors.Count < 5) errors.Add($"{Short(row.Query, 80)} — {pg.MessageText}");
                continue;
            }
            analyzed++;
            var rels = await RelationsAsync(conn, PlanAnalyzer.Relations(plan), ct);
            var (candidates, planNotes) = PlanAnalyzer.Analyze(plan, (s, t) => rels.GetValueOrDefault((s, t)));
            foreach (var n in planNotes)
                if (!notes.Contains(n)) notes.Add(n);
            var cost = PlanAnalyzer.RootCost(plan);
            foreach (var c in candidates)
            {
                if (!merged.TryGetValue(c.Key, out var m)) merged[c.Key] = m = (c, []);
                else foreach (var r in c.Reasons) if (!m.Candidate.Reasons.Contains(r)) m.Candidate.Reasons.Add(r);
                m.Hits.Add((row, cost, c.CostShare));
            }
        }

        // An index on (a) is the leading part of one on (a, b): the longer one serves both sets of statements.
        foreach (var shorter in merged.Values.ToList())
        {
            var longer = merged.Values.Where(m => m.Candidate != shorter.Candidate && IsPrefix(shorter.Candidate, m.Candidate))
                .OrderByDescending(m => m.Hits.Sum(h => h.Row.TotalMs)).FirstOrDefault();
            if (longer.Candidate is null) continue;
            foreach (var hit in shorter.Hits)
                if (!longer.Hits.Any(h => h.Row.QueryId == hit.Row.QueryId)) longer.Hits.Add(hit);
            foreach (var r in shorter.Candidate.Reasons)
                if (!longer.Candidate.Reasons.Contains(r)) longer.Candidate.Reasons.Add(r);
            merged.Remove(shorter.Candidate.Key);
        }

        var suggestions = merged.Values.Select(m =>
        {
            var s = ToSuggestion(m.Candidate, null);
            s.AttributedMs = m.Hits.Sum(h => h.Row.TotalMs * h.Share);
            s.Queries = m.Hits.OrderByDescending(h => h.Row.TotalMs)
                .Select(h => new QueryImpact(h.Row.QueryId, Short(h.Row.Query, 600), h.Row.Calls, h.Row.TotalMs, h.Row.MeanMs, h.Cost, null, null))
                .ToList();
            return s;
        }).OrderByDescending(s => s.AttributedMs).ToList();

        if (hypo.Installed)
        {
            try
            {
                foreach (var s in suggestions.Take(WorkloadCandidates))
                {
                    var candidate = merged.Values.First(m => m.Candidate.Ddl == s.Ddl).Candidate;
                    var (oid, name) = await HypoCreateAsync(conn, candidate, ct);
                    s.SizeBytes = await HypoSizeAsync(conn, oid, ct);
                    double saved = 0;
                    var impacts = new List<QueryImpact>();
                    foreach (var q in s.Queries!)
                    {
                        if (impacts.Count >= QueriesPerCandidate)
                        {
                            impacts.Add(q);
                            continue;
                        }
                        var full = statements.First(r => r.QueryId == q.QueryId).Query;
                        var after = await ExplainAsync(conn, full, Param().IsMatch(full), ct);
                        var cost = PlanAnalyzer.RootCost(after);
                        var used = after.Contains(name);
                        if (used && q.CostBefore > 0) saved += q.TotalMs * Math.Max(0, 1 - cost / q.CostBefore);
                        impacts.Add(q with { CostAfter = cost, Used = used });
                    }
                    s.Queries = impacts;
                    s.Used = impacts.Any(q => q.Used == true);
                    s.SavedMs = saved;
                    await HypoDropAsync(conn, oid, ct);
                }
            }
            finally
            {
                await HypoResetAsync(conn);
            }
            suggestions = suggestions.OrderByDescending(s => s.Used == true).ThenByDescending(s => s.SavedMs ?? -1)
                .ThenByDescending(s => s.AttributedMs).ToList();
        }

        return new
        {
            hypopg = hypo,
            statements = new { state = statsState, since, analyzed, skipped, serverMajor = major },
            suggestions,
            notes,
            errors,
            tables = await SeqScannedTablesAsync(conn, ct),
            unusedIndexes = await UnusedIndexesAsync(conn, ct),
        };
    }

    static bool IsPrefix(Candidate a, Candidate b) =>
        a.Schema == b.Schema && a.Table == b.Table && a.Columns.Count < b.Columns.Count
        && a.Columns.SequenceEqual(b.Columns.Take(a.Columns.Count));

    static Suggestion ToSuggestion(Candidate c, double? before) => new()
    {
        Table = $"{c.Schema}.{c.Table}",
        Columns = c.Columns.Select(x => x.Name + (x.Desc ? " DESC" : "")).ToList(),
        Ddl = c.Ddl,
        Reasons = c.Reasons,
        CostBefore = before,
        CostShare = c.CostShare,
    };

    /// <summary>Proven improvements first, then unproven by how much of the cost they target, then ones the planner ignored.</summary>
    static List<Suggestion> Rank(List<Suggestion> list) =>
        list.OrderByDescending(s => s.Used != false)
            .ThenByDescending(s => s.Improvement ?? -1)
            .ThenByDescending(s => s.CostShare)
            .ToList();

    sealed record StatementRow(long QueryId, string Query, long Calls, double TotalMs, double MeanMs);

    /// <summary>
    /// The most expensive statements in this database, by total time. Only plannable DML is kept; the
    /// tools' own catalog queries (yadbc, psql \d, IDEs) would otherwise rank high and mean nothing.
    /// </summary>
    static async Task<(string State, List<StatementRow> Rows, DateTime? Since)> StatementsAsync(NpgsqlConnection conn, CancellationToken ct)
    {
        await using (var check = new NpgsqlCommand("select exists (select 1 from pg_extension where extname = 'pg_stat_statements')", conn))
            if (!(bool)(await check.ExecuteScalarAsync(ct))!)
                return ("missing", [], null);

        var rows = new List<StatementRow>();
        try
        {
            await using var cmd = new NpgsqlCommand($"""
                select s.queryid, s.query, s.calls, s.total_exec_time, s.mean_exec_time
                from pg_stat_statements s
                where s.dbid = (select oid from pg_database where datname = current_database())
                  and s.query ~* '^\s*(select|with|update|delete|insert|merge|table)\M'
                  and s.query !~* '\m(pg_catalog|information_schema|pg_stat\w*|pg_class|pg_namespace|pg_attribute|pg_index|pg_locks|hypopg\w*)\M'
                order by s.total_exec_time desc
                limit {WorkloadQueries}
                """, conn);
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
                if (!r.IsDBNull(0) && !r.IsDBNull(1))
                    rows.Add(new StatementRow(r.GetInt64(0), Plannable(r.GetString(1)), r.GetInt64(2), r.GetDouble(3), r.GetDouble(4)));
        }
        catch (PostgresException pg) when (pg.MessageText.Contains("shared_preload_libraries"))
        {
            return ("not-loaded", [], null);
        }

        DateTime? since = null;
        try
        {
            await using var info = new NpgsqlCommand("select stats_reset from pg_stat_statements_info", conn);
            since = (DateTime?)await info.ExecuteScalarAsync(ct);
        }
        catch (PostgresException)
        {
            // before PG 14 / pg_stat_statements 1.9
        }
        return ("ok", rows, since);
    }

    static async Task<object> SeqScannedTablesAsync(NpgsqlConnection conn, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("""
            select schemaname || '.' || relname, seq_scan, seq_tup_read, coalesce(idx_scan, 0), n_live_tup
            from pg_stat_user_tables
            where n_live_tup >= 1000 and seq_scan > 0
            order by seq_tup_read desc
            limit 10
            """, conn);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        var list = new List<object>();
        while (await r.ReadAsync(ct))
            list.Add(new { table = r.GetString(0), seqScans = r.GetInt64(1), seqRowsRead = r.GetInt64(2), indexScans = r.GetInt64(3), liveRows = r.GetInt64(4) });
        return list;
    }

    /// <summary>Never-scanned indexes (since the statistics reset), biggest first. Unique ones enforce something; left out.</summary>
    static async Task<object> UnusedIndexesAsync(NpgsqlConnection conn, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("""
            select s.schemaname || '.' || s.relname, s.indexrelname, pg_relation_size(s.indexrelid), pg_get_indexdef(s.indexrelid)
            from pg_stat_user_indexes s
            join pg_index i on i.indexrelid = s.indexrelid
            where s.idx_scan = 0 and not i.indisunique and not i.indisprimary
            order by pg_relation_size(s.indexrelid) desc
            limit 15
            """, conn);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        var list = new List<object>();
        while (await r.ReadAsync(ct))
            list.Add(new { table = r.GetString(0), index = r.GetString(1), sizeBytes = r.GetInt64(2), definition = r.GetString(3) });
        return list;
    }

    public static async Task<HypoStatus> HypoStatusAsync(NpgsqlConnection conn, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("""
            select exists (select 1 from pg_extension where extname = 'hypopg'),
                   exists (select 1 from pg_available_extensions where name = 'hypopg')
            """, conn);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        await r.ReadAsync(ct);
        return new HypoStatus(r.GetBoolean(0), r.GetBoolean(1));
    }

    /// <summary>
    /// EXPLAIN (VERBOSE) of a statement. Normalized statements from pg_stat_statements have $1… placeholders;
    /// EXPLAIN (GENERIC_PLAN) would take them, but Npgsql only speaks the extended protocol, where a literal $1
    /// means a bind parameter (and the failed bind leaves the connection unusable). So: PREPARE it, force a
    /// generic plan, and EXPLAIN EXECUTE with NULLs that the generic plan never looks at. Works from PG 12.
    /// </summary>
    static async Task<string> ExplainAsync(NpgsqlConnection conn, string sql, bool generic, CancellationToken ct)
    {
        if (!generic)
        {
            await using var cmd = new NpgsqlCommand($"EXPLAIN (VERBOSE, FORMAT JSON) {sql}", conn);
            return (string)(await cmd.ExecuteScalarAsync(ct))!;
        }
        var count = Param().Matches(sql).Max(m => int.Parse(m.Value[1..]));
        await ExecAsync(conn, $"PREPARE yadbc_advise AS {sql}", ct);
        try
        {
            await ExecAsync(conn, "SET plan_cache_mode = force_generic_plan", ct);
            await using var cmd = new NpgsqlCommand(
                $"EXPLAIN (VERBOSE, FORMAT JSON) EXECUTE yadbc_advise({string.Join(", ", Enumerable.Repeat("NULL", count))})", conn);
            return (string)(await cmd.ExecuteScalarAsync(ct))!;
        }
        finally
        {
            await ExecAsync(conn, "DEALLOCATE yadbc_advise; RESET plan_cache_mode", CancellationToken.None);
        }
    }

    static async Task ExecAsync(NpgsqlConnection conn, string sql, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand(sql, conn);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    static async Task<(uint Oid, string Name)> HypoCreateAsync(NpgsqlConnection conn, Candidate c, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("select indexrelid, indexname from hypopg_create_index($1)", conn)
        {
            Parameters = { new() { Value = c.HypotheticalDdl } },
        };
        await using var r = await cmd.ExecuteReaderAsync(ct);
        await r.ReadAsync(ct);
        return (r.GetFieldValue<uint>(0), r.GetString(1));
    }

    static async Task<long?> HypoSizeAsync(NpgsqlConnection conn, uint oid, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("select hypopg_relation_size($1)", conn) { Parameters = { new() { Value = oid, DataTypeName = "oid" } } };
        return await cmd.ExecuteScalarAsync(ct) is long size ? size : null;
    }

    static async Task HypoDropAsync(NpgsqlConnection conn, uint oid, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("select hypopg_drop_index($1)", conn) { Parameters = { new() { Value = oid, DataTypeName = "oid" } } };
        await cmd.ExecuteNonQueryAsync(ct);
    }

    /// <summary>The pooled session goes back to the pool: never leave hypothetical indexes in it.</summary>
    static async Task HypoResetAsync(NpgsqlConnection conn)
    {
        try
        {
            await using var cmd = new NpgsqlCommand("select hypopg_reset()", conn);
            await cmd.ExecuteNonQueryAsync();
        }
        catch (NpgsqlException)
        {
            // a broken connection takes its hypothetical indexes with it
        }
    }

    /// <summary>Columns, existing btree indexes and distinct-value estimates for the tables a plan scans.</summary>
    static async Task<Dictionary<(string, string), RelationInfo>> RelationsAsync(
        NpgsqlConnection conn, List<(string Schema, string Table)> names, CancellationToken ct)
    {
        var result = new Dictionary<(string, string), RelationInfo>();
        if (names.Count == 0) return result;
        var schemas = names.Select(n => n.Schema).ToArray();
        var tables = names.Select(n => n.Table).ToArray();

        await using (var cmd = new NpgsqlCommand("""
            select c.oid, n.nspname, c.relname, greatest(c.reltuples, 0)::float8,
                   array(select a.attname::text from pg_attribute a
                         where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped order by a.attnum)
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            join unnest($1::text[], $2::text[]) as w(s, t) on w.s = n.nspname and w.t = c.relname
            """, conn) { Parameters = { new() { Value = schemas }, new() { Value = tables } } })
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct))
                result[(r.GetString(1), r.GetString(2))] = new RelationInfo(
                    r.GetFieldValue<uint>(0), r.GetString(1), r.GetString(2), r.GetDouble(3),
                    r.GetFieldValue<string[]>(4).ToHashSet(), [], []);
        if (result.Count == 0) return result;

        var byOid = result.Values.ToDictionary(x => x.Oid);
        await using (var cmd = new NpgsqlCommand("""
            select i.indrelid, ic.relname,
                   array(select a.attname::text
                         from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
                         left join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                         where k.ord <= i.indnkeyatts order by k.ord)
            from pg_index i
            join pg_class ic on ic.oid = i.indexrelid
            join pg_am am on am.oid = ic.relam
            where i.indrelid = any($1) and i.indisvalid and i.indpred is null and am.amname = 'btree'
            """, conn) { Parameters = { new() { Value = byOid.Keys.ToArray(), DataTypeName = "oid[]" } } })
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct))
                byOid[r.GetFieldValue<uint>(0)].Indexes.Add(new ExistingIndex(r.GetString(1), r.GetFieldValue<string?[]>(2).ToList()));

        await using (var cmd = new NpgsqlCommand("""
            select s.schemaname::text, s.tablename::text, s.attname::text, s.n_distinct::float8
            from pg_stats s
            join unnest($1::text[], $2::text[]) as w(sc, t) on w.sc = s.schemaname and w.t = s.tablename
            where not s.inherited
            """, conn) { Parameters = { new() { Value = schemas }, new() { Value = tables } } })
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct))
                if (result.TryGetValue((r.GetString(0), r.GetString(1)), out var rel))
                {
                    var nd = r.GetDouble(3);
                    rel.Distinct[r.GetString(2)] = nd < 0 ? -nd * rel.RelTuples : nd;
                }
        return result;
    }

    /// <summary>
    /// pg_stat_statements normalizes the literal in interval '1 day' to interval $2, which isn't valid SQL;
    /// as $2::interval it plans the same.
    /// </summary>
    static string Plannable(string query) => TypedLiteral().Replace(query, m => $"${m.Groups[2].Value}::{m.Groups[1].Value}");

    static string Short(string s, int max)
    {
        var one = Whitespace().Replace(s, " ").Trim();
        return one.Length > max ? one[..max] + "…" : one;
    }

    [GeneratedRegex(@"\$\d+")]
    private static partial Regex Param();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();

    [GeneratedRegex(@"\b(interval|timestamptz|timestamp|date|timetz|time|numeric|uuid|jsonb|json|inet)\s+\$(\d+)", RegexOptions.IgnoreCase)]
    private static partial Regex TypedLiteral();
}
