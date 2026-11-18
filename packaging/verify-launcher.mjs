/**
 * End-to-end check of Coherence.exe against the staged app (installer report §3.3, §3.7, Stage 3). It copies
 * build/stage/Coherence to a fresh temporary folder, adds the *test* launcher (packaging/build-launcher.mjs --test)
 * and drives it with a disposable --profile, unattended dialogs and a stand-in browser (verify/fake-browser.mjs) that
 * completes the real S02 bootstrap. The owner's profile, browser, registry preferences and running apps are never used.
 * Usage: node packaging/verify-launcher.mjs [--keep]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LAUNCHER_FILES } from "./launcher-files.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = path.join(ROOT, "build", "stage", "Coherence");
const LAUNCHER = path.join(ROOT, "build", "launcher", "test", "Coherence.exe");
const RELEASE = path.join(
  ROOT,
  "build",
  "launcher",
  "release",
  "Coherence.exe",
);
const keep = process.argv.includes("--keep");
class VerifyError extends Error {}
const check = (condition, message) => {
  if (!condition) throw new VerifyError(message);
};
const steps = [];
const step = (name, detail = "") => {
  steps.push({ name, detail });
  console.log(`verify-launcher: ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A launched process's exit code, or "timeout": a check fails rather than waits forever. */
const exitOf = (launched, timeoutMs = 60_000) =>
  Promise.race([launched.exited, sleep(timeoutMs).then(() => "timeout")]);
const until = async (what, test, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await test();
    if (value) return value;
    check(Date.now() < deadline, `Timed out waiting for ${what}.`);
    await sleep(200);
  }
};
const powershell = (command) =>
  execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", windowsHide: true },
  ).trim();

check(
  fs.existsSync(path.join(STAGE, "build-manifest.json")),
  "Run packaging/build-app.mjs first.",
);
check(
  fs.existsSync(LAUNCHER) && fs.existsSync(RELEASE),
  "Run packaging/build-launcher.mjs --test and packaging/build-launcher.mjs first.",
);
// What Windows sends: Restart Manager and sign-out reach the launcher's hidden "Coherence launcher" window
// (COHERENCE_MESSAGE=endsession); the user closing the app window is WM_CLOSE to the window titled "Coherence…"
// (COHERENCE_MESSAGE=close).
const WINDOW_SCRIPT = String.raw`
$code = @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class CoherenceWindows {
  delegate bool Enum(IntPtr w, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(Enum cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr w, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr w, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr w, uint m, IntPtr wp, IntPtr lp, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr w, uint m, IntPtr wp, IntPtr lp);
  public static int Send(uint target, string message) {
    int sent = 0;
    EnumWindows((w, p) => {
      uint pid; GetWindowThreadProcessId(w, out pid);
      var s = new StringBuilder(128); GetWindowText(w, s, 128);
      var title = s.ToString();
      if (pid != target) return true;
      IntPtr r;
      if (message == "endsession" && title == "Coherence launcher") {
        SendMessageTimeout(w, 0x11, IntPtr.Zero, new IntPtr(1), 2, 5000, out r);
        SendMessageTimeout(w, 0x16, new IntPtr(1), new IntPtr(1), 2, 10000, out r);
        sent++;
      } else if (message == "close" && title.StartsWith("Coherence") && title != "Coherence launcher") {
        PostMessage(w, 0x10, IntPtr.Zero, IntPtr.Zero);
        sent++;
      }
      return true;
    }, IntPtr.Zero);
    return sent;
  }
}
'@
Add-Type -TypeDefinition $code
[CoherenceWindows]::Send([uint32]$env:COHERENCE_TARGET_PID, $env:COHERENCE_MESSAGE)
`;
const sendToWindows = (pid, message) =>
  execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOW_SCRIPT],
    {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        COHERENCE_TARGET_PID: String(pid),
        COHERENCE_MESSAGE: message,
      },
    },
  ).trim();
