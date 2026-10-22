using System.Text.RegularExpressions;

namespace Yadbc.Host.Export;

/// <summary>Identifier and literal quoting for generated SQL.</summary>
public static partial class Sql
{
    /// <summary>Types whose display string is valid as a bare numeric literal.</summary>
    static readonly HashSet<string> NumericLiteralTypes = ["int2", "int4", "int8", "numeric", "float4", "float8", "oid"];

    /// <summary>Postgres reserved words (plus a few that are reserved as column/function names).</summary>
    static readonly HashSet<string> Reserved =
    [
        "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric", "authorization", "binary",
        "both", "case", "cast", "check", "collate", "collation", "column", "concurrently", "constraint", "create",
        "cross", "current_catalog", "current_date", "current_role", "current_schema", "current_time",
        "current_timestamp", "current_user", "default", "deferrable", "desc", "distinct", "do", "else", "end",
        "except", "false", "fetch", "for", "foreign", "freeze", "from", "full", "grant", "group", "having", "ilike",
        "in", "initially", "inner", "intersect", "into", "is", "isnull", "join", "lateral", "leading", "left", "like",
        "limit", "localtime", "localtimestamp", "natural", "not", "notnull", "null", "offset", "on", "only", "or",
        "order", "outer", "overlaps", "placing", "primary", "references", "returning", "right", "select",
        "session_user", "similar", "some", "symmetric", "system_user", "table", "tablesample", "then", "to",
        "trailing", "true", "union", "unique", "user", "using", "variadic", "verbose", "when", "where", "window", "with",
    ];

    [GeneratedRegex("^[a-z_][a-z0-9_$]*$")]
    private static partial Regex PlainIdent();

    [GeneratedRegex(@"^-?\d+(\.\d+)?([eE][-+]?\d+)?$")]
    private static partial Regex PlainNumber();

    /// <summary>Quotes an identifier only when Postgres would otherwise fold or reject it.</summary>
    public static string Ident(string name) =>
        PlainIdent().IsMatch(name) && !Reserved.Contains(name) ? name : $"\"{name.Replace("\"", "\"\"")}\"";

    public static bool IsNumericType(string type) => NumericLiteralTypes.Contains(type);

    public static bool IsPlainNumber(string value) => PlainNumber().IsMatch(value);

    /// <summary>
    /// A literal Postgres accepts for the column's type. Everything that isn't a plain number or bool is a
    /// quoted string; Postgres coerces the untyped literal to the target column type on INSERT/UPDATE.
    /// </summary>
    public static string Literal(string? value, string type) => value switch
    {
        null => "NULL",
        _ when type == "bool" => value == "true" ? "TRUE" : "FALSE",
        _ when IsNumericType(type) && IsPlainNumber(value) => value,
        _ => $"'{value.Replace("'", "''")}'",
    };
}
