using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;

namespace Coherence.Launcher
{
    /// <summary>
    /// The backend process: the official node.exe running server\index.mjs --managed, hidden, from the install folder,
    /// with an allow-listed environment (installer report §3.3). It sits in a Job Object without kill-on-close: if the
    /// launcher dies, the backend sees stdin close and shuts down gracefully by itself; the launcher ends the job only
    /// for a forced quit. stdout carries control events; stderr goes to the log. Both are drained continuously.
    /// </summary>
    internal sealed class Backend : IDisposable
    {
        // What Node, the app and its platform helper need; nothing that changes Node's behaviour (NODE_OPTIONS,
        // NODE_PATH, NODE_TLS_REJECT_UNAUTHORIZED), no proxies (D18) and no SCREENSCRIBE_V2_* settings (D7).
        private static readonly string[] Inherited =
        {
            "SystemRoot", "windir", "SystemDrive", "TEMP", "TMP", "USERPROFILE", "USERNAME", "USERDOMAIN",
            "COMPUTERNAME", "LOCALAPPDATA", "APPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
            "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "PUBLIC",
            "ALLUSERSPROFILE", "HOMEDRIVE", "HOMEPATH", "OS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER",
            "PROCESSOR_LEVEL", "PROCESSOR_REVISION", "NUMBER_OF_PROCESSORS", "PATHEXT", "ComSpec", "SESSIONNAME",
        };

        private readonly Process process;
        private readonly IntPtr job;
        private readonly Stream input;
        private readonly object inputGate = new object();

        private Backend(Process process, IntPtr job)
        {
            this.process = process;
            this.job = job;
            input = process.StandardInput.BaseStream;
        }

        public int ProcessId => process.Id;

        public bool HasExited
        {
            get
            {
                try
                {
                    return process.HasExited;
                }
                catch (InvalidOperationException)
                {
                    return true;
                }
            }
        }

        /// <summary>
        /// Starts the backend. <paramref name="onEvent"/> and <paramref name="onExit"/> run on background threads;
        /// the exit callback runs only after both output streams have been read to the end.
        /// </summary>
        public static Backend Start(AppPaths paths, int[] ports, Log log, Action<BackendEvent> onEvent,
            Action<int> onExit, bool adoptRestoredProfile = false)
        {
            var info = new ProcessStartInfo(paths.Node)
            {
                Arguments = "--use-system-ca --no-global-search-paths \"" + paths.Entry + "\" --managed"
                    + (adoptRestoredProfile ? " --adopt-restored-profile" : ""),
                WorkingDirectory = paths.Install,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardErrorEncoding = new UTF8Encoding(false),
            };
            info.EnvironmentVariables.Clear();
            foreach (var pair in Environment(paths, ports)) info.EnvironmentVariables[pair.Key] = pair.Value;

            var process = new Process { StartInfo = info, EnableRaisingEvents = true };
            process.OutputDataReceived += (_, e) =>
            {
                if (e.Data == null) return;
                var parsed = BackendEvent.Parse(e.Data);
                if (parsed != null) onEvent(parsed);
                else log.Write("backend-stdout", e.Data);
            };
            process.ErrorDataReceived += (_, e) =>
            {
                if (e.Data != null) log.Write("backend", e.Data);
            };
            process.Exited += (_, __) => ThreadPool.QueueUserWorkItem(_ =>
            {
                // The parameterless wait returns only once both redirected streams reached end of file, so the last
                // event (e.g. an error code) is never lost.
                process.WaitForExit();
                onExit(process.ExitCode);
            });

            var job = NativeMethods.CreateJobObject(IntPtr.Zero, null);
            try
            {
                process.Start();
            }
            catch (Win32Exception error)
            {
                if (job != IntPtr.Zero) NativeMethods.CloseHandle(job);
                log.Write("launcher", "could not start the backend: " + error.NativeErrorCode);
                throw new LauncherFailure(ExitCodes.InstallDamaged);
            }
            if (job != IntPtr.Zero && !NativeMethods.AssignProcessToJobObject(job, process.Handle))
                log.Write("launcher", "could not place the backend in a job object; a forced quit ends node.exe only");
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            log.Write("launcher", $"started backend pid {process.Id} on ports {ports[0]}–{ports[ports.Length - 1]}");
            return new Backend(process, job);
        }

        internal static IDictionary<string, string> Environment(AppPaths paths, int[] ports)
        {
            // Windows names are case-insensitive, but the inherited block may spell them differently (SYSTEMROOT from
            // some shells). Without SystemRoot, Windows' random-number and socket APIs fail inside node.exe.
            var source = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (System.Collections.DictionaryEntry entry in System.Environment.GetEnvironmentVariables())
                if (entry.Key is string key && entry.Value is string text) source[key] = text;
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var name in Inherited)
                if (source.TryGetValue(name, out var value)) result[name] = value;
            if (!source.TryGetValue("SystemRoot", out var windows))
                windows = System.Environment.GetFolderPath(System.Environment.SpecialFolder.Windows);
            result["SystemRoot"] = windows;
            // Absolute system folders only: no install or current folder, no user PATH (RT-07, R13). Not PowerShell
            // either: the installed backend uses CoherencePlatform.exe (Stage 6), and any PowerShell use would fail.
            result["PATH"] = string.Join(";", new[]
            {
                Path.Combine(windows, "System32"), windows, Path.Combine(windows, "System32", "Wbem"),
            });
            result["NoDefaultCurrentDirectoryInExePath"] = "1";
            result["SCREENSCRIBE_V2_DATA_DIR"] = paths.DataDir;
            if (paths.WorkspaceDir.Length > 0) result["SCREENSCRIBE_V2_WORKSPACE_DIR"] = paths.WorkspaceDir;
            if (paths.WorkspaceNote != null) result["SCREENSCRIBE_V2_WORKSPACE_NOTE"] = paths.WorkspaceNote;
            result["SCREENSCRIBE_V2_PORT"] = string.Join(",", ports.Select(p => p.ToString()));
            return result;
        }

        /// <summary>Sends one control command; false when the backend no longer reads its input.</summary>
        public bool Send(string op)
        {
            var bytes = Encoding.ASCII.GetBytes(BackendEvent.Command(op));
            lock (inputGate)
            {
                try
                {
                    input.Write(bytes, 0, bytes.Length);
                    input.Flush();
                    return true;
                }
                catch (Exception)
                {
                    return false;
                }
            }
        }

        public bool WaitForExit(int milliseconds)
        {
            try
            {
                return process.WaitForExit(milliseconds);
            }
            catch (Exception)
            {
                return true;
            }
        }

        /// <summary>Forced quit: ends node.exe and every helper it started.</summary>
        public void Terminate()
        {
            if (job != IntPtr.Zero && NativeMethods.TerminateJobObject(job, ExitCodes.ForcedExit)) return;
            try
            {
                process.Kill();
            }
            catch (Exception)
            {
                // Already gone.
            }
        }

        public void Dispose()
        {
            lock (inputGate)
            {
                try
                {
                    input.Dispose();
                }
                catch (Exception)
                {
                    // Already closed.
                }
            }
            if (job != IntPtr.Zero) NativeMethods.CloseHandle(job);
            process.Dispose();
        }
    }
}
