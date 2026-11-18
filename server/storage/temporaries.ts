/**
 * Orphaned atomic-write temporaries (installer finding ST-14). Every durable write goes to `<file>.tmp-<hex>` and is
 * renamed over the target; a crash or forced stop between the two leaves the temporary behind, where inventories and
 * purges would sweep it up as if it were content. At start-up, while this process holds the profile and project locks,
 * no writer can still own one, so each is removed — by the storage guard, and only if its identity and content are
 * still exactly what was inspected.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { removeReviewedPath } from "./windowsStorageGuard";

/** `fsUtils.writeFileAtomic` uses 12 hex characters, the storage guard's queued writes a 32-character GUID. */
const ORPHAN = /^.+\.tmp-(?:[0-9a-f]{12}|[0-9a-f]{32})$/;
const LIMIT = 64 * 1024 * 1024;

/** Removes orphaned temporaries directly inside `folder` (not below it). Returns how many were removed. */
export async function removeOrphanedTemporaries(
  folder: string,
): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(folder);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!ORPHAN.test(name)) continue;
    const file = path.join(folder, name);
    try {
      const stat = await fs.lstat(file, { bigint: true });
      // Links, shared (hard-linked) files and folders are never touched.
      if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(LIMIT))
        continue;
      const sha256 = createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex");
      await removeReviewedPath(file, stat.ino.toString(), sha256, false);
      removed++;
    } catch {
      // Changed, locked or already gone: leave it for a later start.
    }
  }
  return removed;
}
