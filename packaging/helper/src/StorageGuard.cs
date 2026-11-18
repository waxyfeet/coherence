using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
using static Coherence.Platform.NativeMethods;

namespace Coherence.Platform
{
    /// <summary>A refusal with the Windows reason class the backend may explain (Controlled Folder Access).</summary>
    internal sealed class GuardException : IOException
    {
        public GuardException(string message, int win32Error) : base(message) { Win32Error = win32Error; }
        public int Win32Error { get; }
    }

    /// <summary>
    /// The storage guard, ported unchanged in behaviour from the C# that server/storage/windowsStorageGuard.ts compiled
    /// inside PowerShell: same JSON-line protocol, same handles, flags and checks. Directory handles deny DELETE sharing,
    /// preventing ancestor rename/reparse swaps; removal is by the verified file HANDLE, not a check followed by a
    /// path-based delete. One addition: a refusal says when Windows denied access (`"error":"access-denied"`), so the
    /// backend can point to Controlled Folder Access instead of a generic message.
    /// </summary>
    internal static class StorageGuard
    {
        private const int ERROR_ACCESS_DENIED = 5;
        private const int STATUS_ACCESS_DENIED = unchecked((int)0xC0000022);

        public static void Serve(TextReader input, TextWriter output)
        {
            // No 2 MB default cap: requests are small, but the PowerShell guard accepted any length.
            var json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
            var leases = new Dictionary<string, List<IDisposable>>(StringComparer.Ordinal);
            try
            {
                string? line;
                while ((line = input.ReadLine()) != null)
                {
                    object? id = null;
                    string? error = null;
                    try
                    {
                        var request = json.Deserialize<Dictionary<string, object>>(line)
                            ?? throw new IOException("Empty storage request");
                        request.TryGetValue("id", out id);
                        Handle(request, leases);
                    }
                    catch (Exception e)
                    {
                        error = IsAccessDenied(e) ? "access-denied" : "refused";
                    }
                    var response = new Dictionary<string, object?> { ["id"] = id, ["ok"] = error == null };
                    if (error != null) response["error"] = error;
                    output.WriteLine(json.Serialize(response));
                }
            }
            finally
            {
                foreach (var handles in leases.Values)
                    foreach (var handle in handles) handle.Dispose();
            }
        }

        private static void Handle(Dictionary<string, object> r, Dictionary<string, List<IDisposable>> leases)
        {
            switch (Text(r, "action"))
            {
                case "lock":
                {
                    var token = Text(r, "token");
                    if (leases.ContainsKey(token)) throw new IOException("Lease token in use");
                    var handles = new List<IDisposable>();
                    try
                    {
                        foreach (var p in Paths(r, "paths")) handles.Add(Pin(p));
                        leases[token] = handles;
                    }
                    catch
                    {
                        foreach (var h in handles) h.Dispose();
                        throw;
                    }
                    break;
                }
                case "create-directory":
                {
                    var token = Text(r, "token");
                    if (leases.ContainsKey(token)) throw new IOException("Lease token in use");
                    leases[token] = new List<IDisposable> { CreateOwned(Text(r, "path")) };
                    break;
                }
                case "unlock":
                {
                    var token = Text(r, "token");
                    if (leases.TryGetValue(token, out var handles))
                    {
                        foreach (var h in handles) h.Dispose();
                        leases.Remove(token);
                    }
                    break;
                }
                case "remove":
                    Remove(Text(r, "path"), Text(r, "identity"), Text(r, "hash"), Flag(r, "directory"));
                    break;
                case "rename":
                    Move(Text(r, "from"), Text(r, "to"), Text(r, "identity"), false);
                    break;
                case "replace":
                    Move(Text(r, "from"), Text(r, "to"), Text(r, "identity"), true);
                    break;
                case "verify-file":
                    VerifyFile(Text(r, "path"), Text(r, "identity"));
                    break;
                case "queue":
                    Queue(r);
                    break;
                default:
                    throw new IOException("Unknown storage operation");
            }
        }

        /// <summary>Durably write a queued job record: pinned ancestors, verified project root, temporary then rename.</summary>
        private static void Queue(Dictionary<string, object> r)
        {
            var handles = new List<IDisposable>();
            try
            {
                foreach (var p in Paths(r, "paths")) handles.Add(Pin(p));
                VerifyIdentity(Text(r, "root"), Text(r, "rootIdentity"));
                var directory = Text(r, "directory");
                Directory.CreateDirectory(directory);
                handles.Add(Pin(directory));
                var target = Text(r, "target");
                var temporary = target + ".tmp-" + Guid.NewGuid().ToString("N");
                string temporaryIdentity;
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    var bytes = new UTF8Encoding(false).GetBytes(Text(r, "content"));
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                    temporaryIdentity = Id(Inspect(stream.SafeFileHandle));
                }
                Move(temporary, target, temporaryIdentity, false);
            }
            finally
            {
                foreach (var h in handles) h.Dispose();
            }
        }

        private static string Native(string p)
        {
            if (p.StartsWith(@"\\", StringComparison.Ordinal) || GetDriveType(Path.GetPathRoot(p)) == 4)
                throw new IOException("Network storage is not supported");
            return @"\\?\" + p;
        }

