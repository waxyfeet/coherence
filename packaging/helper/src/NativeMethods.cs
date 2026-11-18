using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Coherence.Platform
{
    internal static class NativeMethods
    {
        public const uint LOAD_LIBRARY_SEARCH_SYSTEM32 = 0x00000800;

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetDefaultDllDirectories(uint directoryFlags);

        [DllImport("ntdll.dll")]
        public static extern sbyte RtlSetProcessPlaceholderCompatibilityMode(sbyte mode);

        [DllImport("shell32.dll")]
        public static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);

        [StructLayout(LayoutKind.Sequential)]
        public struct HandleInfo
        {
            public uint Attributes, CreatedLow, CreatedHigh, AccessLow, AccessHigh, WriteLow, WriteHigh, Volume,
                SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct Disposition
        {
            [MarshalAs(UnmanagedType.Bool)] public bool Delete;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct UnicodeName
        {
            public ushort Length, MaximumLength;
            public IntPtr Buffer;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct ObjectAttributes
        {
            public int Length;
            public IntPtr RootDirectory, ObjectName;
            public uint Attributes;
            public IntPtr SecurityDescriptor, SecurityQualityOfService;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct IoStatus
        {
            public IntPtr Status, Information;
        }

        [DllImport("ntdll.dll")]
        public static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes attributes,
            out IoStatus status, IntPtr allocation, uint fileAttributes, uint sharing, uint disposition, uint options,
            IntPtr ea, uint eaLength);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern SafeFileHandle CreateFile(string name, uint access, uint sharing, IntPtr security,
            uint creation, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetFileInformationByHandle(SafeFileHandle handle, out HandleInfo info);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref Disposition info,
            uint size);

        [DllImport("kernel32.dll", EntryPoint = "SetFileInformationByHandle", SetLastError = true)]
        public static extern bool SetRename(SafeFileHandle handle, int kind, IntPtr info, uint size);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern uint GetDriveType(string root);
    }

    internal static class Placeholders
    {
        private const sbyte PHCM_EXPOSE_PLACEHOLDERS = 2;

        /// <summary>
        /// Cloud Files disguises placeholders as ordinary files for most programs, but not for programs under
        /// %SystemRoot% — where the PowerShell guard ran. Setting the mode explicitly keeps that behaviour.
        /// </summary>
        public static bool Expose()
        {
            try
            {
                return NativeMethods.RtlSetProcessPlaceholderCompatibilityMode(PHCM_EXPOSE_PLACEHOLDERS) >= 0;
            }
            catch (EntryPointNotFoundException)
            {
                // Windows before 10 1709 has no Cloud Files placeholders to disguise.
                return true;
            }
        }
    }
}
