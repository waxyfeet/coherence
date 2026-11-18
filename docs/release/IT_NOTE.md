# Coherence — note for IT administrators

Coherence is a local Windows desktop app: a small launcher (`Coherence.exe`), a private Node.js runtime and a native
helper. It installs no services, drivers, scheduled tasks, browser extensions or firewall rules, and it does not start
with Windows. Its web server listens on `127.0.0.1` only, and every API call needs a session that the launcher hands
over through a one-use local ticket.

## Supported

- Windows 11 x64 (Setup refuses earlier versions). Windows 10 and Arm64 are not supported yet.
- The Microsoft Edge WebView2 Runtime (part of Windows 11) for the app window. Without it, Coherence uses the default
  browser.
- One signed-in user per Coherence profile. Multi-session hosts (Remote Desktop Session Host, Azure Virtual Desktop
  pooled) are not supported.

## Install

| Mode | Command | Installs into |
| --- | --- | --- |
| Per user (default, no elevation) | `Coherence-<version>-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART` | `%LOCALAPPDATA%\Programs\Coherence` |
| All users (elevated) | add `/ALLUSERS` | `%ProgramFiles%\Coherence` |

Other switches: `/NOSHORTCUTS=1` (no Start menu or desktop shortcut) and `/ALLOWDOWNGRADE=1` (allow an older version
over a newer one; without it a silent downgrade fails with exit 1).

- Setup refuses to mix per-user and all-users installs.
- Before replacing files, Setup asks a running Coherence to quit gracefully. It never force-closes it: while any copy
  still runs from the program folder, it exits with code 7.
- Upgrades and repairs clear the program sub-folders first, so the install always matches the release exactly.
- Uninstall (`unins000.exe /VERYSILENT`) never removes projects. Silent uninstall keeps settings and saved keys.

**Setup is not signed yet.** Check its SHA-256 against the value published with the release before you deploy it.

## Files, registry and processes

| What | Where |
| --- | --- |
| Program | install folder above: `Coherence.exe`, `CoherencePlatform.exe`, `runtime\node.exe` (official Node.js build, unmodified), `server\`, `dist\`, `node_modules\` (the image library sharp/libvips only), `licenses\` |
| Settings, AI connections, DPAPI-protected keys | `%LOCALAPPDATA%\Coherence` |
| Projects | `Documents\Coherence\Projects`, or `%USERPROFILE%\Coherence Projects` when Documents is redirected to OneDrive or a network share; the user can choose another local folder |
| Launcher logs, app-window data | `%LOCALAPPDATA%\CoherenceLauncher\Logs`, `…\WebView2` |
| Registry | `HKCU\Software\Coherence` (`PreferredPort`, `Window`); the standard uninstall entry |

Processes, all running as the signed-in user:
- `Coherence.exe`: the launcher and tray icon;
- `runtime\node.exe`: the backend, started by the launcher in a Job Object with an allow-listed environment;
- `CoherencePlatform.exe`: the native helper for file protection, Windows folders, DPAPI and the folder chooser.
  One instance runs for the backend's lifetime; others are short-lived.

PowerShell is not used at run time.

## Application control

- **AppLocker / App Control for Business:** builds are not signed yet, so publisher rules cannot be used. The default
  AppLocker rules block programs under `%LOCALAPPDATA%`; on such PCs, install with `/ALLUSERS` into Program Files, or
  add path or hash rules for the three executables above. Coherence runs no scripts, so it is built to work under
  Constrained Language Mode; that has not been confirmed on a policy-enforced PC yet.
- **Controlled Folder Access:** it protects Documents, where projects live by default. Allow `Coherence.exe`,
  `runtime\node.exe` and `CoherencePlatform.exe` from the install folder, or point users to an unprotected project
  folder. Coherence explains a refusal by naming these programs.
- **Smart App Control:** Coherence is not signed yet, so Smart App Control may block it.

## Network

- **Inbound:** none. The server binds to `127.0.0.1` on a per-user port between 20000 and 45000 (kept in
  `HKCU\Software\Coherence\PreferredPort`).
- **Outbound:** only to services a user configures and uses, over HTTPS (plain HTTP only to loopback and, without
  credentials, trusted local model servers):
  - AI providers: `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, the customer's
    `*.openai.azure.com`, or local Ollama / LM Studio;
  - trackers when a user exports: the configured Jira, Azure DevOps (`dev.azure.com`) or GitHub (`api.github.com` or
    GitHub Enterprise);
  - Figma (`api.figma.com`) when a user imports designs.
- No telemetry, no automatic update check and no other calls home. Redirects are refused.
- **Proxies are not supported yet:** Coherence connects directly and ignores proxy settings. Coherence trusts the
  Windows certificate store (`--use-system-ca`), so TLS inspection with an enterprise root works.

## Data protection

- Saved AI and tracker keys are encrypted with Windows DPAPI for the current user. They cannot be read by other
  accounts or on other PCs; restoring settings on another PC means entering keys again.
- Diagnostics and logs redact known credentials. Project folders contain the customer's screenshots and requirements:
  treat backups as private.
- Windows Error Reporting follows the PC's policy. A crash report of `node.exe` can contain what was in memory,
  including decrypted keys. Restrict local dump collection through WER policy if that matters.

## Removing all traces

1. Uninstall Coherence.
2. Delete `%LOCALAPPDATA%\Coherence` (settings and keys) and `%LOCALAPPDATA%\CoherenceLauncher` (logs and
   app-window data).
3. Delete `HKCU\Software\Coherence`.
4. Delete the project folders only if the user no longer needs them.
