using System.Text.Json;
using System.Text.RegularExpressions;
using Yadbc.Host.Export;

namespace Yadbc.Host.Advisor;

/// <summary>What the advisor needs to know about a table the plan scans.</summary>
public sealed record RelationInfo(
    uint Oid,
    string Schema,
    string Name,
    double RelTuples,
    HashSet<string> Columns,
    /// <summary>Distinct values per column (pg_stats, made absolute); more distinct = better leading column.</summary>
    Dictionary<string, double> Distinct,
    List<ExistingIndex> Indexes);

/// <summary>A usable (valid, non-partial, btree) index's key columns; null for expression keys.</summary>
public sealed record ExistingIndex(string Name, List<string?> Columns);

public sealed record IndexColumn(string Name, bool Desc);

/// <summary>An index worth trying on one table, and why.</summary>
public sealed class Candidate
{
    public required string Schema { get; init; }
    public required string Table { get; init; }
    public required List<IndexColumn> Columns { get; init; }
    public List<string> Reasons { get; } = [];
    /// <summary>Share of the statement's estimated cost spent in the scan this would replace (0..1).</summary>
    public double CostShare { get; set; }

    public string Key => $"{Schema}.{Table}({string.Join(",", Columns.Select(c => c.Name + (c.Desc ? " desc" : "")))})";

    string ColumnList => string.Join(", ", Columns.Select(c => Sql.Ident(c.Name) + (c.Desc ? " DESC" : "")));

    public string Ddl
    {
        get
        {
            var name = $"{Table}_{string.Join("_", Columns.Select(c => c.Name))}_idx";
            if (name.Length > 63) name = name[..63];
            return $"CREATE INDEX CONCURRENTLY {Sql.Ident(name)} ON {Sql.Ident(Schema)}.{Sql.Ident(Table)} ({ColumnList});";
        }
    }

    /// <summary>For hypopg_create_index: no name, no CONCURRENTLY.</summary>
    public string HypotheticalDdl => $"CREATE INDEX ON {Sql.Ident(Schema)}.{Sql.Ident(Table)} ({ColumnList})";
}

/// <summary>
/// Finds missing indexes in an EXPLAIN (VERBOSE, FORMAT JSON) plan. VERBOSE matters: every column in a
/// condition is printed as alias.column, so conditions can be matched against the scanned table's real
/// columns instead of guessing at SQL. Looks for three things:
/// <list type="bullet">
/// <item>a Seq Scan on a big table that keeps a small fraction of it (equality / range conditions),</item>
/// <item>a Seq Scan repeated as the inner side of a Nested Loop (join column),</item>
/// <item>an index scan that still filters many rows, or a Sort right above a scan (ORDER BY … LIMIT).</item>
/// </list>
/// Heuristics only — with HypoPG the advisor then proves (or drops) each candidate by re-planning.
/// </summary>
public static partial class PlanAnalyzer
{
    const double MinRows = 2000;
    const double MaxSelectivity = 0.2;

    sealed class Scan
    {
        public required JsonElement Node { get; init; }
        public required string Schema { get; init; }
        public required string Table { get; init; }
        public required string Alias { get; init; }
        public required string NodeType { get; init; }
        public double Rows { get; init; }
        public double Cost { get; init; }
        public double ChildCost { get; init; }
        public int Parallel { get; init; } = 1;
        public double? OuterRows { get; set; }
        public List<(string Col, bool Desc)>? SortKeys { get; set; }
        public bool Limited { get; set; }
    }

    /// <summary>The relations a plan scans (schema, table), so their metadata can be loaded in one go.</summary>
    public static List<(string Schema, string Table)> Relations(string planJson)
    {
        var list = new List<(string, string)>();
        foreach (var scan in Scans(planJson, out _))
            if (!list.Contains((scan.Schema, scan.Table))) list.Add((scan.Schema, scan.Table));
        return list;
    }

    public static double RootCost(string planJson)
    {
        using var doc = JsonDocument.Parse(planJson);
        return doc.RootElement[0].GetProperty("Plan").GetProperty("Total Cost").GetDouble();
    }

