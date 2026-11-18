# Coherence — privacy and data flow

Coherence runs on your PC. It has no account, no cloud service of its own, no telemetry and no automatic update check.
Its author receives nothing from it.

## What stays on your PC

- **Projects:** your screenshots, business context, requirements, history and exports are files in your project
  folders.
- **Settings and keys:** settings and AI connections are in `%LOCALAPPDATA%\Coherence`. Saved keys are encrypted by
  Windows for your account.
- **Logs:** they are on your PC, with known credentials removed: the launcher's logs are in
  `%LOCALAPPDATA%\CoherenceLauncher\Logs`, and each AI task's record is in its project folder (`jobs`).

## What leaves your PC, and only when you ask

| When | What is sent | To whom |
| --- | --- | --- |
| You analyse screens or generate, revise or check requirements | The screenshots and the text needed for that step | The AI service you connected (Anthropic, OpenAI, Google, your Azure OpenAI resource), or nobody if you use a local model (Ollama, LM Studio) or the offline demo |
| You export to a tracker | The use cases you export | Your Jira, Azure DevOps or GitHub |
| You import from Figma | Your request for the frames you chose | Figma |
| You test a connection | A minimal request | That service |

Each service handles your data under its own terms. A project's **Keep AI analysis on this computer** setting limits
its AI requests to local models and the offline demo.

## What Coherence never does

- It sends nothing when idle, and nothing to its developer.
- It does not accept connections from other computers: its server listens on `127.0.0.1` only, and every request
  needs a session handed over by the launcher.
- It does not read files outside its own program, settings and project folders, apart from the screenshots and folders
  you choose.

## Windows components

- The app window uses Microsoft Edge WebView2, a Windows component. Its own diagnostic data follows your Windows
  settings. Links to other sites open in your default browser.
- If Coherence crashes, Windows Error Reporting may keep a crash report according to your Windows settings. Such
  reports can contain what was in memory at the time.

## Removing your data

Uninstalling keeps your projects. It can also remove your settings and saved keys if you choose that. The
[IT note](IT_NOTE.md) lists every location.
