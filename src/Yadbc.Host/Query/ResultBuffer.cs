using System.Text.Json.Serialization;

namespace Yadbc.Host.Query;

/// <summary>
/// A result column. <see cref="TableOid"/>/<see cref="ColumnAttr"/> come straight from Postgres' row
/// description (0 for computed columns), even through aliases — that's how exports and editing know
/// which table a column belongs to without parsing SQL.
/// </summary>
public sealed record ColumnInfo(
    string Name,
    string Type,
    [property: JsonIgnore] uint TableOid,
    [property: JsonIgnore] short ColumnAttr,
    /// <summary>Type OID, for enum values (works for computed columns too).</summary>
    [property: JsonIgnore] uint TypeOid = 0);

/// <summary>
/// A query result held in backend memory. The reader is drained as fast as possible so the session
/// never sits "idle in transaction" holding locks while someone looks at the grid; the UI pulls
/// windows of rows on demand, so the WebView never holds the whole result.
/// </summary>
public sealed class ResultBuffer(string id, string tabId, string connectionId, IReadOnlyList<ColumnInfo> columns)
{
    /// <summary>Grid windows only need what fits in a cell; full values travel via <see cref="Cell"/> / full windows.</summary>
    public const int WindowCellLength = 500;

    readonly List<string?[]> _rows = [];
    readonly Lock _lock = new();
    /** Row order as the query returned it, kept from the first sort so "unsorted" can come back. */
    List<string?[]>? _original;

    public string Id { get; } = id;
    public string TabId { get; } = tabId;
    public string ConnectionId { get; } = connectionId;
    /// <summary>Lazily resolved source table info (see Export.TableSources); cached per result.</summary>
    public Task<Export.ResultSource>? Source { get; set; }
    public IReadOnlyList<ColumnInfo> Columns { get; } = columns;

    /// <summary>Rows the server returned, including ones past the cap that were counted but not kept.</summary>
    public long TotalRows { get; private set; }
    public bool Capped { get; private set; }
    public bool Done { get; private set; }

    public int Count
    {
        get { lock (_lock) return _rows.Count; }
    }

    public void Add(string?[] row)
    {
        lock (_lock) _rows.Add(row);
    }

    public void Complete(long totalRows, bool capped)
    {
        lock (_lock)
        {
            TotalRows = totalRows;
            Capped = capped;
            Done = true;
        }
    }

    public string?[][] Window(int from, int count, bool full)
    {
        lock (_lock)
        {
            if (from >= _rows.Count || count <= 0) return [];
            var rows = _rows.GetRange(from, Math.Min(count, _rows.Count - from));
            return full ? rows.ToArray() : rows.Select(ForWindow).ToArray();
        }
    }

    /// <summary>Whole columns, cut to <paramref name="maxLength"/> characters (a chart needs values and labels, not documents).</summary>
    public string?[][] ColumnValues(IReadOnlyList<int> cols, int maxLength)
    {
        lock (_lock)
            return cols.Select(c => _rows.Select(r => r[c] is { Length: var n } v && n > maxLength ? v[..maxLength] : r[c]).ToArray())
                .ToArray();
    }

    public string?[]? Row(int row)
    {
        lock (_lock) return row >= 0 && row < _rows.Count ? (string?[])_rows[row].Clone() : null;
    }

    /// <summary>
    /// Applies committed edits in one step so window readers never see a half-applied batch:
    /// replaced rows, then deletions (indexes refer to the pre-edit buffer), then appended rows.
    /// </summary>
    public void ApplyEdits(IReadOnlyDictionary<int, string?[]> replaced, IEnumerable<int> deleted, IEnumerable<string?[]> appended)
    {
        lock (_lock)
        {
            // Edits change the rows themselves; the remembered query order would bring back stale ones.
            _original = null;
            foreach (var (row, values) in replaced) _rows[row] = values;
            var removed = 0;
            foreach (var row in deleted.Distinct().OrderDescending())
            {
                _rows.RemoveAt(row);
                removed++;
            }
            var added = 0;
            foreach (var row in appended)
            {
                _rows.Add(row);
                added++;
            }
            TotalRows += added - removed;
        }
    }

    /// <summary>
    /// Sorts the buffered rows by one column (stable; NULLs last either way). Numbers compare as numbers;
    /// everything else as text, which also orders ISO dates and timestamps. Only what's buffered is sorted.
    /// </summary>
    public void Sort(int col, bool descending)
    {
        var numeric = NumericTypes.Contains(Columns[col].Type);
        lock (_lock)
        {
            _original ??= [.. _rows];
            var nonNull = _rows.Where(r => r[col] is not null).ToList();
            var nulls = _rows.Where(r => r[col] is null).ToList();
            IEnumerable<string?[]> sorted = numeric
                ? (descending ? nonNull.OrderByDescending(r => Number(r[col]!)) : nonNull.OrderBy(r => Number(r[col]!)))
                : (descending ? nonNull.OrderByDescending(r => r[col], TextOrder) : nonNull.OrderBy(r => r[col], TextOrder));
            var result = sorted.Concat(nulls).ToList();
            _rows.Clear();
            _rows.AddRange(result);
        }
    }

    /// <summary>Back to the order the query returned (when no edits were applied since).</summary>
    public bool RestoreOrder()
    {
        lock (_lock)
        {
            if (_original is null) return false;
            _rows.Clear();
            _rows.AddRange(_original);
            _original = null;
            return true;
        }
    }

    /// <summary>Cells containing <paramref name="text"/> (case-insensitive), row by row, at most <paramref name="max"/>.</summary>
    public (List<int[]> Matches, int Total) Find(string text, int max)
    {
        var matches = new List<int[]>();
        var total = 0;
        lock (_lock)
            for (var r = 0; r < _rows.Count; r++)
                for (var c = 0; c < Columns.Count; c++)
                    if (_rows[r][c] is { } v && v.Contains(text, StringComparison.OrdinalIgnoreCase))
                    {
                        total++;
                        if (matches.Count < max) matches.Add([r, c]);
                    }
        return (matches, total);
    }

    static readonly HashSet<string> NumericTypes = ["int2", "int4", "int8", "numeric", "float4", "float8", "oid", "money"];
    static readonly StringComparer TextOrder = StringComparer.Create(System.Globalization.CultureInfo.InvariantCulture, false);

    static decimal Number(string v) =>
        decimal.TryParse(v.Replace("$", "").Replace(",", ""), System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out var d) ? d
        : v.Contains("Infinity") ? (v.StartsWith('-') ? decimal.MinValue : decimal.MaxValue) : 0;

    public string? Cell(int row, int col)
    {
        lock (_lock)
        {
            if (row < 0 || row >= _rows.Count || col < 0 || col >= Columns.Count) throw new ArgumentOutOfRangeException(nameof(row));
            return _rows[row][col];
        }
    }

    static string?[] ForWindow(string?[] row)
    {
        if (!row.Any(v => v is { Length: > WindowCellLength })) return row;
        return row.Select(v => v is { Length: > WindowCellLength } ? v[..WindowCellLength] + "…" : v).ToArray();
    }
}