    /// <summary>Candidates, plus notes for scans where a matching index exists but wasn't used.</summary>
    public static (List<Candidate> Candidates, List<string> Notes) Analyze(
        string planJson, Func<string, string, RelationInfo?> relation)
    {
        var candidates = new List<Candidate>();
        var notes = new List<string>();
        var scans = Scans(planJson, out var rootCost);

        foreach (var s in scans)
        {
            var rel = relation(s.Schema, s.Table);
            if (rel is null) continue;
            var label = $"{s.Schema}.{s.Table}";
            var where = s.Node.TryGetProperty("Filter", out var f) ? f.GetString() ?? "" : "";
            var (eq, range) = Conditions(where, s.Alias, rel);
            var rows = s.Rows * s.Parallel;
            var share = rootCost > 0 ? Math.Clamp((s.Cost - s.ChildCost) / rootCost, 0, 1) : 0;
            string? reason = null;
            var indexEq = new List<string>();

            if (s.NodeType == "Seq Scan")
            {
                if (eq.Count == 0 && range.Count == 0 && s.SortKeys is null) continue;
                if (s.OuterRows is > 1 && rel.RelTuples >= 100 && eq.Count > 0)
                    reason = $"Seq Scan on {label} (~{Fmt(rel.RelTuples)} rows) is repeated for each of ~{Fmt(s.OuterRows.Value)} outer rows: {Trim(where)}";
                else if (rel.RelTuples >= MinRows && (eq.Count > 0 || range.Count > 0) && rows / Math.Max(rel.RelTuples, 1) <= MaxSelectivity)
                    reason = $"Seq Scan on {label} reads all ~{Fmt(rel.RelTuples)} rows to keep ~{Fmt(rows)}: {Trim(where)}";
                else if (rel.RelTuples >= MinRows && s.SortKeys is not null && s.Limited)
                    reason = $"Seq Scan on {label} (~{Fmt(rel.RelTuples)} rows) is sorted only to return the first rows" +
                             (where.Length > 0 ? $": {Trim(where)}" : "");
            }
            else if (s.NodeType is "Index Scan" or "Index Only Scan" or "Bitmap Heap Scan" && (eq.Count > 0 || range.Count > 0))
            {
                // The index finds rows by its own condition; the Filter then throws some away again.
                var cond = s.Node.TryGetProperty("Index Cond", out var ic) ? ic.GetString() ?? ""
                    : s.Node.TryGetProperty("Recheck Cond", out var rc) ? rc.GetString() ?? "" : "";
                indexEq = Conditions(cond, s.Alias, rel).Eq;
                if (rel.RelTuples >= MinRows && indexEq.Count > 0)
                {
                    var via = s.Node.TryGetProperty("Index Name", out var iname) ? $" using {iname.GetString()}" : "";
                    reason = $"{s.NodeType} on {label}{via} then filters rows again: {Trim(where)}";
                }
            }
            if (reason is null) continue;

            var allEq = indexEq.Concat(eq).Distinct().ToList();
            var columns = Build(allEq, range, s.SortKeys, rel);
            if (columns.Count == 0) continue;
            if (s.SortKeys is not null && reason.Contains("reads all"))
                reason += s.Limited ? ", then sorts them for the first rows" : ", then sorts them";

            if (Covering(rel, columns, Math.Min(allEq.Count, columns.Count)) is { } existing)
            {
                notes.Add($"{label} already has {existing} for this, but the planner chose a {s.NodeType} " +
                          $"(it expects ~{Fmt(rows)} of ~{Fmt(rel.RelTuples)} rows to match — too many for the index to pay off, or stale statistics: try ANALYZE {label}).");
                continue;
            }
            var candidate = new Candidate { Schema = s.Schema, Table = s.Table, Columns = columns, CostShare = share };
            candidate.Reasons.Add(reason);
            if (candidates.FirstOrDefault(c => c.Key == candidate.Key) is { } same)
            {
                same.Reasons.Add(reason);
                same.CostShare = Math.Min(1, same.CostShare + share);
            }
            else candidates.Add(candidate);
        }
        return (candidates, notes);
    }

    /// <summary>
    /// Equality columns first (most distinct values first), then one range column — an index can't use
    /// columns after a range — or else the ORDER BY columns, so the index returns rows already sorted.
    /// </summary>
    static List<IndexColumn> Build(List<string> eq, List<string> range, List<(string Col, bool Desc)>? sort, RelationInfo rel)
    {
        var cols = eq.OrderByDescending(c => rel.Distinct.GetValueOrDefault(c)).Select(c => new IndexColumn(c, false)).ToList();
        var sortCols = sort?.Where(k => !eq.Contains(k.Col)).ToList();
        if (range.Count > 0)
        {
            // ORDER BY the range column itself still comes out sorted.
            var r = sortCols is { Count: > 0 } && range.Contains(sortCols[0].Col) ? sortCols[0].Col : range[0];
            cols.Add(new IndexColumn(r, false));
        }
        else if (sortCols is { Count: > 0 })
        {
            // All-DESC (or all-ASC) needs no DESC in the index: it's scanned backwards. Mixed needs it spelled out.
            var mixed = sortCols.Select(k => k.Desc).Distinct().Count() > 1;
            cols.AddRange(sortCols.Select(k => new IndexColumn(k.Col, mixed && k.Desc)));
        }
        return cols.Take(4).ToList();
    }

