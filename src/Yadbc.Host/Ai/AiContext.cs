using System.Text;
using System.Text.RegularExpressions;
using Npgsql;

namespace Yadbc.Host.Ai;

/// <summary>
/// What the model is told about the database: the server version and the schema — in detail for the
/// tables the statement or question is about (columns, types, keys, foreign keys, existing indexes, and
/// their neighbours either way), then column names for the rest as far as the budget goes. Never any
/// rows: results stay out of prompts. Kept within a budget so a 16k-token model still has room to answer.
/// </summary>
public static partial class AiContext
{
    const int Budget = 24_000;

    internal sealed record Col(string Name, string Type, bool NotNull, bool Pk, string? Ref);

    internal sealed record Table(uint Oid, string Schema, string Name, string Kind, double Rows, List<Col> Cols)
    {
        public string Id => Schema == "public" ? Name : $"{Schema}.{Name}";
    }

    public static async Task<string> SchemaAsync(NpgsqlConnection conn, string mentionText, CancellationToken ct)
    {
        var tables = new Dictionary<(string, string), Table>();
        await using (var cmd = new NpgsqlCommand("""
            select n.nspname, c.relname, c.relkind::text, greatest(c.reltuples, 0)::float8, c.oid,
                   a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
                   exists (select 1 from pg_index i where i.indrelid = c.oid and i.indisprimary and a.attnum = any(i.indkey)),
                   (select rn.nspname || '.' || rc.relname || '(' || ra.attname || ')'
                      from pg_constraint k
                      join pg_class rc on rc.oid = k.confrelid join pg_namespace rn on rn.oid = rc.relnamespace
                      join pg_attribute ra on ra.attrelid = k.confrelid and ra.attnum = k.confkey[1]
                     where k.conrelid = c.oid and k.contype = 'f' and cardinality(k.conkey) = 1 and k.conkey[1] = a.attnum
                     limit 1)
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
            where c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
              and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'
              -- views/tables an extension installed (pg_stat_statements, hypopg…) aren't the user's schema
              and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
            order by n.nspname, c.relname, a.attnum
            """, conn))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct))
            {
                var key = (r.GetString(0), r.GetString(1));
                if (!tables.TryGetValue(key, out var t))
                    tables[key] = t = new Table(r.GetFieldValue<uint>(4), key.Item1, key.Item2, r.GetString(2), r.GetDouble(3), []);
                t.Cols.Add(new Col(r.GetString(5), r.GetString(6), r.GetBoolean(7), r.GetBoolean(8), r.IsDBNull(9) ? null : r.GetString(9)));
            }

        // Three tiers inside the budget, most useful first:
        //   1. full detail for the tables the statement / question is about, and their foreign-key
        //      neighbours both ways (anti_affinities → virtual_machines is found from either end);
        //   2. column names for as many of the rest as fit — enough to write a query against them;
        //   3. bare names past that, so the model knows what exists.
        var all = tables.Values.ToList();
        var mentioned = Mentioned(all, mentionText);
        var neighbours = all
            .Where(t => !mentioned.Contains(t) && mentioned.Any(m => References(m, t) || References(t, m)))
            .ToList();

        var sb = new StringBuilder();
        var detailed = new HashSet<Table>();
        if (mentioned.Count > 0)
        {
            var inQuestion = mentioned.Concat(neighbours).ToList();
            var indexes = await IndexesAsync(conn, inQuestion.Select(t => t.Oid).ToArray(), ct);
            sb.AppendLine("Tables in question (columns: name type [PK] [NOT NULL] [→ referenced]; then every index the table has):");
            foreach (var t in inQuestion)
            {
                if (sb.Length > Budget * 2 / 3) break;
                Detail(sb, t);
                // Views and foreign tables can't have indexes: "none" would only invite suggestions.
                if (t.Kind is "r" or "p" or "m")
                    sb.AppendLine(indexes.TryGetValue(t.Oid, out var list) ? $"  indexes: {string.Join("; ", list)}" : "  indexes: none");
                detailed.Add(t);
            }
            sb.AppendLine();
        }
        var rest = all.Where(t => !detailed.Contains(t)).ToList();
        if (rest.Count == 0) return sb.ToString();

        // A small schema fits in full detail; otherwise an outline with column names.
        var full = new StringBuilder();
        foreach (var t in rest) Detail(full, t);
        if (sb.Length + full.Length <= Budget)
        {
            sb.AppendLine(mentioned.Count > 0 ? "Other tables:" : "Tables (columns: name type [PK] [NOT NULL] [→ referenced]):");
            return sb.Append(full).ToString();
        }
        sb.AppendLine(mentioned.Count > 0 ? "Other tables (table(columns), PK marked *):" : "Schema outline (table(columns), PK marked *):");
        var shown = 0;
        foreach (var t in rest)
        {
            var line = $"{t.Id}({string.Join(", ", t.Cols.Select(c => (c.Pk ? "*" : "") + c.Name))})";
            if (sb.Length + line.Length > Budget) break;
            sb.AppendLine(line);
            shown++;
        }
        if (shown < rest.Count)
        {
            sb.Append("More tables (names only): ");
            AppendNames(sb, rest.Skip(shown).ToList());
        }
        return sb.ToString();
    }

    /// <summary>
    /// The indexes of these tables, as "name (columns)" with UNIQUE / PK, a non-btree method and a
    /// partial index's WHERE — what the model needs to not suggest an index that's already there.
    /// </summary>
    static async Task<Dictionary<uint, List<string>>> IndexesAsync(NpgsqlConnection conn, uint[] oids, CancellationToken ct)
    {
        var byTable = new Dictionary<uint, List<string>>();
        if (oids.Length == 0) return byTable;
        await using var cmd = new NpgsqlCommand("""
            select i.indrelid, ic.relname, pg_get_indexdef(i.indexrelid), i.indisprimary, i.indisunique, i.indisvalid
            from pg_index i join pg_class ic on ic.oid = i.indexrelid
            where i.indrelid = any($1)
            order by i.indrelid, i.indisprimary desc, ic.relname
            """, conn);
        cmd.Parameters.Add(new NpgsqlParameter { Value = oids, NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Array | NpgsqlTypes.NpgsqlDbType.Oid });
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
        {
            // "CREATE UNIQUE INDEX x ON s.t USING btree (a, b) WHERE …" → "x UNIQUE (a, b) WHERE …"
            var def = r.GetString(2);
            var using_ = def.IndexOf(" USING ", StringComparison.Ordinal);
            var body = using_ < 0 ? def : def[(using_ + 7)..];
            if (body.StartsWith("btree ", StringComparison.Ordinal)) body = body[6..];
            var flags = r.GetBoolean(3) ? " PK" : r.GetBoolean(4) ? " UNIQUE" : "";
            if (!r.GetBoolean(5)) flags += " INVALID";
            var oid = r.GetFieldValue<uint>(0);
            if (!byTable.TryGetValue(oid, out var list)) byTable[oid] = list = [];
            list.Add($"{r.GetString(1)}{flags} {body}");
        }
        return byTable;
    }

    static bool References(Table from, Table to) =>
        from.Cols.Any(c => c.Ref is { } r && r.StartsWith($"{to.Schema}.{to.Name}(", StringComparison.Ordinal));

    /// <summary>
    /// Tables the text is about, written the way people write them: exact (users, shop.orders),
    /// without the underscores (antiaffinities, "virtual machines"), in the singular (order → orders),
    /// or by initials (vms → virtual_machines). Short names (&lt; 4 letters) only match whole words.
    /// </summary>
    internal static List<Table> Mentioned(List<Table> tables, string text)
    {
        var words = Word().Matches(text).Select(m => m.Value.Trim('"').ToLowerInvariant()).ToHashSet();
        var squashed = Squash(text);
        return tables.Where(t =>
        {
            var name = t.Name.ToLowerInvariant();
            if (words.Contains(name) || words.Contains($"{t.Schema}.{name}".ToLowerInvariant())) return true;
            var plain = Squash(name);
            if (plain.Length >= 4 && (squashed.Contains(plain) || squashed.Contains(Singular(plain)))) return true;
            var parts = name.Split('_', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2) return false;
            var initials = string.Concat(parts.Select(p => p[0]));
            return words.Contains(initials) || words.Contains(initials + "s");
        }).ToList();
    }

    static string Squash(string s) => new([.. s.ToLowerInvariant().Where(char.IsLetterOrDigit)]);

    static string Singular(string s) =>
        s.EndsWith("ies") ? s[..^3] + "y" : s.EndsWith("ses") || s.EndsWith("xes") ? s[..^2] : s.EndsWith('s') ? s[..^1] : s;

    static void Detail(StringBuilder sb, Table t)
    {
        var kind = t.Kind switch { "v" => " (view)", "m" => " (materialized view)", "f" => " (foreign table)", _ => "" };
        sb.AppendLine($"{t.Schema}.{t.Name}{kind} ~{Rows(t.Rows)} rows");
        foreach (var c in t.Cols)
            sb.AppendLine($"  {c.Name} {c.Type}{(c.Pk ? " PK" : "")}{(c.NotNull && !c.Pk ? " NOT NULL" : "")}{(c.Ref is null ? "" : $" → {c.Ref}")}");
    }

    static void AppendNames(StringBuilder sb, List<Table> tables)
    {
        foreach (var t in tables)
        {
            if (sb.Length > Budget)
            {
                sb.Append("…");
                break;
            }
            sb.Append(t.Id).Append(", ");
        }
        sb.AppendLine();
    }

    static string Rows(double n) => n >= 1e6 ? $"{n / 1e6:0.#}M" : n >= 1e3 ? $"{n / 1e3:0.#}k" : $"{n:0}";

    [GeneratedRegex("\"(?:[^\"]|\"\")+\"|[A-Za-z_][A-Za-z0-9_$]*")]
    private static partial Regex Word();
}
