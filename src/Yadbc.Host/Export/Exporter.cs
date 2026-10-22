using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using Yadbc.Host.Query;

namespace Yadbc.Host.Export;

public sealed record ExportOptions(
    bool Header = true,
    /// <summary>Target table for INSERT/UPDATE; defaults to the resolved source table.</summary>
    string? Table = null,
    /// <summary>"row" = one INSERT per row, "multi" = multi-row VALUES.</summary>
    string InsertMode = "row",
    /// <summary>"none", "nothing" or "update".</summary>
    string OnConflict = "none");

/// <param name="Rows">[from, toExclusive]; null = all buffered rows.</param>
/// <param name="Columns">Result column indexes in output order; null = all.</param>
/// <param name="PreviewRows">Limit for the dialog preview.</param>
public sealed record ExportRequest(string Format, int[]? Rows, int[]? Columns, ExportOptions? Options, int? PreviewRows);

public sealed record ExportResult(string Text, int RowCount, string? Table, string Extension, string Mime);

public sealed class ExportException(string message) : Exception(message);

/// <summary>Turns a slice of a result buffer into TSV, CSV, JSON, Markdown or SQL.</summary>
public static partial class Exporter
{
    const int MultiRowBatch = 500;

    [GeneratedRegex(@"… \(truncated, [\d,\s ]+ characters\)$|… \([\d,\s ]+ bytes\)$")]
    private static partial Regex TruncatedMarker();

    public static ExportResult Run(ResultBuffer buffer, ResultSource source, ExportRequest req)
    {
        var options = req.Options ?? new ExportOptions();
        var cols = req.Columns is { Length: > 0 } c ? c : Enumerable.Range(0, buffer.Columns.Count).ToArray();
        if (cols.Any(i => i < 0 || i >= buffer.Columns.Count)) throw new ExportException("Unknown column");

        var from = req.Rows?[0] ?? 0;
        var to = Math.Min(req.Rows?[1] ?? buffer.Count, buffer.Count);
        if (req.PreviewRows is { } preview) to = Math.Min(to, from + preview);
        var rows = buffer.Window(from, Math.Max(0, to - from), full: true);

        var ctx = new Context(buffer, source, cols, rows, options);
        // For data formats the table only names the saved file (users.csv rather than result.csv).
        var table = source.TableOf(cols);
        return req.Format switch
        {
            "tsv" => new(Delimited(ctx, '\t', "\n"), rows.Length, table, "tsv", "text/tab-separated-values"),
            "csv" => new(Delimited(ctx, ',', "\r\n"), rows.Length, table, "csv", "text/csv"),
            "json" => new(Json(ctx), rows.Length, table, "json", "application/json"),
            "markdown" => new(Markdown(ctx), rows.Length, table, "md", "text/markdown"),
            "insert" => Insert(ctx),
            "update" => Update(ctx),
            "in" => new(InList(ctx), rows.Length, table, "sql", "application/sql"),
            "where" => new(Where(ctx), rows.Length, table, "sql", "application/sql"),
            _ => throw new ExportException($"Unknown format '{req.Format}'"),
        };
    }

    sealed record Context(ResultBuffer Buffer, ResultSource Source, int[] Cols, string?[][] Rows, ExportOptions Options)
    {
        public string Type(int col) => Buffer.Columns[col].Type;
        public string Name(int col) => Buffer.Columns[col].Name;

        /// <summary>Real column name behind an alias when known — what INSERT/UPDATE/WHERE need.</summary>
        public string SqlName(int col) => Sql.Ident(col < Source.BaseColumns.Count && Source.BaseColumns[col] is { } b ? b : Name(col));

        /// <summary>A value that was cut by the buffer's safety limit must never be exported as if complete.</summary>
        public string? Value(int row, int col)
        {
            var v = Rows[row][col];
            if (v is not null && (TruncatedMarker().IsMatch(v) || v.StartsWith("⚠ ")))
                throw new ExportException($"Row {row + 1}, column \"{Name(col)}\" holds a truncated or unreadable value; exporting it would produce wrong data.");
            return v;
        }
    }

