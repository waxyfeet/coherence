using System;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace Coherence.Launcher
{
    /// <summary>
    /// Coherence.exe — starts Coherence for the signed-in Windows user, or hands a second launch over to the one
    /// already running (installer report §3.3). <c>--quit [--wait]</c> asks a running launcher to quit (installer).
    /// </summary>
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            // DLLs only from System32 and the program folder (WebView2Loader.dll): never from the current folder or PATH.
            NativeMethods.SetDefaultDllDirectories(NativeMethods.LOAD_LIBRARY_SEARCH_SYSTEM32
                | NativeMethods.LOAD_LIBRARY_SEARCH_APPLICATION_DIR);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            var options = LaunchOptions.Parse(args, out var error);
            Dialogs.Unattended = options.Unattended;
            foreach (var answer in options.Answers) Dialogs.Answers.Add(answer);
            if (error != null)
            {
                Dialogs.Inform("Coherence", error);
                return ExitCodes.BadArguments;
            }
            // --quit only asks this user's running launcher to quit, so an elevated all-users Setup may send it.
            if (!options.Quit && NativeMethods.IsElevated())
            {
                Dialogs.Inform("Coherence runs as you",
                    "Coherence was started as administrator. Open it normally from the Start menu so it runs with your own account.");
                return ExitCodes.Elevated;
            }

            AppPaths paths;
            try
            {
                paths = AppPaths.Resolve(Application.ExecutablePath, options.Profile);
            }
            catch (LauncherFailure failure)
            {
                Dialogs.Inform(StartupMessages.Title(failure.Code), StartupMessages.Describe(failure.Code));
                return failure.Code;
            }
            var log = new Log(paths.LogsDir);
            Dialogs.Log = log;
            var version = Metadata("CoherenceVersion");
            log.Write("launcher", $"Coherence.exe {version} ({Metadata("CoherenceBuildKind")} build), pid {Process.GetCurrentProcess().Id}"
                + (args.Length > 0 ? ", options: " + string.Join(" ", args.Where(a => a.StartsWith("--", StringComparison.Ordinal))) : ""));
            AppDomain.CurrentDomain.UnhandledException += (_, e) =>
                log.Write("launcher", "unhandled error: " + (e.ExceptionObject as Exception)?.ToString());
            Application.ThreadException += (_, e) =>
            {
                log.Write("launcher", "unhandled error: " + e.Exception);
                Dialogs.Inform("Coherence", "The Coherence launcher hit a problem and will close. Your work is kept; open Coherence again.");
                Application.Exit();
            };

            // Setup starts Coherence from its last page (or after a silent upgrade) moments before Setup itself exits.
            if (!options.Quit && SingleInstance.SetupIsRunning()
                && !(options.AfterSetup && WaitForSetup(log)))
            {
                Dialogs.Inform("Coherence is being updated", "Coherence Setup is running. Open Coherence again when Setup has finished.");
                return ExitCodes.SetupRunning;
            }

            using (var single = SingleInstance.Acquire(paths))
            {
                if (!single.IsPrimary) return HandOver(single, options, log);
                if (options.Quit)
                {
                    log.Write("launcher", "--quit: Coherence was not running");
                    return 0;
                }
                using (var context = new LauncherContext(paths, log, single, version, options.BrowserCommand,
                    options.WindowHidden))
                {
                    Application.Run(context);
                    return context.ExitCode;
                }
            }
        }

        /// <summary>A launcher is already running for this user: forward the request to it.</summary>
        private static int HandOver(SingleInstance single, LaunchOptions options, Log log)
        {
            var command = options.Quit ? "quit" : "open";
            var result = single.Forward(command, Application.ExecutablePath, message => log.Write("launcher", message));
            if (result == null)
            {
                log.Write("launcher", "the running launcher did not answer");
                Dialogs.Inform("Coherence is not responding",
                    "Coherence is already running but not responding. Restart Windows, then open Coherence again.");
                return ExitCodes.OtherInstanceUnresponsive;
            }
            var (reply, processId) = result.Value;
            log.Write("launcher", $"forwarded {command} to pid {processId}: {Log.Clean(reply)}");
            if (!options.Quit) return reply == "ok" ? 0 : ExitCodes.OtherInstanceUnresponsive;
            if (reply == "cancelled") return ExitCodes.QuitCancelled;
            if (reply != "ok") return ExitCodes.OtherInstanceUnresponsive;
            if (!options.Wait) return 0;
            try
            {
                using (var running = Process.GetProcessById(processId))
                    return running.WaitForExit(60_000) ? 0 : ExitCodes.OtherInstanceUnresponsive;
            }
            catch (ArgumentException)
            {
                return 0;
            }
        }

        /// <summary>True when Setup exited within a minute (it normally takes under a second).</summary>
        private static bool WaitForSetup(Log log)
        {
            log.Write("launcher", "started by Setup: waiting for it to exit");
            var watch = Stopwatch.StartNew();
            while (SingleInstance.SetupIsRunning())
            {
                if (watch.Elapsed > TimeSpan.FromMinutes(1))
                {
                    log.Write("launcher", "Setup is still running after a minute");
                    return false;
                }
                Thread.Sleep(250);
            }
            log.Write("launcher", $"Setup exited after {watch.ElapsedMilliseconds} ms");
            return true;
        }

        private static string Metadata(string key) =>
            typeof(Program).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
                .FirstOrDefault(a => a.Key == key)?.Value ?? "unknown";
    }
}
