using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace Coherence.Launcher
{
    /// <summary>
    /// One control event from the backend's stdout (installer report §3.4): a line "@coherence {json}". The launcher
    /// trusts nothing in it until validated: origins must be literal loopback, bootstrap pages must sit in the data
    /// folder's .local-auth, and the version must match the launcher's own.
    /// </summary>
    internal sealed class BackendEvent
    {
        private const string Prefix = "@coherence ";
        private const int MaxLine = 65536;
        private static readonly Regex Origin = new Regex(@"^http://127\.0\.0\.1:([0-9]{1,5})$", RegexOptions.CultureInvariant);
        private static readonly Regex BootstrapName = new Regex(@"^bootstrap-[a-f0-9]{16,128}\.html$", RegexOptions.CultureInvariant);

        private BackendEvent(string name, IDictionary<string, object?> data)
        {
            Name = name;
            Data = data;
        }

        public string Name { get; }
        public IDictionary<string, object?> Data { get; }

        /// <summary>Null for lines that are not well-formed control events.</summary>
        public static BackendEvent? Parse(string? line)
        {
            if (line == null || line.Length > MaxLine || !line.StartsWith(Prefix, StringComparison.Ordinal)) return null;
            try
            {
                var serializer = new JavaScriptSerializer { RecursionLimit = 8 };
                if (!(serializer.DeserializeObject(line.Substring(Prefix.Length)) is Dictionary<string, object?> data))
                    return null;
                return data.TryGetValue("event", out var name) && name is string text && text.Length > 0
                    ? new BackendEvent(text, data)
                    : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        public string? Text(string key) => Data.TryGetValue(key, out var value) ? value as string : null;

        public int? Number(string key)
        {
            if (!Data.TryGetValue(key, out var value) || value == null) return null;
            switch (value)
            {
                case int i:
                    return i;
                case long l when l >= int.MinValue && l <= int.MaxValue:
                    return (int)l;
                case decimal d when d == Math.Floor(d) && d >= int.MinValue && d <= int.MaxValue:
                    return (int)d;
                default:
                    return null;
            }
        }

        /// <summary>The port of a literal http://127.0.0.1:port origin, or null.</summary>
        public static int? LoopbackPort(string? origin)
        {
            if (origin == null) return null;
            var match = Origin.Match(origin);
            if (!match.Success) return null;
            var port = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
            return port >= 1 && port <= 65535 ? port : (int?)null;
        }

        /// <summary>A bootstrap page path is accepted only as dataDir\.local-auth\bootstrap-&lt;hex&gt;.html.</summary>
        public static bool IsBootstrapFile(string? file, string dataDir)
        {
            if (string.IsNullOrEmpty(file) || !Path.IsPathRooted(file) || file!.IndexOf('\0') >= 0) return false;
            string full;
            try
            {
                full = Path.GetFullPath(file);
            }
            catch (Exception)
            {
                return false;
            }
            if (!string.Equals(full, file, StringComparison.Ordinal)) return false;
            var folder = Path.GetDirectoryName(full);
            return string.Equals(folder, Path.Combine(dataDir, ".local-auth"), StringComparison.OrdinalIgnoreCase)
                && BootstrapName.IsMatch(Path.GetFileName(full));
        }

        public static string Command(string op) => "{\"op\":\"" + op + "\"}\n";
    }
}
