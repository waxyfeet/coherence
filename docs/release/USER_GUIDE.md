# Installing and using Coherence on Windows

Coherence is a desktop app for business analysts. It reads screenshots of a user interface and writes editable
requirements: use cases, business rules and BDD scenarios. It runs entirely on your PC; the only things that leave it
are the requests you send to the AI services you connect and the items you export to a tracker.

## What you need

- Windows 11, 64-bit. Windows 10 is not supported yet.
- No administrator rights: Coherence installs for your account only.
- The Microsoft Edge WebView2 Runtime, which is part of Windows 11. If it is missing, Coherence opens in your default
  browser instead.

## Install

1. Run `Coherence-<version>-Setup.exe`.
2. Coherence installs into `%LOCALAPPDATA%\Programs\Coherence` and adds a Start menu entry. A desktop icon is optional.
3. Finish starts Coherence.

**Coherence is not signed yet.** Windows SmartScreen may say "Windows protected your PC". Only continue (**More info
→ Run anyway**) if you downloaded the file from <https://github.com/waxyfeet/coherence/releases> and its SHA-256
matches the checksum published there. In PowerShell: `Get-FileHash .\Coherence-<version>-Setup.exe`.

## Starting, closing and the tray

- Coherence opens in its own window. A second start brings that window forward.
- The tray icon offers **Open**, **Open in browser instead** and **Quit**.
- Closing the window quits Coherence. If AI work is still running, Coherence asks first.
- Coherence never starts with Windows on its own.

If Coherence cannot start, it says why and what to do: another copy still closing, missing or damaged program files
(reinstall; your projects and settings are kept), data from a newer version, or restored data that needs your
choice. Its log files are in `%LOCALAPPDATA%\CoherenceLauncher\Logs`.

## Connecting an AI service

The **Offline demo** works without any account, but it only produces sample content. To analyse your own screens,
connect an AI service:

1. Open **Settings → AI connections → Add connection**.
   - For **Anthropic**, **OpenAI** or **Google Gemini**, choose it and paste your API key.
   - For most other services (OpenRouter, Groq, DeepSeek, Together AI, Mistral, xAI and many more), choose
     **OpenAI-compatible**. Then click the service under **Recognised addresses**, or paste the API address from the
     service's documentation; Coherence tidies what you paste.
2. Paste the API key, then click **Connect & find models**. Coherence lists the models and, where the service allows,
   checks the key without running a model.
3. Tick the models you want to use, then **Save**.
4. On a project's **Analysis** page, choose a model to **Read screens** and one to **Write use cases**. The reading
   model must accept screenshots: models that do are listed first.

**Free tiers are small.** For example, OpenRouter's free models allow about 50 requests a day without purchased
credits, and a four-screen project needs roughly that many. When a service's limit runs out, Coherence pauses the run
and says when the limit resets.

**When a run stops** (a limit, a refused key, a cancelled run), the Analysis page says why and offers:
- **Try again:** reuses every step the run finished, as long as the models and settings stay the same;
- **Change models:** pick other models, then start again;
- **Abandon run:** discards the finished steps and starts from scratch next time.

Your existing requirements are never changed by a run that did not finish.

## Publishing to Azure DevOps

**Before you start:** in **Settings → Integrations**, add your Azure DevOps organisation URL
(`https://dev.azure.com/<organisation>`), the project, and a personal access token with **Work Items: Read & write**.
Use **Test connection** to check them.

**To publish:**
1. On **Export**, choose the use cases and **Azure DevOps**.
2. Choose **Plan with AI** or **Plan without AI**. Coherence reads how your project is set up (it changes nothing
   there) and works out which work item type and which field each part of a use case goes to.
3. Answer any questions it couldn't work out. Where it had a good guess it **assumed** it and lists it; change any
   that are wrong.
4. Choose **Publish to Azure DevOps…**. Check the organisation and project in the confirmation, then **Create N work
   items**.

**What Coherence does:**
- It first asks Azure DevOps to check every item without saving it.
- It then creates Features first, then the user stories under them, then the dependency links.
- Items Azure DevOps would refuse stay behind, and the results say why.

**What it never does:** delete, close or reassign anything, or remove tags.

**Publishing again** sends only what isn't there yet, and updates work items whose use case you changed:
- **Your changes go across.** Only the fields you changed in Coherence are sent.
- **The team's edits stay.** A field the team edited in Azure DevOps is kept, and their tags stay too.
- **Both changed:** if a field was changed in both places, Coherence asks which to keep.
- **Edited after planning:** if someone edits the work item after you planned, Azure DevOps refuses the update rather
  than losing their edit. Plan again and publish.

**If a run stops with "Needs checking",** Azure DevOps didn't confirm whether an item was saved. Choose **Check Azure
DevOps** before publishing again. Coherence finds the item if it was saved, so nothing is created twice.

## Publishing to Jira

