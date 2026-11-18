import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { regularPath, relativeFile, directoryIdentity } from "./pathSafety";
import {
  withDirectoryGuard,
  removeReviewedPath,
  verifyRegularFile,
} from "./windowsStorageGuard";
import { ConflictError } from "../errors";
import {
  assertNoNestedProjects,
  assertNoNestedProjectPath,
  assertProjectPath,
  assertStandaloneProject,
} from "./projectBoundaries";

export interface InventoryFile {
  path: string;
  bytes: number;
  sha256: string;
  identity: string;
}
export interface TreeInventory {
  files: InventoryFile[];
  directories: { path: string; identity: string }[];
  bytes: number;
  digest: string;
  rootIdentity: string;
}
export async function inventoryTree(root: string): Promise<TreeInventory> {
  assertNoNestedProjects(root);
  const rootIdentity = directoryIdentity(root);
  const files: InventoryFile[] = [];
  const directories: { path: string; identity: string }[] = [];
  const names = new Set<string>();
  let bytes = 0;
  const visit = async (dir: string, rel: string) => {
    if (rel) assertNoNestedProjectPath(root, dir);
    regularPath(dir, false);
    const stat = await fs.lstat(dir, { bigint: true });
    if (!stat.isDirectory())
      throw new ConflictError("A project directory changed during inventory.");
    directories.push({ path: rel, identity: stat.ino.toString() });
    if (directories.length + files.length > 50000)
      throw new ConflictError(
        "This project exceeds the safe inventory limit. No partial inventory will be used.",
      );
    for (const name of (await fs.readdir(dir)).sort()) {
      const file = relativeFile(root, rel ? `${rel}/${name}` : name);
      const key = (rel ? `${rel}/${name}` : name)
        .normalize("NFC")
        .toLowerCase();
      if (names.has(key))
        throw new ConflictError(
          "The project contains case-insensitive or Unicode-normalisation filename collisions.",
        );
      names.add(key);
      const st = await fs.lstat(file, { bigint: true });
      if (st.isDirectory()) await visit(file, rel ? `${rel}/${name}` : name);
      else if (st.isFile() && st.nlink === 1n) {
        if (st.size > 64n * 1024n * 1024n)
          throw new ConflictError(
            "A project file exceeds the safe inventory limit (64 MB). Review it separately; no partial copy was accepted.",
          );
        const data = await verifiedSource(file, st.ino.toString());
        files.push({
          path: rel ? `${rel}/${name}` : name,
          bytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
          identity: st.ino.toString(),
        });
        bytes += data.length;
      } else
        throw new ConflictError(
          "Project inventories refuse links, shared files and special filesystem objects.",
        );
    }
  };
  await withDirectoryGuard(root, () => visit(root, ""));
  if (directoryIdentity(root) !== rootIdentity)
    throw new ConflictError(
      "The project moved during inventory. Retry from its current location.",
    );
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        files: files.map(({ identity: _id, ...f }) => f),
        directories: directories.map((d) => d.path),
      }),
    )
    .digest("hex");
  return { files, directories, bytes, digest, rootIdentity };
}
async function verifiedSource(file: string, identity: string): Promise<Buffer> {
  return withDirectoryGuard(path.dirname(file), async () => {
    regularPath(file, false);
    const handle = await fs.open(file, "r");
    try {
      const before = await handle.stat({ bigint: true });
      await verifyRegularFile(file, before.ino.toString());
      regularPath(file, false);
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.ino.toString() !== identity
      )
        throw new ConflictError(
          "A source file changed identity. Refresh the inventory.",
        );
      const data = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      )
        throw new ConflictError(
          "A file was edited during inventory. Save/close it and retry.",
        );
      return data;
    } finally {
      await handle.close();
    }
  });
}
/** Delete only reviewed identities/content, by native handle. No recursive rm or link following. */
export async function purgeReviewedTree(
  root: string,
  inventory: TreeInventory,
) {
  assertStandaloneProject(root);
  if (
    (await inventoryTree(root)).digest !== inventory.digest ||
    directoryIdentity(root) !== inventory.rootIdentity
  )
    throw new ConflictError(
      "The files changed after deletion review. Review the complete project again.",
    );
  const manifest = inventory.files.find((f) => f.path === "project.json");
  const manifestBytes = manifest
    ? await verifiedSource(relativeFile(root, manifest.path), manifest.identity)
    : undefined;
  try {
    const files = [...inventory.files].sort(
      (a, b) =>
        Number(a.path === "project.json") - Number(b.path === "project.json"),
    );
    for (const file of files) {
      assertProjectPath(root, relativeFile(root, file.path));
      if (directoryIdentity(root) !== inventory.rootIdentity)
        throw new ConflictError("Project ownership changed during deletion.");
      await removeReviewedPath(
        relativeFile(root, file.path),
        file.identity,
        file.sha256,
        false,
      );
    }
    for (const dir of [...inventory.directories].sort(
      (a, b) =>
        b.path.split("/").length - a.path.split("/").length ||
        b.path.localeCompare(a.path),
    )) {
      const target = dir.path ? relativeFile(root, dir.path) : root;
      await removeReviewedPath(target, dir.identity, "", true);
    }
  } catch (error) {
    // A failed irreversible purge can be partial. Keep its identity/recovery record
    // discoverable, without overwriting a new file or recreating a missing root.
    if (manifestBytes && directoryIdentity(root) === inventory.rootIdentity) {
      const file = relativeFile(root, "project.json");
      try {
        await withDirectoryGuard(root, async () => {
          const handle = await fs.open(file, "wx", 0o600);
          try {
            await handle.writeFile(manifestBytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
        });
      } catch (recovery) {
        if ((recovery as NodeJS.ErrnoException).code !== "EEXIST")
          throw new ConflictError(
            "Deletion stopped part-way and its recovery record could not be restored. Keep the remaining Trash folder for manual recovery; no parent folder was removed.",
          );
      }
    }
    throw error;
  }
}
