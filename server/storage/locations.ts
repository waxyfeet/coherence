import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { platformProcess } from "../platform/nativeHelper";
import { StartupError, logHelperTimeout } from "../startupErrors";

const KNOWN_FOLDER_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CoherenceKnownFolders {
 [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(ref Guid id,uint flags,IntPtr token,out IntPtr result);
 public static string Resolve(string value) {
  var id=new Guid(value);IntPtr result=IntPtr.Zero;
  try {Marshal.ThrowExceptionForHR(SHGetKnownFolderPath(ref id,0x4000,IntPtr.Zero,out result));return Marshal.PtrToStringUni(result);}
  finally {if(result!=IntPtr.Zero)Marshal.FreeCoTaskMem(result);}
 }
}
'@
[Console]::WriteLine([CoherenceKnownFolders]::Resolve([Console]::ReadLine()))
`;

/** Shell Known Folders, including redirected Documents; never construct C:\\Users paths. */
export function knownFolder(
  kind: "MyDocuments" | "LocalApplicationData",
): string {
  if (process.platform !== "win32")
    return kind === "MyDocuments"
      ? path.join(os.homedir(), "Documents")
      : path.join(os.homedir(), ".local", "share");
  const unavailable = new StartupError(
    "USER_FOLDERS_UNAVAILABLE",
    "Windows could not resolve the user folder. Check folder availability before starting Coherence.",
  );
  let result: string;
  const lookup = platformProcess("known-folder", [
    "-Command",
    KNOWN_FOLDER_SCRIPT,
  ]);
  try {
    result = execFileSync(lookup.file, lookup.args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      stdio: ["pipe", "pipe", "ignore"],
      input:
        (kind === "MyDocuments"
          ? "FDD39AD0-238F-46AF-ADB4-6C85480369C7"
          : "F1B32785-6FBA-4FCF-9D55-7B8E7F157091") + "\n",
    }).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ETIMEDOUT")
      logHelperTimeout("Known-folder lookup");
    throw unavailable;
  }
  if (!result || !path.isAbsolute(result)) throw unavailable;
  // Trust only the OS-selected anchor, resolving an existing redirected alias once.
  // Links appearing inside an owned project remain forbidden by the IO boundary.
  return fs.existsSync(result) ? fs.realpathSync(result) : result;
}

/**
 * `folder` names the default profile and workspace folders: the installed app owns "Coherence"; developer runs use
 * "Coherence-Dev" so the two never share data (installer decision D6). An explicit SCREENSCRIBE_V2_DATA_DIR or
 * SCREENSCRIBE_V2_WORKSPACE_DIR still wins.
 */
export function storageLocations(
  install: string,
  folder: "Coherence" | "Coherence-Dev" = "Coherence",
) {
  const requested = process.env.SCREENSCRIBE_V2_STORAGE_LAYOUT;
  if (requested && requested !== "portable")
    throw Error(
      "Legacy project storage is no longer supported. Keep the old folder intact and choose a separate Coherence profile and project workspace.",
    );
  const dataDir = path.resolve(
    process.env.SCREENSCRIBE_V2_DATA_DIR ||
      path.join(knownFolder("LocalApplicationData"), folder),
  );
  let workspaceDir = "";
  let workspaceNote: WorkspaceNote | undefined;
  if (process.env.SCREENSCRIBE_V2_WORKSPACE_DIR) {
    workspaceDir = path.resolve(process.env.SCREENSCRIBE_V2_WORKSPACE_DIR);
    // The launcher applies the same policy natively and says why it chose a folder outside Documents.
    const note = process.env.SCREENSCRIBE_V2_WORKSPACE_NOTE;
    if (note === "onedrive" || note === "network") workspaceNote = note;
  } else
    try {
      ({ dir: workspaceDir, note: workspaceNote } = defaultWorkspace(
        knownFolder("MyDocuments"),
        folder,
      ));
    } catch {
      /* Browse remains available; never fall back to AppData projects. */
    }
  return {
    dataDir,
    workspaceDir,
    workspaceNote,
    storageLayout: "portable" as const,
    installDir: install,
  };
}

export type WorkspaceNote = "onedrive" | "network";

/**
 * Decision D8 (installer report §5.6): projects default to Documents\<folder>\Projects, except when Documents is
 * synced by OneDrive (Known Folder Move) or redirected to a network share. Coherence's storage protection refuses
 * those locations, so projects then default to a local folder in the user's profile, with a note saying why. The
 * user can still choose any safe folder.
 */
export function defaultWorkspace(
  documents: string,
  folder: "Coherence" | "Coherence-Dev",
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): { dir: string; note?: WorkspaceNote } {
  const local = path.join(home, `${folder} Projects`);
  if (documents.startsWith("\\\\")) return { dir: local, note: "network" };
  const synced = [env.OneDrive, env.OneDriveCommercial, env.OneDriveConsumer]
    .filter((root): root is string => !!root && path.isAbsolute(root))
    .some((root) =>
      `${path.resolve(documents)}\\`
        .toLowerCase()
        .startsWith(`${path.resolve(root)}\\`.toLowerCase()),
    );
  if (synced) return { dir: local, note: "onedrive" };
  return { dir: path.join(documents, folder, "Projects") };
}
