# Packaging Coherence for Windows

Builds the installable app folder and the launcher that runs it (below). The installer is built on top of this
folder.

## Prerequisites

- Windows x64, the repository's Node.js (for building only) and `npm ci` done.
- The pinned Node.js runtime zip from [`node-version.json`](node-version.json), downloaded from `nodejs.org` with its
  `SHASUMS256.txt` and placed in `build/cache/`. The build never downloads it and refuses a zip whose SHA-256 differs.
- For a release build: `packaging/licenses/LGPL-3.0.txt` and `packaging/licenses/GPL-3.0.txt` (official GNU texts).

## Commands

```bash
node packaging/build-app.mjs
node packaging/build-launcher.mjs --stage   # adds Coherence.exe and CoherencePlatform.exe (see below)
node packaging/verify-staged.mjs
```

`build-app.mjs` writes `build/stage/Coherence/` (git-ignored):

| Path                  | Contents                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `server/index.mjs`    | The backend as one unsplit ESM bundle (esbuild). `sharp` is the only package left outside it.                                       |
| `dist/`               | The UI, built with `VITE_COHERENCE_RELEASE=1` (no `?prototype` design demo).                                                        |
| `samples/screens/`    | The four offline-demo screens, checked against `server/agents/mock/sampleScreens.ts`.                                               |
| `node_modules/`       | Exactly the sharp runtime closure from `package-lock.json` (sharp, `@img/sharp-win32-x64`, `@img/colour`, `detect-libc`, `semver`). |
| `runtime/node.exe`    | The official Node.js build, unmodified: checksum and OpenJS Authenticode signature are checked.                                     |
| `licenses/`           | Node.js licence, the Odysseus themes permission, font and component licences, `sbom.cdx.json` (CycloneDX).                          |
| `build-manifest.json` | Version, Node version, source commit and the SHA-256 of every file. No timestamps: two builds of one commit should match.           |

Options: `--release` fails on any warning (for example missing GNU licence texts); `--node-candidate` builds with the
next Node major recorded in `node-version.json`, for evaluation only; `--node-zip <path>` uses a zip from elsewhere.

`verify-staged.mjs` copies the stage to a fresh `%TEMP%` folder with no `node_modules` above it and starts
`runtime/node.exe --no-global-search-paths --use-system-ca server/index.mjs` with a minimal environment (no Node and no
PowerShell on `PATH`, isolated data folders, a port in 4490–4499). It proves the server's identity, signs in through the real one-use
bootstrap ticket, creates the offline demo (the screens go through sharp), checks the UI is served without the
prototype, stops the server, checks no child process is left, and fails if any module was resolved from outside the
copy. Results: `build/meta/verify-report.json`. `--remove <path>` deletes something from the copy first — a negative
self-test that must fail. Your profile, projects and running apps are never touched.

## The launcher, `Coherence.exe`

C# for .NET Framework 4.8 (part of Windows 10 and 11), in `packaging/launcher/`. Built with the .NET SDK pinned in
[`dotnet-version.json`](dotnet-version.json): download its zip from Microsoft, check the SHA-512 and extract it to
`build/cache/dotnet-sdk-<version>/`. Nothing is installed: the build keeps the SDK's home, NuGet packages and caches
under `build/cache/`. The only packages are Microsoft's .NET Framework 4.8 reference assemblies (build-time only) and
Microsoft's WebView2 SDK 1.0.4314.35 (the app window; BSD-3-Clause, its licence and notices ship in `licenses/`). Both
are pinned by `packages.lock.json`, restricted by `nuget.config`, and have their signatures verified on every build.
`--stage` copies the launcher with its window files (`Microsoft.Web.WebView2.Core.dll`, `…WinForms.dll`,
`WebView2Loader.dll`, `Coherence.exe.config`) and the platform helper (below) into the stage and its manifest. The list
is in `launcher-files.mjs`.

```bash
node packaging/build-launcher.mjs           # release build → build/launcher/release/Coherence.exe
node packaging/build-launcher.mjs --test    # test build    → build/launcher/test/Coherence.exe
node packaging/build-launcher.mjs --stage   # also copy it into build/stage/Coherence
node packaging/verify-launcher.mjs          # end-to-end check (needs the stage and both builds)
```

### The platform helper, `CoherencePlatform.exe`

`packaging/helper/`, C# for .NET Framework 4.8, built by the same script into `build/helper/` (one build; there is no
test variant). The installed backend runs it instead of PowerShell for every Windows-only operation, so Coherence keeps
working where script hosts are blocked (Smart App Control, AppLocker, Constrained Language Mode):

