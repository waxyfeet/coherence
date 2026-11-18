/**
 * OWNER: server-core builder.
 * Process entry. Stop, crash and control-channel handlers exist before any application module loads; the app itself
 * (server/startup.ts) is loaded afterwards, so even a failure while modules load — a user folder Windows cannot
 * resolve, a blocked native library — reaches the launcher as a typed `error` event and exit code
 * (server/startupErrors.ts) rather than a raw stack trace. Stop requests — Ctrl+C, SIGTERM, a closed console, Ctrl+Break,
 * or in managed mode the launcher's control channel (installer report §3.4) — made while starting are honoured at the
 * next safe point.
 */
import { randomUUID } from "node:crypto";
import packageJson from "../package.json" with { type: "json" };
import {
  emit,
  listenForControl,
  routeConsoleToStderr,
  type StopReason,
} from "./lifecycle/control";
import {
  LauncherError,
  launcherFailureMessage,
} from "./security/launcherErrors";
import { errorMessage } from "./errors";
import { EXIT_CODES, StartupError, safeCause } from "./startupErrors";
import type { RunningApp } from "./startup";

routeConsoleToStderr();

let stopping = false;
/** Until the app serves, a stop request is remembered and honoured at the next safe point. */
let pendingStop: StopReason | undefined;
let running: RunningApp | undefined;
const requestStop = (reason: StopReason) => {
  if (running) running.stop(reason);
  else pendingStop ??= reason;
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const)
  process.on(signal, () => {
    // A second request while stopping means: stop waiting.
    if (stopping) process.exit(EXIT_CODES.FORCED_EXIT);
    requestStop(signal);
  });
listenForControl({
  open: () =>
    running
      ? running.openSession()
      : Promise.reject(new Error("Coherence is still starting.")),
  status: () =>
    running?.status() ?? {
      ready: false,
      version: packageJson.version,
      activeJobs: 0,
    },
  shutdown: (reason) => {
    if (!stopping) requestStop(reason);
  },
});
// Crashes keep their stack frames for diagnosis but never their message, which may contain project text.
for (const event of ["uncaughtException", "unhandledRejection"] as const)
  process.on(event, (error: unknown) => {
    const reference = randomUUID();
    console.error(
      `Coherence stopped after an unexpected error. Reference ${reference}.`,
    );
    console.error(
      `[crash] ${reference}: ${safeCause(error)}\n${String(
        (error as Error)?.stack ?? "",
      )
        .split("\n")
        .slice(1)
        .join("\n")}`,
    );
    emit("error", { code: "OTHER" });
    process.exit(EXIT_CODES.OTHER);
  });
emit("starting", { version: packageJson.version, pid: process.pid });

import("./startup")
  .then(({ start }) =>
    start({
      pendingStop: () => pendingStop,
      beginStop: () => {
        if (stopping) return false;
        stopping = true;
        return true;
      },
      serving: (app) => {
        running = app;
      },
    }),
  )
  .catch((error: unknown) => {
    const known =
      error instanceof StartupError
        ? error
        : error instanceof LauncherError
          ? new StartupError(
              "LAUNCHER_PREPARATION",
              launcherFailureMessage(error),
            )
          : undefined;
    if (known) {
      console.error(`Coherence failed to start: ${known.message}`);
      emit("error", { code: known.code });
      process.exit(EXIT_CODES[known.code]);
    }
    const message = errorMessage(error);
    console.error(`Coherence failed to start: ${message}`);
    // Correlates the reference shown to the user with a cause class: never a message, path or secret.
    console.error(
      `[startup] ${/Reference ([0-9a-f-]{36})/.exec(message)?.[1] ?? "unreferenced"}: ${safeCause(error)}`,
    );
    emit("error", { code: "OTHER" });
    process.exit(EXIT_CODES.OTHER);
  });
