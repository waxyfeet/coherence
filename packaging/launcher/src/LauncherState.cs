using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Coherence.Launcher
{
    /// <summary>
    /// Launcher preferences: the preferred local port. Kept in HKCU\Software\Coherence, never in the data folder
    /// (installer report §3.3, §3.5); test profiles use a file beside their disposable profile instead.
    /// </summary>
    internal sealed class LauncherState
    {
        // Below the dynamic range, and away from the developer ports 4417/5417 and the owner's 7917 (report §3.5).
        internal const int LowestBase = 20000;
        internal const int HighestBase = 44990;
        internal const int Candidates = 10;
        private const string RegistryKey = @"Software\Coherence";
        private readonly string? file;

        public LauncherState(string? stateFile)
        {
            file = stateFile;
        }

        /// <summary>The preferred port and the next nine, choosing and saving a random preference on first run.</summary>
        public int[] PortCandidates()
        {
            var port = Read();
            if (!IsUsable(port))
            {
                port = RandomBase();
                Save(port);
            }
            return Enumerable.Range(port, Candidates).ToArray();
        }

        /// <summary>Keeps the port the backend actually used, so open tabs find the same origin next time.</summary>
        public void Remember(int port)
        {
            if (port != Read() && port >= LowestBase && port < HighestBase + Candidates) Save(port);
        }

        /// <summary>After every candidate was taken: a fresh random range for the next attempt.</summary>
        public void ChooseNewRange()
        {
            Save(RandomBase());
        }

        internal static bool IsUsable(int port) => port >= LowestBase && port <= HighestBase;

        /// <summary>The app window's last position and size ("x,y,width,height,maximised"), if any.</summary>
        public (System.Drawing.Rectangle Bounds, bool Maximised)? WindowPlacement()
        {
            try
            {
                string? text;
                if (file != null)
                    text = File.Exists(file + ".window") ? File.ReadAllText(file + ".window") : null;
                else
                    using (var key = Registry.CurrentUser.OpenSubKey(RegistryKey))
                        text = key?.GetValue("Window") as string;
                return ParsePlacement(text);
            }
            catch (Exception)
            {
                return null;
            }
        }

        public void SaveWindowPlacement(System.Drawing.Rectangle bounds, bool maximised)
        {
            var text = string.Join(",", bounds.X, bounds.Y, bounds.Width, bounds.Height, maximised ? 1 : 0);
            try
            {
                if (file != null)
                {
                    File.WriteAllText(file + ".window", text, new UTF8Encoding(false));
                    return;
                }
                using (var key = Registry.CurrentUser.CreateSubKey(RegistryKey))
                    key?.SetValue("Window", text, RegistryValueKind.String);
            }
            catch (Exception)
            {
                // The window then opens at its default size next time.
            }
        }

        internal static (System.Drawing.Rectangle Bounds, bool Maximised)? ParsePlacement(string? text)
        {
            var parts = (text ?? "").Split(',');
            if (parts.Length != 5 || !parts.All(p => int.TryParse(p, out _))) return null;
            var n = parts.Select(int.Parse).ToArray();
            if (n[2] < 200 || n[3] < 150 || n[2] > 20000 || n[3] > 20000) return null;
            return (new System.Drawing.Rectangle(n[0], n[1], n[2], n[3]), n[4] == 1);
        }

        internal static int RandomBase()
        {
            var bytes = new byte[4];
            using (var random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
            return LowestBase + (int)(BitConverter.ToUInt32(bytes, 0) % (uint)(HighestBase - LowestBase + 1));
        }

        private int Read()
        {
            try
            {
                if (file != null)
                {
                    if (!File.Exists(file)) return 0;
                    var match = Regex.Match(File.ReadAllText(file), "\"preferredPort\"\\s*:\\s*(\\d{1,5})");
                    return match.Success ? int.Parse(match.Groups[1].Value) : 0;
                }
                using (var key = Registry.CurrentUser.OpenSubKey(RegistryKey))
                    return key?.GetValue("PreferredPort") is int value ? value : 0;
            }
            catch (Exception)
            {
                return 0;
            }
        }

        private void Save(int port)
        {
            try
            {
                if (file != null)
                {
                    File.WriteAllText(file, "{ \"preferredPort\": " + port + " }\n", new UTF8Encoding(false));
                    return;
                }
                using (var key = Registry.CurrentUser.CreateSubKey(RegistryKey))
                    key?.SetValue("PreferredPort", port, RegistryValueKind.DWord);
            }
            catch (Exception)
            {
                // Without a saved preference the next start simply chooses again.
            }
        }
    }
}
