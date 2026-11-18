/**
 * Managed mode (installer report §3.4): when the Windows launcher starts the backend with `--managed`, the two
 * talk over the child's private stdio pipes. stdin carries JSON-line commands; stdout carries only protocol events,
 * each one line prefixed "@coherence "; every other console line goes to stderr. stdin closing means the launcher is
 * gone, so the backend shuts down gracefully. Nothing here listens on a socket.
 */
import readline from "node:readline";

export const managed = process.argv.includes("--managed");
const PREFIX = "@coherence ";

export type ControlEvent =
  | "starting"
  | "ready"
  | "bootstrap"
  | "session-opened"
  | "status"
  | "jobs"
  | "quit-requested"
  | "stopping"
  | "error";

export type StopReason =
  "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGBREAK" | "launcher" | "launcher-gone";

export function emit(
  event: ControlEvent,
  data: Record<string, unknown> = {},
): void {
  if (managed)
    process.stdout.write(`${PREFIX}${JSON.stringify({ event, ...data })}\n`);
}

/**
 * In managed mode nothing but protocol events may reach stdout. When the launcher is gone its end of stdout and
 * stderr is gone too: writes then fail with EPIPE, which must not turn the graceful shutdown into a crash that
 * leaves the profile locked.
 */
export function routeConsoleToStderr(): void {
  if (!managed) return;
  for (const name of ["log", "info", "debug"] as const)
    console[name] = (...args: unknown[]) => console.error(...args);
  for (const stream of [process.stdout, process.stderr])
    stream.on("error", () => {});
}

export interface ControlHandlers {
  /** Creates a one-use bootstrap file for a new browser session and returns its path. */
  open(): Promise<string>;
  status(): Record<string, unknown>;
  shutdown(reason: "launcher" | "launcher-gone"): void;
}

export function listenForControl(handlers: ControlHandlers): void {
  if (!managed) return;
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => void handle(line));
  lines.on("close", () => handlers.shutdown("launcher-gone"));
  async function handle(line: string): Promise<void> {
    let op: unknown;
    try {
      op = (JSON.parse(line) as { op?: unknown })?.op;
    } catch {
      op = undefined;
    }
    try {
      if (op === "open") emit("bootstrap", { file: await handlers.open() });
      else if (op === "status") emit("status", handlers.status());
      else if (op === "shutdown") handlers.shutdown("launcher");
      else emit("error", { code: "UNKNOWN_COMMAND" });
    } catch {
      emit("error", { code: op === "open" ? "OPEN_FAILED" : "COMMAND_FAILED" });
    }
  }
}
