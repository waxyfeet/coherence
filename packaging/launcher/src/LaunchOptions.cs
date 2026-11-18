using System;
using System.Collections.Generic;

namespace Coherence.Launcher
{
    /// <summary>
    /// Command line. Release builds accept only <c>--quit [--wait]</c> and <c>--after-setup</c> (used by the installer). Test builds — stamped
    /// "test" at compile time and never shipped — also accept a disposable profile, a stand-in browser and unattended
    /// dialogs, so automated checks never touch the owner's data or browser (installer decision D6).
    /// </summary>
    internal sealed class LaunchOptions
    {
        public bool Quit { get; private set; }
        public bool Wait { get; private set; }
        /// <summary>Started by Setup as it finishes: wait for Setup to exit instead of refusing to start.</summary>
        public bool AfterSetup { get; private set; }
        public string? Profile { get; private set; }
        public string? BrowserCommand { get; private set; }
        public bool Unattended { get; private set; }
        /// <summary>Test builds: the app window is created off-screen, so checks never show it to the owner.</summary>
        public bool WindowHidden { get; private set; }
        /// <summary>Test builds: dialog buttons an unattended run chooses (e.g. "Use this data").</summary>
        public List<string> Answers { get; } = new List<string>();

        public static LaunchOptions Parse(IList<string> args, out string? error)
        {
            var options = new LaunchOptions();
            error = null;
            for (var i = 0; i < args.Count; i++)
            {
                var arg = args[i];
#if COHERENCE_TEST_BUILD
                string? Value()
                {
                    if (i + 1 < args.Count && !args[i + 1].StartsWith("--", StringComparison.Ordinal)) return args[++i];
                    return null;
                }
#endif
                switch (arg)
                {
                    case "--quit":
                        options.Quit = true;
                        break;
                    case "--wait":
                        options.Wait = true;
                        break;
                    case "--after-setup":
                        options.AfterSetup = true;
                        break;
#if COHERENCE_TEST_BUILD
                    // Compiled into test builds only: a release Coherence.exe does not contain these switches.
                    case "--profile":
                        options.Profile = Value();
                        if (string.IsNullOrWhiteSpace(options.Profile)) error = "--profile needs a folder.";
                        break;
                    case "--browser-command":
                        options.BrowserCommand = Value();
                        if (string.IsNullOrWhiteSpace(options.BrowserCommand))
                            error = "--browser-command needs a command line.";
                        break;
                    case "--unattended":
                        options.Unattended = true;
                        break;
                    case "--window-hidden":
                        options.WindowHidden = true;
                        break;
                    case "--answer":
                        var answer = Value();
                        if (string.IsNullOrWhiteSpace(answer)) error = "--answer needs a button label.";
                        else options.Answers.Add(answer!);
                        break;
#endif
                    default:
                        error = $"Unknown option: {arg}";
                        break;
                }
                if (error != null) return options;
            }
            if (options.Wait && !options.Quit) error = "--wait is used with --quit.";
            if (options.AfterSetup && options.Quit) error = "--after-setup is not used with --quit.";
            return options;
        }
    }
}
