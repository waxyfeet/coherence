/**
 * Library maintenance for profile loss and restores (installer finding ST-09, decision D12, report §5.4 point 5):
 * find Coherence projects in a folder (including its Coherence Trash), remove a project whose folder is gone from the
 * library without touching any files, and export a complete project as one .zip backup.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FoundProject } from "@shared/storage";
import { ConflictError, HttpError } from "../errors";
import { regularPath, pathKey } from "./pathSafety";
import {
  forgetRegistryProject,
  projectUnavailable,
  readPortableManifest,
  registeredProjectRoot,
  registryEntries,
  registryEntry,
} from "./projectRegistry";
import { withProjectNamespace } from "./projectNamespace";
import { inventoryTree } from "./inventory";
import { zip } from "./zip";

const TRASH = ".coherence-trash";
const MAX_CANDIDATES = 500;
/** One file is fine for a normal project; beyond this, copying the folder is the better backup. */
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

/** Project folders directly inside `folder` and inside its Coherence Trash. Reads only; changes nothing. */
export async function findProjects(folder: string): Promise<FoundProject[]> {
  regularPath(folder, false);
  if (!fs.statSync(folder).isDirectory())
    throw new ConflictError("Choose a folder to search.");
  const candidates: { dir: string; inTrash: boolean }[] = [];
  const list = async (dir: string, inTrash: boolean) => {
    let names: fs.Dirent[];
    try {
      names = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of names)
      if (item.isDirectory() && item.name !== TRASH)
        candidates.push({ dir: path.join(dir, item.name), inTrash });
  };
  await list(folder, false);
  await list(path.join(folder, TRASH), true);
  const registered = registryEntries();
  const found: FoundProject[] = [];
  for (const { dir, inTrash } of candidates.slice(0, MAX_CANDIDATES)) {
    if (!fs.existsSync(path.join(dir, "project.json"))) continue;
    try {
      regularPath(dir, false);
      const manifest = readPortableManifest(dir);
      const entry = registered.find((e) => e.id === manifest.id);
      found.push({
        path: dir,
        id: manifest.id,
        name: manifest.name,
        updatedAt: manifest.updatedAt,
        inTrash,
        library: !entry
          ? "absent"
          : pathKey(entry.root) === pathKey(dir)
            ? "here"
            : "elsewhere",
      });
    } catch (error) {
      // Not a complete Coherence project (or one from a newer version): say so instead of hiding it.
      found.push({
        path: dir,
        name: path.basename(dir),
        inTrash,
        library: "absent",
        problem:
          error instanceof HttpError
            ? error.message
            : "This folder's project.json could not be read.",
      });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Only for a project whose folder is gone or unusable: the library forgets it; no file is touched. */
export async function removeFromLibrary(id: string): Promise<void> {
  await withProjectNamespace(async () => {
    const entry = registryEntry(id);
    if (entry.state !== "active" || entry.transition)
      throw new ConflictError(
        "This project is in Trash or being moved. Manage it from Trash instead.",
      );
    if (projectUnavailable(id) === undefined)
      throw new ConflictError(
        "This project's folder is available. Use Move to trash to remove it; Remove from library is for folders that are gone.",
      );
    await forgetRegistryProject(id);
  });
}

/** The complete project folder as one .zip, minus the regenerable analysis cache. Verified file by file. */
export async function projectArchive(
  id: string,
): Promise<{ name: string; data: Buffer }> {
  const root = registeredProjectRoot(id);
  const folder = path.basename(root);
  const inventory = await inventoryTree(root);
  const files = inventory.files.filter(
    (file) =>
      file.path !== "analysis-cache" &&
      !file.path.startsWith("analysis-cache/"),
  );
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total > MAX_ARCHIVE_BYTES)
    throw new HttpError(
      413,
      "This project is too large to export as one file. Copy its folder instead; nothing was changed.",
      "ARCHIVE_TOO_LARGE",
    );
  const entries = [];
  for (const file of files) {
    const full = path.join(root, ...file.path.split("/"));
    const data = await fsp.readFile(full);
    // The bytes must still be what the inventory verified: a file that changed meanwhile fails the export.
    if (createHash("sha256").update(data).digest("hex") !== file.sha256)
      throw new ConflictError(
        "The project changed while it was being exported. Try again.",
      );
    entries.push({
      path: `${folder}/${file.path}`,
      data,
      modified: (await fsp.stat(full)).mtime,
    });
  }
  return { name: `${folder}.zip`, data: zip(entries) };
}