const work = fs.mkdtempSync(path.join(os.tmpdir(), "coherence-launcher-"));
const app = path.join(work, "Coherence");
const profile = path.join(work, "profile");
const browserLog = path.join(work, "browser-log.jsonl");
const marker = path.join(work, "node-options-marker.txt");
const exe = path.join(app, "Coherence.exe");
const data = path.join(profile, "data");
const launcherLog = path.join(profile, "launcher-logs", "launcher.log");
const report = { started: new Date().toISOString(), work, steps };
let failed = false;
const launched = [];

// Settings a user might have in their environment; the launcher must not pass any of them to the backend (D7).
fs.writeFileSync(
  path.join(work, "inject.cjs"),
  // Only the backend (started with --managed) may not load it; the stand-in browser inherits it legitimately.
  `if (process.argv.includes("--managed")) require("fs").writeFileSync(${JSON.stringify(marker)}, "loaded");`,
);
const hostileEnv = {
  ...process.env,
  NODE_OPTIONS: `--require ${path.join(work, "inject.cjs")}`,
  SCREENSCRIBE_V2_PORT: "4417",
  SCREENSCRIBE_V2_DATA_DIR: path.join(work, "wrong-data"),
};
const browserCommand = `"${process.execPath}" "${path.join(ROOT, "packaging", "verify", "fake-browser.mjs")}" "${browserLog}" %1`;
/** `command` null: Coherence's own app window, created off-screen so it never appears on the owner's screen. */
const launch = (extra = [], command = browserCommand, program = exe) => {
  const child = spawn(
    program,
    [
      "--profile",
      profile,
      "--unattended",
      ...(command === null
        ? ["--window-hidden"]
        : ["--browser-command", command]),
      ...extra,
    ],
    { cwd: work, env: hostileEnv, windowsHide: true, stdio: "ignore" },
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));
  launched.push({ child, exited });
  return { child, exited };
};
const browserVisits = () =>
  fs.existsSync(browserLog)
    ? fs
        .readFileSync(browserLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const sessions = () =>
  browserVisits().filter((v) => v.status === 200 && v.session);
const logText = () =>
  fs.existsSync(launcherLog) ? fs.readFileSync(launcherLog, "utf8") : "";
const count = (pattern) => (logText().match(pattern) ?? []).length;
const backendPid = () => {
  const all = [...logText().matchAll(/started backend pid (\d+)/g)];
  return all.length ? Number(all.at(-1)[1]) : undefined;
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const fromApp = () =>
  Number(
    powershell(
      `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith(${JSON.stringify(app + path.sep)}, [StringComparison]::OrdinalIgnoreCase) }).Count`,
    ),
  );
const released = () =>
  !fs.existsSync(path.join(data, ".instance-lock.json")) &&
  !fs.existsSync(path.join(data, ".local-auth", "launch.json"));

try {
  for (let dir = work; ; dir = path.dirname(dir)) {
    check(
      !fs.existsSync(path.join(dir, "node_modules")),
      `${path.join(dir, "node_modules")} would hide missing modules.`,
    );
    if (path.dirname(dir) === dir) break;
  }
  fs.cpSync(STAGE, app, { recursive: true });
  for (const name of LAUNCHER_FILES)
    fs.copyFileSync(
      path.join(path.dirname(LAUNCHER), name),
      path.join(app, name),
    );
  step("copied stage and test launcher", app);

  // 1. First launch: backend starts with launcher-chosen folders and ports, the browser opens a session.
  const first = launch();
  await until("the first browser session", () => sessions().length >= 1);
  await until("session-opened", () => count(/session opened/g) >= 1);
  const ready = /backend ready on port (\d+)/.exec(logText());
  const state = JSON.parse(
    fs.readFileSync(path.join(profile, "launcher-state.json"), "utf8"),
  );
  check(
    ready && Number(ready[1]) >= 20000 && Number(ready[1]) < 45000,
    "The backend did not use a launcher-chosen port.",
  );
  check(
    state.preferredPort === Number(ready[1]),
    "The port in use was not remembered.",
  );
  check(
    sessions()[0].origin === `http://127.0.0.1:${ready[1]}`,
    "The session opened on another origin.",
  );
  check(
    fs.existsSync(path.join(data, ".instance-lock.json")) &&
      !fs.existsSync(path.join(work, "wrong-data")),
    "The backend did not use the launcher's data folder.",
  );
  check(!fs.existsSync(marker), "NODE_OPTIONS reached the backend.");
  step(
    "first launch",
    `port ${ready[1]} (remembered), session opened, inherited NODE_OPTIONS and SCREENSCRIBE_V2_* ignored`,
  );

  // 2. A second launch hands over to the first and exits; the user gets another session on the same origin.
  const second = launch();
  check(
    (await second.exited) === 0,
    "The second launch did not hand over cleanly.",
  );
  await until("the second browser session", () => sessions().length >= 2);
  check(
    sessions()[1].origin === sessions()[0].origin,
    "The second session used another origin.",
  );
  check(first.child.exitCode === null, "The first launcher stopped.");
  step("second launch", "forwarded to the running launcher, same origin");

  // 3. A backend crash is restarted automatically, and a new session can be opened.
  const crashed = backendPid();
  process.kill(crashed);
  await until(
    "an automatic restart",
    () => count(/backend ready on port/g) >= 2,
    90_000,
  );
  check(
    /automatic restart 1 of 3/.test(logText()),
    "The crash was not reported as a restart.",
  );
  check(backendPid() !== crashed, "The backend was not restarted.");
  const third = launch();
  check((await third.exited) === 0, "The launch after a restart failed.");
  await until("a session after the restart", () => sessions().length >= 3);
  step("backend crash", "restarted automatically; a new session opened");

  // 4. --quit --wait (what Setup uses): graceful stop, everything released, nothing left running.
  const backendBefore = backendPid();
  const quit = launch(["--quit", "--wait"]);
  check((await quit.exited) === 0, "--quit --wait did not succeed.");
  check(
    (await first.exited) === 0,
    "The launcher did not exit cleanly on quit.",
  );
  await until("the backend to stop", () => !alive(backendBefore), 15_000);
  check(released(), "The lock or launch record was left behind.");
  check(
    /backend stopping: launcher/.test(logText()),
    "The backend was not asked to stop gracefully.",
  );
  await sleep(1500);
  check(fromApp() === 0, "Processes from the app folder are still running.");
  step(
    "quit",
    "--quit --wait exit 0; graceful shutdown; lock and launch record released; nothing left running",
  );

  // 5. The launcher crashing: the backend sees its input close and stops gracefully by itself.
  const again = launch();
  await until("a session after relaunch", () => sessions().length >= 4);
  const orphan = backendPid();
  execFileSync("taskkill.exe", ["/F", "/PID", String(again.child.pid)], {
    stdio: "ignore",
  });
  await again.exited;
  await until(
    "the orphaned backend to stop by itself",
    () => !alive(orphan),
    20_000,
  );
  await until("the lock to be released", released, 10_000);
  await sleep(1500);
  check(fromApp() === 0, "Processes from the app folder are still running.");
  step(
    "launcher crash",
    "backend saw stdin close, stopped gracefully, released the profile",
  );

  // 6. Quit from inside the app: the backend only asks; the launcher runs its quit flow.
  const inApp = launch();
  await until("a session for in-app quit", () => sessions().length >= 5);
  const visit = sessions().at(-1);
  const quitBackend = backendPid();
  const asked = await fetch(`${visit.origin}/api/app/quit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${visit.token}`, "X-ScreenScribe": "1" },
  });
  check(asked.status === 202, `In-app quit returned ${asked.status}.`);
  check(
    (await inApp.exited) === 0,
    "The launcher did not quit when asked by the app.",
  );
  await until("the backend to stop", () => !alive(quitBackend), 15_000);
  check(released(), "In-app quit left the lock or launch record behind.");
  step(
    "in-app quit",
    "quit-requested ran the launcher's quit flow; exit 0; profile released",
  );

  // 7. Windows Restart Manager (and sign-out) closes the launcher through its hidden window.
  const managedClose = launch();
  await until("a session before Restart Manager", () => sessions().length >= 6);
  const rmBackend = backendPid();
  const windows = sendToWindows(managedClose.child.pid, "endsession");
  check(
    windows === "1",
    `Expected one hidden launcher window, found ${windows}.`,
  );
  check(
    (await managedClose.exited) === 0,
    "The launcher did not close for Restart Manager.",
  );
  await until("the backend to stop", () => !alive(rmBackend), 15_000);
  await until("the profile to be released", released, 10_000);
  check(
    /Windows is signing out or shutting down/.test(logText()),
    "The end-session message was not handled.",
  );
  step(
    "Restart Manager close",
    "WM_QUERYENDSESSION/WM_ENDSESSION: graceful shutdown, exit 0, profile released",
  );

  // 8. A browser that never connects: after 30 s the launcher offers Try again / Edge (unattended: Close).
  const silent = launch([], `"${process.execPath}" -e "0"`);
  const watchdogBefore = count(/Coherence didn't open in your browser/g);
  await until(
    "the session watchdog",
    () => count(/Coherence didn't open in your browser/g) > watchdogBefore,
    60_000,
  );
  const stopSilent = launch(["--quit", "--wait"]);
  check((await stopSilent.exited) === 0, "Could not quit after the watchdog.");
  check((await silent.exited) === 0, "The launcher did not exit after quit.");
  await until("the profile to be released", released, 15_000);
  step(
    "browser watchdog",
    "no session within 30 s → Try again / Open in Microsoft Edge offered",
  );

  // 9. A release build ignores the test-only switches: it must not start, choose a profile or log anything.
  const releaseCopy = path.join(app, "Coherence-release.exe");
  fs.copyFileSync(RELEASE, releaseCopy);
  const releaseProfile = path.join(work, "release-profile");
  const refused = spawn(
    releaseCopy,
    ["--profile", releaseProfile, "--unattended"],
    {
      cwd: work,
      env: hostileEnv,
      windowsHide: true,
      stdio: "ignore",
    },
  );
  const refusedExit = new Promise((r) => refused.once("exit", r));
  launched.push({ child: refused, exited: refusedExit });
  // It either shows its "Unknown option" message (still running) or has exited with the bad-arguments code.
  const outcome = await Promise.race([
    refusedExit,
    sleep(4000).then(() => "waiting"),
  ]);
  const nodes = Number(
    powershell(
      `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith(${JSON.stringify(app + path.sep)}, [StringComparison]::OrdinalIgnoreCase) }).Count`,
    ),
  );
  check(
    (outcome === 64 || outcome === "waiting") &&
      !fs.existsSync(releaseProfile) &&
      nodes === 0,
    `A release build accepted the test-only --profile switch (outcome ${outcome}).`,
  );
  if (refused.exitCode === null)
    execFileSync("taskkill.exe", ["/F", "/PID", String(refused.pid)], {
      stdio: "ignore",
    });
  await refusedExit;
  fs.rmSync(releaseCopy, { force: true, maxRetries: 10, retryDelay: 200 });
  step(
    "release build",
    `refuses --profile/--unattended as unknown options (${outcome === 64 ? "exit 64" : "message shown"}); no profile, no backend`,
  );

  // 10. While Setup runs (its SetupMutex exists) the launcher refuses to start.
  const holdSetupMutex = async (seconds) => {
    const holder = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$m = [System.Threading.Mutex]::new($true, 'CoherenceSetupRunning'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Seconds ${seconds}`,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise((resolve) => holder.stdout.once("data", resolve));
    return holder;
  };
  const holder = await holdSetupMutex(30);
  const blocked = launch();
  const blockedCode = await blocked.exited;
  holder.kill();
  check(
    blockedCode === 20,
    `Expected exit 20 while Setup runs, got ${blockedCode}.`,
  );
  check(fromApp() === 0, "A backend started while Setup ran.");
  step("setup running", "refused with exit 20, nothing started");

  // 10b. Started by Setup from its last page (--after-setup), moments before Setup exits: it waits, then starts.
  const finishing = await holdSetupMutex(3);
  const backendsBefore = count(/started backend pid/g);
  const afterSetup = launch(["--after-setup"], null);
  await until(
    "a backend once Setup exited",
    () => count(/started backend pid/g) > backendsBefore,
  );
  check(
    finishing.exitCode !== null && /Setup exited after \d+ ms/.test(logText()),
    "The launcher started before Setup exited.",
  );
  check(
    (await launch(["--quit", "--wait"]).exited) === 0 &&
      (await afterSetup.exited) === 0,
    "Could not quit after starting from Setup.",
  );
  await until("the profile to be released", released, 15_000);
  step(
    "started by Setup",
    "--after-setup waited for Setup to exit, then started",
  );

  // 11. A data folder restored from a backup (same files, new folder identity): the user chooses (decision D9).
  const restoreProfile = () => {
    const copy = `${data}-restored`;
    fs.cpSync(data, copy, { recursive: true });
    fs.rmSync(data, { recursive: true, maxRetries: 10, retryDelay: 200 });
    fs.renameSync(copy, data);
  };
  const record = path.join(data, ".coherence-global.json");
  restoreProfile();
  const restoredRecord = fs.readFileSync(record, "utf8");
  const declined = launch();
  check(
    (await declined.exited) === 1,
    "A restored profile was not stopped for a choice.",
  );
  check(
    /Coherence found restored data/.test(logText()) &&
      fs.readFileSync(record, "utf8") === restoredRecord,
    "Declining a restored profile changed it, or no choice was offered.",
  );
  const kept = launch(["--answer", "Use this data"]);
  await until("a session with the restored data", () => sessions().length >= 7);
  check(
    JSON.parse(fs.readFileSync(record, "utf8")).adoptedFrom ===
      JSON.parse(restoredRecord).identity,
    "The restored profile was not adopted.",
  );
  check(
    (await launch(["--quit", "--wait"]).exited) === 0 &&
      (await kept.exited) === 0,
    "Could not quit after adopting the restored profile.",
  );
  await until("the profile to be released", released, 15_000);
  restoreProfile();
  const fresh = launch(["--answer", "Start fresh"]);
  await until("a session with fresh data", () => sessions().length >= 8);
  const asideNames = fs
    .readdirSync(profile)
    .filter((name) => /^data\.old-\d{8}-\d{6}$/.test(name));
  check(
    asideNames.length === 1 &&
      fs.existsSync(
        path.join(profile, asideNames[0], ".coherence-global.json"),
      ) &&
      fs.existsSync(path.join(profile, asideNames[0], "settings.json")) &&
      !JSON.parse(fs.readFileSync(record, "utf8")).adoptedFrom,
    "Starting fresh did not keep the restored folder aside and create a new profile.",
  );
  check(
    (await launch(["--quit", "--wait"]).exited) === 0 &&
      (await fresh.exited) === 0,
    "Could not quit after starting fresh.",
  );
  await until("the profile to be released", released, 15_000);
  step(
    "restored profile",
    "stopped for a choice (Quit leaves it unchanged); Use this data adopts it; Start fresh keeps it as data.old-<time>",
  );

  // 12. Coherence's own app window (owner decision D3): it signs in by itself, a second launch brings it forward, a
  // backend crash re-signs it without reloading, and closing it quits.
  // Counted from here: earlier scenarios (10b uses the window too) also signed in and opened sessions. A sign-in only
  // counts with a session the backend really opened, i.e. the window's one-use ticket reached it.
  const visitsBefore = browserVisits().length;
  const signedIn = () => count(/\[window\] signed in/g);
  const sessionsOpened = () => count(/\[launcher\] session opened/g);
  const signedBefore = signedIn();
  const openedBefore = sessionsOpened();
  const inWindow = launch([], null);
  await until("the window to sign in", () => signedIn() > signedBefore, 90_000);
  await until(
    "the window's session",
    () => sessionsOpened() > openedBefore,
    10_000,
  );
  check(
    /opening Coherence in its own window \(WebView2/.test(logText()),
    "The launcher did not choose its app window.",
  );
  check(
    fs.existsSync(path.join(profile, "webview2")) &&
      !fs.existsSync(path.join(app, "Coherence.exe.WebView2")) &&
      !fs.existsSync(path.join(data, "EBWebView")),
    "The window's browser data is not in its own folder.",
  );
  check(
    browserVisits().length === visitsBefore,
    "The window mode opened a browser.",
  );
  const forward = launch([], null);
  check(
    (await exitOf(forward)) === 0 &&
      (await until(
        "the window to come forward",
        () => /window brought to the front/.test(logText()),
        15_000,
      )),
    "A second launch did not bring the window forward.",
  );
  const signedBeforeCrash = signedIn();
  const openedBeforeCrash = sessionsOpened();
  process.kill(backendPid());
  await until(
    "the window to sign in again after a backend restart",
    () => signedIn() > signedBeforeCrash,
    90_000,
  );
  await until(
    "the window's new session after the restart",
    () => sessionsOpened() > openedBeforeCrash,
    10_000,
  );
  check(
    !/sign-in view refused a navigation/.test(logText()),
    "The window's sign-in view refused a navigation.",
  );
  const windowBackend = backendPid();
  check(
    sendToWindows(inWindow.child.pid, "close") === "1",
    "The app window was not found.",
  );
  const closedWith = await exitOf(inWindow);
  check(
    closedWith === 0,
    `Closing the window did not quit Coherence cleanly (${closedWith}).`,
  );
  await until("the backend to stop", () => !alive(windowBackend), 15_000);
  await until("the profile to be released", released, 15_000);
  step(
    "app window",
    "signs in by itself (no browser), data in its own folder, second launch brings it forward, re-signs after a crash, closing it quits cleanly",
  );

  // 13. A damaged installation is explained, not served.
  fs.rmSync(path.join(app, "dist", "index.html"));
  const damaged = launch();
  check(
    (await damaged.exited) === 1,
    "A damaged installation did not fail start-up.",
  );
  check(
    /backend exited with code 19/.test(logText()) &&
      /start-up failed with code 19/.test(logText()),
    "The INSTALL_DAMAGED code was not reported.",
  );
  await sleep(1000);
  check(fromApp() === 0, "Processes from the app folder are still running.");
  step("damaged install", "backend exit 19 explained; launcher exit 1");
} catch (error) {
  failed = true;
  report.error =
    error instanceof VerifyError
      ? error.message
      : String(error?.stack ?? error);
  console.error(`verify-launcher: FAILED — ${report.error}`);
} finally {
  for (const { child } of launched)
    if (child.exitCode === null) {
      try {
        execFileSync("taskkill.exe", ["/F", "/T", "/PID", String(child.pid)], {
          stdio: "ignore",
        });
      } catch {
        // Already gone.
      }
    }
  await sleep(1000);
  try {
    if (fromApp() > 0) {
      failed = true;
      console.error("verify-launcher: FAILED — processes outlived the test.");
      powershell(
        `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith(${JSON.stringify(app + path.sep)}, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
      );
    }
  } catch {
    // Reported above.
  }
  report.launcherLog = logText().split("\n").slice(-80).join("\n");
  report.browserVisits = browserVisits();
  report.result = failed ? "FAIL" : "PASS";
  fs.mkdirSync(path.join(ROOT, "build", "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, "build", "meta", "verify-launcher-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (keep || failed) console.log(`verify-launcher: kept ${work}`);
  else
    fs.rmSync(work, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  console.log(`verify-launcher: ${report.result}`);
  process.exitCode = failed ? 1 : 0;
}
