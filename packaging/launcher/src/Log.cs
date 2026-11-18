using System;
using System.IO;
using System.Text;

namespace Coherence.Launcher
{
    /// <summary>
    /// Bounded rotating log (5 × 1 MB) for the launcher and the backend's stderr. Logging never fails the launcher.
    /// </summary>
    internal sealed class Log
    {
        private const long MaxBytes = 1_000_000;
        private const int Keep = 5;
        private const int MaxLine = 4000;
        private static readonly Encoding Utf8 = new UTF8Encoding(false);
        private readonly object gate = new object();
        private readonly string file;

        public Log(string folder)
        {
            Folder = folder;
            file = Path.Combine(folder, "launcher.log");
            try
            {
                Directory.CreateDirectory(folder);
            }
            catch (Exception)
            {
                // Without a log folder the launcher still works; it just cannot keep diagnostics.
            }
        }

        public string Folder { get; }

        public void Write(string source, string text)
        {
            var line = Clean(text);
            lock (gate)
            {
                try
                {
                    Rotate();
                    File.AppendAllText(file, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [{source}] {line}\r\n", Utf8);
                }
                catch (Exception)
                {
                    // Disk full, folder removed or locked: drop the line.
                }
            }
        }

        private void Rotate()
        {
            var info = new FileInfo(file);
            if (!info.Exists || info.Length < MaxBytes) return;
            for (var i = Keep - 1; i >= 1; i--)
            {
                var older = Path.Combine(Folder, $"launcher.{i}.log");
                var newer = i == 1 ? file : Path.Combine(Folder, $"launcher.{i - 1}.log");
                if (File.Exists(older)) File.Delete(older);
                if (File.Exists(newer)) File.Move(newer, older);
            }
        }

        internal static string Clean(string text)
        {
            var builder = new StringBuilder(Math.Min(text.Length, MaxLine));
            foreach (var c in text)
            {
                if (builder.Length >= MaxLine)
                {
                    builder.Append('…');
                    break;
                }
                builder.Append(char.IsControl(c) && c != '\t' ? ' ' : c);
            }
            return builder.ToString();
        }
    }
}
