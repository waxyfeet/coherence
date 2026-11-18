/**
 * OWNER: server-core builder.
 * Boot, loaded by the process entry (server/index.ts) once its handlers exist: data-folder claim → crash recovery →
 * settings → protected launcher folder → HTTP server on 127.0.0.1 (first free candidate port) → launch record →
 * optional browser. Stopping lets changes already sent finish, cancels running jobs so no project stays "generating",
 * closes SSE streams and releases every lock.
 */
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { cleanLegacyDiagnostics } from "./security/legacyDiagnostics";
import { LocalAuth, literalLoopbackOrigin } from "./security/localAuth";
import {
  createBootstrapFile,
  launchBrowser,
  prepareLaunchDirectory,
} from "./security/localLauncher";
import { launcherFailureMessage } from "./security/launcherErrors";
import { createApp } from "./app";
import { APP_VERSION, PACKAGED, ROOT_DIR, config } from "./config";
import { checkInstallation } from "./lifecycle/installCheck";
import { activeJobCount, cancelAllJobs } from "./jobs/jobManager";
import {
  ensureDataDirs,
  recoverInterruptedProjects,
} from "./storage/projectStore";
import { getSettings } from "./storage/settingsStore";
import { acquireInstanceLock, type InstanceLock } from "./storage/instanceLock";
import { recoverInterruptedJobs } from "./jobs/recovery";
import { releaseProjectLeases } from "./storage/projectRegistry";
import { removeOrphanedTemporaries } from "./storage/temporaries";
import {
  releaseFilesystemGuard,
  beginFilesystemShutdown,
} from "./storage/windowsStorageGuard";
import { emit, managed, type StopReason } from "./lifecycle/control";
import { beginClosing, drainChanges } from "./lifecycle/inflight";
import { EXIT_CODES, StartupError, safeCause } from "./startupErrors";

/** What the process entry hands the app. */
export interface Lifecycle {
  /** A stop requested before the app serves. */
  pendingStop(): StopReason | undefined;
  /** Marks the process as stopping; false if it already was. */
  beginStop(): boolean;
  /** From now on, control commands and stop requests go to the running app. */
  serving(app: RunningApp): void;
}
export interface RunningApp {
  openSession(): Promise<string>;
  status(): Record<string, unknown>;
  stop(reason: StopReason): void;
}

export async function start(lifecycle: Lifecycle): Promise<void> {
  // Before any data is touched: a damaged install must not claim or change the profile.
  if (PACKAGED) await checkInstallation(ROOT_DIR);
  const releaseLock = await acquireInstanceLock();
  try {
    await run(releaseLock, lifecycle);
  } catch (error) {
    await releaseLock().catch(() => {});
    throw error;
  }
}

