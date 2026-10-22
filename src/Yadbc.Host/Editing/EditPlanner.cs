using System.Text;
using System.Text.RegularExpressions;
using Yadbc.Host.Export;
using Yadbc.Host.Query;

namespace Yadbc.Host.Editing;

public sealed record CellEdit(int Row, int Col, string? Value);

/// <summary>A new row: result column index → value. Columns left out get their DEFAULT.</summary>
public sealed record RowInsert(Dictionary<int, string?> Values);

public sealed record EditSet(List<CellEdit>? Updates, List<int>? Deletes, List<RowInsert>? Inserts);

public enum EditKind { Update, Delete, Insert }

/// <param name="Row">Buffer row for updates/deletes; index into <see cref="EditSet.Inserts"/> for inserts.</param>
/// <param name="Columns">Result columns this statement writes (update/insert), so RETURNING can be mapped back.</param>
public sealed record PlannedStatement(EditKind Kind, string Sql, string Table, int Row, IReadOnlyList<int> Columns);

public sealed class EditException(string message) : Exception(message);

/// <summary>
/// Turns staged grid edits into the exact SQL that will run (the review shows the same text).
/// Every statement must affect exactly one row; UPDATEs also check the old values, so a row
/// someone changed in the meantime fails the batch instead of being silently overwritten.
/// </summary>
public static partial class EditPlanner
{
    /// <summary>Types without an equality operator: compare their text form instead.</summary>
    static readonly HashSet<string> NoEquality = ["json", "xml", "point", "line", "lseg", "box", "path", "polygon", "circle"];

    [GeneratedRegex(@"… \(truncated, [\d,\s ]+ characters\)$|… \([\d,\s ]+ bytes\)$")]
    private static partial Regex TruncatedMarker();

    public static object Editability(ResultBuffer buffer, ResultSource source)
    {
        var columns = Enumerable.Range(0, buffer.Columns.Count).Select(c => ColumnReason(source, c)).ToList();
        var rowTable = RowTable(buffer, source, out var rowReason);
        return new
        {
            columns = columns.Select(r => new { editable = r is null, reason = r }),
            rows = new
            {
                editable = rowTable is not null,
                reason = rowReason,
                table = rowTable,
                // New rows start editing after these (usually serial/identity keys with defaults).
                primaryKey = rowTable is null ? null : source.PrimaryKey(rowTable),
            },
        };
    }

    /// <summary>Null when the column is editable, else why not.</summary>
    static string? ColumnReason(ResultSource source, int col)
    {
        var table = col < source.ColumnTables.Count ? source.ColumnTables[col] : null;
        if (table is null || source.BaseColumns[col] is null) return "Computed column — not from a table";
        return source.PrimaryKey(table) is null
            ? $"{table} has no primary key in this result — add its key columns to the query to edit"
            : null;
    }

    /// <summary>Inserting/deleting rows needs a result that is one table, with its primary key.</summary>
    static string? RowTable(ResultBuffer buffer, ResultSource source, out string? reason)
    {
        var table = source.TableOf(Enumerable.Range(0, buffer.Columns.Count));
        reason = table is null ? "Adding or deleting rows needs a result from a single table"
            : source.PrimaryKey(table) is null ? $"{table}'s primary key isn't in this result"
            : null;
        return reason is null ? table : null;
    }

