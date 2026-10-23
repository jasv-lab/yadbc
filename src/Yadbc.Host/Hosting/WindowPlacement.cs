using System.Runtime.InteropServices;
using System.Text.Json;

namespace Yadbc.Host.Hosting;

/// <summary>
/// The window opens where it was closed: position, size and maximized (window.json). Windows' own
/// placement API rather than Photino's size events: it keeps the restored size of a maximized window
/// and uses the same coordinates both ways. A placement on no monitor any more (a screen unplugged)
/// is ignored. Windows only; elsewhere the window just opens centered.
/// </summary>
static partial class WindowPlacement
{
    const int ShowNormal = 1, ShowMinimized = 2, ShowMaximized = 3;
    const int RestoreToMaximized = 2; // WPF_RESTORETOMAXIMIZED: minimized from maximized
    const uint MonitorDefaultToNull = 0;

    static string File => Path.Combine(AppPaths.DataDir, "window.json");

    sealed record Saved(int Left, int Top, int Right, int Bottom, bool Maximized);

    /// <summary>Whether there's a saved placement to restore (otherwise the caller centers the window).</summary>
    public static bool Exists => OperatingSystem.IsWindows() && Load() is not null;

    public static void Restore(IntPtr hwnd)
    {
        if (!OperatingSystem.IsWindows() || hwnd == IntPtr.Zero || Load() is not { } saved) return;
        var rect = new Rect { Left = saved.Left, Top = saved.Top, Right = saved.Right, Bottom = saved.Bottom };
        if (MonitorFromRect(ref rect, MonitorDefaultToNull) == IntPtr.Zero) return;
        var placement = new Placement
        {
            Length = Marshal.SizeOf<Placement>(),
            ShowCmd = saved.Maximized ? ShowMaximized : ShowNormal,
            NormalPosition = rect,
        };
        SetWindowPlacement(hwnd, ref placement);
    }

    public static void Save(IntPtr hwnd)
    {
        if (!OperatingSystem.IsWindows() || hwnd == IntPtr.Zero) return;
        var placement = new Placement { Length = Marshal.SizeOf<Placement>() };
        if (!GetWindowPlacement(hwnd, ref placement)) return;
        var r = placement.NormalPosition;
        var maximized = placement.ShowCmd == ShowMaximized
            || (placement.ShowCmd == ShowMinimized && (placement.Flags & RestoreToMaximized) != 0);
        try
        {
            System.IO.File.WriteAllText(File, JsonSerializer.Serialize(new Saved(r.Left, r.Top, r.Right, r.Bottom, maximized)));
        }
        catch (IOException)
        {
            // Next start opens centered; not worth failing the close over.
        }
    }

    static Saved? Load()
    {
        try
        {
            return System.IO.File.Exists(File) ? JsonSerializer.Deserialize<Saved>(System.IO.File.ReadAllText(File)) is { } s
                && s.Right - s.Left >= 400 && s.Bottom - s.Top >= 300 ? s : null : null;
        }
        catch (Exception e) when (e is JsonException or IOException)
        {
            return null;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Rect
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Point
    {
        public int X, Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Placement
    {
        public int Length;
        public int Flags;
        public int ShowCmd;
        public Point MinPosition;
        public Point MaxPosition;
        public Rect NormalPosition;
    }

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetWindowPlacement(IntPtr hwnd, ref Placement placement);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetWindowPlacement(IntPtr hwnd, ref Placement placement);

    [LibraryImport("user32.dll")]
    private static partial IntPtr MonitorFromRect(ref Rect rect, uint flags);
}
