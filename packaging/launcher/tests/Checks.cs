using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Coherence.Launcher.Checks
{
    /// <summary>Plain checks of the launcher's validation and parsing rules. Prints one line per check.</summary>
    internal static class Program
    {
        private static int failures;

        private static int Main()
        {
            Protocol();
            BootstrapFiles();
            BrowserCommands();
            BackendEnvironment();
            Options();
            Ports();
            Logging();
            Workspace();
            Console.WriteLine(failures == 0 ? "launcher checks: all passed" : $"launcher checks: {failures} failed");
            return failures == 0 ? 0 : 1;
        }

        private static void Workspace()
        {
            const string home = @"C:\Users\Synthetic";
            var oneDrive = new[] { null, @"C:\Users\Synthetic\OneDrive - Acme" };
            var synced = AppPaths.DefaultWorkspace(@"C:\Users\Synthetic\OneDrive - Acme\Documents", oneDrive, home);
            Check("OneDrive-synced Documents: a local Coherence Projects folder, with the reason",
                synced.Dir == @"C:\Users\Synthetic\Coherence Projects" && synced.Note == "onedrive");
            var network = AppPaths.DefaultWorkspace(@"\\fileserver\home$\synthetic", oneDrive, home);
            Check("network Documents: the same local folder, with the reason",
                network.Dir == @"C:\Users\Synthetic\Coherence Projects" && network.Note == "network");
            var lookalike = AppPaths.DefaultWorkspace(@"C:\Users\Synthetic\OneDrive - Acme Archive\Documents",
                oneDrive, home);
            Check("a folder that only starts like OneDrive stays in Documents",
                lookalike.Dir == @"C:\Users\Synthetic\OneDrive - Acme Archive\Documents\Coherence\Projects"
                && lookalike.Note == null);
        }

        private static void Check(string name, bool ok)
        {
            Console.WriteLine((ok ? "  ok   " : "  FAIL ") + name);
            if (!ok) failures++;
        }

        private static void Protocol()
        {
            var ready = BackendEvent.Parse("@coherence {\"event\":\"ready\",\"origin\":\"http://127.0.0.1:41234\",\"version\":\"0.2.0\",\"pid\":42}");
            Check("parses a ready event", ready?.Name == "ready" && ready.Text("version") == "0.2.0" && ready.Number("pid") == 42);
            Check("reads its loopback port", BackendEvent.LoopbackPort(ready?.Text("origin")) == 41234);
            foreach (var origin in new[] { "http://localhost:41234", "http://127.0.0.1:41234/", "https://127.0.0.1:41234",
                "http://127.0.0.2:41234", "http://127.0.0.1:99999", "http://127.0.0.1:0", "http://127.0.0.1:41234 " })
                Check("refuses origin " + origin, BackendEvent.LoopbackPort(origin) == null);
            foreach (var line in new[] { "Coherence running at http://127.0.0.1:1", "@coherence not json", "@coherence []",
                "@coherence {\"event\":\"\"}", "@coherence {\"noevent\":1}", "@coherence " + new string('x', 70000) })
                Check("ignores non-event line " + line.Substring(0, Math.Min(line.Length, 30)), BackendEvent.Parse(line) == null);
            var jobs = BackendEvent.Parse("@coherence {\"event\":\"jobs\",\"active\":2.5}");
            Check("refuses a fractional job count", jobs?.Number("active") == null);
            Check("commands are single JSON lines", BackendEvent.Command("open") == "{\"op\":\"open\"}\n");
        }

        private static void BootstrapFiles()
        {
            var data = @"C:\Users\Someone\AppData\Local\Coherence";
            var good = data + @"\.local-auth\bootstrap-0123456789abcdef01234567.html";
            Check("accepts the backend's bootstrap page", BackendEvent.IsBootstrapFile(good, data));
            foreach (var bad in new[]
            {
                data + @"\bootstrap-0123456789abcdef01234567.html",
                data + @"\.local-auth\launch.json",
                data + @"\.local-auth\bootstrap-0123456789ABCDEF01234567.html",
                data + @"\.local-auth\bootstrap-0123.html",
                data + @"\.local-auth\..\.local-auth\bootstrap-0123456789abcdef01234567.html",
                @"C:\Elsewhere\.local-auth\bootstrap-0123456789abcdef01234567.html",
                @".local-auth\bootstrap-0123456789abcdef01234567.html",
                @"\\server\share\.local-auth\bootstrap-0123456789abcdef01234567.html",
                "",
            })
                Check("refuses bootstrap path " + bad, !BackendEvent.IsBootstrapFile(bad, data));
        }

        private static void BrowserCommands()
        {
            const string url = "file:///C:/Users/A%20B/AppData/Local/Coherence/.local-auth/bootstrap-ab.html";
            var brave = BrowserLauncher.Expand("\"C:\\Program Files\\Brave\\brave.exe\" --single-argument %1", url);
            Check("expands a quoted program with %1", brave.Program == @"C:\Program Files\Brave\brave.exe"
                && brave.Arguments == "--single-argument " + url);
            var firefox = BrowserLauncher.Expand("\"C:\\Program Files\\Mozilla Firefox\\firefox.exe\" -osint -url \"%1\"", url);
            Check("keeps the template's own quotes", firefox.Arguments == "-osint -url \"" + url + "\"");
            var bare = BrowserLauncher.Expand("C:\\Browsers\\b.exe", url);
            Check("appends the URL when the template has no placeholder", bare.Program == @"C:\Browsers\b.exe"
                && bare.Arguments == "\"" + url + "\"");
            var star = BrowserLauncher.Expand("\"C:\\b.exe\" %L %*", url);
            Check("substitutes %L and drops %*", star.Arguments == url);
            var threw = false;
            try
            {
                BrowserLauncher.Expand("\"C:\\b.exe --x %1", url);
            }
            catch (FormatException)
            {
                threw = true;
            }
            Check("refuses unbalanced quotes", threw);
            Check("bootstrap URLs contain no spaces or quotes",
                new Uri(@"C:\Users\A B\x'y\.local-auth\bootstrap-ab.html").AbsoluteUri.IndexOfAny(new[] { ' ', '"' }) < 0);
        }

        private static void BackendEnvironment()
        {
            Environment.SetEnvironmentVariable("NODE_OPTIONS", "--require evil.js");
            Environment.SetEnvironmentVariable("NODE_TLS_REJECT_UNAUTHORIZED", "0");
            Environment.SetEnvironmentVariable("SCREENSCRIBE_V2_OPENAI_API_KEY", "secret");
            Environment.SetEnvironmentVariable("HTTPS_PROXY", "http://proxy");
            var paths = AppPaths.Resolve(Path.Combine(Path.GetTempPath(), "x", "Coherence.exe"),
                Path.Combine(Path.GetTempPath(), "coherence-launcher-checks"));
            var env = Backend.Environment(paths, new[] { 41234, 41235 });
            // Run from Git Bash, this process inherits SYSTEMROOT, TEMP etc. in upper case: they must still pass.
            Check("passes SystemRoot, TEMP and USERPROFILE whatever their spelling",
                env.TryGetValue("SystemRoot", out var root) && root == Environment.GetEnvironmentVariable("SystemRoot")
                && env.ContainsKey("TEMP") && env.ContainsKey("USERPROFILE"));
            Check("drops NODE_OPTIONS, TLS overrides, proxies and inherited app settings",
                !env.Keys.Any(k => k.StartsWith("NODE_", StringComparison.OrdinalIgnoreCase)
                    || k.EndsWith("_PROXY", StringComparison.OrdinalIgnoreCase) || k == "SCREENSCRIBE_V2_OPENAI_API_KEY"));
            Check("passes the data folder, workspace and ports",
                env["SCREENSCRIBE_V2_DATA_DIR"] == paths.DataDir && env["SCREENSCRIBE_V2_WORKSPACE_DIR"] == paths.WorkspaceDir
                && env["SCREENSCRIBE_V2_PORT"] == "41234,41235");
            Check("PATH holds only absolute Windows folders",
                env["PATH"].Split(';').All(p => Path.IsPathRooted(p) && p.StartsWith(Environment.GetEnvironmentVariable("SystemRoot")!, StringComparison.OrdinalIgnoreCase)));
            Check("no executable lookup in the current folder", env["NoDefaultCurrentDirectoryInExePath"] == "1");
            Check("test profiles get their own instance names", paths.InstanceKey.Contains('.') && paths.StateFile != null);
            Check("the profile's data folder is not created by the launcher", !Directory.Exists(paths.DataDir));
        }

        private static void Options()
        {
            var quit = LaunchOptions.Parse(new[] { "--quit", "--wait" }, out var error);
            Check("parses --quit --wait", error == null && quit.Quit && quit.Wait);
            LaunchOptions.Parse(new[] { "--wait" }, out error);
            Check("refuses --wait without --quit", error != null);
            var afterSetup = LaunchOptions.Parse(new[] { "--after-setup" }, out error);
            Check("parses --after-setup", error == null && afterSetup.AfterSetup && !afterSetup.Quit);
            LaunchOptions.Parse(new[] { "--after-setup", "--quit" }, out error);
            Check("refuses --after-setup with --quit", error != null);
            LaunchOptions.Parse(new[] { "--nope" }, out error);
            Check("refuses unknown options", error != null);
            var test = LaunchOptions.Parse(new[] { "--profile", @"C:\T", "--unattended" }, out error);
            Check("test builds accept a profile", error == null && test.Profile == @"C:\T" && test.Unattended);
            LaunchOptions.Parse(new[] { "--profile" }, out error);
            Check("a profile needs a folder", error != null);
        }

        private static void Ports()
        {
            var bases = Enumerable.Range(0, 2000).Select(_ => LauncherState.RandomBase()).ToList();
            Check("random preferred ports stay in the agreed range",
                bases.All(p => p >= LauncherState.LowestBase && p <= LauncherState.HighestBase));
            Check("random preferred ports vary", bases.Distinct().Count() > 1500);
            var file = Path.Combine(Path.GetTempPath(), "coherence-launcher-checks", "state.json");
            File.Delete(file);
            var state = new LauncherState(file);
            var candidates = state.PortCandidates();
            Check("ten consecutive candidates, remembered", candidates.Length == 10
                && candidates.Zip(candidates.Skip(1), (a, b) => b - a).All(d => d == 1)
                && new LauncherState(file).PortCandidates().SequenceEqual(candidates));
            state.Remember(candidates[3]);
            Check("keeps the port actually used", new LauncherState(file).PortCandidates()[0] == candidates[3]);
            Check("never prefers the developer or demo ports",
                new[] { 4417, 5417, 7917 }.All(p => !LauncherState.IsUsable(p)));
        }

        private static void Logging()
        {
            Check("log lines lose control characters", Log.Clean("a\r\nb\u001b[31mc") == "a  b [31mc");
            Check("log lines are bounded", Log.Clean(new string('x', 10000)).Length <= 4001);
            Check("final paths drop device prefixes", AppPaths.StripDevicePrefix(@"\\?\C:\x") == @"C:\x"
                && AppPaths.StripDevicePrefix(@"\\?\UNC\srv\share") == @"\\srv\share");
            var codes = new[] { 1, 2, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 24, 30, 31 };
            var messages = codes.Select(StartupMessages.Describe).ToList();
            Check("every start-up code has plain words, without npm or environment advice",
                messages.All(m => m.Length > 40 && m.IndexOf("npm", StringComparison.OrdinalIgnoreCase) < 0
                    && m.IndexOf("SCREENSCRIBE", StringComparison.Ordinal) < 0));
            Check("each start-up code has its own message, apart from the generic one",
                messages.Skip(1).Distinct().Count() == codes.Length - 1
                && !messages.Skip(1).Contains(StartupMessages.Describe(999)));
            var answered = LaunchOptions.Parse(new[] { "--answer", "Use this data", "--answer", "Start fresh" }, out var error);
            Check("test builds take preset dialog answers", error == null
                && answered.Answers.SequenceEqual(new[] { "Use this data", "Start fresh" }));
        }
    }
}
