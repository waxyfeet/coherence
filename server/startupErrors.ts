/**
 * Start-up failures the launcher can explain in plain words (installer report §3.4). The message is fixed and
 * safe to show; the code is the managed-mode `error` event and selects the process exit code. Codes never carry
 * paths, file contents or secrets.
 */
export const EXIT_CODES = {
  /** Anything not classified below; the log line carries a reference and a safe cause class. */
  OTHER: 1,
  /** Another Coherence already owns this data folder. */
  ALREADY_RUNNING: 2,
  /** Shutdown did not finish in time and was forced. */
  FORCED_EXIT: 3,
  /** None of the candidate ports could be used. */
  PORT_UNAVAILABLE: 10,
  /** The profile's lock or ownership record is invalid, or the profile folder was replaced. */
  PROFILE_INVALID: 11,
  /** A new profile folder already contains files Coherence did not create. */
  PROFILE_NOT_EMPTY: 12,
  /** Windows storage protection could not start or stopped responding. */
  STORAGE_PROTECTION: 13,
  /** Windows could not say where the user's AppData or Documents folder is. */
  USER_FOLDERS_UNAVAILABLE: 14,
  /** The data folder is inside the installation folder. */
  DATA_INSIDE_INSTALL: 15,
  /**
   * No longer raised: since Stage 4, keys Windows cannot unlock no longer stop start-up (saved-keys-locked mode,
   * server/storage/settingsStore.ts). Kept so that no code ever changes meaning.
   */
  SETTINGS_LOCKED: 16,
  /** Saved data was written by a newer Coherence; nothing was changed. */
  DATA_NEWER: 17,
  /** The private launcher folder could not be prepared. */
  LAUNCHER_PREPARATION: 18,
  /** The packaged app's own files are missing or altered. */
  INSTALL_DAMAGED: 19,
  // 20–29 are the launcher's own exit codes (packaging/launcher/src/ExitCodes.cs).
  /** The data folder was restored or copied from elsewhere; it is used only after the user chooses to. */
  PROFILE_RESTORED: 30,
  /** A data migration failed; everything it changed was put back (server/storage/migrations.ts). */
  MIGRATION_FAILED: 31,
} as const;

export type StartupErrorCode = Exclude<
  keyof typeof EXIT_CODES,
  "OTHER" | "FORCED_EXIT"
>;

export class StartupError extends Error {
  constructor(
    readonly code: StartupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StartupError";
  }
}

/**
 * Windows helpers get 15 s. Antivirus scanning of a first run can exceed that (installer report R3), so each timeout
 * leaves one log line naming the helper; the failure itself surfaces as the caller's typed error.
 */
export function logHelperTimeout(helper: string): void {
  console.error(`[helper-timeout] ${helper} did not finish within 15 s.`);
}

/** Error class and system code only — never a message, which may contain paths or provider text. */
export function safeCause(error: unknown): string {
  if (!error || typeof error !== "object") return typeof error;
  const { name, code, syscall } = error as {
    name?: unknown;
    code?: unknown;
    syscall?: unknown;
  };
  return [name, code, syscall]
    .filter((part) => typeof part === "string" && /^[\w.-]{1,40}$/.test(part))
    .join(" ");
}
