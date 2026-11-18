/**
 * Runs the platform-dependent suites against CoherencePlatform.exe instead of PowerShell (installer Stage 6): the
 * storage guard, saved keys, Known Folders, launcher folder, jobs and lifecycle tests, so both implementations stay
 * covered while both exist. Build the helper first: node packaging/build-launcher.mjs
 * Usage: node scripts/test-platform-helper.mjs [extra vitest arguments]
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(ROOT, "build", "helper", "CoherencePlatform.exe");
if (!fs.existsSync(helper)) {
  console.error(
    "test-platform-helper: build/helper/CoherencePlatform.exe is missing. Run node packaging/build-launcher.mjs first.",
  );
  process.exit(1);
}
const result = spawnSync(
  process.execPath,
  [
    path.join(ROOT, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "server/storage",
    "server/security",
    "server/platform",
    "server/jobs",
    "server/lifecycle",
    ...process.argv.slice(2),
  ],
  {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, SCREENSCRIBE_V2_PLATFORM_HELPER: helper },
  },
);
process.exit(result.status ?? 1);
