import { spawn } from "node:child_process";

import { logHelperTimeout } from "../startupErrors";
import { nativeHelper } from "./nativeHelper";

/**
 * Shows a folder in File Explorer ("Open project folder"). The installed app asks the native helper, which opens only
 * an existing local folder that is not a link. Developer runs keep the `open` package, loaded on demand because it
 * runs PowerShell on Windows and installed builds leave it out (installer Stage 6).
 */
export async function revealFolder(folder: string): Promise<void> {
  const helper = nativeHelper();
  if (!helper) {
    const { default: open } = await import("open");
    await open(folder);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(helper, ["reveal"], {
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill();
      logHelperTimeout("Open folder");
      reject(Error("Windows did not open the folder in time."));
    }, 15000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(Error("Windows could not open the folder."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(Error("Windows could not open the folder."));
    });
    child.stdin.on("error", () => {});
    // The path travels as base64 UTF-8, never as an argument.
    child.stdin.end(Buffer.from(folder, "utf8").toString("base64"));
  });
}
