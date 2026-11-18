# Your Coherence project files

Each new Coherence project has its own folder. Your screenshots, editable requirements, business context, saved analysis, reviews and history stay together there. This folder contains the real working files, not an export copy.

## Choose where projects live

Coherence suggests **Documents → Coherence → Projects**, using your Windows Documents location. Choose **Browse** when creating a project to use another available local folder. Coherence creates a separate folder for that project; it will not take over an existing unrelated folder.

Use **Project files → Choose workspace** to remember a different default. Existing projects stay where they are. If a drive is missing or a folder is unavailable, reconnect it or choose another available location; Coherence will not silently create a replacement project elsewhere.

Keep projects beside one another, never inside another project's folder or `specs`. Coherence refuses overlapping project folders even after reinstall or when using separate app profiles. If old folders overlap, keep both intact, close the applications and separate the complete folders before reopening. Do not delete their contents to dismiss the warning.

Occupied folders, including unsupported old ScreenScribe folders and marked requirements, are protected from adoption or cleanup. Only the complete versioned Coherence project format can be opened.

## Find and edit your files

The project's Overview and project details show its actual folder. **Open project folder** opens it in Windows Explorer. Editable requirements and BDD files are in `specs`; original screenshots and retained versions are in `screens`. Keep `project.json`, `model.json` and the other project folders with them.

You can edit requirements in Coherence or an external Markdown editor. Save and close external edits before regenerating. Coherence checks for conflicts and preserves human edits when that option is enabled. A changed approved requirement needs review again. Missing or damaged files may block generation until you repair or restore them; they are not replaced silently.

## Back up, move or reopen a project

1. Finish running operations, save your edits and close Coherence and external editors.
2. Copy the **entire project folder**, including its hidden files and subfolders, to your backup location. Copying only `specs` is not a complete project backup.
3. To reopen a complete project, choose **Project files → Open existing Coherence project** and select that folder.

For a single-file backup, use **Export project as .zip** in the project card's menu. It contains the complete project except the analysis cache, which Coherence rebuilds when needed. Unzip it, then open the folder as above.

If the original is still registered and present, Coherence rejects a second working copy with the same identity. Use **Duplicate** for a separate draft, or close the app, move the original and explicitly reconnect its new location. A project restored from backup into its original folder reconnects through **Open existing Coherence project**. A missing project stays in your library with **Reconnect project folder**. Choose that same complete project; selecting another project's folder is rejected. If the folder is gone for good, **Remove from library** in the card's menu removes the entry and touches no files.

After a reinstall or on a new PC, **Project files → Find Coherence projects in a folder** lists every project in the folder you choose, including its Coherence Trash, and says whether each is already in your library. Open or reconnect the ones you want. Folders that are not readable Coherence projects are listed with the reason.

Another PC or reinstall can open a complete project without the old application settings. Global preferences, area definitions and AI credentials are separate. Missing areas appear unassigned. Saved requirements remain readable, but missing AI connections must be deliberately reconfigured before new generation; Coherence will not silently substitute a cloud provider.

DPAPI-protected AI keys are tied to your Windows account. Do not put keys into project files or assume copying AppData transfers working credentials. Treat project backups as private: they contain your screenshots, business context and requirements.

## Duplicate and Trash

**Duplicate** copies the project brief, settings and screenshots into an independent draft with new identities. It does not copy the analysis, generated specifications or approvals. Run analysis again when ready.

**Move to Trash** moves the complete project into the workspace's local Trash. You can restore it if the original location is available and empty. **Delete permanently** asks for confirmation and removes only that reviewed Trash project. It does not remove the parent workspace, sibling projects, separate backups or anything published remotely.

A permanent deletion interrupted by a file lock or newly changed file may be partial. Keep the remaining Trash entry, review it again, and retry only after understanding the remaining files. Permanent deletion is irreversible; make a backup first if the project matters.

## Existing ScreenScribe projects

The unreleased application now supports one project format. Old ScreenScribe layouts cannot be opened or operated by this version; there is no migration feature. Start with a separate empty global profile and workspace. Existing old demo folders remain untouched and can stay parked with their earlier application worktree. This engineering change does not delete them or update the running demo.

## Current preview limits

The new writable layout is Windows-first and supports available local drives. Keep projects fully downloaded and close Coherence before moving an open folder. Network shares, cloud placeholders/conflict resolution and simultaneous editing from multiple PCs are not supported. A separate application instance cannot open the same physical project for writing.

When Windows Documents is synced by OneDrive or redirected to a network share, new projects default to `%USERPROFILE%\Coherence Projects` instead, and the Project files dialog says why. If Controlled Folder Access protects your project folder, Coherence says which programs to allow.

Installing, updating and uninstalling the Windows app are described in the [user guide](release/USER_GUIDE.md). Clean-machine acceptance of the installed app has not been completed yet.