async function run(
  releaseLock: InstanceLock,
  lifecycle: Lifecycle,
): Promise<void> {
  /** Before the server listens there is nothing to drain: release ownership and leave. */
  const stopIfRequested = async () => {
    const reason = lifecycle.pendingStop();
    if (!reason) return;
    lifecycle.beginStop();
    emit("stopping", { reason });
    beginFilesystemShutdown();
    await releaseProjectLeases();
    await releaseLock().catch(() => {});
    await releaseFilesystemGuard();
    process.exit(0);
  };
  await ensureDataDirs();
  // Leftovers of writes cut short by a crash (installer finding ST-14); projects are cleaned during recovery below.
  for (const folder of [
    config.dataDir,
    path.join(config.dataDir, "delivery", "profiles"),
    path.join(config.dataDir, "delivery", "destinations"),
  ])
    await removeOrphanedTemporaries(folder);
  await recoverInterruptedJobs();
  const recovered = await recoverInterruptedProjects();
  if (recovered.length) {
    console.log(
      `Reset ${recovered.length} project(s) that were interrupted while generating: ${recovered.join(", ")}`,
    );
  }
  await stopIfRequested();
  // Creates settings.json with the default connections on first run.
  await getSettings();
  const diagnosticCleanup = await cleanLegacyDiagnostics();
  if (diagnosticCleanup.cleaned)
    console.log(
      `Sanitized ${diagnosticCleanup.cleaned} earlier diagnostic record(s). Saved project documents and proposal content were retained.`,
    );
  if (diagnosticCleanup.unreadable)
    console.warn(
      "Some earlier diagnostic records could not be read. Keep the entire runtime folder private; do not share raw history as a support report.",
    );
  await stopIfRequested();

  // Slow ACL preparation and stale-record removal must precede any listening socket.
  const publishLaunchRecord = await prepareLaunchDirectory(releaseLock);
  await stopIfRequested();
  // The installed app has no development UI, so it accepts neither its origin nor its proxy.
  const origins = managed ? [] : [literalLoopbackOrigin(config.devPort)];
  const auth = new LocalAuth({
    origins,
    allowDevProxy: !managed,
    onSessionOpened: () => emit("session-opened"),
  });
  const server = http.createServer(createApp(auth));
  server.on("error", (error) =>
    console.error(`The local server reported an error: ${safeCause(error)}`),
  );
  const port = await listenOnFirstFree(server);
  const url = literalLoopbackOrigin(port);
  origins.push(url);
  let removeLaunchRecord: () => Promise<void>;
  try {
    removeLaunchRecord = await publishLaunchRecord(auth.capability, port);
  } catch (error) {
    auth.invalidate();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    throw error;
  }

  console.log(`Coherence running at ${url}`);
  console.log(`Data folder: ${config.dataDir}`);
  if (!managed)
    console.log(
      "Open an authenticated browser with npm run open (built UI) or npm run open:dev (development UI).",
    );

  const shutdown = async (reason: StopReason) => {
    if (!lifecycle.beginStop()) return;
    console.log(`\nStopping Coherence (${reason})…`);
    emit("stopping", { reason });
    setTimeout(() => process.exit(EXIT_CODES.FORCED_EXIT), 8000).unref();
    beginClosing();
    const closed = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    // Changes already sent may finish (bounded) while running jobs record their cancellation.
    await Promise.all([drainChanges(3000), cancelAllJobs(5000)]);
    auth.invalidate();
    server.closeAllConnections();
    await closed;
    await removeLaunchRecord().catch((error) =>
      console.warn(launcherFailureMessage(error)),
    );
    beginFilesystemShutdown();
    await releaseProjectLeases();
    await releaseLock().catch(() => {});
    await releaseFilesystemGuard();
    process.exit(0);
  };
  lifecycle.serving({
    openSession: () => createBootstrapFile(auth.capability, url),
    status: () => ({
      ready: true,
      version: APP_VERSION,
      origin: url,
      activeJobs: activeJobCount(),
    }),
    stop: (reason) => void shutdown(reason),
  });
  emit("ready", { origin: url, version: APP_VERSION, pid: process.pid });
  const early = lifecycle.pendingStop();
  if (early) {
    void shutdown(early);
    return;
  }
  if (config.openBrowser) {
    try {
      await launchBrowser(process.argv.includes("--dev"));
    } catch (error) {
      console.warn(launcherFailureMessage(error));
    }
  }
}

/** Tries each candidate port in turn; only "in use" and "not permitted" move on to the next one. */
async function listenOnFirstFree(server: http.Server): Promise<number> {
  for (const candidate of config.portCandidates) {
    const outcome = await new Promise<number | NodeJS.ErrnoException>(
      (resolve) => {
        const failed = (error: NodeJS.ErrnoException) => {
          server.off("listening", listening);
          resolve(error);
        };
        const listening = () => {
          server.off("error", failed);
          resolve((server.address() as AddressInfo).port);
        };
        server.once("error", failed);
        server.once("listening", listening);
        server.listen(candidate, config.host);
      },
    );
    if (typeof outcome === "number") return outcome;
    if (outcome.code !== "EADDRINUSE" && outcome.code !== "EACCES")
      throw outcome;
  }
  throw new StartupError(
    "PORT_UNAVAILABLE",
    managed
      ? "None of Coherence's local ports is free. Close the program using them or restart Windows, then open Coherence again."
      : `Port ${config.portCandidates.join(", ")} is already in use by another program. Set SCREENSCRIBE_V2_PORT to use another port.`,
  );
}
