import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { config } from "../config";
import { assertGlobalPath } from "./boundary";
import { claimGlobalDirectory } from "./globalOwnership";
import { StartupError } from "../startupErrors";

export type InstanceLock = () => Promise<void>;
interface Ownership {
  root: string;
  closing: boolean;
  tail: Promise<unknown>;
}
const owners = new WeakMap<InstanceLock, Ownership>();
const busy = () =>
  new StartupError(
    "ALREADY_RUNNING",
    "Another V2 process owns this data folder. Close it before starting another server.",
  );
const invalid = () =>
  new StartupError(
    "PROFILE_INVALID",
    "The V2 data lock is invalid. Inspect it before removing it.",
  );

/** Serialize launcher mutations against release, without exposing the kernel handle. */
export function withInstanceLock<T>(
  claim: InstanceLock,
  operation: () => Promise<T>,
): Promise<T> {
  const owner = owners.get(claim);
  if (!owner || owner.closing || owner.root !== config.dataDir)
    return Promise.reject(
      new Error("Active V2 data-folder ownership is required."),
    );
  const pending = owner.tail.then(operation);
  owner.tail = pending.catch(() => {});
  return pending;
}

/**
 * The OS endpoint, NOT the JSON/PID file, is the exclusive claim. Windows/libuv
 * binds with FILE_FLAG_FIRST_PIPE_INSTANCE; Linux abstract sockets also have
 * atomic bind and automatic crash release. Never unlink a filesystem socket.
 */
export async function acquireInstanceLock(): Promise<InstanceLock> {
  assertGlobalPath(config.dataDir);
  await fs.mkdir(config.dataDir, { recursive: true });
  const physical = await fs.realpath(config.dataDir);
  const identity =
    process.platform === "win32" ? physical.toLowerCase() : physical;
  const name =
    "screenscribe-v2-" + createHash("sha256").update(identity).digest("hex");
  const endpoint =
    process.platform === "win32"
      ? "\\\\.\\pipe\\" + name
      : process.platform === "linux"
        ? "\0" + name
        : undefined;
  if (!endpoint)
    throw new Error(
      "Safe data-folder ownership requires Windows or Linux. This platform is not supported.",
    );
  const lease = net.createServer((socket) => {
    // This is an exclusion primitive, never an application/session IPC service.
    socket.on("error", () => {});
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    lease.once("error", reject);
    lease.listen({ path: endpoint, exclusive: true }, () => {
      lease.removeListener("error", reject);
      resolve();
    });
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") throw busy();
    throw new Error("Could not acquire exclusive V2 data-folder ownership.");
  });

  let closing = false;
  const lostOwnership = () => {
    if (!closing) {
      console.error(
        "Coherence lost exclusive data-folder ownership and must stop.",
      );
      process.exit(1);
    }
  };
  lease.on("error", lostOwnership);
  lease.on("close", lostOwnership);
  const close = async () => {
    closing = true;
    await new Promise<void>((resolve) => lease.close(() => resolve()));
  };
  const file = path.join(config.dataDir, ".instance-lock.json");
  const nonce = randomUUID();
  try {
    await claimGlobalDirectory();
    // Compatibility with a still-running older version that has only a PID claim.
    // Every read/check/removal happens INSIDE the already acquired OS exclusion.
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink()) throw invalid();
      // An empty claim was torn by a crash before anything was written: stale.
      const text = await fs.readFile(file, "utf8");
      if (text.trim()) {
        let old: { pid?: number; nonce?: unknown } | null;
        try {
          old = JSON.parse(text);
        } catch {
          throw invalid();
        }
        if (!old || !Number.isSafeInteger(old.pid) || old.pid! < 1)
          throw invalid();
        // Every claim written by a pipe-holding version carries a nonce. Holding the pipe proves that writer
        // has exited, whatever process has since been given its PID, so only PID-only claims are checked.
        if (typeof old.nonce !== "string")
          try {
            process.kill(old.pid!, 0);
            throw busy();
          } catch (error) {
            // EPERM: a protected or other-account process, never this user's older server.
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ESRCH" && code !== "EPERM") throw error;
          }
      }
      await fs.rm(file);
    }
    // Written atomically, so a crash can never leave an empty claim behind.
    for (const name of await fs.readdir(config.dataDir))
      if (/^\.instance-lock\.json\.[0-9a-f-]{36}\.tmp$/.test(name))
        await fs.rm(path.join(config.dataDir, name));
    const temp = `${file}.${nonce}.tmp`;
    await fs.writeFile(
      temp,
      JSON.stringify({
        pid: process.pid,
        nonce,
        createdAt: new Date().toISOString(),
      }),
      { flag: "wx", mode: 0o600 },
    );
    await fs.rename(temp, file);
  } catch (error) {
    await close();
    throw error;
  }

  const owner: Ownership = {
    root: config.dataDir,
    closing: false,
    tail: Promise.resolve(),
  };
  let released: Promise<void> | undefined;
  const release: InstanceLock = () => {
    if (released) return released;
    owner.closing = true; // Refuse new mutations immediately; drain existing ones.
    released = (async () => {
      await owner.tail;
      try {
        const stat = await fs.lstat(file).catch(() => undefined);
        if (stat?.isFile() && !stat.isSymbolicLink()) {
          const saved = JSON.parse(await fs.readFile(file, "utf8"));
          if (saved.nonce === nonce && saved.pid === process.pid)
            await fs.rm(file);
        }
      } finally {
        // Last: no other process can acquire while cleanup is in flight.
        await close();
      }
    })();
    return released;
  };
  owners.set(release, owner);
  return release;
}
