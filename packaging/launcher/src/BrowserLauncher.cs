using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using Microsoft.Win32;

namespace Coherence.Launcher
{
    /// <summary>
    /// Opens the one-use bootstrap page without PowerShell, through the default <b>http</b> handler rather than the
    /// .html file association, which can point at an editor (installer report §3.3, LC-04). Microsoft Edge is the
    /// fallback the user can choose when the default browser does not open a session.
    /// </summary>
    internal sealed class BrowserLauncher
    {
        private readonly string? overrideCommand;

        public BrowserLauncher(string? overrideCommand)
        {
            this.overrideCommand = overrideCommand;
        }

        /// <summary>Opens the page in the default browser. Returns the program used.</summary>
        public string OpenDefault(string bootstrapFile)
        {
            var command = overrideCommand ?? DefaultHttpCommand()
                ?? throw new InvalidOperationException("No default web browser is set.");
            return Start(command, bootstrapFile);
        }

        /// <summary>Opens the page in Microsoft Edge; false when Edge is not installed.</summary>
        public bool OpenEdge(string bootstrapFile)
        {
            var edge = EdgePath();
            if (edge == null) return false;
            Start("\"" + edge + "\" %1", bootstrapFile);
            return true;
        }

        private static string Start(string command, string bootstrapFile)
        {
            var url = new Uri(bootstrapFile).AbsoluteUri;
            var (program, arguments) = Expand(command, url);
            var info = new ProcessStartInfo(program, arguments) { UseShellExecute = false };
            using (Process.Start(info)) { }
            return program;
        }

        /// <summary>The command Windows runs for http links, e.g. "C:\…\brave.exe" --single-argument %1.</summary>
        internal static string? DefaultHttpCommand()
        {
            uint length = 0;
            var flags = NativeMethods.ASSOCF_IS_PROTOCOL | NativeMethods.ASSOCF_NOTRUNCATE;
            NativeMethods.AssocQueryString(flags, NativeMethods.ASSOCSTR_COMMAND, "http", "open", null, ref length);
            if (length == 0) return null;
            var buffer = new StringBuilder((int)length);
            return NativeMethods.AssocQueryString(flags, NativeMethods.ASSOCSTR_COMMAND, "http", "open", buffer, ref length) == 0
                ? buffer.ToString()
                : null;
        }

        /// <summary>
        /// Splits a registry command template into program and arguments and substitutes the URL for %1 / %L. A
        /// template without a placeholder gets the URL appended. The URL is percent-encoded, so it contains no spaces
        /// or quotes.
        /// </summary>
        internal static (string Program, string Arguments) Expand(string template, string url)
        {
            template = template.Trim();
            string program, rest;
            if (template.StartsWith("\"", StringComparison.Ordinal))
            {
                var end = template.IndexOf('"', 1);
                if (end < 0) throw new FormatException("Unbalanced quotes in the browser command.");
                program = template.Substring(1, end - 1);
                rest = template.Substring(end + 1);
            }
            else
            {
                var space = template.IndexOf(' ');
                program = space < 0 ? template : template.Substring(0, space);
                rest = space < 0 ? "" : template.Substring(space);
            }
            program = Environment.ExpandEnvironmentVariables(program);
            var replaced = false;
            foreach (var token in new[] { "%1", "%L", "%l" })
                if (rest.Contains(token))
                {
                    rest = rest.Replace(token, url);
                    replaced = true;
                }
            rest = rest.Replace("%*", "").Trim();
            if (!replaced) rest = (rest + " \"" + url + "\"").Trim();
            return (program, rest);
        }

        internal static string? EdgePath()
        {
            foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
            {
                try
                {
                    using (var key = hive.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"))
                        if (key?.GetValue(null) is string path && File.Exists(path)) return path;
                }
                catch (Exception)
                {
                    // Try the next location.
                }
            }
            foreach (var root in new[] { "ProgramFiles(x86)", "ProgramFiles" })
            {
                var folder = Environment.GetEnvironmentVariable(root);
                if (folder == null) continue;
                var path = Path.Combine(folder, "Microsoft", "Edge", "Application", "msedge.exe");
                if (File.Exists(path)) return path;
            }
            return null;
        }
    }
}
