namespace Yadbc.Broker.Storage;

/// <summary>
/// Nightly <c>VACUUM INTO</c> copy next to the database (a consistent snapshot even while it's in use),
/// keeping the last few. It covers a bad write or a corrupt file; getting copies off the volume is the
/// cluster backup's job.
/// </summary>
public sealed class Backup(Db db, BrokerOptions options, ILogger<Backup> log) : BackgroundService
{
    static readonly TimeSpan At = TimeSpan.FromHours(2); // UTC, after the working day everywhere we are

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            var now = DateTimeOffset.UtcNow;
            var next = new DateTimeOffset(now.UtcDateTime.Date, TimeSpan.Zero) + At;
            if (next <= now) next = next.AddDays(1);
            await Task.Delay(next - now, ct);
            try
            {
                await RunOnce(ct);
            }
            catch (Exception e)
            {
                log.LogError(e, "Backup failed");
            }
        }
    }

    public async Task<string> RunOnce(CancellationToken ct = default)
    {
        var dir = Path.Combine(options.DataDir, "backups");
        Directory.CreateDirectory(dir);
        var file = Path.GetFullPath(Path.Combine(dir, $"broker-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}.db"));
        await db.Run(sql => sql.Exec("vacuum into $file", new { file }), ct);
        foreach (var old in Directory.GetFiles(dir, "broker-*.db").OrderDescending().Skip(options.BackupKeepDays))
            File.Delete(old);
        log.LogInformation("Backed up to {File}", file);
        return file;
    }
}