    public static List<PlannedStatement> Plan(ResultBuffer buffer, ResultSource source, EditSet edits)
    {
        var plan = new List<PlannedStatement>();
        var deletes = (edits.Deletes ?? []).ToHashSet();
        var cols = buffer.Columns;

        // UPDATEs: one statement per (row, table), skipping rows that are being deleted anyway.
        foreach (var group in (edits.Updates ?? []).Where(u => !deletes.Contains(u.Row))
                     .GroupBy(u => (u.Row, Table: TableOrThrow(source, u.Col))))
        {
            var (row, table) = group.Key;
            var current = buffer.Row(row) ?? throw new EditException($"Row {row + 1} is no longer in the result");
            var pk = source.PrimaryKey(table)!;
            var edited = group.GroupBy(u => u.Col).Select(g => g.Last()).ToList();

            var set = string.Join(", ", edited.Select(u => $"{Name(source, u.Col)} = {NewValue(u.Value)}"));
            var where = pk.Select(c => $"{Name(source, c)} = {Sql.Literal(OldValue(current, c, cols), cols[c].Type)}")
                .Concat(edited.Select(u => OldValueCheck(source, cols, current, u.Col)));
            plan.Add(new(EditKind.Update, $"UPDATE {table} SET {set} WHERE {string.Join(" AND ", where)} RETURNING *",
                table, row, edited.Select(u => u.Col).ToList()));
        }

        if (deletes.Count > 0 || edits.Inserts is { Count: > 0 })
        {
            var table = RowTable(buffer, source, out var reason) ?? throw new EditException(reason!);
            var pk = source.PrimaryKey(table)!;

            foreach (var row in deletes.Order())
            {
                var current = buffer.Row(row) ?? throw new EditException($"Row {row + 1} is no longer in the result");
                var where = pk.Select(c => $"{Name(source, c)} = {Sql.Literal(OldValue(current, c, cols), cols[c].Type)}");
                plan.Add(new(EditKind.Delete, $"DELETE FROM {table} WHERE {string.Join(" AND ", where)}", table, row, []));
            }

            for (var i = 0; i < (edits.Inserts?.Count ?? 0); i++)
            {
                var values = edits.Inserts![i].Values.OrderBy(kv => kv.Key).ToList();
                var sql = values.Count == 0
                    ? $"INSERT INTO {table} DEFAULT VALUES RETURNING *"
                    : $"INSERT INTO {table} ({string.Join(", ", values.Select(kv => Name(source, kv.Key)))}) " +
                      $"VALUES ({string.Join(", ", values.Select(kv => NewValue(kv.Value)))}) RETURNING *";
                plan.Add(new(EditKind.Insert, sql, table, i, values.Select(kv => kv.Key).ToList()));
            }
        }

        return plan;
    }

    /// <summary>The review text: exactly what Apply runs, framed as one transaction.</summary>
    public static string Script(IReadOnlyList<PlannedStatement> plan)
    {
        var sb = new StringBuilder("BEGIN;\n");
        foreach (var s in plan)
            sb.Append(s.Kind == EditKind.Delete ? s.Sql : s.Sql[..s.Sql.LastIndexOf(" RETURNING *", StringComparison.Ordinal)]).Append(";\n");
        return sb.Append("COMMIT;\n").ToString();
    }

    static string TableOrThrow(ResultSource source, int col) =>
        ColumnReason(source, col) is { } reason ? throw new EditException(reason) : source.ColumnTables[col]!;

    static string Name(ResultSource source, int col) => Sql.Ident(source.BaseColumns[col]!);

    /// <summary>
    /// New values are always quoted: Postgres then parses them with the column's own input rules
    /// ('yes' for bool, '42' for int), and rejects anything invalid instead of us guessing.
    /// </summary>
    static string NewValue(string? value) => value is null ? "NULL" : $"'{value.Replace("'", "''")}'";

    static string? OldValue(string?[] row, int col, IReadOnlyList<ColumnInfo> cols)
    {
        var v = row[col];
        if (v is not null && (TruncatedMarker().IsMatch(v) || v.StartsWith("⚠ ")))
            throw new EditException($"\"{cols[col].Name}\" holds a value too large or unreadable to check safely; edit it with SQL instead.");
        return v;
    }

    static string OldValueCheck(ResultSource source, IReadOnlyList<ColumnInfo> cols, string?[] row, int col)
    {
        var old = OldValue(row, col, cols);
        var name = Name(source, col);
        if (old is null) return $"{name} IS NULL";
        return NoEquality.Contains(cols[col].Type)
            ? $"{name}::text = {NewValue(old)}::{cols[col].Type}::text"
            : $"{name} IS NOT DISTINCT FROM {NewValue(old)}";
    }
}
