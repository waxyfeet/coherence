import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { useTempDataDir, removeDir } from "../storage/testUtils";

// Windows profile names are often not ASCII; the data folder sits under the profile (installer review SEC-02).
let dir: string;
beforeAll(async () => {
  dir = await useTempDataDir("José-日本");
  vi.resetModules();
});
afterAll(async () => {
  await removeDir(dir);
});

it.runIf(process.platform === "win32")(
  "protects the launcher folder when the data folder path is not ASCII",
  async () => {
    const launcher = await import("./localLauncher");
    const claim = await (
      await import("../storage/instanceLock")
    ).acquireInstanceLock();
    try {
      await expect(launcher.prepareLaunchDirectory(claim)).resolves.toEqual(
        expect.any(Function),
      );
      const acl = execFileSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          '$a = Get-Acl -LiteralPath $env:COHERENCE_TEST_DIR; "$($a.AreAccessRulesProtected)|$($a.Access.Count)"',
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          env: {
            ...process.env,
            COHERENCE_TEST_DIR: path.join(dir, ".local-auth"),
          },
        },
      ).trim();
      expect(acl).toBe("True|1");
    } finally {
      await claim();
    }
  },
);
