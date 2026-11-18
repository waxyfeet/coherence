using System;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace Coherence.Launcher
{
    /// <summary>
    /// One launcher per Windows user (installer report §3.3). The first launcher owns a per-user mutex and a pipe that
    /// only this account can open; a second launch asks it to "open" (or "quit") and exits. Because the pipe name is
    /// predictable, the client first checks that the pipe's server is this same Coherence.exe running as this user.
    /// The backend's data-folder lock stays the authoritative exclusion.
    /// </summary>
    internal sealed class SingleInstance : IDisposable
    {
        /// <summary>Inno Setup's SetupMutex (packaging/installer): never start while Setup runs.</summary>
        public const string SetupMutexName = "CoherenceSetupRunning";
        /// <summary>Inno Setup's AppMutex: lets Setup see that a launcher is running in this session.</summary>
        public const string AppMutexName = "CoherenceLauncherRunning";
        private static readonly Encoding Utf8 = new UTF8Encoding(false);
        private readonly Mutex instance;
        private readonly Mutex? running;
        private readonly Mutex? appMutex;
        private readonly string pipeName;
        private Thread? server;
        private volatile bool disposed;

        private SingleInstance(Mutex instance, Mutex? running, Mutex? appMutex, string pipeName, bool primary)
        {
            this.instance = instance;
            this.running = running;
            this.appMutex = appMutex;
            this.pipeName = pipeName;
            IsPrimary = primary;
        }

        public bool IsPrimary { get; }

        public static SingleInstance Acquire(AppPaths paths)
        {
            var instance = new Mutex(true, @"Local\Coherence.Launcher." + paths.InstanceKey, out var created);
            if (!created)
            {
                instance.Dispose();
                return new SingleInstance(new Mutex(), null, null, PipeName(paths), false);
            }
            // Visible to a per-machine Setup in another session (report §4.7), and to Inno's AppMutex check.
            Mutex? running = null, appMutex = null;
            try
            {
                running = new Mutex(true, @"Global\Coherence.Running." + paths.InstanceKey, out _);
            }
            catch (Exception)
            {
                running = null;
            }
            if (paths.StateFile == null) appMutex = new Mutex(true, AppMutexName, out _);
            return new SingleInstance(instance, running, appMutex, PipeName(paths), true);
        }

        public static bool SetupIsRunning()
        {
            foreach (var name in new[] { SetupMutexName, @"Global\" + SetupMutexName })
            {
                try
                {
                    if (Mutex.TryOpenExisting(name, MutexRights.Synchronize, out var existing))
                    {
                        existing.Dispose();
                        return true;
                    }
                }
                catch (UnauthorizedAccessException)
                {
                    return true;
                }
            }
            return false;
        }

        private static string PipeName(AppPaths paths) => "Coherence.Launcher." + paths.InstanceKey;

        /// <summary>
        /// Serves "open" and "quit" from later launches. <paramref name="handle"/> runs on a background thread and
        /// returns the reply ("ok", "cancelled" or "busy").
        /// </summary>
        public void Serve(Func<string, string> handle, Action<string> log)
        {
            var user = WindowsIdentity.GetCurrent().User!;
            server = new Thread(() =>
            {
                while (!disposed)
                {
                    try
                    {
                        using (var pipe = CreateServer(user))
                        {
                            pipe.WaitForConnection();
                            if (disposed) return;
                            var reader = new StreamReader(pipe, Utf8, false, 256, true);
                            var command = reader.ReadLine() ?? "";
                            var reply = command == "open" || command == "quit" ? handle(command) : "unknown";
                            var bytes = Utf8.GetBytes(reply + "\n");
                            pipe.Write(bytes, 0, bytes.Length);
                            pipe.Flush();
                            pipe.WaitForPipeDrain();
                        }
                    }
                    catch (Exception error) when (!disposed)
                    {
                        log("forwarding pipe: " + error.GetType().Name);
                        Thread.Sleep(500);
                    }
                    catch (Exception)
                    {
                        return;
                    }
                }
            })
            { IsBackground = true, Name = "launcher pipe" };
            server.Start();
        }

        private NamedPipeServerStream CreateServer(SecurityIdentifier user)
        {
            var security = new PipeSecurity();
            security.SetOwner(user);
            security.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.ReadWrite, AccessControlType.Allow));
            // Same account over the network is still refused.
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null),
                PipeAccessRights.FullControl, AccessControlType.Deny));
            // One instance: while it exists, no other process can create a server under this name.
            return new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                PipeOptions.None, 256, 256, security);
        }

        /// <summary>
        /// Sends a command to the first launcher after verifying it. Returns its reply and process id, or null when it
        /// cannot be reached or is not a genuine Coherence launcher of this user.
        /// </summary>
        public (string Reply, int ProcessId)? Forward(string command, string executable, Action<string> log)
        {
            for (var attempt = 0; attempt < 10; attempt++)
            {
                try
                {
                    using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.None,
                        TokenImpersonationLevel.Identification))
                    {
                        pipe.Connect(3000);
                        if (!NativeMethods.GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var serverId))
                            return null;
                        if (!IsGenuine(serverId, executable, log)) return null;
                        var bytes = Utf8.GetBytes(command + "\n");
                        pipe.Write(bytes, 0, bytes.Length);
                        pipe.Flush();
                        var reply = new StreamReader(pipe, Utf8).ReadLine();
                        return reply == null ? null : (reply, (int)serverId);
                    }
                }
                catch (TimeoutException)
                {
                    return null;
                }
                catch (IOException)
                {
                    // Between two connections the server briefly has no listening instance: try again.
                    Thread.Sleep(200);
                }
            }
            return null;
        }

        private static bool IsGenuine(uint processId, string executable, Action<string> log)
        {
            var image = NativeMethods.ProcessImagePath(processId);
            var owner = NativeMethods.ProcessOwner(processId);
            var self = WindowsIdentity.GetCurrent().User;
            var genuine = image != null && owner != null
                && string.Equals(Path.GetFullPath(image), Path.GetFullPath(executable), StringComparison.OrdinalIgnoreCase)
                && owner.Equals(self);
            if (!genuine) log("refused to forward: the pipe server is not this Coherence launcher");
            return genuine;
        }

        public void Dispose()
        {
            disposed = true;
            if (IsPrimary)
            {
                // Wake the server thread so it can exit.
                try
                {
                    using (var wake = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut))
                        wake.Connect(200);
                }
                catch (Exception)
                {
                    // Already gone.
                }
                instance.ReleaseMutex();
                running?.ReleaseMutex();
                appMutex?.ReleaseMutex();
            }
            instance.Dispose();
            running?.Dispose();
            appMutex?.Dispose();
        }
    }
}
