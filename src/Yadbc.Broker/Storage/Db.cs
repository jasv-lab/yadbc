using Microsoft.Data.Sqlite;

namespace Yadbc.Broker.Storage;

/// <summary>
/// broker.db through one connection, one caller at a time. The volume is NFS in the cluster: SQLite's
/// WAL index normally lives in shared memory, which isn't reliable there. In EXCLUSIVE locking mode WAL
/// keeps its index on the heap instead — which also means only this one connection may open the file.
/// A team's worth of catalog reads and logins is nowhere near what one connection can serve.
/// </summary>
public sealed class Db : IDisposable
{
    readonly SqliteConnection _conn;
    readonly SemaphoreSlim _gate = new(1, 1);

    public Db(BrokerOptions options)
    {
        Directory.CreateDirectory(options.DataDir);
        Path = System.IO.Path.GetFullPath(System.IO.Path.Combine(options.DataDir, "broker.db"));
        _conn = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path, Pooling = false }.ToString());
        _conn.Open();
        var sql = new Sql(_conn);
        sql.Exec("pragma locking_mode = exclusive; pragma journal_mode = wal; pragma foreign_keys = on");
        Schema.Migrate(sql);
    }

    public string Path { get; }

    public async Task<T> Run<T>(Func<Sql, T> work, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            return work(new Sql(_conn));
        }
        finally
        {
            _gate.Release();
        }
    }

    public Task Run(Action<Sql> work, CancellationToken ct = default) =>
        Run(sql =>
        {
            work(sql);
            return 0;
        }, ct);

    public void Dispose()
    {
        _conn.Dispose();
        _gate.Dispose();
    }
}

/// <summary>Thin helpers over the connection; inside <see cref="Transaction"/> every command joins it.</summary>
public sealed class Sql(SqliteConnection conn)
{
    SqliteTransaction? _tx;

    public static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public static DateTimeOffset Time(long ms) => DateTimeOffset.FromUnixTimeMilliseconds(ms);

    public T Transaction<T>(Func<T> work)
    {
        _tx = conn.BeginTransaction();
        try
        {
            var result = work();
            _tx.Commit();
            return result;
        }
        catch
        {
            _tx.Rollback();
            throw;
        }
        finally
        {
            _tx.Dispose();
            _tx = null;
        }
    }

    public int Exec(string sql, object? args = null)
    {
        using var cmd = Command(sql, args);
        return cmd.ExecuteNonQuery();
    }

    public T? Scalar<T>(string sql, object? args = null)
    {
        using var cmd = Command(sql, args);
        var value = cmd.ExecuteScalar();
        return value is null or DBNull ? default : (T)Convert.ChangeType(value, Nullable.GetUnderlyingType(typeof(T)) ?? typeof(T));
    }

    public List<T> Query<T>(string sql, Func<SqliteDataReader, T> map, object? args = null)
    {
        using var cmd = Command(sql, args);
        using var reader = cmd.ExecuteReader();
        var rows = new List<T>();
        while (reader.Read()) rows.Add(map(reader));
        return rows;
    }

    public T? One<T>(string sql, Func<SqliteDataReader, T> map, object? args = null) where T : class =>
        Query(sql, map, args).FirstOrDefault();

    /// <summary>Parameters from an anonymous object: <c>new { id }</c> binds <c>$id</c>.</summary>
    SqliteCommand Command(string sql, object? args)
    {
        var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.Transaction = _tx;
        if (args is not null)
            foreach (var p in args.GetType().GetProperties())
                cmd.Parameters.AddWithValue("$" + p.Name, p.GetValue(args) ?? DBNull.Value);
        return cmd;
    }
}

public static class ReaderExtensions
{
    public static string? Str(this SqliteDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? null : r.GetString(i);
    }

    public static long Long(this SqliteDataReader r, string column) => r.GetInt64(r.GetOrdinal(column));

    public static bool Bool(this SqliteDataReader r, string column) => r.GetInt64(r.GetOrdinal(column)) != 0;

    public static byte[]? Bytes(this SqliteDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? null : (byte[])r.GetValue(i);
    }
}