    /// <summary>
    /// An existing index covers the candidate when it starts with the same columns: the equality ones in
    /// any order (each pins one value), then the rest in the same order.
    /// </summary>
    static string? Covering(RelationInfo rel, List<IndexColumn> cols, int eqCount)
    {
        var want = cols.Select(c => c.Name).ToList();
        foreach (var ix in rel.Indexes)
        {
            if (ix.Columns.Count < want.Count) continue;
            var lead = ix.Columns.Take(want.Count).ToList();
            if (lead.Any(c => c is null)) continue;
            if (lead.Take(eqCount).ToHashSet().SetEquals(want.Take(eqCount)) && lead.Skip(eqCount).SequenceEqual(want.Skip(eqCount)))
                return $"{ix.Name} ({string.Join(", ", ix.Columns.Select(c => c ?? "expr"))})";
        }
        return null;
    }

    /// <summary>
    /// Columns of this alias used with = / IN / IS NULL (equality) or &lt; &gt; (range), from the
    /// top-level AND conditions. Conditions under an OR and columns inside a function call (lower(x),
    /// which would need an expression index) are skipped. String literals are blanked first so a
    /// 'a.b' inside one isn't taken for a column.
    /// </summary>
    public static (List<string> Eq, List<string> Range) Conditions(string expr, string alias, RelationInfo rel)
    {
        var eq = new List<string>();
        var range = new List<string>();
        if (string.IsNullOrWhiteSpace(expr)) return (eq, range);
        var text = Literal().Replace(expr, "''");
        foreach (var part in Conjuncts(text))
        {
            if (OrWord().IsMatch(part)) continue;
            foreach (Match m in ColumnRef().Matches(part))
            {
                if (Unquote(m.Groups["a"].Value) != alias) continue;
                var col = Unquote(m.Groups["c"].Value);
                if (!rel.Columns.Contains(col)) continue;
                var before = part[..m.Index];
                if (FunctionOpen().IsMatch(before)) continue;
                var after = CastTail().Replace(part[(m.Index + m.Length)..], "", 1);
                var op = OpAfter().Match(after) is { Success: true } a ? a.Groups[1].Value
                    : OpBefore().Match(before) is { Success: true } b ? b.Groups[1].Value : null;
                switch (op?.ToUpperInvariant())
                {
                    case "=" or "IS NULL":
                        if (!eq.Contains(col)) eq.Add(col);
                        break;
                    case "<" or ">" or "<=" or ">=":
                        if (!range.Contains(col)) range.Add(col);
                        break;
                }
            }
        }
        range.RemoveAll(eq.Contains);
        return (eq, range);
    }

    /// <summary>Splits "((a) AND (b) AND (c))" into its top-level AND parts.</summary>
    static List<string> Conjuncts(string expr)
    {
        var s = expr.Trim();
        while (s.StartsWith('(') && s.EndsWith(')') && Balanced(s[1..^1])) s = s[1..^1].Trim();
        var parts = new List<string>();
        int depth = 0, start = 0;
        for (var i = 0; i < s.Length; i++)
        {
            if (s[i] == '(') depth++;
            else if (s[i] == ')') depth--;
            else if (depth == 0 && string.CompareOrdinal(s, i, " AND ", 0, 5) == 0)
            {
                parts.Add(s[start..i]);
                start = i + 5;
                i += 4;
            }
        }
        parts.Add(s[start..]);
        return parts;
    }

    static bool Balanced(string s)
    {
        var depth = 0;
        foreach (var ch in s)
        {
            if (ch == '(') depth++;
            else if (ch == ')' && --depth < 0) return false;
        }
        return depth == 0;
    }

    static List<Scan> Scans(string planJson, out double rootCost)
    {
        using var doc = JsonDocument.Parse(planJson);
        var root = doc.RootElement[0].GetProperty("Plan").Clone();
        rootCost = root.GetProperty("Total Cost").GetDouble();
        var scans = new List<Scan>();
        Walk(root, null, 1, scans);
        return scans;
    }

