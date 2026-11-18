using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Coherence.Platform
{
    /// <summary>The one-shot operations, each a port of the PowerShell it replaces (named in each summary).</summary>
    internal static class Commands
    {
        /// <summary>server/storage/locations.ts: a Shell Known Folder by GUID, including redirected Documents.</summary>
        public static string KnownFolder(string? line)
        {
            var id = new Guid((line ?? "").Trim());
            var result = IntPtr.Zero;
            try
            {
                // KF_FLAG_DONT_VERIFY: report the configured location even when it is not reachable right now.
                Marshal.ThrowExceptionForHR(NativeMethods.SHGetKnownFolderPath(ref id, 0x4000, IntPtr.Zero, out result));
                return Marshal.PtrToStringUni(result) ?? throw new IOException("No folder");
            }
            finally
            {
                if (result != IntPtr.Zero) Marshal.FreeCoTaskMem(result);
            }
        }

        /// <summary>
        /// server/storage/protectedSecrets.ts: Windows DPAPI for the current user, base64 in and out. The same call as
        /// the PowerShell version, so either one reads what the other saved.
        /// </summary>
        public static string Dpapi(bool protect, string base64)
        {
            var input = Convert.FromBase64String(base64.Trim());
            var output = protect
                ? ProtectedData.Protect(input, null, DataProtectionScope.CurrentUser)
                : ProtectedData.Unprotect(input, null, DataProtectionScope.CurrentUser);
            return Convert.ToBase64String(output);
        }

        /// <summary>A path sent as base64 UTF-8, so no console code page can change it.</summary>
        public static string Utf8Path(string base64)
        {
            var path = new UTF8Encoding(false, true).GetString(Convert.FromBase64String(base64.Trim()));
            if (!Path.IsPathRooted(path) || path.IndexOf('\0') >= 0) throw new IOException("Bad path");
            return path;
        }

        /// <summary>
        /// server/security/localLauncher.ts: the launcher folder becomes owned by, and open only to, the current user
        /// (inheritance removed), before any secret is written into it.
        /// </summary>
        public static void PrivateDirectory(string path)
        {
            var sid = WindowsIdentity.GetCurrent().User ?? throw new IOException("No user");
            var acl = new DirectorySecurity();
            acl.SetOwner(sid);
            acl.SetAccessRuleProtection(true, false);
            acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None,
                AccessControlType.Allow));
            Directory.SetAccessControl(path, acl);
        }

        /// <summary>
        /// server/platform/outputFolder.ts: the Windows folder chooser. The request is JSON
        /// (<c>{"initialPath","description"}</c>); the answer is <c>{"path": string | null}</c>.
        /// </summary>
        public static string ChooseFolder(string requestJson)
        {
            var json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
            var request = json.Deserialize<Dictionary<string, object>>(requestJson)
                ?? throw new IOException("Bad request");
            Application.EnableVisualStyles();
            // The process has no visible window; an invisible top-most owner keeps the chooser in front and modal.
            using (var owner = new Form())
            using (var dialog = new FolderBrowserDialog())
            {
                owner.Text = "Coherence folder chooser";
                owner.ShowInTaskbar = false;
                owner.TopMost = true;
                owner.StartPosition = FormStartPosition.CenterScreen;
                owner.Size = new Size(1, 1);
                owner.Opacity = 0;
                owner.Show();
                owner.Activate();
                dialog.Description = request.TryGetValue("description", out var d) ? d as string ?? "" : "";
                dialog.SelectedPath = request.TryGetValue("initialPath", out var p) ? p as string ?? "" : "";
                dialog.ShowNewFolderButton = false;
                string? selected = null;
                if (dialog.ShowDialog(owner) == DialogResult.OK) selected = dialog.SelectedPath;
                return json.Serialize(new Dictionary<string, object?> { ["path"] = selected });
            }
        }

        /// <summary>
        /// "Open project folder": the folder in File Explorer, replacing the `open` package (which used PowerShell).
        /// Only an existing local folder that is not a link; Explorer gets it as one quoted argument.
        /// </summary>
        public static void Reveal(string path)
        {
            if (path.StartsWith(@"\\", StringComparison.Ordinal) || path.EndsWith(@"\", StringComparison.Ordinal))
                throw new IOException("Bad path");
            var attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Not a folder");
            var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            using (Process.Start(new ProcessStartInfo(Path.Combine(windows, "explorer.exe"), "\"" + path + "\"")
                   {
                       UseShellExecute = false,
                       WorkingDirectory = windows,
                   }))
            {
            }
        }
    }
}
