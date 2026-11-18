/**
 * The packaged app checks its own files before serving (installer report RT-03). A partial or damaged install, or a
 * build whose resource root moved, is refused with INSTALL_DAMAGED instead of serving the "not built" page or failing
 * later when the demo opens. Developer runs skip it: there the UI is built on demand.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { SAMPLE_SCREENS } from "../agents/mock/sampleScreens";
import { HELPER_FILE } from "../platform/nativeHelper";
import { StartupError } from "../startupErrors";

export async function checkInstallation(root: string): Promise<void> {
  const damaged: string[] = [];
  const index = await fs
    .stat(path.join(root, "dist", "index.html"))
    .catch(() => undefined);
  if (!index?.isFile() || index.size === 0) damaged.push("dist/index.html");
  // Every guarded file operation needs the native helper (installer Stage 6); without it nothing could be saved.
  if (process.platform === "win32") {
    const helper = await fs
      .stat(path.join(root, HELPER_FILE))
      .catch(() => undefined);
    if (!helper?.isFile() || helper.size === 0) damaged.push(HELPER_FILE);
  }
  for (const sample of SAMPLE_SCREENS) {
    const relative = `samples/screens/${sample.file}`;
    const bytes = await fs
      .readFile(path.join(root, relative))
      .catch(() => undefined);
    if (
      !bytes ||
      createHash("sha256").update(bytes).digest("hex") !== sample.sha256
    )
      damaged.push(relative);
  }
  if (!damaged.length) return;
  // Install-relative names only: no user paths reach the log.
  console.error(`[install-check] missing or altered: ${damaged.join(", ")}`);
  throw new StartupError(
    "INSTALL_DAMAGED",
    "Some of Coherence's program files are missing or damaged. Reinstall Coherence; your projects and settings are kept.",
  );
}
