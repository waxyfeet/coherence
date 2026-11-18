using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Coherence.Launcher
{
    /// <summary>
    /// Coherence in its own window (owner decision D3, changed 2 November 2026), hosted by WebView2, which is part of
    /// Windows 11. Only Coherence's own loopback origin and its one-use bootstrap page load here; every other link opens
    /// in the default browser. Developer tools, password and form autofill, host objects and web messages are off, and
    /// the window's browser data lives outside both the program folder and the Coherence data folder.
    /// Signing in uses a hidden second view in the same browser profile: the bootstrap page stores the new session in
    /// the origin's local storage, which the visible page notices without reloading, so unsaved edits survive a backend
    /// restart (the app's SessionBoundary reconnects on the storage event).
    /// </summary>
    internal sealed class AppWindow : Form
    {
        private readonly WebView2 view = new WebView2 { Dock = DockStyle.Fill };
        private readonly WebView2 signIn = new WebView2 { Size = new Size(1, 1), Visible = false, TabStop = false };
        private readonly string userDataFolder;
        private readonly Log log;
        private readonly bool offScreen;
        private readonly LauncherState state;
        private Task? ready;
        private int port;
        private string? bootstrapUrl;
        private bool ticketSent;
        private bool closing;

        public AppWindow(string userDataFolder, Log log, LauncherState state, bool offScreen)
        {
            this.userDataFolder = userDataFolder;
            this.log = log;
            this.state = state;
            this.offScreen = offScreen;
            Text = "Coherence";
            AccessibleName = "Coherence";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
            AutoScaleMode = AutoScaleMode.Dpi;
            MinimumSize = new Size(LogicalToDeviceUnits(760), LogicalToDeviceUnits(520));
            Size = new Size(LogicalToDeviceUnits(1280), LogicalToDeviceUnits(840));
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(18, 18, 20);
            view.DefaultBackgroundColor = BackColor;
            Controls.Add(signIn);
            Controls.Add(view);
            if (offScreen)
            {
                // Test builds: a real window that never appears on the owner's screen or taskbar.
                StartPosition = FormStartPosition.Manual;
                Location = new Point(-32000, -32000);
                ShowInTaskbar = false;
            }
            else RestorePlacement();
        }

        /// <summary>The user closed the window: the launcher runs its quit flow (it may keep running for AI work).</summary>
        public event Action? CloseRequested;

        /// <summary>The hidden view stored a new session for the origin.</summary>
        public event Action? SignedIn;

        /// <summary>The installed WebView2 runtime version, or null when Windows has none.</summary>
        public static string? RuntimeVersion()
        {
            try
            {
                return CoreWebView2Environment.GetAvailableBrowserVersionString();
            }
            catch (Exception)
            {
                return null;
            }
        }

        public Task Ready => ready ??= Initialise();

        private async Task Initialise()
        {
            var environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder,
                new CoreWebView2EnvironmentOptions());
            await view.EnsureCoreWebView2Async(environment);
            await signIn.EnsureCoreWebView2Async(environment);
            Harden(view.CoreWebView2);
            Harden(signIn.CoreWebView2);
            view.CoreWebView2.NavigationStarting += (_, e) =>
            {
                if (Allowed(e.Uri)) return;
                e.Cancel = true;
                OpenElsewhere(e.Uri);
            };
            view.CoreWebView2.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                if (SameOrigin(e.Uri)) view.CoreWebView2.Navigate(e.Uri);
                else OpenElsewhere(e.Uri);
            };
            view.CoreWebView2.DocumentTitleChanged += (_, __) =>
            {
                var title = view.CoreWebView2.DocumentTitle;
                Text = string.IsNullOrWhiteSpace(title) || title.StartsWith("Coherence", StringComparison.Ordinal)
                    ? (string.IsNullOrWhiteSpace(title) ? "Coherence" : title)
                    : "Coherence — " + title;
            };
            signIn.CoreWebView2.NavigationStarting += (_, e) =>
            {
                // The bootstrap page posts its one-use ticket to the backend, whose answer stores the new session in
                // the origin's local storage and then moves on to the app itself: that hand-off is the sign-in. Only
                // that one post goes through; the hand-off is stopped (the visible view shows the app).
                if (e.Uri == bootstrapUrl)
                {
                    ticketSent = false;
                    return;
                }
                if (!ticketSent && e.Uri == Origin + "/api/auth/bootstrap")
                {
                    ticketSent = true;
                    return;
                }
                e.Cancel = true;
                if (ticketSent && SameOrigin(e.Uri))
                {
                    ticketSent = false;
                    log.Write("window", "signed in");
                    SignedIn?.Invoke();
                }
                else log.Write("window", "the sign-in view refused a navigation");
            };
            signIn.CoreWebView2.NewWindowRequested += (_, e) => e.Handled = true;
            log.Write("window", "WebView2 " + environment.BrowserVersionString + " ready");
        }

        private void Harden(CoreWebView2 core)
        {
            var settings = core.Settings;
            settings.AreDevToolsEnabled = false;
            settings.IsPasswordAutosaveEnabled = false;
            settings.IsGeneralAutofillEnabled = false;
            settings.AreHostObjectsAllowed = false;
            settings.IsWebMessageEnabled = false;
            settings.IsStatusBarEnabled = false;
            core.ProcessFailed += (_, e) => log.Write("window", "browser process failed: " + e.ProcessFailedKind);
        }

        /// <summary>Signs in with a one-use bootstrap page for the backend at <paramref name="origin"/>.</summary>
        public async Task SignIn(string bootstrapFile, int originPort)
        {
            await Ready;
            port = originPort;
            bootstrapUrl = new Uri(bootstrapFile).AbsoluteUri;
            signIn.CoreWebView2.Navigate(bootstrapUrl);
        }

        /// <summary>After sign-in: show Coherence, loading it only if the window is not already showing it.</summary>
        public void ShowApp()
        {
            if (view.CoreWebView2 != null && !SameOrigin(view.CoreWebView2.Source))
                view.CoreWebView2.Navigate(Origin + "/");
            BringToFront(true);
        }

        private string Origin => $"http://127.0.0.1:{port.ToString(CultureInfo.InvariantCulture)}";

        public void BringToFront(bool activate)
        {
            if (!Visible) Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            if (activate && !offScreen) Activate();
        }

        /// <summary>The off-screen test window never takes focus from whatever the owner is doing.</summary>
        protected override bool ShowWithoutActivation => offScreen;

        /// <summary>Closes for real (quit, sign-out): no further quit request.</summary>
        public void CloseForQuit()
        {
            closing = true;
            Close();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // Any close the launcher did not start (the X button, Alt+F4, a WM_CLOSE from elsewhere, whatever reason
            // WinForms reports) asks the launcher to quit. Only a Windows shutdown proceeds: the launcher's hidden
            // window handles that session end.
            if (!closing && e.CloseReason != CloseReason.WindowsShutDown)
            {
                e.Cancel = true;
                CloseRequested?.Invoke();
                return;
            }
            if (!offScreen) SavePlacement();
            base.OnFormClosing(e);
        }

        internal bool Allowed(string? uri) => uri == bootstrapUrl || uri == "about:blank" || SameOrigin(uri);

        /// <summary>http://127.0.0.1:&lt;port&gt;/… or a blob: URL created by that origin.</summary>
        internal bool SameOrigin(string? uri)
        {
            if (uri == null || port == 0) return false;
            if (uri.StartsWith("blob:" + Origin + "/", StringComparison.Ordinal)) return true;
            return Uri.TryCreate(uri, UriKind.Absolute, out var parsed) && parsed.Scheme == Uri.UriSchemeHttp
                && parsed.Host == "127.0.0.1" && parsed.Port == port && parsed.UserInfo.Length == 0;
        }

        /// <summary>Links leaving Coherence open in the default browser; anything else is refused.</summary>
        private void OpenElsewhere(string uri)
        {
            if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed)
                || !new[] { Uri.UriSchemeHttps, Uri.UriSchemeHttp, Uri.UriSchemeMailto }.Contains(parsed.Scheme))
            {
                log.Write("window", "refused a navigation to " + Log.Clean(parsed?.Scheme ?? "an invalid address"));
                return;
            }
            try
            {
                using (Process.Start(new ProcessStartInfo(parsed.AbsoluteUri) { UseShellExecute = true })) { }
            }
            catch (Exception error)
            {
                log.Write("window", "could not open a link elsewhere: " + error.GetType().Name);
            }
        }

        private void RestorePlacement()
        {
            var saved = state.WindowPlacement();
            if (saved == null) return;
            var (bounds, maximised) = saved.Value;
            // Only where some screen can show most of it (a monitor may have been removed).
            if (!Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(bounds)
                && Rectangle.Intersect(s.WorkingArea, bounds).Width > 200)) return;
            StartPosition = FormStartPosition.Manual;
            Bounds = bounds;
            if (maximised) WindowState = FormWindowState.Maximized;
        }

        private void SavePlacement()
        {
            var bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            state.SaveWindowPlacement(bounds, WindowState == FormWindowState.Maximized);
        }
    }
}
