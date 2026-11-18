/** A private IPC launcher for the legacy browser suites; no authentication bypass in the app. */
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
// Capture before browser harnesses override TEMP for browser-only artefacts.
const fixtureBase = path.resolve(os.tmpdir());
export async function authenticatedFixture(port, existingDataDir) {
  let dataDir;
  if (existingDataDir) {
    const requested = path.resolve(existingDataDir);
    if (requested.startsWith(path.join(process.cwd(), ".cache") + path.sep)) {
      if (await fs.lstat(requested).catch(() => null))
        throw Error(
          "Old checkout-local browser fixtures cannot be reused. Create a fresh current-format fixture.",
        );
      // Older callers supplied an unused .cache name. Never put the new profile there.
    } else if (
      path.dirname(requested) === fixtureBase &&
      path.basename(requested).startsWith("coherence-test-browser-")
    ) {
      if ((await fs.lstat(requested)).isSymbolicLink())
        throw Error("Linked fixture profiles cannot be reused.");
      dataDir = requested;
    } else throw Error("Only isolated fixture data can be reused.");
  }
  dataDir ??= await fs.mkdtemp(
    path.join(fixtureBase, "coherence-test-browser-"),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("SCREENSCRIBE_V2_"),
    ),
  );
  Object.assign(env, {
    SCREENSCRIBE_V2_PORT: String(port),
    SCREENSCRIBE_V2_DATA_DIR: dataDir,
    SCREENSCRIBE_V2_MOCK_DELAY_MS: "100",
  });
  env.SCREENSCRIBE_V2_WORKSPACE_DIR =
    env.SCREENSCRIBE_V2_DATA_DIR + "-workspace";
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/parity-api.ts"],
    {
      cwd: process.cwd(),
      env,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  const stop = () => {
    child.kill("SIGTERM");
  };
  process.once("exit", stop);
  const session = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(Error("Authenticated fixture startup timed out."));
    }, 20000);
    child.once("message", (message) => {
      clearTimeout(timer);
      if (message.type === "test-session" && message.session)
        resolve(message.session);
      else {
        stop();
        reject(Error("Fixture authentication unavailable."));
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(Error("Fixture could not start."));
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(Error("Fixture exited before authentication."));
    });
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    session,
    stop,
    dataDir: env.SCREENSCRIBE_V2_DATA_DIR,
  };
}
