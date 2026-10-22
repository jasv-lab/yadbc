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
            .SetUseOsDefaultSize(false)
            .SetSize(1440, 900)
            .Center()
            .SetResizable(true)
            .SetDevToolsEnabled(Environment.GetEnvironmentVariable("YADBC_DEV_URL") is not null)
            .Load(url);

        window.WaitForClose();
    }
}