    static string Delimited(Context ctx, char sep, string newline)
    {
        var sb = new StringBuilder();
        string Field(string? v) =>
            v is null ? "" :
            v.IndexOfAny([sep, '"', '\r', '\n']) >= 0 || (sep == ',' && v.Length > 0 && (v[0] == ' ' || v[^1] == ' '))
                ? $"\"{v.Replace("\"", "\"\"")}\"" : v;

        if (ctx.Options.Header) sb.Append(string.Join(sep, ctx.Cols.Select(c => Field(ctx.Name(c))))).Append(newline);
        for (var r = 0; r < ctx.Rows.Length; r++)
            sb.Append(string.Join(sep, ctx.Cols.Select(c => Field(ctx.Value(r, c))))).Append(newline);
        return sb.ToString();
    }

    static string Json(Context ctx)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms, new JsonWriterOptions { Indented = true, NewLine = "\n", Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
        {
            w.WriteStartArray();
            for (var r = 0; r < ctx.Rows.Length; r++)
            {
                w.WriteStartObject();
                foreach (var c in ctx.Cols)
                {
                    w.WritePropertyName(ctx.Name(c));
                    var v = ctx.Value(r, c);
                    var type = ctx.Type(c);
                    if (v is null) w.WriteNullValue();
                    else if (type == "bool") w.WriteBooleanValue(v == "true");
                    // Raw text, so int8/numeric keep every digit (a JSON consumer may still round; that's on it).
                    else if (Sql.IsNumericType(type) && Sql.IsPlainNumber(v)) w.WriteRawValue(v);
                    else if (type is "json" or "jsonb") w.WriteRawValue(v);
                    else w.WriteStringValue(v);
                }
                w.WriteEndObject();
            }
            w.WriteEndArray();
        }
        return Encoding.UTF8.GetString(ms.ToArray()) + "\n";
    }

    static string Markdown(Context ctx)
    {
        static string Cell(string? v) => v is null ? "NULL" : v.Replace("|", "\\|").Replace("\r\n", "<br>").Replace("\n", "<br>");
        var sb = new StringBuilder();
        sb.Append("| ").Append(string.Join(" | ", ctx.Cols.Select(c => Cell(ctx.Name(c))))).Append(" |\n");
        sb.Append("| ").Append(string.Join(" | ", ctx.Cols.Select(c => Sql.IsNumericType(ctx.Type(c)) ? "---:" : "---"))).Append(" |\n");
        for (var r = 0; r < ctx.Rows.Length; r++)
            sb.Append("| ").Append(string.Join(" | ", ctx.Cols.Select(c => Cell(ctx.Value(r, c))))).Append(" |\n");
        return sb.ToString();
    }

    static string TargetTable(Context ctx, string verb) =>
        ctx.Options.Table is { Length: > 0 } t ? t.Trim()
        : ctx.Source.TableOf(ctx.Cols)
          ?? throw new ExportException($"These columns don't come from a single table. Enter the table to {verb}.");

    static ExportResult Insert(Context ctx)
    {
        var table = TargetTable(ctx, "insert into");
        var columns = string.Join(", ", ctx.Cols.Select(ctx.SqlName));
        var onConflict = OnConflictClause(ctx, table);
        string Values(int r) => "(" + string.Join(", ", ctx.Cols.Select(c => Sql.Literal(ctx.Value(r, c), ctx.Type(c)))) + ")";

        var sb = new StringBuilder();
        if (ctx.Options.InsertMode == "multi")
        {
            for (var start = 0; start < ctx.Rows.Length; start += MultiRowBatch)
            {
                var end = Math.Min(start + MultiRowBatch, ctx.Rows.Length);
                sb.Append($"INSERT INTO {table} ({columns}) VALUES\n");
                for (var r = start; r < end; r++) sb.Append("  ").Append(Values(r)).Append(r < end - 1 ? ",\n" : "");
                sb.Append(onConflict).Append(";\n");
            }
        }
        else
        {
            for (var r = 0; r < ctx.Rows.Length; r++)
                sb.Append($"INSERT INTO {table} ({columns}) VALUES {Values(r)}{onConflict};\n");
        }
        return new(sb.ToString(), ctx.Rows.Length, table, "sql", "application/sql");
    }

    static string OnConflictClause(Context ctx, string table)
    {
        switch (ctx.Options.OnConflict)
        {
            case "nothing":
                return "\nON CONFLICT DO NOTHING";
            case "update":
                var pk = SourcePrimaryKey(ctx, table, "ON CONFLICT DO UPDATE");
                var set = ctx.Cols.Where(c => !pk.Contains(c)).Select(c => $"{ctx.SqlName(c)} = EXCLUDED.{ctx.SqlName(c)}").ToList();
                var target = string.Join(", ", pk.Select(ctx.SqlName));
                return set.Count == 0
                    ? $"\nON CONFLICT ({target}) DO NOTHING"
                    : $"\nON CONFLICT ({target}) DO UPDATE SET {string.Join(", ", set)}";
            default:
                return "";
        }
    }

    /// <summary>PK columns of the table the selected columns come from; required for UPDATE and upserts.</summary>
    static IReadOnlyList<int> SourcePrimaryKey(Context ctx, string table, string what)
    {
        var source = ctx.Source.TableOf(ctx.Cols);
        if (source is null || source != table)
            throw new ExportException($"{what} needs the primary key of the source table; these columns don't come from \"{table}\" as a single table.");
        return ctx.Source.PrimaryKey(source)
               ?? throw new ExportException($"{what} needs {table}'s primary key columns in the result.");
    }

    static ExportResult Update(Context ctx)
    {
        var table = TargetTable(ctx, "update");
        var pk = SourcePrimaryKey(ctx, table, "UPDATE");
        var setCols = ctx.Cols.Where(c => !pk.Contains(c)).ToList();
        if (setCols.Count == 0) throw new ExportException("Select at least one column that isn't part of the primary key.");

        var sb = new StringBuilder();
        for (var r = 0; r < ctx.Rows.Length; r++)
        {
            var set = string.Join(", ", setCols.Select(c => $"{ctx.SqlName(c)} = {Sql.Literal(ctx.Value(r, c), ctx.Type(c))}"));
            var where = string.Join(" AND ", pk.Select(c => $"{ctx.SqlName(c)} = {Sql.Literal(ctx.Value(r, c), ctx.Type(c))}"));
            sb.Append($"UPDATE {table} SET {set} WHERE {where};\n");
        }
        return new(sb.ToString(), ctx.Rows.Length, table, "sql", "application/sql");
    }

    /// <summary>Distinct values: (1, 2, 3) — or row tuples ((1, 'a'), (2, 'b')) for several columns.</summary>
    static string InList(Context ctx)
    {
        var items = DistinctTuples(ctx).Select(t => t.Length == 1 ? t[0] : $"({string.Join(", ", t)})");
        return $"({string.Join(", ", items)})";
    }

    /// <summary>col IN (…) / col = … (NULLs become IS NULL); several columns become OR-ed AND groups.</summary>
    static string Where(Context ctx)
    {
        if (ctx.Cols.Length == 1)
        {
            var c = ctx.Cols[0];
            var name = ctx.SqlName(c);
            var values = Enumerable.Range(0, ctx.Rows.Length).Select(r => ctx.Value(r, c)).Distinct().ToList();
            var parts = new List<string>();
            var nonNull = values.Where(v => v is not null).Select(v => Sql.Literal(v, ctx.Type(c))).ToList();
            if (nonNull.Count == 1) parts.Add($"{name} = {nonNull[0]}");
            else if (nonNull.Count > 1) parts.Add($"{name} IN ({string.Join(", ", nonNull)})");
            if (values.Contains(null)) parts.Add($"{name} IS NULL");
            return string.Join(" OR ", parts) + "\n";
        }

        var groups = Enumerable.Range(0, ctx.Rows.Length)
            .Select(r => string.Join(" AND ", ctx.Cols.Select(c =>
                ctx.Value(r, c) is null ? $"{ctx.SqlName(c)} IS NULL" : $"{ctx.SqlName(c)} = {Sql.Literal(ctx.Value(r, c), ctx.Type(c))}")))
            .Distinct()
            .Select(g => $"({g})");
        return string.Join("\n   OR ", groups) + "\n";
    }

    static IEnumerable<string[]> DistinctTuples(Context ctx)
    {
        var seen = new HashSet<string>();
        for (var r = 0; r < ctx.Rows.Length; r++)
        {
            var tuple = ctx.Cols.Select(c => Sql.Literal(ctx.Value(r, c), ctx.Type(c))).ToArray();
            if (seen.Add(string.Join("\u001f", tuple))) yield return tuple;
        }
    }
}