| Operation (only argument) | Replaces the PowerShell in                 | Input on stdin → output                                  |
| ------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| `guard`                   | `server/storage/windowsStorageGuard.ts`    | the storage guard's JSON-line protocol, unchanged        |
| `known-folder`            | `server/storage/locations.ts`              | a Known Folder GUID → its path                           |
| `protect`, `unprotect`    | `server/storage/protectedSecrets.ts`       | base64 → base64 (DPAPI, current user; same call)         |
| `private-directory`       | `server/security/localLauncher.ts`         | base64 UTF-8 path → owner-only, non-inherited ACL        |
| `choose-folder`           | `server/platform/outputFolder.ts`          | `{"initialPath","description"}` → `{"path"}`             |
| `reveal`                  | the `open` package ("Open project folder") | base64 UTF-8 path of an existing local folder → Explorer |

It writes nothing about a failure (exit 1; 64 for bad arguments) and loads DLLs only from System32. The guard's one
addition is `"error":"access-denied"` on a refusal Windows denied, which the backend turns into Controlled Folder Access
guidance naming `Coherence.exe`, `runtime\node.exe` and `CoherencePlatform.exe`. It sets the placeholder compatibility
mode to _expose_ (decision D8), so OneDrive placeholders are refused as reparse points wherever it is installed, as they
were under the System32 PowerShell. The backend's choice is in `server/platform/nativeHelper.ts`: the installed app
always uses the helper beside `Coherence.exe` (the install self-check requires it, and the launcher no longer puts
PowerShell on the backend's `PATH`); developer runs keep PowerShell unless `SCREENSCRIBE_V2_PLATFORM_HELPER` names a
built helper. `open` is left out of the bundle and loaded only by developer runs.

```bash
node scripts/test-platform-helper.mjs       # the platform suites again, against build/helper/CoherencePlatform.exe
```

`server/platform/nativeHelper.test.ts` (part of `npm test` when the helper is built) checks that both guards answer the
same request sequence identically, that each reads keys the other saved, the same Known Folders, the ACL shape, the
access-denied guidance, and that no PowerShell starts once the helper is in use.

Every build first compiles and runs `packaging/launcher/tests` (the launcher's validation and parsing rules) and stops
if any check fails. **Test builds** also accept `--profile <dir>` (disposable data, projects, logs and preferences),
`--browser-command "<program> … %1"` (browser mode with a stand-in browser), `--window-hidden` (the app window,
off-screen), `--unattended` (dialogs answer "cancel" and are logged) and `--answer "<button>"` (an unattended run
chooses that button). Release builds do not contain those switches at all. Never ship a test build.

What the launcher does:

- **One per user.** It holds a per-user mutex and serves a pipe only this account can open. A second launch checks
  that the pipe belongs to this `Coherence.exe` running as the same user, forwards "open" (or "quit") and exits.
- **Starting the backend.** It runs `runtime\node.exe --use-system-ca --no-global-search-paths server\index.mjs
--managed` hidden from the install folder, with an allow-listed environment. `NODE_OPTIONS`, proxies and
  `SCREENSCRIBE_V2_*` are not passed on. It passes the Known Folders as final paths and a remembered random port range
  (`HKCU\Software\Coherence\PreferredPort`), and runs the backend in a Job Object without kill-on-close. It never
  creates anything in the data folder.
- **The app window** (`AppWindow.cs`).
  - Coherence opens in its own window hosted by WebView2, which Windows 11 includes, so users install nothing.
  - **Only Coherence's own loopback origin and its one-use bootstrap page load in it.** Every other link opens in the
    default browser.
  - Developer tools, password and form autofill, host objects and web messages are off.
  - Its browser data lives in `%LOCALAPPDATA%\CoherenceLauncher\WebView2`, outside the program and data folders.
    Uninstall removes it.
  - **Signing in:** a hidden second view in the same window profile posts the bootstrap ticket. The new session
    reaches the visible page through shared local storage, so after a backend crash the window signs in again without
    reloading and unsaved edits survive.
  - A second launch brings the window to the front. Closing it runs the quit flow. Its size and position are
    remembered (`HKCU\Software\Coherence\Window`).
  - If no session opens within 30 s it offers Try again / Open in browser. Without WebView2, or if the window fails, it
    falls back to the default browser.
- **Browser hand-over** (fallback, and "Open in browser instead" in the tray). It validates every control event, then
  opens the bootstrap page through the default **http** handler. If no session opens within 30 s, it offers Try again
  / Open in Microsoft Edge.
- **Lifecycle.**
  - Tray: Open Coherence, Open in browser instead (window mode), projects folder, logs, About, Quit.
  - Quit: warns when AI tasks are running, asks for a graceful shutdown, and forces only after 10 s. In-app Quit
    reaches it through the backend's `quit-requested` event.
  - Crashes: restarted automatically up to 3 times in 10 minutes.
  - Sign-out and Restart Manager are handled by a hidden window.
  - An earlier backend that is still stopping is waited for, or ended with permission.
- **Refusals and errors.**
  - It refuses to run as administrator, while Setup's `CoherenceSetupRunning` mutex exists, or with a backend of
    another version. Setup itself starts it with `--after-setup` (the "Launch Coherence" box on its last page, and the
    restart after a silent upgrade); the mutex still exists at that moment, so it waits up to a minute for Setup to
    exit instead of refusing.
  - Every start-up exit code gets a plain-English message.
- **Dialogs** and the "Starting Coherence…" window are laid out at 96 DPI and created DPI-unaware with GDI scaling
  (`ScaledByWindows`), so Windows draws them sharply at each monitor's scale. Per-monitor-aware WinForms on .NET
  Framework laid them out for the scale Windows signed in with, which clipped them on a monitor with another scale.
- **Logs.** Rotating, 5 × 1 MB, in `%LOCALAPPDATA%\CoherenceLauncher\Logs` (outside the profile).
- **Installer support.** `--quit --wait` lets Setup stop it. It holds the `CoherenceLauncherRunning` mutex, which Setup
  checks before asking it to quit; Inno's own `AppMutex` is deliberately not used.

`verify-launcher.mjs` copies the stage to `%TEMP%`, adds the test launcher and drives it with a disposable profile and
a stand-in browser (`verify/fake-browser.mjs`) that completes the real one-use bootstrap. It covers:

- the first launch, with hostile `NODE_OPTIONS` and `SCREENSCRIBE_V2_*` in the environment;
- a second launch handing over;
- a killed backend being restarted;
- `--quit --wait`;
- a killed launcher (the backend stops by itself);
- in-app Quit;
- a Restart Manager close (`WM_QUERYENDSESSION`/`WM_ENDSESSION` sent to the hidden window);
- the 30 s browser watchdog;
- a release build refusing the test switches;
- refusal while Setup runs, and `--after-setup` waiting for Setup to exit and then starting;
- a restored profile (Quit, Use this data, Start fresh);
- the app window: signs in by itself with no browser, keeps its data in its own folder, comes forward on a second
  launch, signs in again after a backend crash, and quits cleanly when closed (`WM_CLOSE`);
- a damaged install (exit 19).

Each scenario also checks that no process from the app folder is left. Results: `build/meta/verify-launcher-report.json`.
The release-build check shows its "Unknown option" message for a few seconds.

## The installer

Inno Setup 7.1.1, unpacked in portable mode (nothing installed) to `build/cache/innosetup-7.1.1/`. To get it, download
`innosetup-7.1.1-x64.exe` from the jrsoftware.org download page and check SHA-256
`8a5a6711c3766a6e5fb74f280ba0e3551e719ce94538d901fdbd1f8f9920b3f0`. Then, **from PowerShell** (Git Bash rewrites
`/SWITCHES` into paths), run it with `/PORTABLE=1 /CURRENTUSER /VERYSILENT /DIR=<that folder>`.

```bash
node packaging/build-app.mjs
node packaging/build-launcher.mjs --stage   # release launcher into the stage and its manifest
node packaging/build-launcher.mjs --test    # for the checks below
node packaging/build-installer.mjs          # → build/installer/Coherence-<version>-Setup.exe
node packaging/verify-installer.mjs         # silent install / repair / refusals / uninstall in %TEMP%
```

[`installer/Coherence.iss`](installer/Coherence.iss):

- Installs per user into `%LOCALAPPDATA%\Programs\Coherence` without elevation; IT can use `/ALLUSERS`.
- Upgrades and repairs clear the program sub-folders first.
- Before replacing anything it asks a running Coherence to quit gracefully (`Coherence.exe --quit --wait`). It refuses
  — never force-closes — while any copy still runs from the program folder (exit 7).
- A downgrade needs confirmation, or `/ALLOWDOWNGRADE=1` when silent (otherwise exit 1).
- It refuses mixed per-user and all-users installs.
- Uninstall never removes projects. Interactively it offers (default No) to remove settings and saved keys.

Silent switches for IT: `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART [/ALLUSERS] [/NOSHORTCUTS=1] [/ALLOWDOWNGRADE=1]`.
Setup is **not signed** yet: Windows SmartScreen warns about it, and Smart App Control may block it.

`verify-installer.mjs`:

- installs silently into a `%TEMP%` folder without shortcuts and compares every installed file with
  `build-manifest.json`;
- repairs over planted stale files;
- shows Setup refusing while the test launcher (disposable `--profile`) runs from the program folder;
- checks downgrade refusal and override;
- uninstalls silently;
- confirms the standard Coherence folders, `HKCU\Software\Coherence` and shortcuts are as before.

It refuses to run on a PC where Coherence is installed, and never starts the installed release launcher. Results:
`build/meta/verify-installer-report.json`.

## Node.js version

The app pins Node.js 24 LTS (`node-version.json`). Node 26 is recorded as a blocked candidate: on Node 26 `fetch`
no longer uses the internal dispatcher key that `server/llm/providers/common.ts` relies on to lift the 300 s header
timeout for slow local models. Make that version-aware and pass the full suite on the exact Node 26 build before
switching. Node 24 is supported until 2028-04-30.
