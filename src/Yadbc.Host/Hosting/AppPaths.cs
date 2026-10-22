namespace Yadbc.Host.Hosting;

public static class AppPaths
{
    public static string DataDir { get; } = Directory.CreateDirectory(
        Environment.GetEnvironmentVariable("YADBC_DATA_DIR")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "yadbc")).FullName;

    public static string ConnectionsFile => Path.Combine(DataDir, "connections.json");
}
