const messages = {
  SERVER_UNAVAILABLE:
    "Coherence is not ready or unavailable. Start the local server (and development UI if used), wait for its ready message, then run the launcher again.",
  VERIFICATION_MISMATCH:
    "The local Coherence server could not be verified. Restart the intended V2 server and try its launcher again; do not send credentials to another listener.",
  INVALID_TARGET:
    "Server verification requires the exact literal IPv4 loopback origin. Restart the intended V2 server and use its local launcher.",
  LAUNCHER_PREPARATION:
    "Coherence could not prepare its protected local launcher. Check local file permissions and run the launcher from the same Windows account as the server.",
  BROWSER_LAUNCH:
    "The verified local browser handoff was prepared, but the browser could not be opened. Check the default browser and run the launcher again.",
} as const;
export class LauncherError extends Error {
  constructor(public readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = "LauncherError";
  }
}
/** Never trust an arbitrary error's message, cause, stack or other properties for CLI output. */
export function launcherFailureMessage(error: unknown): string {
  return error instanceof LauncherError
    ? (messages[error.code] ?? messages.LAUNCHER_PREPARATION)
    : messages.LAUNCHER_PREPARATION;
}