        private static SafeFileHandle Open(string p, uint access, uint sharing)
        {
            var h = CreateFile(Native(p), access, sharing, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            if (h.IsInvalid)
            {
                var error = Marshal.GetLastWin32Error();
                h.Dispose();
                throw new GuardException("Unsafe storage handle", error);
            }
            return h;
        }

        private static HandleInfo Inspect(SafeFileHandle h)
        {
            if (h.IsInvalid || !GetFileInformationByHandle(h, out var i) || (i.Attributes & 0x400) != 0)
                throw new IOException("Unsafe storage handle");
            return i;
        }

        private static string Id(HandleInfo i) => (((ulong)i.IndexHigh << 32) | i.IndexLow).ToString();

        private static SafeFileHandle CreateOwned(string p)
        {
            Native(p);
            var text = @"\??\" + p;
            var bytes = Encoding.Unicode.GetByteCount(text);
            var name = new UnicodeName
            {
                Length = checked((ushort)bytes),
                MaximumLength = checked((ushort)(bytes + 2)),
                Buffer = Marshal.StringToHGlobalUni(text),
            };
            var pointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeName)));
            try
            {
                Marshal.StructureToPtr(name, pointer, false);
                var attributes = new ObjectAttributes
                {
                    Length = Marshal.SizeOf(typeof(ObjectAttributes)),
                    ObjectName = pointer,
                    Attributes = 0x40,
                };
                // FILE_CREATE + DIRECTORY + synchronous I/O: creation and no-DELETE-sharing ownership are one kernel
                // operation; an existing directory is never adopted.
                var status = NtCreateFile(out var h, 0x120081, ref attributes, out _, IntPtr.Zero, 0x10, 3, 2, 0x21,
                    IntPtr.Zero, 0);
                if (status < 0)
                {
                    h?.Dispose();
                    throw new GuardException("Cannot exclusively create project directory",
                        status == STATUS_ACCESS_DENIED ? ERROR_ACCESS_DENIED : 0);
                }
                try
                {
                    var info = Inspect(h);
                    if ((info.Attributes & 0x10) == 0) throw new IOException("Not a directory");
                    return h;
                }
                catch
                {
                    h.Dispose();
                    throw;
                }
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
                Marshal.FreeHGlobal(name.Buffer);
            }
        }

        private static SafeFileHandle Pin(string p)
        {
            var h = Open(p, 0x80000000, 3);
            try
            {
                var i = Inspect(h);
                if ((i.Attributes & 0x10) == 0) throw new IOException("Not a directory");
                return h;
            }
            catch
            {
                h.Dispose();
                throw;
            }
        }

        private static void VerifyIdentity(string p, string id)
        {
            using (var h = Pin(p))
                if (Id(Inspect(h)) != id) throw new IOException("Storage identity mismatch");
        }

        private static void VerifyFile(string p, string id)
        {
            using (var h = Open(p, 0x80, 3))
            {
                var i = Inspect(h);
                if ((i.Attributes & 0x10) != 0 || i.Links != 1 || Id(i) != id)
                    throw new IOException("Unsafe file identity");
            }
        }

        private static void Move(string from, string to, string id, bool replace)
        {
            using (var h = Open(from, 0x10080, 3))
            {
                var i = Inspect(h);
                if (Id(i) != id || ((i.Attributes & 0x10) == 0 && i.Links != 1))
                    throw new IOException("Folder identity mismatch");
                var bytes = Encoding.Unicode.GetBytes(Native(to));
                var offset = IntPtr.Size == 8 ? 20 : 12;
                var size = offset + bytes.Length + 2;
                var buffer = Marshal.AllocHGlobal(size);
                try
                {
                    for (var n = 0; n < size; n++) Marshal.WriteByte(buffer, n, 0);
                    if (replace) Marshal.WriteByte(buffer, 0, 1);
                    Marshal.WriteInt32(buffer, IntPtr.Size == 8 ? 16 : 8, bytes.Length);
                    Marshal.Copy(bytes, 0, IntPtr.Add(buffer, offset), bytes.Length);
                    if (!SetRename(h, 3, buffer, (uint)size))
                        throw new GuardException("Cannot move owned folder", Marshal.GetLastWin32Error());
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
            }
        }

        private static void Remove(string p, string id, string hash, bool directory)
        {
            using (var h = Open(p, directory ? 0x10080u : 0x80010080u, 1))
            {
                var i = Inspect(h);
                if (Id(i) != id || ((i.Attributes & 0x10) != 0) != directory || (!directory && i.Links != 1))
                    throw new IOException("Storage identity mismatch");
                var delete = new Disposition { Delete = true };
                if (!directory)
                {
                    using (var stream = new FileStream(h, FileAccess.Read))
                    {
                        using (var sha = SHA256.Create())
                            if (BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant() != hash)
                                throw new IOException("Content changed");
                        if (!SetFileInformationByHandle(h, 4, ref delete, (uint)Marshal.SizeOf(typeof(Disposition))))
                            throw new GuardException("Cannot remove reviewed file", Marshal.GetLastWin32Error());
                    }
                }
                else if (!SetFileInformationByHandle(h, 4, ref delete, (uint)Marshal.SizeOf(typeof(Disposition))))
                    throw new GuardException("Directory is not empty or is locked", Marshal.GetLastWin32Error());
            }
        }

        private static bool IsAccessDenied(Exception e) =>
            e is UnauthorizedAccessException || e is GuardException { Win32Error: ERROR_ACCESS_DENIED };

        private static string Text(Dictionary<string, object> r, string key) =>
            r.TryGetValue(key, out var value) && value is string text ? text : throw new IOException("Bad request");

        private static bool Flag(Dictionary<string, object> r, string key) =>
            r.TryGetValue(key, out var value) && value is bool flag && flag;

        private static IEnumerable<string> Paths(Dictionary<string, object> r, string key)
        {
            if (!r.TryGetValue(key, out var value) || !(value is IEnumerable items) || value is string)
                throw new IOException("Bad request");
            var paths = new List<string>();
            foreach (var item in items) paths.Add(item as string ?? throw new IOException("Bad request"));
            return paths;
        }
    }
}
