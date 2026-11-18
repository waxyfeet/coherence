/**
 * OWNER: server-core builder.
 * "Undo" safety nets for a BA: restore an earlier solution model from history/ (e.g. after a disappointing
 * re-generation) and restore a deleted project from .trash. Both are non-destructive: restoring a model
 * first snapshots the current one, so the restore itself can be undone.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type { Project, SolutionModel } from "@shared/types";
import { paths } from "../config";

import {
  registryEntries,
  verifyEntry,
  transitionProject,
  registryEntry,
  safeWorkspace,
} from "./projectRegistry";
import { withLibraryLock, listAreas } from "./areaStore";
import { BadRequestError, NotFoundError } from "../errors";
import { isNotFound, readJsonIfExists, writeJsonAtomic } from "./fsUtils";
import {
  getProject,
  saveProject,
  snapshotCurrentModel,
  withProjectLock,
} from "./projectStore";

export interface ModelSnapshotInfo {
  /** File name inside history/, e.g. "model-2026-10-14T10-00-00-000Z.json" — used as the id. */
  id: string;
  /** When the snapshot was taken (the model was replaced right after). */
  savedAt: string;
  /** When that model was originally generated / last updated. */
  generatedAt?: string;
  modelUpdatedAt?: string;
  useCaseCount: number;
  featureCount: number;
  screenCount: number;
  sizeBytes: number;
}

export interface TrashedProjectInfo {
  /** Folder name inside .trash, e.g. "acme-orders-2026-10-14T10-00-00-000Z" — used as the id. */
  id: string;
  projectId: string;
  name: string;
  description: string;
  screenCount: number;
  deletedAt: string;
}

const SNAPSHOT_RE =
  /^model-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json$/;

/** Resolve an exact saved entry; never operate on a live folder or follow a trash junction. */
export async function readTrashedProject(trashId: string) {
  {
    const entry = registryEntries("trash").find((e) => e.trashId === trashId);
    if (!entry) throw new NotFoundError("That project is no longer in Trash.");
    const root = verifyEntry(entry);
    const project = await readJsonIfExists<Project>(
      path.join(root, "project.json"),
    );
    if (!project || project.id !== entry.id)
      throw new BadRequestError("The Trash project manifest needs recovery.");
    return { root, project };
  }
}

/** "2026-10-14T10-00-00-000Z" → "2026-10-14T10:00:00.000Z" */
function fromFileTimestamp(ts: string): string {
  return ts.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
}

/** Newest first. */
export async function listModelSnapshots(
  projectId: string,
): Promise<ModelSnapshotInfo[]> {
  await getProject(projectId);
  const dir = paths.historyDir(projectId);
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => SNAPSHOT_RE.test(n));
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const infos: ModelSnapshotInfo[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const [stat, model] = await Promise.all([
        fs.stat(file),
        readJsonIfExists<SolutionModel>(file),
      ]);
      infos.push({
        id: name,
        savedAt: fromFileTimestamp(SNAPSHOT_RE.exec(name)![1]),
        generatedAt: model?.generatedAt,
        modelUpdatedAt: model?.updatedAt,
        useCaseCount: model?.useCases?.length ?? 0,
        featureCount: model?.features?.length ?? 0,
        screenCount: model?.screens?.length ?? 0,
        sizeBytes: stat.size,
      });
    } catch {
      // A damaged snapshot is simply not offered for restore.
    }
  }
  return infos.sort((a, b) => b.id.localeCompare(a.id));
}

/**
 * Replace model.json with a snapshot. The current model is snapshotted first. The .md files are NOT
 * re-rendered here (that could overwrite unsynced BA edits) — the caller offers "Re-render" afterwards.
 */
export async function restoreModelSnapshot(
  projectId: string,
  snapshotId: string,
): Promise<SolutionModel> {
  if (!SNAPSHOT_RE.test(snapshotId))
    throw new NotFoundError(`Model snapshot "${snapshotId}" was not found.`);
  return withProjectLock(projectId, async () => {
    const project = await getProject(projectId);
    const file = path.join(paths.historyDir(projectId), snapshotId);
    let model: SolutionModel | undefined;
    try {
      model = await readJsonIfExists<SolutionModel>(file);
    } catch (err) {
      throw new BadRequestError(
        `Model snapshot "${snapshotId}" is damaged and cannot be restored.`,
      );
    }
    if (!model)
      throw new NotFoundError(`Model snapshot "${snapshotId}" was not found.`);
    if (model.projectId !== projectId || !Array.isArray(model.useCases)) {
      throw new BadRequestError(
        `Model snapshot "${snapshotId}" does not belong to this project.`,
      );
    }
    await snapshotCurrentModel(projectId);
    // ChangeLogKind has no "restored" kind (shared contract), so the restore is not added to the changelog.
    model.updatedAt = new Date().toISOString();
    await writeJsonAtomic(paths.modelFile(projectId), model);
    if (project.status === "draft") {
      project.status = "specified";
      await saveProject(project);
    }
    return model;
  });
}

/** Deleted projects, newest first. */
export async function listTrash(): Promise<TrashedProjectInfo[]> {
  {
    const items: TrashedProjectInfo[] = [];
    for (const entry of registryEntries("trash")) {
      try {
        const { project } = await readTrashedProject(entry.trashId!);
        items.push({
          id: entry.trashId!,
          projectId: entry.id,
          name: project.name,
          description: project.description,
          screenCount: project.screens.length,
          deletedAt: entry
            .trashId!.slice(-24)
            .replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z"),
        });
      } catch {
        items.push({
          id: entry.trashId!,
          projectId: entry.id,
          name: entry.name,
          description:
            "Trash location unavailable. Reconnect the disk before restoring or deleting.",
          screenCount: 0,
          deletedAt: entry.updatedAt,
        });
      }
    }
    return items;
  }
}

/** Moves a trashed project back. @throws ConflictError when a project with the same id exists again. */
export async function restoreFromTrash(trashId: string): Promise<Project> {
  {
    const { project } = await readTrashedProject(trashId);
    return withLibraryLock(() =>
      withProjectLock(project.id, async () => {
        const entry = registryEntry(project.id);
        if (!entry.originalRoot)
          throw new BadRequestError(
            "The original project location is unknown. Recovery is required.",
          );
        safeWorkspace(path.dirname(entry.originalRoot), false);
        await transitionProject(project.id, entry.originalRoot, "active");
        const restored = await getProject(project.id);
        if (
          restored.areaId &&
          !(await listAreas()).some((a) => a.id === restored.areaId)
        ) {
          delete restored.areaId;
          await saveProject(restored);
        }
        return restored;
      }),
    );
  }
}
