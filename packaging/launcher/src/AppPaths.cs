using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace Coherence.Launcher
{
    /// <summary>
    /// Every folder the launcher and backend use, resolved natively and passed to the backend as final paths so
    /// junctioned or redirected folders behave as the backend's own lookup did (installer report §3.3). The launcher
    /// never creates anything inside the data folder: the backend claims it.
    /// </summary>
    internal sealed class AppPaths
    {
        public string Install { get; private set; } = "";
        public string Node { get; private set; } = "";
        public string Entry { get; private set; } = "";
        public string DataDir { get; private set; } = "";
        /// <summary>Empty when Windows cannot say where Documents is; the app then offers Browse.</summary>
        public string WorkspaceDir { get; private set; } = "";
        /// <summary>"onedrive" or "network" when the workspace is not in Documents for that reason (decision D8).</summary>
        public string? WorkspaceNote { get; private set; }
        public string LogsDir { get; private set; } = "";
        /// <summary>The app window's browser data (session storage, cache): outside the program and data folders.</summary>
        public string WebViewDir { get; private set; } = "";
        /// <summary>Test profiles keep launcher preferences in a file instead of the registry.</summary>
        public string? StateFile { get; private set; }
        /// <summary>Names the per-user (and, in test builds, per-profile) mutexes and pipe.</summary>
        public string InstanceKey { get; private set; } = "";
        public SecurityIdentifier User { get; private set; } = WindowsIdentity.GetCurrent().User!;

        public static AppPaths Resolve(string executable, string? testProfile)
        {
            var paths = new AppPaths();
            paths.Install = FinalPath(Path.GetDirectoryName(Path.GetFullPath(executable))!);
            paths.Node = Path.Combine(paths.Install, "runtime", "node.exe");
            paths.Entry = Path.Combine(paths.Install, "server", "index.mjs");
            paths.InstanceKey = paths.User.Value;
            if (testProfile != null)
            {
                var root = Path.GetFullPath(testProfile);
                Directory.CreateDirectory(root);
                root = FinalPath(root);
                paths.DataDir = Path.Combine(root, "data");
                paths.WorkspaceDir = Path.Combine(root, "projects");
                paths.LogsDir = Path.Combine(root, "launcher-logs");
                paths.WebViewDir = Path.Combine(root, "webview2");
                paths.StateFile = Path.Combine(root, "launcher-state.json");
                paths.InstanceKey += "." + ShortHash(root.ToLowerInvariant());
                return paths;
            }
            var localAppData = KnownFolder(NativeMethods.FolderLocalAppData)
                ?? throw new LauncherFailure(ExitCodes.UserFoldersUnavailable);
            paths.DataDir = Path.Combine(localAppData, "Coherence");
            // Outside the profile: a fresh profile must contain only what the backend creates.
            paths.LogsDir = Path.Combine(localAppData, "CoherenceLauncher", "Logs");
            paths.WebViewDir = Path.Combine(localAppData, "CoherenceLauncher", "WebView2");
            var documents = KnownFolder(NativeMethods.FolderDocuments);
            if (documents != null)
            {
                var oneDrive = new[] { "OneDrive", "OneDriveCommercial", "OneDriveConsumer" }
                    .Select(Environment.GetEnvironmentVariable);
                var (dir, note) = DefaultWorkspace(documents, oneDrive,
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
                paths.WorkspaceDir = dir;
                paths.WorkspaceNote = note;
            }
            return paths;
        }

        /// <summary>
        /// Decision D8, as in server/storage/locations.ts: projects go to Documents\Coherence\Projects unless
        /// Documents is synced by OneDrive or on a network share, which Coherence's storage protection refuses; then
        /// they go to a local "Coherence Projects" folder in the user's profile, and the app says why.
        /// </summary>
        internal static (string Dir, string? Note) DefaultWorkspace(string documents, IEnumerable<string?> oneDriveRoots,
            string home)
        {
            var local = Path.Combine(home, "Coherence Projects");
            if (documents.StartsWith(@"\\", StringComparison.Ordinal)) return (local, "network");
            var inside = Path.GetFullPath(documents).TrimEnd('\\') + @"\";
            foreach (var root in oneDriveRoots)
            {
                if (string.IsNullOrEmpty(root) || !Path.IsPathRooted(root)) continue;
                if (inside.StartsWith(Path.GetFullPath(root).TrimEnd('\\') + @"\", StringComparison.OrdinalIgnoreCase))
                    return (local, "onedrive");
            }
            return (Path.Combine(documents, "Coherence", "Projects"), null);
        }

        /// <summary>The Known Folder as Windows maps it (including redirection), resolved to its final path.</summary>
        public static string? KnownFolder(Guid id)
        {
            if (NativeMethods.SHGetKnownFolderPath(id, NativeMethods.KF_FLAG_DONT_VERIFY, IntPtr.Zero, out var raw) != 0)
                return null;
            try
            {
                var path = Marshal.PtrToStringUni(raw);
                if (string.IsNullOrEmpty(path) || !Path.IsPathRooted(path)) return null;
                return Directory.Exists(path) ? FinalPath(path!) : path;
            }
            finally
            {
                NativeMethods.CoTaskMemFree(raw);
            }
        }

        /// <summary>Resolves junctions and symbolic links in an existing folder, like Node's realpath.</summary>
        public static string FinalPath(string path)
        {
            using (var handle = NativeMethods.CreateFile(path, 0, NativeMethods.FILE_SHARE_ALL, IntPtr.Zero,
                NativeMethods.OPEN_EXISTING, NativeMethods.FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero))
            {
                if (handle.IsInvalid) return path;
                var buffer = new StringBuilder(32768);
                var length = NativeMethods.GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity,
                    NativeMethods.FILE_NAME_NORMALIZED);
                if (length == 0 || length >= buffer.Capacity) return path;
                return StripDevicePrefix(buffer.ToString());
            }
        }

        internal static string StripDevicePrefix(string path)
        {
            if (path.StartsWith(@"\\?\UNC\", StringComparison.Ordinal)) return @"\\" + path.Substring(8);
            if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path.Substring(4);
            return path;
        }

        private static string ShortHash(string value)
        {
            using (var sha = SHA256.Create())
            {
                var hash = sha.ComputeHash(Encoding.UTF8.GetBytes(value));
                return BitConverter.ToString(hash, 0, 6).Replace("-", "").ToLowerInvariant();
            }
        }
    }
}
