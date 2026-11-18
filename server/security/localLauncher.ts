import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { config } from "../config";
import { platformProcess } from "../platform/nativeHelper";
import { assertV2Path } from "../storage/boundary";
import { withInstanceLock, type InstanceLock } from "../storage/instanceLock";
import { LauncherError } from "./launcherErrors";
import { logHelperTimeout } from "../startupErrors";
import {
  equalSecret,
  makeTicket,
  proof,
  TICKET_TTL_MS,
  isLiteralLoopbackOrigin,
  literalLoopbackOrigin,
} from "./localAuth";

interface LaunchRecord {
  capability: string;
  backend: string;
}
const runtimeDir = () => assertV2Path(path.join(config.dataDir, ".local-auth"));
const manifestPath = () => path.join(runtimeDir(), "launch.json");

/** Establish owner-only permissions BEFORE writing secrets. Fail closed on ACL errors. */
async function privateDirectory(dir: string): Promise<void> {
  assertV2Path(dir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error("Unsafe local launcher directory.");
  if (process.platform !== "win32") {
    await fs.chmod(dir, 0o700);
    return;
  }
  // The path travels as base64 UTF-8: the console code page cannot carry non-ASCII profile names.
  const script =
    "$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($p,$acl)";
  const command = platformProcess("private-directory", ["-Command", script]);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill();
      logHelperTimeout("Launcher folder permissions");
      reject(Error("Local launcher permissions timed out."));
    }, 15000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(Error("Cannot protect the local launcher directory."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(Error("Cannot protect the local launcher directory."));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(dir, "utf8").toString("base64"));
  });
}

async function launcherDirectory() {
  const dir = runtimeDir();
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new LauncherError("LAUNCHER_PREPARATION");
  return stat;
}

/** Complete slow permission work and remove stale authority BEFORE binding the listening socket. */
export async function prepareLaunchDirectory(
  claim: InstanceLock,
): Promise<(capability: string, port: number) => Promise<() => Promise<void>>> {
  try {
    return await withInstanceLock(claim, async () => {
      await privateDirectory(runtimeDir());
      const prepared = await launcherDirectory();
      // Remove only known launcher artifacts from an earlier launch; never follow links.
      for (const name of await fs.readdir(runtimeDir())) {
        if (name === "launch.json" || /^bootstrap-[a-f0-9]+\.html$/.test(name))
          await fs.unlink(path.join(runtimeDir(), name));
      }
      let attempted = false;
      return async (capability, port) => {
        try {
          return await withInstanceLock(claim, async () => {
            const current = await launcherDirectory();
            if (
              attempted ||
              current.dev !== prepared.dev ||
              current.ino !== prepared.ino
            )
              throw new LauncherError("LAUNCHER_PREPARATION");
            attempted = true;
            const record: LaunchRecord = {
              capability,
              backend: literalLoopbackOrigin(port),
            };
            await fs.writeFile(manifestPath(), JSON.stringify(record), {
              flag: "wx",
              mode: 0o600,
            });
            const timer = setInterval(() => {
              void withInstanceLock(claim, () =>
                cleanupBootstrapFiles(false),
              ).catch(() => {});
            }, 15_000);
            timer.unref();
            return async () => {
              try {
                clearInterval(timer);
                await withInstanceLock(claim, async () => {
                  await launcherDirectory();
                  // Cleanup cannot remove another launch's authority or follow a planted manifest symlink.
                  const stat = await fs
                    .lstat(manifestPath())
                    .catch(() => undefined);
                  if (stat?.isFile() && !stat.isSymbolicLink()) {
                    const saved = JSON.parse(
                      await fs.readFile(manifestPath(), "utf8"),
                    ) as LaunchRecord;
                    if (
                      saved.capability === capability &&
                      saved.backend === record.backend
                    )
                      await fs.unlink(manifestPath());
                  }
                  await cleanupBootstrapFiles(true);
                });
              } catch {
                throw new LauncherError("LAUNCHER_PREPARATION");
              }
            };
          });
        } catch {
          throw new LauncherError("LAUNCHER_PREPARATION");
        }
      };
    });
  } catch {
    throw new LauncherError("LAUNCHER_PREPARATION");
  }
}

/** Compatibility helper for isolated fixture servers; production prepares before listen. */
export async function publishLaunchRecord(
  capability: string,
  port: number,
  claim: InstanceLock,
): Promise<() => Promise<void>> {
  return (await prepareLaunchDirectory(claim))(capability, port);
}

