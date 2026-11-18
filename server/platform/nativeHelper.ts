/**
 * CoherencePlatform.exe, the native platform helper (installer Stage 6, `packaging/helper`). The installed app uses it
 * for every Windows operation that used to run PowerShell — the storage guard, Known Folders, DPAPI, launcher-folder
 * permissions, the folder chooser and "Open project folder" — so it keeps working where script hosts are blocked
 * (Smart App Control, AppLocker, Constrained Language Mode). It ships next to Coherence.exe, and the install self-check
 * requires it.
 *
 * Developer runs keep the PowerShell implementations unless SCREENSCRIBE_V2_PLATFORM_HELPER names a built helper:
 * `node scripts/test-platform-helper.mjs` runs the platform suites that way, so both implementations stay covered
 * while both exist. The installed app ignores that variable (installer decision D7).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HELPER_FILE = "CoherencePlatform.exe";

// Same rule as server/config.ts, which cannot be imported here (it resolves folders through this module).
const PACKAGED = import.meta.url.endsWith("/server/index.mjs");

export type HelperOperation =
  | "guard"
  | "known-folder"
  | "protect"
  | "unprotect"
  | "private-directory"
  | "choose-folder"
  | "reveal";

/** The helper's absolute path when this process uses it, otherwise undefined. */
export function nativeHelper(): string | undefined {
  if (process.platform !== "win32") return undefined;
  if (PACKAGED)
    return path.join(
      path.dirname(path.dirname(fileURLToPath(import.meta.url))),
      HELPER_FILE,
    );
  const configured = process.env.SCREENSCRIBE_V2_PLATFORM_HELPER;
  return configured && path.isAbsolute(configured) ? configured : undefined;
}

/**
 * The program and arguments for one operation: the helper, or Windows PowerShell with the caller's own arguments
 * (`powershell` lists everything after `-NoLogo -NoProfile -NonInteractive`). Requests always travel over stdin.
 */
export function platformProcess(
  operation: HelperOperation,
  powershell: string[],
): { file: string; args: string[] } {
  const helper = nativeHelper();
  return helper
    ? { file: helper, args: [operation] }
    : {
        file: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", ...powershell],
      };
}
