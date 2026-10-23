using Photino.NET;

namespace Yadbc.Host.Hosting;

public static class DesktopWindow
{
    public static void Run(string url)
    {
        var window = new PhotinoWindow()
            // Photino logs every call, including Load(url) with the per-launch token in it.
            .SetLogVerbosity(0)
            .SetTitle("yadbc")
            // Title bar and taskbar; without it Windows shows the generic window icon.
            .SetIconFile(Path.Combine(AppContext.BaseDirectory, "yadbc.ico"))
            .SetUseOsDefaultSize(false)
            .SetSize(1440, 900)
            .SetResizable(true)
            .SetDevToolsEnabled(Environment.GetEnvironmentVariable("YADBC_DEV_URL") is not null)
            .Load(url);
        // First start: maximized (un-maximizing gives the centered default size).
        if (!WindowPlacement.Exists) window.Center().SetMaximized(true);
        // Where it was closed: restored once the native window exists, saved while it still does.
        window.RegisterWindowCreatedHandler((_, _) => WindowPlacement.Restore(window.WindowHandle));
        window.RegisterWindowClosingHandler((_, _) =>
        {
            WindowPlacement.Save(window.WindowHandle);
            return false; // don't cancel the close
        });

        window.WaitForClose();
    }
}
