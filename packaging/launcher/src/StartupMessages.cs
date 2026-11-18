namespace Coherence.Launcher
{
    /// <summary>Plain-English explanations for start-up failures, keyed by exit code (installer report §3.7).</summary>
    internal static class StartupMessages
    {
        public static string Title(int code) =>
            code == ExitCodes.DataNewer ? "Coherence needs a newer version"
            : code == ExitCodes.InstallDamaged ? "Coherence needs to be reinstalled"
            : code == ExitCodes.VersionMismatch ? "Coherence needs to be reinstalled"
            : "Coherence couldn't start";

        public static string Describe(int code) => code switch
        {
            ExitCodes.AlreadyRunning =>
                "Another copy of Coherence is already using your data folder. Close it, or restart Windows, and then open Coherence again.",
            ExitCodes.PortUnavailable =>
                "Coherence couldn't find a free local connection on this computer. Restart Windows, then open Coherence again.",
            ExitCodes.ProfileInvalid =>
                "Coherence's data folder doesn't look the way Coherence left it, so it was not opened. Nothing was changed. The logs say more.",
            ExitCodes.ProfileNotEmpty =>
                "Coherence's data folder already contains files that Coherence didn't create, so it was not used. Nothing was changed. The logs say more.",
            ExitCodes.StorageProtection =>
                "Windows couldn't start the protection Coherence uses for your files. Security software or a company policy may be blocking it. The logs say more.",
            ExitCodes.UserFoldersUnavailable =>
                "Windows couldn't tell Coherence where your AppData or Documents folders are. Check that your user folders are available, then open Coherence again.",
            ExitCodes.DataInsideInstall =>
                "Coherence's data folder is inside its program folder, which isn't allowed. Reinstall Coherence to its standard location.",
            ExitCodes.SettingsLocked =>
                "Windows couldn't unlock Coherence's saved keys for your account. This can happen when the data folder was copied from another computer or account. Nothing was changed.",
            ExitCodes.DataNewer =>
                "Your Coherence data was saved by a newer version of Coherence. Install that version or a later one. Nothing was changed.",
            ExitCodes.LauncherPreparation =>
                "Coherence couldn't prepare its private sign-in folder. Check that your account can write to its AppData folder, then open Coherence again.",
            ExitCodes.InstallDamaged =>
                "Some of Coherence's program files are missing or damaged. Reinstall Coherence; your projects and settings are kept.",
            ExitCodes.VersionMismatch =>
                "Parts of this Coherence installation come from different versions. Reinstall Coherence; your projects and settings are kept.",
            ExitCodes.MigrationFailed =>
                "Coherence couldn't update your saved data for this version. Everything was put back as it was, so nothing was lost. Reinstall the previous version to keep working, and keep the logs for support.",
            ExitCodes.ProfileRestored =>
                "Coherence's data folder was restored or copied from somewhere else, so it was not opened. Nothing was changed. Open Coherence again to choose whether to use it or start fresh.",
            _ => "Coherence stopped while starting. The logs say more.",
        };
    }
}
