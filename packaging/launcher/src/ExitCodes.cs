using System;

namespace Coherence.Launcher
{
    /// <summary>
    /// The backend's start-up codes (server/startupErrors.ts is the source of truth) and the launcher's own exit codes.
    /// </summary>
    internal static class ExitCodes
    {
        // Backend (server/startupErrors.ts).
        public const int Other = 1;
        public const int AlreadyRunning = 2;
        public const int ForcedExit = 3;
        public const int PortUnavailable = 10;
        public const int ProfileInvalid = 11;
        public const int ProfileNotEmpty = 12;
        public const int StorageProtection = 13;
        public const int UserFoldersUnavailable = 14;
        public const int DataInsideInstall = 15;
        public const int SettingsLocked = 16;
        public const int DataNewer = 17;
        public const int LauncherPreparation = 18;
        public const int InstallDamaged = 19;
        public const int ProfileRestored = 30;
        public const int MigrationFailed = 31;

        // Launcher only.
        public const int StartFailed = 1;
        public const int SetupRunning = 20;
        public const int Elevated = 21;
        public const int OtherInstanceUnresponsive = 22;
        public const int QuitCancelled = 23;
        public const int VersionMismatch = 24;
        public const int BadArguments = 64;
    }

    /// <summary>A failure the launcher explains with the message for its code.</summary>
    internal sealed class LauncherFailure : Exception
    {
        public LauncherFailure(int code) : base("Launcher failure " + code)
        {
            Code = code;
        }

        public int Code { get; }
    }
}
