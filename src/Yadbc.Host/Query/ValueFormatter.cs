using System.Collections;
using System.Globalization;
using System.Numerics;
using System.Text;
using Npgsql;

namespace Yadbc.Host.Query;

/// <summary>
/// Turns cell values into display strings on the backend. Everything crosses the wire as a string
/// or null: int8/numeric as JS numbers would silently lose precision above 2^53 (wrong IDs, and
/// later wrong rows edited), and NULL must stay distinguishable from ''.
/// </summary>
public static class ValueFormatter
{
    /// <summary>
    /// Safety limit per stored cell. Grid windows are cut much shorter (<see cref="ResultBuffer.WindowCellLength"/>);
    /// the inspector and copy get the stored value.
    /// </summary>
    public const int MaxStoredLength = 1_000_000;
    const int MaxBytes = 64 * 1024;

    public static string? Format(NpgsqlDataReader reader, int ordinal, string pgType)
    {
        if (reader.IsDBNull(ordinal)) return null;
        try
        {
            // TimeSpan can't hold months, and its ToString isn't valid Postgres input — format intervals ourselves.
            if (pgType == "interval") return FormatInterval(reader.GetFieldValue<NpgsqlTypes.NpgsqlInterval>(ordinal));
            return Truncate(FormatValue(reader.GetValue(ordinal), pgType));
        }
        catch (OverflowException) when (pgType == "numeric")
        {
            // numeric beyond System.Decimal (e.g. 1e40): BigInteger keeps the integer part exact.
            return Truncate(reader.GetFieldValue<BigInteger>(ordinal).ToString(CultureInfo.InvariantCulture));
        }
        catch (Exception ex) when (ex is InvalidCastException or NotSupportedException or OverflowException)
        {
            return $"⚠ {ex.Message}";
        }
    }

    static string FormatValue(object value, string pgType) => value switch
    {
        string s => s,
        bool b => b ? "true" : "false",
        DateTime dt when pgType == "date" => dt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        // timestamptz arrives as UTC; show it in local time with the offset so it's never ambiguous.
        DateTime { Kind: DateTimeKind.Utc } dt => dt.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss.FFFFFFzzz", CultureInfo.InvariantCulture),
        DateTime dt => dt.ToString("yyyy-MM-dd HH:mm:ss.FFFFFF", CultureInfo.InvariantCulture),
        DateOnly d => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        DateTimeOffset dto => dto.ToString("yyyy-MM-dd HH:mm:ss.FFFFFFzzz", CultureInfo.InvariantCulture),
        byte[] bytes => FormatBytes(bytes),
        BitArray bits => FormatBits(bits),
        IDictionary<string, string?> hstore => string.Join(", ", hstore.Select(kv => $"\"{kv.Key}\"=>{(kv.Value is null ? "NULL" : $"\"{kv.Value}\"")}")),
        Array array => FormatArray(array, pgType),
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => value.ToString() ?? "",
    };

    /// <summary>Postgres' own output style: 1 year 2 mons 3 days 04:05:06.5</summary>
    static string FormatInterval(NpgsqlTypes.NpgsqlInterval iv)
    {
        var parts = new List<string>();
        var years = iv.Months / 12;
        var months = iv.Months % 12;
        if (years != 0) parts.Add($"{years} {(Math.Abs(years) == 1 ? "year" : "years")}");
        if (months != 0) parts.Add($"{months} {(Math.Abs(months) == 1 ? "mon" : "mons")}");
        if (iv.Days != 0) parts.Add($"{iv.Days} {(Math.Abs(iv.Days) == 1 ? "day" : "days")}");
        if (iv.Time != 0 || parts.Count == 0)
        {
            var t = TimeSpan.FromTicks(Math.Abs(iv.Time) * 10);
            var sign = iv.Time < 0 ? "-" : "";
            var frac = t.Ticks % TimeSpan.TicksPerSecond;
            parts.Add($"{sign}{(int)t.TotalHours:00}:{t.Minutes:00}:{t.Seconds:00}" + (frac != 0 ? $".{frac:0000000}".TrimEnd('0') : ""));
        }
        return string.Join(' ', parts);
    }

    static string FormatBytes(byte[] bytes)
    {
        var hex = Convert.ToHexString(bytes, 0, Math.Min(bytes.Length, MaxBytes)).ToLowerInvariant();
        return bytes.Length > MaxBytes ? $"\\x{hex}… ({bytes.Length:N0} bytes)" : $"\\x{hex}";
    }

    static string FormatBits(BitArray bits)
    {
        var sb = new StringBuilder(bits.Length);
        foreach (bool bit in bits) sb.Append(bit ? '1' : '0');
        return sb.ToString();
    }

    /// <summary>
    /// Postgres array output style — {1,2,NULL}, {"a b",c}, {{1,2},{3,4}} — so it's also valid array input
    /// for exports. Elements are quoted by the same rule Postgres uses, whatever their type.
    /// </summary>
    static string FormatArray(Array array, string pgType)
    {
        var elementType = pgType.TrimStart('_');
        var sb = new StringBuilder();
        var index = new int[array.Rank];
        AppendDimension(array, elementType, 0, index, sb);
        return sb.ToString();
    }

    static void AppendDimension(Array array, string elementType, int dim, int[] index, StringBuilder sb)
    {
        sb.Append('{');
        var lower = array.GetLowerBound(dim);
        for (var i = lower; i <= array.GetUpperBound(dim); i++)
        {
            if (i > lower) sb.Append(',');
            index[dim] = i;
            if (dim < array.Rank - 1) AppendDimension(array, elementType, dim + 1, index, sb);
            else sb.Append(ArrayElement(array.GetValue(index), elementType));
        }
        sb.Append('}');
    }

    static string ArrayElement(object? item, string elementType)
    {
        if (item is null or DBNull) return "NULL";
        var s = FormatValue(item, elementType);
        var needsQuotes = s.Length == 0
            || s.Equals("NULL", StringComparison.OrdinalIgnoreCase)
            || s.Any(ch => ch is ',' or '"' or '{' or '}' or '\\' or ' ' or '\t' or '\n' or '\r');
        return needsQuotes ? $"\"{s.Replace("\\", "\\\\").Replace("\"", "\\\"")}\"" : s;
    }

    static string Truncate(string s) =>
        s.Length > MaxStoredLength ? $"{s[..MaxStoredLength]}… (truncated, {s.Length:N0} characters)" : s;
}
