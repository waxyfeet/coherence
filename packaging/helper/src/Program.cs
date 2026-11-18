using System;
using System.IO;
using System.Text;

namespace Coherence.Platform
{
    /// <summary>
    /// CoherencePlatform.exe (installer report §8, Stage 6): the native replacement for every runtime PowerShell use, so
    /// installed Coherence runs where script hosts are blocked (Smart App Control, AppLocker, Constrained Language Mode).
    /// One operation per process, named by the only argument. Requests, paths and secrets travel over stdin, never as
    /// arguments; nothing about a failure is written anywhere (the backend words every message itself).
    /// Exit codes: 0 done, 1 refused or failed, 64 bad arguments.
    /// </summary>
    internal static class Program
    {
        private const int Failed = 1;
        private const int BadArguments = 64;

        [STAThread]
        private static int Main(string[] args)
        {
            // DLLs only from System32: never from the current folder, the program folder or PATH.
            NativeMethods.SetDefaultDllDirectories(NativeMethods.LOAD_LIBRARY_SEARCH_SYSTEM32);
            if (args.Length != 1) return BadArguments;
            // Installer decision D8: cloud-file placeholders (OneDrive) are always seen as the reparse points they are,
            // and the storage guard refuses them, whichever folder this program is installed in. The guard does not run
            // without that setting.
            var exposed = Placeholders.Expose();
            try
            {
                var utf8 = new UTF8Encoding(false);
                var input = new StreamReader(Console.OpenStandardInput(), utf8);
                var output = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true, NewLine = "\n" };
                switch (args[0])
                {
                    case "guard":
                        if (!exposed) return Failed;
                        StorageGuard.Serve(input, output);
                        return 0;
                    case "known-folder":
                        output.WriteLine(Commands.KnownFolder(input.ReadLine()));
                        return 0;
                    case "protect":
                    case "unprotect":
                        output.Write(Commands.Dpapi(args[0] == "protect", input.ReadToEnd()));
                        return 0;
                    case "private-directory":
                        Commands.PrivateDirectory(Commands.Utf8Path(input.ReadToEnd()));
                        return 0;
                    case "choose-folder":
                        output.Write(Commands.ChooseFolder(input.ReadToEnd()));
                        return 0;
                    case "reveal":
                        Commands.Reveal(Commands.Utf8Path(input.ReadToEnd()));
                        return 0;
                    case "version":
                        output.WriteLine(typeof(Program).Assembly.GetName().Version.ToString());
                        return 0;
                    default:
                        return BadArguments;
                }
            }
            catch
            {
                return Failed;
            }
        }
    }
}