async function cleanupBootstrapFiles(all: boolean): Promise<void> {
  await launcherDirectory();
  for (const name of await fs.readdir(runtimeDir())) {
    if (!/^bootstrap-[a-f0-9]+\.html$/.test(name)) continue;
    const file = path.join(runtimeDir(), name);
    const stat = await fs.lstat(file);
    if (all || stat.mtimeMs + TICKET_TTL_MS < Date.now()) await fs.unlink(file);
  }
}

export function bootstrapHtml(ticket: string, origin: string): string {
  if (
    !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(ticket) ||
    !isLiteralLoopbackOrigin(origin)
  )
    throw Error("Invalid local launch target.");
  // No capability or reusable session credential in this file, path, URL or browser history.
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; form-action ${origin}; base-uri 'none'"><title>Open Coherence</title></head><body><p>Opening your local Coherence workspace…</p><form method="post" action="${origin}/api/auth/bootstrap"><input type="hidden" name="ticket" value="${ticket}"><button>Open Coherence</button></form><script>document.forms[0].submit();</script></body></html>`;
}

/**
 * Writes a one-use bootstrap page into the owner-only launcher folder. Managed mode calls this in-process for the
 * launcher's `open` command, so the capability never leaves the server.
 */
export async function createBootstrapFile(
  capability: string,
  origin: string,
): Promise<string> {
  await launcherDirectory();
  const file = path.join(
    runtimeDir(),
    `bootstrap-${randomBytes(12).toString("hex")}.html`,
  );
  try {
    await fs.writeFile(
      file,
      bootstrapHtml(makeTicket(capability, origin), origin),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
  } catch {
    throw new LauncherError("LAUNCHER_PREPARATION");
  }
  return file;
}

/** Owner-only launcher. An HTTP caller cannot read this record or create a session by visiting the app. */
export async function prepareBrowserLaunch(
  dev = false,
): Promise<{ file: string; origin: string }> {
  try {
    await launcherDirectory();
    const stat = await fs.lstat(manifestPath());
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new LauncherError("VERIFICATION_MISMATCH");
    let record: LaunchRecord;
    try {
      record = JSON.parse(await fs.readFile(manifestPath(), "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new LauncherError("VERIFICATION_MISMATCH");
      throw error;
    }
    if (
      !record ||
      typeof record.capability !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.capability) ||
      typeof record.backend !== "string" ||
      !isLiteralLoopbackOrigin(record.backend)
    )
      throw new LauncherError("VERIFICATION_MISMATCH");
    const origin = dev ? literalLoopbackOrigin(config.devPort) : record.backend;
    await verifyLocalServer(record.capability, record.backend);
    if (dev) await verifyLocalServer(record.capability, origin);
    // The running server sweeps expired one-use files. The command can exit immediately.
    return {
      file: await createBootstrapFile(record.capability, origin),
      origin,
    };
  } catch (error) {
    if (error instanceof LauncherError) throw error;
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
      throw new LauncherError("SERVER_UNAVAILABLE");
    throw new LauncherError("LAUNCHER_PREPARATION");
  }
}

/** Developer runs only (`--open`, `npm run open`): the installed app's launcher opens Coherence itself. */
export async function launchBrowser(dev = false): Promise<void> {
  const { file } = await prepareBrowserLaunch(dev);
  try {
    // Loaded on demand: the `open` package runs PowerShell, and installed builds leave it out (installer Stage 6).
    const { default: open } = await import("open");
    await open(pathToFileURL(file).href);
  } catch {
    throw new LauncherError("BROWSER_LAUNCH");
  }
}

export async function verifyLocalServer(
  capability: string,
  origin: string,
): Promise<void> {
  if (!isLiteralLoopbackOrigin(origin))
    throw new LauncherError("INVALID_TARGET");
  const challenge = randomBytes(32).toString("hex");
  let response: Response;
  try {
    response = await fetch(`${origin}/api/auth/identity`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: { "X-ScreenScribe": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ challenge }),
    });
  } catch {
    throw new LauncherError("SERVER_UNAVAILABLE");
  }
  if (response.status >= 500) throw new LauncherError("SERVER_UNAVAILABLE");
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new LauncherError("VERIFICATION_MISMATCH");
  }
  if (
    !response.ok ||
    !result ||
    typeof result !== "object" ||
    !("proof" in result) ||
    typeof result.proof !== "string" ||
    !equalSecret(result.proof, proof(capability, "identity", challenge))
  )
    throw new LauncherError("VERIFICATION_MISMATCH");
}