    /// <summary>Collects scans; a Sort (under a Limit) directly over a scan hands it its sort keys.</summary>
    static Scan? Walk(JsonElement node, JsonElement? parent, int parallel, List<Scan> scans)
    {
        var type = node.GetProperty("Node Type").GetString()!;
        if (type is "Gather" or "Gather Merge" && node.TryGetProperty("Workers Planned", out var w))
            parallel = w.GetInt32() + 1;
        var children = node.TryGetProperty("Plans", out var p) ? p.EnumerateArray().ToList() : [];
        var childScans = new List<Scan?>();
        foreach (var child in children) childScans.Add(Walk(child, node, parallel, scans));

        if (type == "Nested Loop" && children.Count == 2 && childScans[1] is { } inner)
            inner.OuterRows = children[0].GetProperty("Plan Rows").GetDouble();

        if (node.TryGetProperty("Relation Name", out var rel) && node.TryGetProperty("Schema", out var schema)
            && node.TryGetProperty("Alias", out var alias))
        {
            var childCost = children.Sum(c => c.GetProperty("Total Cost").GetDouble());
            var scan = new Scan
            {
                Node = node,
                Schema = schema.GetString()!,
                Table = rel.GetString()!,
                Alias = alias.GetString()!,
                NodeType = type,
                Rows = node.GetProperty("Plan Rows").GetDouble(),
                Cost = node.GetProperty("Total Cost").GetDouble(),
                ChildCost = childCost,
                Parallel = parallel,
            };
            scans.Add(scan);
            return scan;
        }

        // Pass a scan up through nodes that don't change which rows come out (parallel gathering, sorting).
        var single = children.Count == 1 ? childScans[0] : null;
        if (single is null) return null;
        if (type is "Sort" or "Incremental Sort" && node.TryGetProperty("Sort Key", out var keys))
        {
            var parsed = new List<(string, bool)>();
            foreach (var k in keys.EnumerateArray())
            {
                var m = SortKey().Match(k.GetString() ?? "");
                if (!m.Success || Unquote(m.Groups["a"].Value) != single.Alias) return single;
                parsed.Add((Unquote(m.Groups["c"].Value), m.Groups["desc"].Success));
            }
            single.SortKeys = parsed;
        }
        if (type == "Limit") single.Limited = true;
        return type is "Gather" or "Gather Merge" or "Sort" or "Incremental Sort" or "Limit" ? single : null;
    }

    static string Unquote(string ident) =>
        ident.StartsWith('"') ? ident[1..^1].Replace("\"\"", "\"") : ident;

    static string Trim(string where)
    {
        var s = where.Trim();
        return s.Length > 160 ? s[..160] + "…" : s;
    }

    static string Fmt(double n) => n switch
    {
        >= 1e9 => $"{n / 1e9:0.#}G",
        >= 1e6 => $"{n / 1e6:0.#}M",
        >= 1e4 => $"{n / 1e3:0}k",
        >= 1e3 => $"{n / 1e3:0.#}k",
        _ => $"{n:0}",
    };

    const string Ident = """(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)""";

    [GeneratedRegex("'(?:[^']|'')*'")]
    private static partial Regex Literal();

    [GeneratedRegex(@"\bOR\b")]
    private static partial Regex OrWord();

    [GeneratedRegex($"""(?<![\w".])(?<a>{Ident})\.(?<c>{Ident})""")]
    private static partial Regex ColumnRef();

    /// <summary>Text before the column ends in "name(" (possibly nested parens): it's a function argument.</summary>
    [GeneratedRegex(@"[A-Za-z_][A-Za-z0-9_]*\s*\(+\s*$")]
    private static partial Regex FunctionOpen();

    /// <summary>"(x.col)::text" — a cast on the column; the operator comes after it.</summary>
    [GeneratedRegex(@"^\s*\)?(?:::[\w ]+(?:\[\])?\)?)*")]
    private static partial Regex CastTail();

    [GeneratedRegex(@"^\s*(=|<=|>=|<>|!=|<|>|IS NULL|IS NOT NULL)(?![=<>])", RegexOptions.IgnoreCase)]
    private static partial Regex OpAfter();

    [GeneratedRegex(@"(=|<=|>=|<>|!=|<|>)\s*\(*\s*$")]
    private static partial Regex OpBefore();

    [GeneratedRegex($"""^\(*(?<a>{Ident})\.(?<c>{Ident})\)*(?:\s+(?<desc>DESC))?(?:\s+NULLS\s+(?:FIRST|LAST))?$""")]
    private static partial Regex SortKey();
}
