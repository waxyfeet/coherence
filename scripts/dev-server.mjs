/** Development only: explicit source watching, never Node's imported-dependency watch mode. */
import fs, { watch } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const configuration = new Set([
  "package.json",
  "tsconfig.json",
  "tsconfig.server.json",
]);
const excluded = new Set([
  "node_modules",
  "dist",
  "build",
  "generated",
  "outputs",
  "backups",
  "artifacts",
  "coverage",
  "logs",
  "tmp",
  "temp",
  "fixtures",
  "__fixtures__",
  "__tests__",
  "test-results",
  "playwright-report",
]);
function inside(parent, file) {
  const relative = path.relative(parent, file);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function isRestartFile(
  root,
  filename,
  dataDir = process.env.SCREENSCRIBE_V2_DATA_DIR,
) {
  if (!filename) return false;
  const absolute = path.resolve(root, filename);
  if (
    !inside(root, absolute) ||
    inside(path.resolve(root, dataDir || ".screenscribe-v2"), absolute)
  )
    return false;
  const relative = path.relative(root, absolute).replaceAll("\\", "/");
  if (configuration.has(relative)) return true;
  const segments = relative.split("/");
  if (!["server", "shared"].includes(segments[0])) return false;
  if (
    segments.some((segment) => segment.startsWith(".") || excluded.has(segment))
  )
    return false;
  const name = segments.at(-1);
  return (
    /\.[cm]?[jt]s$/.test(name) &&
    !/(?:\.(?:test|spec|tmp|temp|bak)\.|~|^#)/.test(name)
  );
}

/** Baseline reads happen before watchers exist, so cold-start reads cannot request restarts. */
export function createContentGate(root) {
  root = path.resolve(root);
  function snapshot() {
    const files = new Map();
    function fingerprint(relative) {
      const file = path.join(root, relative);
      let descriptor;
      try {
        const before = fs.lstatSync(file);
        if (!before.isFile() || before.isSymbolicLink()) throw Error();
        descriptor = fs.openSync(
          file,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
        );
        const opened = fs.fstatSync(descriptor);
        if (
          !opened.isFile() ||
          before.ino !== opened.ino ||
          before.dev !== opened.dev
        )
          throw Error();
        files.set(
          relative.replaceAll("\\", "/"),
          createHash("sha256")
            .update(fs.readFileSync(descriptor))
            .digest("hex"),
        );
      } catch (error) {
        if (error?.code !== "ENOENT")
          throw new Error(
            "Cannot safely fingerprint development source: " +
              JSON.stringify(relative.replaceAll("\\", "/")),
          );
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
    }
    function walk(relative) {
      // Do not read runtime, hidden, dependency or fixture folders while building the baseline.
      const absolute = path.join(root, relative);
      if (
        inside(
          path.resolve(
            root,
            process.env.SCREENSCRIBE_V2_DATA_DIR || ".screenscribe-v2",
          ),
          absolute,
        )
      )
        return;
      let entries;
      try {
        entries = fs.readdirSync(absolute, { withFileTypes: true });
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || excluded.has(entry.name)) continue;
        const next = path.join(relative, entry.name);
        if (isRestartFile(root, next)) fingerprint(next);
        else if (entry.isDirectory()) walk(next);
      }
    }
    walk("server");
    walk("shared");
    for (const file of configuration) fingerprint(file);
    return files;
  }
  let baseline = snapshot();
  return {
    affects(filename) {
      const relative = filename.replaceAll("\\", "/");
      if (isRestartFile(root, relative)) return true;
      if ([...baseline.keys()].some((file) => file.startsWith(relative + "/")))
        return true;
      // New directories can arrive with files already inside them (e.g. a directory rename).
      if (isRestartFile(root, path.join(relative, "source.ts"))) {
        try {
          return fs.lstatSync(path.join(root, relative)).isDirectory();
        } catch {
          /* removed directory without baseline children */
        }
      }
      return false;
    },
    changes() {
      const next = snapshot();
      const changed = [...new Set([...baseline.keys(), ...next.keys()])]
        .filter((file) => baseline.get(file) !== next.get(file))
        .sort();
      baseline = next;
      return changed;
    },
  };
}

export function startDevServer(root = process.cwd()) {
  root = path.resolve(root);
  const gate = createContentGate(root);
  let child,
    timer,
    restarting = false,
    stopping = false;
  const pending = new Set();
  const watchers = [];
  function launch() {
    if (stopping) return;
    child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", () => {
      console.error(
        "[dev] Backend could not start. Check the local Node installation; source watching remains active.",
      );
    });
    child.once("exit", () => {
      if (!stopping && !restarting)
        console.log(
          "[dev] Backend stopped. Waiting for a source/configuration change.",
        );
    });
  }
  async function stopChild() {
    const running = child;
    if (
      !running ||
      running.exitCode !== null ||
      running.signalCode !== null ||
      !running.pid
    )
      return;
    await new Promise((resolve) => {
      running.once("exit", resolve);
      running.kill("SIGTERM");
    });
  }
  async function restart() {
    if (stopping || restarting) return;
    restarting = true;
    const paths = [...pending].sort();
    pending.clear();
    console.log(
      "[dev] Application source/configuration changed; restarting backend: " +
        JSON.stringify(paths),
    );
    await stopChild();
    restarting = false;
    launch();
    if (pending.size) schedule();
  }
  function schedule() {
    if (stopping) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        for (const file of gate.changes()) pending.add(file);
        if (pending.size) void restart();
      } catch {
        console.error(
          "[dev] Cannot verify development source contents. Backend stopped; check source file access and restart the development command.",
        );
        process.exitCode = 1;
        void stop();
      }
    }, 250);
  }
  function changed(prefix, filename) {
    if (!filename || gate.affects(path.join(prefix, filename.toString())))
      schedule();
  }
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    await stopChild();
  }
  try {
    for (const prefix of ["server", "shared"])
      watchers.push(
        watch(
          path.join(root, prefix),
          { recursive: true },
          (_event, filename) => changed(prefix, filename),
        ),
      );
    // Watch the directory, not individual files: editor atomic replacements must remain detectable.
    watchers.push(
      watch(root, (_event, filename) => {
        if (!filename || configuration.has(filename.toString()))
          changed("", filename);
      }),
    );
    for (const watcher of watchers)
      watcher.on("error", () => {
        console.error(
          "[dev] Source watching failed. Restart the development command.",
        );
        process.exitCode = 1;
        void stop();
      });
  } catch {
    for (const watcher of watchers) watcher.close();
    throw new Error(
      "Cannot watch backend source directories. Check local filesystem access.",
    );
  }
  console.log(
    "[dev] Watching server/shared source and package/TypeScript configuration only.",
  );
  // Reconcile the baseline-to-watch setup gap, including additions, before the first launch.
  try {
    for (const file of gate.changes()) pending.add(file);
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    throw error;
  }
  if (pending.size) schedule();
  launch();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return { stop };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  try {
    startDevServer();
  } catch {
    console.error(
      "[dev] Cannot initialise development source fingerprints. Check source file access and restart the development command.",
    );
    process.exitCode = 1;
  }
