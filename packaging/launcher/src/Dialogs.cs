using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;

namespace Coherence.Launcher
{
    /// <summary>
    /// Small accessible dialogs: system message font, scaled by Windows (<see cref="ScaledByWindows"/>), keyboard
    /// operable (Enter, Esc, Tab), named for screen readers, on top so they are not lost behind the browser. In
    /// unattended test runs they are not shown: the cancel answer is logged and returned, so a test never loops or
    /// proceeds on an assumed "yes".
    /// </summary>
    internal static class Dialogs
    {
        public static bool Unattended { get; set; }
        /// <summary>Test builds: button labels an unattended run chooses when a dialog offers them.</summary>
        public static ICollection<string> Answers { get; } = new List<string>();
        public static Log? Log { get; set; }

        /// <summary>Returns the index of the chosen button; Esc or closing chooses <paramref name="cancel"/>.</summary>
        public static int Choose(string title, string message, string[] buttons, int defaultButton, int cancel)
        {
            Log?.Write("dialog", $"{title}: {message} [{string.Join(" | ", buttons)}]");
            if (Unattended)
            {
                var preset = Array.FindIndex(buttons, button => Answers.Contains(button));
                var answer = preset >= 0 ? preset : cancel;
                Log?.Write("dialog", "unattended answer: " + buttons[answer]);
                return answer;
            }
            using (ScaledByWindows.Begin())
            using (var form = new DialogForm(title, message, buttons, defaultButton, cancel))
            {
                form.ShowDialog();
                Log?.Write("dialog", "answer: " + buttons[form.Choice]);
                return form.Choice;
            }
        }

        public static void Inform(string title, string message) => Choose(title, message, new[] { "OK" }, 0, 0);

        private sealed class DialogForm : Form
        {
            public DialogForm(string title, string message, string[] buttons, int defaultButton, int cancel)
            {
                Choice = cancel;
                Text = title;
                AccessibleName = title;
                AccessibleDescription = message;
                Font = SystemFonts.MessageBoxFont;
                AutoScaleMode = AutoScaleMode.None;
                FormBorderStyle = FormBorderStyle.FixedDialog;
                MaximizeBox = false;
                MinimizeBox = false;
                ShowInTaskbar = true;
                TopMost = true;
                StartPosition = FormStartPosition.CenterScreen;
                AutoSize = true;
                AutoSizeMode = AutoSizeMode.GrowAndShrink;
                Padding = new Padding(16);
                try
                {
                    Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                }
                catch (Exception)
                {
                    // The default icon will do.
                }

                var layout = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, Dock = DockStyle.Fill };
                var text = new Label
                {
                    Text = message,
                    AutoSize = true,
                    MaximumSize = new Size(440, 0),
                    Margin = new Padding(0, 0, 0, 16),
                    AccessibleRole = AccessibleRole.StaticText,
                };
                layout.Controls.Add(text);
                var row = new FlowLayoutPanel
                {
                    AutoSize = true,
                    FlowDirection = FlowDirection.RightToLeft,
                    Anchor = AnchorStyles.Right,
                    WrapContents = false,
                };
                // Right to left: add the last button first so the visual order matches the given order.
                for (var i = buttons.Length - 1; i >= 0; i--)
                {
                    var index = i;
                    var button = new Button
                    {
                        Text = buttons[i],
                        AutoSize = true,
                        MinimumSize = new Size(88, 0),
                        TabIndex = i,
                        AccessibleName = buttons[i],
                    };
                    button.Click += (_, __) =>
                    {
                        Choice = index;
                        Close();
                    };
                    row.Controls.Add(button);
                    if (i == defaultButton) AcceptButton = button;
                    if (i == cancel) CancelButton = button;
                }
                layout.Controls.Add(row);
                Controls.Add(layout);
                Shown += (_, __) =>
                {
                    Activate();
                    (AcceptButton as Control)?.Focus();
                };
            }

            public int Choice { get; private set; }
        }
    }

    /// <summary>
    /// The launcher's own small windows (dialogs, "Starting Coherence…") are laid out at 96 DPI and created DPI-unaware
    /// with GDI scaling, so Windows draws them sharply at the scale of whichever monitor they are on. WinForms on .NET
    /// Framework lays out per-monitor-aware windows for the scale Windows signed in with, so on a monitor with another
    /// scale their text came out small and their buttons clipped. The app window stays per-monitor aware (WebView2).
    /// Create and show such a window inside <c>using (ScaledByWindows.Begin())</c>.
    /// </summary>
    internal sealed class ScaledByWindows : IDisposable
    {
        private readonly IntPtr previous;

        private ScaledByWindows(IntPtr previous) => this.previous = previous;

        public static ScaledByWindows Begin() => new ScaledByWindows(
            NativeMethods.SetThreadDpiAwarenessContext(NativeMethods.DPI_AWARENESS_CONTEXT_UNAWARE_GDISCALED));

        public void Dispose()
        {
            // Zero: the change was refused, so there is nothing to restore.
            if (previous != IntPtr.Zero) NativeMethods.SetThreadDpiAwarenessContext(previous);
        }
    }

    /// <summary>"Starting Coherence…", shown only when start-up takes longer than about two seconds.</summary>
    internal sealed class StartingWindow : Form
    {
        public StartingWindow()
        {
            Text = "Coherence";
            AccessibleName = "Starting Coherence";
            Font = SystemFonts.MessageBoxFont;
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            ControlBox = false;
            ShowInTaskbar = true;
            StartPosition = FormStartPosition.CenterScreen;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Padding = new Padding(20);
            var layout = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, Dock = DockStyle.Fill };
            layout.Controls.Add(new Label
            {
                Text = "Starting Coherence…",
                AutoSize = true,
                Margin = new Padding(0, 0, 0, 12),
            });
            layout.Controls.Add(new ProgressBar
            {
                Style = ProgressBarStyle.Marquee,
                Width = 280,
                AccessibleName = "Starting",
            });
            Controls.Add(layout);
        }
    }
}