Jira works the same way, for Jira Cloud and Jira Server/Data Center.

**Before you start:** in **Settings → Integrations**, add the site, the project key and your credentials:
- **Cloud:** your email and an API token;
- **Server/Data Center:** a personal access token.

**What Coherence creates:**
- Epics for feature groups, and stories under them (through the Parent field on Cloud, the Epic Link on Data Center);
- "Blocks" links from each prerequisite to the use case that depends on it.

**Differences from Azure DevOps:**
- **Labels:** Coherence only ever adds labels.
- **No check first:** Jira can't check an issue without saving it. Anything Jira refuses shows while publishing: the
  issues already created stay and are listed, and an Epic that is refused keeps its stories back.
- **Updates:** before each update Coherence checks that nobody edited the issue in Jira since you planned. If someone
  did, the issue isn't touched; plan again.

## Publishing to GitHub

GitHub works the same way, for github.com and GitHub Enterprise.

**Before you start:** in **Settings → Integrations**, add the owner, the repository and a token that can read and
write the repository's issues.

**What Coherence creates:**
- milestones (or "feature: …" labels, if you chose labels) for feature groups;
- issues with their milestone, labels and issue type.

**How GitHub differs:**
- **Dependencies:** an issue that depends on another starts with a line such as "**Depends on:** #12 (UC-001)".
- **Labels:** Coherence only ever adds labels.
- **No check first:** GitHub can't check an issue without saving it, so a refusal shows while publishing.
- **Silent drops:** if GitHub quietly leaves out the labels or the milestone (it does for tokens without triage
  access), the results say so.
- **Updates:** before each update Coherence checks that nobody edited the issue on GitHub since you planned.
- **Not sent:** organisation issue fields aren't sent yet; the preview and the results say so.

## Reporting a problem

Open an issue at <https://github.com/waxyfeet/coherence/issues>. Say what you did, what you expected and what
happened, with a screenshot if you can. Helpful extras:
- the run's log: open **Activity** and copy the lines around the problem;
- Coherence's own logs, in `%LOCALAPPDATA%\CoherenceLauncher\Logs`.

**Never send your API keys** or any files from `%LOCALAPPDATA%\Coherence`.

## Where your work is kept

| What | Where |
| --- | --- |
| Projects (screenshots, requirements, history) | `Documents\Coherence\Projects`, one folder per project. If Documents is synced by OneDrive or is on a network share, `%USERPROFILE%\Coherence Projects` instead, and the app says why. |
| Settings, AI connections, saved keys | `%LOCALAPPDATA%\Coherence` |
| The app itself | `%LOCALAPPDATA%\Programs\Coherence` |

You can choose another folder for projects at any time (**Project files → Choose workspace**). See
[Your Coherence project files](../PROJECT_FILES_GUIDE.md) for editing, moving and backing up projects.

Saved AI keys are protected by Windows for your account. Copying them to another PC or account does not carry the keys
across. Enter them again there.

## Back up, export and recover

- **Export a project:** on a project card, **⋯ → Export project as .zip** gives one file with the complete project
  (the regenerable analysis cache is left out). Unzip it anywhere and open it with **Open existing Coherence project**.
- **Copy the folder:** with Coherence closed, copying a complete project folder is also a full backup.
- **After a reinstall or on a new PC:** **Project files → Find Coherence projects in a folder** lists every project in
  a folder (and its Trash) and opens or reconnects the ones you choose.
- **A project whose folder is gone:** reconnect it, or use **Remove from library** on its card. That only removes it
  from the list; no files are touched.
- **Restored settings folder:** if you restore `%LOCALAPPDATA%\Coherence` from a backup, Coherence asks whether to
  use it or start fresh. Starting fresh keeps the old folder as `Coherence.old-<date>`.

## Updating and uninstalling

- **Update:** run the newer Setup. It closes Coherence gracefully first, and never while AI work is running unless
  you agree. Your projects and settings are kept. Installing an older version over a newer one needs confirmation.
- **Uninstall:** use **Settings → Apps → Installed apps → Coherence**. Your projects are never removed. Uninstall asks
  whether to also remove your settings and saved keys; the answer defaults to **No**.

## If something is blocked

- **"Windows denied Coherence access to this folder"**: Controlled Folder Access (Windows Security → Virus & threat
  protection → Ransomware protection) may be protecting it. Either allow `Coherence.exe`, `runtime\node.exe` and
  `CoherencePlatform.exe` from `%LOCALAPPDATA%\Programs\Coherence`, or keep projects in a folder it does not protect.
- **OneDrive, network folders and cloud-only files** are not supported for projects yet. Keep projects on a local
  drive.
- **Proxies:** Coherence connects to AI services directly. Networks that only allow traffic through a proxy are not
  supported yet.

## Privacy

See [Privacy and data flow](PRIVACY_AND_DATA_FLOW.md).
