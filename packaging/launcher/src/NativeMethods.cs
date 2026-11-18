using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Coherence.Launcher
{
    /// <summary>The Windows APIs the launcher uses. Callers check results; nothing here throws on failure.</summary>
    internal static class NativeMethods
    {
        public const uint LOAD_LIBRARY_SEARCH_SYSTEM32 = 0x00000800;
        public const uint LOAD_LIBRARY_SEARCH_APPLICATION_DIR = 0x00000200;
        public const uint KF_FLAG_DONT_VERIFY = 0x00004000;
        public const uint FILE_SHARE_ALL = 0x7;
        public const uint OPEN_EXISTING = 3;
        public const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        public const uint FILE_NAME_NORMALIZED = 0;
        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        public const uint PROCESS_TERMINATE = 0x0001;
        public const uint SYNCHRONIZE = 0x00100000;
        public const uint TOKEN_QUERY = 0x0008;
        public const int TokenUser = 1;
        public const int TokenElevation = 20;
        public const uint ASSOCF_NOTRUNCATE = 0x20;
        public const uint ASSOCF_IS_PROTOCOL = 0x1000;
        public const int ASSOCSTR_COMMAND = 1;
        public const int WM_QUERYENDSESSION = 0x0011;
        public const int WM_ENDSESSION = 0x0016;
        public const uint TH32CS_SNAPPROCESS = 0x00000002;

        public static readonly Guid FolderLocalAppData = new Guid("F1B32785-6FBA-4FCF-9D55-7B8E7F157091");
        public static readonly Guid FolderDocuments = new Guid("FDD39AD0-238F-46AF-ADB4-6C85480369C7");

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetDefaultDllDirectories(uint directoryFlags);

        [DllImport("shell32.dll")]
        public static extern int SHGetKnownFolderPath(
            [MarshalAs(UnmanagedType.LPStruct)] Guid folderId, uint flags, IntPtr token, out IntPtr path);

        [DllImport("ole32.dll")]
        public static extern void CoTaskMemFree(IntPtr memory);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern SafeFileHandle CreateFile(
            string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint GetFinalPathNameByHandle(
            SafeFileHandle file, StringBuilder path, uint length, uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool QueryFullProcessImageName(
            IntPtr process, uint flags, StringBuilder name, ref uint length);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool GetTokenInformation(
            IntPtr token, int infoClass, IntPtr info, int length, out int returned);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateJobObject(IntPtr security, string? name);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
        public static extern int AssocQueryString(
            uint flags, int str, string assoc, string? extra, StringBuilder? output, ref uint length);

        /// <summary>DPI-unaware windows whose GDI drawing Windows scales sharply (see <c>ScaledByWindows</c>).</summary>
        public static readonly IntPtr DPI_AWARENESS_CONTEXT_UNAWARE_GDISCALED = new IntPtr(-5);

        /// <summary>Returns the previous context, or zero when the change was refused.</summary>
        [DllImport("user32.dll")]
        public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool ShutdownBlockReasonCreate(IntPtr window, string reason);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool ShutdownBlockReasonDestroy(IntPtr window);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct ProcessEntry
        {
            public uint Size;
            public uint Usage;
            public uint ProcessId;
            public IntPtr DefaultHeapId;
            public uint ModuleId;
            public uint Threads;
            public uint ParentProcessId;
            public int PriorityClassBase;
            public uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string ExeFile;
        }

        /// <summary>The image path of a process, or null when it cannot be read.</summary>
        public static string? ProcessImagePath(uint processId)
        {
            var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
            if (process == IntPtr.Zero) return null;
            try
            {
                var buffer = new StringBuilder(32768);
                var length = (uint)buffer.Capacity;
                return QueryFullProcessImageName(process, 0, buffer, ref length) ? buffer.ToString() : null;
            }
            finally
            {
                CloseHandle(process);
            }
        }

        /// <summary>The account that owns a process, or null when it cannot be read.</summary>
        public static SecurityIdentifier? ProcessOwner(uint processId)
        {
            var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
            if (process == IntPtr.Zero) return null;
            try
            {
                if (!OpenProcessToken(process, TOKEN_QUERY, out var token)) return null;
                try
                {
                    GetTokenInformation(token, TokenUser, IntPtr.Zero, 0, out var needed);
                    if (needed <= 0) return null;
                    var info = Marshal.AllocHGlobal(needed);
                    try
                    {
                        if (!GetTokenInformation(token, TokenUser, info, needed, out _)) return null;
                        // TOKEN_USER starts with SID_AND_ATTRIBUTES, whose first field is the SID pointer.
                        return new SecurityIdentifier(Marshal.ReadIntPtr(info));
                    }
                    finally
                    {
                        Marshal.FreeHGlobal(info);
                    }
                }
                finally
                {
                    CloseHandle(token);
                }
            }
            finally
            {
                CloseHandle(process);
            }
        }

        /// <summary>True when this process runs with an elevated (administrator) token.</summary>
        public static bool IsElevated()
        {
            using (var identity = WindowsIdentity.GetCurrent())
            {
                var value = Marshal.AllocHGlobal(4);
                try
                {
                    return GetTokenInformation(identity.Token, TokenElevation, value, 4, out _)
                        && Marshal.ReadInt32(value) != 0;
                }
                finally
                {
                    Marshal.FreeHGlobal(value);
                }
            }
        }
    }
}
