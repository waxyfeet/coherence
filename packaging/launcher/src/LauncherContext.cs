using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Coherence.Launcher
{
    /// <summary>
    /// The running launcher (installer report §3.3, §3.7): starts the backend, hands each browser session over, keeps
    /// the tray icon, and runs the quit, crash and Windows sign-out flows. Everything here runs on the UI thread;
    /// backend and pipe callbacks are marshalled onto it.
    /// </summary>
    internal sealed class LauncherContext : ApplicationContext
    {
        private enum Phase { Starting, Ready, Stopped }
        /// <summary>Where a session opens: Coherence's own window (D3), or the default browser or Edge as fallback.</summary>
        private enum Browser { Window, Default, Edge }

        private const int WatchdogMs = 30_000;
        private const int QuitWaitMs = 10_000;
        private const int SignOutWaitMs = 3_000;
        private static readonly TimeSpan CrashWindow = TimeSpan.FromMinutes(10);
        private const int AutomaticRestarts = 3;

        private readonly AppPaths paths;
        private readonly Log log;
        private readonly LauncherState state;
        private readonly BrowserLauncher browser;
        private readonly string version;
        private readonly ControlWindow window;
        private readonly NotifyIcon tray;
        private readonly Timer startingTimer = new Timer { Interval = 2000 };
        private readonly Timer watchdog = new Timer { Interval = WatchdogMs };
        private readonly Timer forceTimer = new Timer { Interval = QuitWaitMs };
        private readonly Queue<Browser> waitingForReady = new Queue<Browser>();
        private readonly Queue<Browser> sentOpens = new Queue<Browser>();
        private readonly List<DateTime> crashes = new List<DateTime>();
        private Backend? backend;
        private int[] ports = new int[0];
        private Phase phase = Phase.Stopped;
        private bool quitting;
        private bool forced;
        private bool portRetried;
        private bool leftoverHandled;
        private bool restoreHandled;
        private bool adoptRestoredProfile;
        private bool blockingShutdown;
        private int activeJobs;
        private TaskCompletionSource<int?>? statusWaiter;
        private StartingWindow? startingWindow;
        private AppWindow? appWindow;
        private Browser preferred = Browser.Default;
        private bool windowSignedIn;
        private int readyPort;

        public LauncherContext(AppPaths paths, Log log, SingleInstance single, string version, string? browserCommand,
            bool windowHidden)
        {
            this.paths = paths;
            this.log = log;
            this.version = version;
            state = new LauncherState(paths.StateFile);
            browser = new BrowserLauncher(browserCommand);
            window = new ControlWindow(QueryEndSession, EndSession);
            // Coherence's own window when Windows has WebView2 (always on Windows 11); otherwise the default browser.
            // Test builds that substitute a browser command test the browser path.
            if (browserCommand == null)
            {
                var runtime = AppWindow.RuntimeVersion();
                if (runtime != null)
                {
                    appWindow = new AppWindow(paths.WebViewDir, log, state, windowHidden);
                    appWindow.CloseRequested += () => _ = Quit(confirm: true);
                    appWindow.SignedIn += WindowSignedIn;
                    preferred = Browser.Window;
                    log.Write("launcher", "opening Coherence in its own window (WebView2 " + Log.Clean(runtime) + ")");
                }
                else log.Write("launcher", "WebView2 is not available: opening Coherence in the default browser");
            }
            tray = new NotifyIcon
            {
                Icon = AppIcon(),
                Text = "Coherence is starting…",
                ContextMenuStrip = TrayMenu(),
                // Unattended test runs (test builds only) leave nothing in the owner's notification area.
                Visible = !Dialogs.Unattended,
            };
            tray.MouseDoubleClick += (_, e) =>
            {
                if (e.Button == MouseButtons.Left) Open(preferred);
            };
            startingTimer.Tick += (_, __) => ShowStarting();
            watchdog.Tick += (_, __) => SessionNotOpened();
            forceTimer.Tick += (_, __) => ForceQuit();
            single.Serve(Forwarded, message => log.Write("launcher", message));
            Open(preferred);
        }

        public int ExitCode { get; private set; }

        private void Post(Action action)
        {
            try
            {
                if (!window.IsDisposed) window.BeginInvoke(action);
            }
            catch (InvalidOperationException)
            {
                // The launcher is closing.
            }
        }

        private void StartBackend()
        {
            phase = Phase.Starting;
            activeJobs = 0;
            sentOpens.Clear();
            tray.Text = "Coherence is starting…";
            ports = state.PortCandidates();
            try
            {
                backend = Backend.Start(paths, ports, log, e => Post(() => OnEvent(e)), code => Post(() => OnExit(code)),
                    adoptRestoredProfile);
                adoptRestoredProfile = false;
            }
            catch (LauncherFailure failure)
            {
                phase = Phase.Stopped;
                Fail(failure.Code);
                return;
            }
            startingTimer.Start();
        }

        private void OnEvent(BackendEvent e)
        {
            switch (e.Name)
            {
                case "starting":
                    log.Write("launcher", "backend starting");
                    break;
                case "ready":
                    Ready(e);
                    break;
                case "bootstrap":
                    Bootstrap(e.Text("file"));
                    break;
                case "session-opened":
                    watchdog.Stop();
                    log.Write("launcher", "session opened");
                    break;
                case "jobs":
                    activeJobs = Math.Max(0, e.Number("active") ?? activeJobs);
                    UpdateShutdownBlock();
                    break;
                case "status":
                    statusWaiter?.TrySetResult(e.Number("activeJobs"));
                    break;
                case "quit-requested":
                    _ = Quit(confirm: true);
                    break;
                case "stopping":
                    log.Write("launcher", "backend stopping: " + (e.Text("reason") ?? "unknown"));
                    break;
                case "error":
                    var code = e.Text("code") ?? "";
                    log.Write("launcher", "backend error event: " + code);
                    if ((code == "OPEN_FAILED" || code == "COMMAND_FAILED") && sentOpens.Count > 0)
                    {
                        sentOpens.Dequeue();
                        Dialogs.Inform("Coherence couldn't open", "Coherence couldn't prepare a new browser session. Try Open Coherence again from the tray icon.");
                    }
                    break;
                default:
                    log.Write("launcher", "ignored unknown backend event: " + Log.Clean(e.Name));
                    break;
            }
        }

        private void Ready(BackendEvent e)
        {
            var port = BackendEvent.LoopbackPort(e.Text("origin"));
            if (port == null || !ports.Contains(port.Value))
            {
                log.Write("launcher", "rejected ready event: unexpected origin");
                backend?.Terminate();
                return;
            }
            var reported = e.Text("version");
            if (reported != version)
            {
                log.Write("launcher", $"version mismatch: launcher {version}, backend {Log.Clean(reported ?? "none")}");
                quitting = true;
                backend?.Send("shutdown");
                forceTimer.Start();
                HideStarting();
                Fail(ExitCodes.VersionMismatch, exitWhenDone: false);
                return;
            }
            phase = Phase.Ready;
            readyPort = port.Value;
            state.Remember(port.Value);
            HideStarting();
            tray.Text = "Coherence is running";
            log.Write("launcher", $"backend ready on port {port}");
            while (waitingForReady.Count > 0) SendOpen(waitingForReady.Dequeue());
        }

        private void Open(Browser kind)
        {
            if (quitting) return;
            // The window already holds a live session: just bring it forward.
            if (kind == Browser.Window && appWindow != null && windowSignedIn && phase == Phase.Ready)
            {
                appWindow.BringToFront(true);
                log.Write("launcher", "window brought to the front");
                return;
            }
            if (phase == Phase.Ready && backend != null)
            {
                SendOpen(kind);
                return;
            }
            if (!waitingForReady.Contains(kind)) waitingForReady.Enqueue(kind);
            if (phase == Phase.Stopped) StartBackend();
        }

        private void SendOpen(Browser kind)
        {
            if (backend == null || !backend.Send("open")) return;
            sentOpens.Enqueue(kind);
        }

        private void Bootstrap(string? file)
        {
            var kind = sentOpens.Count > 0 ? sentOpens.Dequeue() : Browser.Default;
            if (!BackendEvent.IsBootstrapFile(file, paths.DataDir) || !File.Exists(file))
            {
                log.Write("launcher", "rejected bootstrap event: unexpected file");
                return;
            }
            try
            {
                if (kind == Browser.Window && appWindow != null)
                {
                    _ = SignInWindow(file!);
                }
                else if (kind == Browser.Edge)
                {
                    if (!browser.OpenEdge(file!))
                    {
                        Dialogs.Inform("Microsoft Edge not found", "Microsoft Edge isn't installed on this computer. Open Coherence again from the tray icon to use your default browser.");
                        return;
                    }
                    log.Write("launcher", "opened the session page in Microsoft Edge");
                }
                else
                {
                    log.Write("launcher", "opened the session page with " + Path.GetFileName(browser.OpenDefault(file!)));
                }
                watchdog.Stop();
                watchdog.Start();
            }
            catch (Exception error)
            {
                log.Write("launcher", "could not start the browser: " + error.GetType().Name);
                SessionNotOpened();
            }
        }

        /// <summary>The window signs in through its hidden view; any failure falls back to the default browser.</summary>
        private async Task SignInWindow(string file)
        {
            try
            {
                await appWindow!.SignIn(file, readyPort);
                log.Write("launcher", "opened the session page in the window");
            }
            catch (Exception error)
            {
                log.Write("launcher", "the window could not sign in (" + error.GetType().Name + "); using the default browser");
                preferred = Browser.Default;
                appWindow?.CloseForQuit();
                appWindow = null;
                try
                {
                    log.Write("launcher", "opened the session page with " + Path.GetFileName(browser.OpenDefault(file)));
                }
                catch (Exception fallback)
                {
                    log.Write("launcher", "could not start the browser: " + fallback.GetType().Name);
                }
            }
        }

        private void WindowSignedIn()
        {
            windowSignedIn = true;
            watchdog.Stop();
            appWindow?.ShowApp();
        }

        private void SessionNotOpened()
        {
            watchdog.Stop();
            if (preferred == Browser.Window && appWindow != null)
            {
                var answer = Dialogs.Choose("Coherence's window didn't sign in",
                    "Coherence's window has not connected yet. Try again, or open Coherence in your web browser instead.",
                    new[] { "Try again", "Open in browser", "Close" }, 0, 2);
                if (answer == 0) Open(Browser.Window);
                else if (answer == 1) Open(Browser.Default);
                return;
            }
            var choice = Dialogs.Choose("Coherence didn't open in your browser",
                "No Coherence tab has connected yet. If none appeared, try again, or open Coherence in Microsoft Edge.",
                new[] { "Try again", "Open in Microsoft Edge", "Close" }, 0, 2);
            if (choice == 0) Open(Browser.Default);
            else if (choice == 1) Open(Browser.Edge);
        }

        private void OnExit(int code)
        {
            var wasReady = phase == Phase.Ready;
            phase = Phase.Stopped;
            backend?.Dispose();
            backend = null;
            startingTimer.Stop();
            watchdog.Stop();
            forceTimer.Stop();
            sentOpens.Clear();
            HideStarting();
            activeJobs = 0;
            windowSignedIn = false;
            UpdateShutdownBlock();
            log.Write("launcher", $"backend exited with code {code}");
            if (quitting)
            {
                if (ExitCode == 0) ExitCode = forced ? ExitCodes.ForcedExit : 0;
                Finish();
                return;
            }
            if (!wasReady)
            {
                if (code == ExitCodes.PortUnavailable && !portRetried)
                {
                    portRetried = true;
                    state.ChooseNewRange();
                    log.Write("launcher", "every candidate port was taken; trying a new range");
                    StartBackend();
                    return;
                }
                if (code == ExitCodes.AlreadyRunning && !leftoverHandled && EndLeftover())
                {
                    StartBackend();
                    return;
                }
                if (code == ExitCodes.ProfileRestored && !restoreHandled)
                {
                    restoreHandled = true;
                    if (RestoredProfile()) return;
                }
                waitingForReady.Clear();
                Fail(code);
                return;
            }
            Crashed();
        }

        /// <summary>An exit nobody asked for: restart automatically a few times, then ask.</summary>
        private void Crashed()
        {
            var now = DateTime.UtcNow;
            crashes.RemoveAll(time => now - time > CrashWindow);
            crashes.Add(now);
            if (crashes.Count <= AutomaticRestarts)
            {
                log.Write("launcher", $"backend stopped unexpectedly; automatic restart {crashes.Count} of {AutomaticRestarts}");
                tray.ShowBalloonTip(5000, "Coherence restarted", "Coherence stopped unexpectedly and was restarted. Reconnect open tabs if they ask you to.", ToolTipIcon.Warning);
                StartBackend();
                // The window signs in again by itself; its page reconnects without reloading.
                if (appWindow != null) Open(Browser.Window);
                return;
            }
            var choice = Dialogs.Choose("Coherence stopped unexpectedly",
                "Coherence stopped several times in a few minutes. Your saved work is kept. Restart it, or open the logs to see what happened.",
                new[] { "Restart", "Open logs", "Quit" }, 0, 2);
            if (choice == 0)
            {
                crashes.Clear();
                StartBackend();
                return;
            }
            if (choice == 1) OpenFolder(log.Folder);
            Finish();
        }

        /// <summary>
        /// The data folder was restored from a backup or copied from another place or computer (decision D9): the
        /// user chooses to use it as it is, or to start fresh with the old folder kept beside the new one. Returns
        /// false when the user quits or the folder cannot be set aside.
        /// </summary>
        private bool RestoredProfile()
        {
            var choice = Dialogs.Choose("Coherence found restored data",
                "Coherence's data folder was restored from a backup or copied from another place or computer. Use it as it is, or start with a fresh data folder? Starting fresh keeps this folder, renamed, beside the new one. Your project folders are not affected either way.",
                new[] { "Use this data", "Start fresh", "Quit" }, 0, 2);
            if (choice == 0)
            {
                log.Write("launcher", "using the restored data folder, as chosen");
                adoptRestoredProfile = true;
                StartBackend();
                return true;
            }
            if (choice != 1) return false;
            var aside = paths.DataDir + ".old-" + DateTime.Now.ToString("yyyyMMdd-HHmmss");
            try
            {
                Directory.Move(paths.DataDir, aside);
            }
            catch (Exception error)
            {
                log.Write("launcher", "could not set the restored data folder aside: " + error.GetType().Name);
                return false;
            }
            log.Write("launcher", "starting fresh; the restored data folder was kept as " + Path.GetFileName(aside));
            StartBackend();
            return true;
        }

        /// <summary>
        /// The data folder is still held by an earlier backend of this installation (e.g. after a launcher crash it
        /// is still shutting down). Wait for it briefly; if it does not stop, offer to end it.
        /// </summary>
        private bool EndLeftover()
        {
            leftoverHandled = true;
            var pid = LockOwner();
            if (pid == null) return false;
            log.Write("launcher", $"data folder held by an earlier Coherence backend (pid {pid})");
            using (var process = TryGetProcess(pid.Value))
            {
                if (process == null) return true;
                if (process.WaitForExit(8000)) return true;
                var choice = Dialogs.Choose("Coherence is not responding",
                    "An earlier Coherence is still running but not responding. End it and start again? Work it had not saved may be lost.",
                    new[] { "End it and start", "Cancel" }, 0, 1);
                if (choice != 0) return false;
                KillTree((uint)pid.Value);
                return process.WaitForExit(5000);
            }
        }

        /// <summary>The pid in the backend's diagnostic lock record, if it is this installation's node.exe and ours.</summary>
        private int? LockOwner()
        {
            try
            {
                var text = File.ReadAllText(Path.Combine(paths.DataDir, ".instance-lock.json"));
                var match = Regex.Match(text, "\"pid\"\\s*:\\s*(\\d{1,10})");
                if (!match.Success || !uint.TryParse(match.Groups[1].Value, out var pid)) return null;
                var image = NativeMethods.ProcessImagePath(pid);
                var owner = NativeMethods.ProcessOwner(pid);
                return image != null && owner != null && owner.Equals(paths.User)
                    && string.Equals(image, paths.Node, StringComparison.OrdinalIgnoreCase)
                    ? (int)pid
                    : (int?)null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static Process? TryGetProcess(int pid)
        {
            try
            {
                return Process.GetProcessById(pid);
            }
            catch (ArgumentException)
            {
                return null;
            }
        }

        /// <summary>Ends a process and everything it started (its platform helpers).</summary>
        private static void KillTree(uint root)
        {
            var children = new Dictionary<uint, List<uint>>();
            var snapshot = NativeMethods.CreateToolhelp32Snapshot(NativeMethods.TH32CS_SNAPPROCESS, 0);
            if (snapshot != new IntPtr(-1))
            {
                try
                {
                    var entry = new NativeMethods.ProcessEntry
                    {
                        Size = (uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(NativeMethods.ProcessEntry)),
                        ExeFile = "",
                    };
                    for (var ok = NativeMethods.Process32FirstW(snapshot, ref entry); ok;
                        ok = NativeMethods.Process32NextW(snapshot, ref entry))
                    {
                        if (!children.TryGetValue(entry.ParentProcessId, out var list))
                            children[entry.ParentProcessId] = list = new List<uint>();
                        list.Add(entry.ProcessId);
                    }
                }
                finally
                {
                    NativeMethods.CloseHandle(snapshot);
                }
            }
            var order = new List<uint>();
            var pending = new Stack<uint>();
            pending.Push(root);
            while (pending.Count > 0)
            {
                var pid = pending.Pop();
                if (order.Contains(pid)) continue;
                order.Add(pid);
                if (children.TryGetValue(pid, out var list))
                    foreach (var child in list) pending.Push(child);
            }
            foreach (var pid in order)
            {
                var handle = NativeMethods.OpenProcess(NativeMethods.PROCESS_TERMINATE, false, pid);
                if (handle == IntPtr.Zero) continue;
                NativeMethods.TerminateProcess(handle, ExitCodes.ForcedExit);
                NativeMethods.CloseHandle(handle);
            }
        }

        /// <summary>
        /// Quit: if AI work is running, say what stops; then ask the backend to shut down gracefully and end it only if
        /// it has not stopped within ten seconds. Returns "ok" or "cancelled" (for an installer's --quit).
        /// </summary>
        public async Task<string> Quit(bool confirm)
        {
            if (quitting) return "ok";
            if (backend == null || phase == Phase.Stopped)
            {
                quitting = true;
                Finish();
                return "ok";
            }
            var jobs = activeJobs;
            if (phase == Phase.Ready)
            {
                statusWaiter = new TaskCompletionSource<int?>();
                backend.Send("status");
                var answered = await Task.WhenAny(statusWaiter.Task, Task.Delay(2000));
                if (answered == statusWaiter.Task && statusWaiter.Task.Result is int reported) jobs = reported;
                statusWaiter = null;
            }
            if (confirm && jobs > 0)
            {
                var message = jobs == 1
                    ? "An AI task is still running. Quitting stops it; screen readings that already finished are kept."
                    : $"{jobs} AI tasks are still running. Quitting stops them; screen readings that already finished are kept.";
                if (Dialogs.Choose("Quit Coherence?", message, new[] { "Quit", "Keep running" }, 1, 1) != 0)
                    return "cancelled";
            }
            if (quitting) return "ok";
            quitting = true;
            tray.Text = "Coherence is stopping…";
            log.Write("launcher", "quitting");
            if (backend == null)
            {
                Finish();
                return "ok";
            }
            backend.Send("shutdown");
            forceTimer.Start();
            return "ok";
        }

        private void ForceQuit()
        {
            forceTimer.Stop();
            if (backend == null) return;
            forced = true;
            log.Write("launcher", "backend did not stop in time; ending it");
            backend.Terminate();
        }

        private void Finish()
        {
            startingTimer.Stop();
            watchdog.Stop();
            forceTimer.Stop();
            HideStarting();
            tray.Visible = false;
            appWindow?.CloseForQuit();
            log.Write("launcher", "launcher exiting with code " + ExitCode);
            ExitThread();
        }

        private void Fail(int code, bool exitWhenDone = true)
        {
            HideStarting();
            log.Write("launcher", $"start-up failed with code {code}");
            var choice = Dialogs.Choose(StartupMessages.Title(code), StartupMessages.Describe(code),
                new[] { "Open logs", "Close" }, 1, 1);
            if (choice == 0) OpenFolder(log.Folder);
            ExitCode = code == ExitCodes.VersionMismatch ? ExitCodes.VersionMismatch : ExitCodes.StartFailed;
            if (exitWhenDone) Finish();
        }

        private string Forwarded(string command)
        {
            // Runs on the pipe thread: hand over to the UI thread and wait for the answer.
            if (command == "open")
            {
                Post(() => Open(preferred));
                return "ok";
            }
            var answer = new TaskCompletionSource<string>();
            Post(async () => answer.TrySetResult(await Quit(confirm: true)));
            return answer.Task.Wait(TimeSpan.FromMinutes(5)) ? answer.Task.Result : "busy";
        }

        private void QueryEndSession()
        {
            // Answer at once; ask Windows to show a reason only while AI work is running.
            UpdateShutdownBlock();
        }

        private void EndSession()
        {
            log.Write("launcher", "Windows is signing out or shutting down");
            quitting = true;
            if (backend != null)
            {
                backend.Send("shutdown");
                backend.WaitForExit(SignOutWaitMs);
            }
            NativeMethods.ShutdownBlockReasonDestroy(window.Handle);
            Finish();
        }

        private void UpdateShutdownBlock()
        {
            var block = activeJobs > 0 && !window.IsDisposed;
            if (block == blockingShutdown) return;
            blockingShutdown = block;
            if (block) NativeMethods.ShutdownBlockReasonCreate(window.Handle, "Coherence is stopping its running AI tasks safely.");
            else if (!window.IsDisposed) NativeMethods.ShutdownBlockReasonDestroy(window.Handle);
        }

        private void ShowStarting()
        {
            startingTimer.Stop();
            if (phase != Phase.Starting || startingWindow != null || Dialogs.Unattended) return;
            using (ScaledByWindows.Begin())
            {
                startingWindow = new StartingWindow();
                startingWindow.Show();
            }
        }

        private void HideStarting()
        {
            startingTimer.Stop();
            startingWindow?.Close();
            startingWindow?.Dispose();
            startingWindow = null;
        }

        private ContextMenuStrip TrayMenu()
        {
            var menu = new ContextMenuStrip { AccessibleName = "Coherence" };
            var open = new ToolStripMenuItem("Open Coherence", null, (_, __) => Open(preferred))
            {
                Font = new Font(SystemFonts.MenuFont, FontStyle.Bold),
            };
            menu.Items.Add(open);
            if (appWindow != null)
                menu.Items.Add(new ToolStripMenuItem("Open in browser instead", null, (_, __) => Open(Browser.Default)));
            menu.Items.Add(new ToolStripMenuItem("Open projects folder", null, (_, __) =>
            {
                if (paths.WorkspaceDir.Length > 0 && Directory.Exists(paths.WorkspaceDir)) OpenFolder(paths.WorkspaceDir);
                else Dialogs.Inform("No projects folder yet", "Coherence creates its projects folder when you save your first project.");
            }));
            menu.Items.Add(new ToolStripMenuItem("Open logs folder", null, (_, __) => OpenFolder(log.Folder)));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("About Coherence", null, (_, __) => Dialogs.Inform("About Coherence",
                $"Coherence {version}\nOpen source under the MIT licence.\nInstalled in {paths.Install}")));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Quit Coherence", null, (_, __) => _ = Quit(confirm: true)));
            return menu;
        }

        private void OpenFolder(string folder)
        {
            try
            {
                Directory.CreateDirectory(folder);
                var explorer = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
                using (Process.Start(new ProcessStartInfo(explorer, "\"" + folder + "\"") { UseShellExecute = false })) { }
            }
            catch (Exception error)
            {
                log.Write("launcher", "could not open a folder: " + error.GetType().Name);
            }
        }

        private static Icon AppIcon()
        {
            try
            {
                return Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
            }
            catch (Exception)
            {
                return SystemIcons.Application;
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                backend?.Dispose();
                tray.Dispose();
                startingTimer.Dispose();
                watchdog.Dispose();
                forceTimer.Dispose();
                appWindow?.Dispose();
                window.Dispose();
            }
            base.Dispose(disposing);
        }

        /// <summary>
        /// A hidden top-level window: the UI-thread anchor for callbacks and the receiver of Windows' sign-out and
        /// restart messages (including Restart Manager's ENDSESSION_CLOSEAPP).
        /// </summary>
        private sealed class ControlWindow : Form
        {
            private readonly Action queryEnd;
            private readonly Action end;

            public ControlWindow(Action queryEnd, Action end)
            {
                this.queryEnd = queryEnd;
                this.end = end;
                ShowInTaskbar = false;
                // Not "Coherence": that is the app window's title.
                Text = "Coherence launcher";
                CreateHandle();
            }

            protected override void SetVisibleCore(bool value) => base.SetVisibleCore(false);

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == NativeMethods.WM_QUERYENDSESSION)
                {
                    queryEnd();
                    m.Result = new IntPtr(1);
                    return;
                }
                if (m.Msg == NativeMethods.WM_ENDSESSION)
                {
                    if (m.WParam != IntPtr.Zero) end();
                    m.Result = IntPtr.Zero;
                    return;
                }
                base.WndProc(ref m);
            }
        }
    }
}
