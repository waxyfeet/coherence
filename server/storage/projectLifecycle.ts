import fs from "node:fs/promises";
import { assertStandaloneProject } from "./projectBoundaries";
import path from "node:path";
import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import type {
  Project,
  ProjectDeletionPreview,
  TrashDeletionPreview,
} from "@shared/types";
import { paths } from "../config";
import { BadRequestError, ConflictError } from "../errors";
import { forgetProjectJobs, withProjectMaintenance } from "../jobs/jobManager";
import { assertV2Path } from "./boundary";
import {
  forgetRegistryProject,
  releaseProjectPins,
  restoreProjectPins,
} from "./projectRegistry";
import {
  inventoryTree,
  purgeReviewedTree,
  type TreeInventory,
} from "./inventory";
import { readOwnedFile, writeFileAtomic } from "./fsUtils";

async function lifecycleInventory(root: string) {
  return inventoryTree(root);
}

import { assertArea, withLibraryLock, listAreas } from "./areaStore";

import { readTrashedProject } from "./recovery";
import {
  createProject,
  deleteProject,
  getProject,
  loadModel,
  screenImagePath,
  withProjectLock,
} from "./projectStore";

/** Refuse junctions even when they point elsewhere inside V2. Never follow links when copying/deleting. */
async function validateTree(root: string): Promise<void> {
  assertV2Path(root);
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink())
    throw new BadRequestError(
      "Project operations refuse symbolic links or junctions. Remove the link and retry.",
    );
  if (stat.isDirectory())
    for (const name of await fs.readdir(root))
      await validateTree(path.join(root, name));
}
function privateRoot(projectId: string): string {
  const root = assertV2Path(paths.projectDir(projectId));
  return root;
}

export async function duplicateProject(
  projectId: string,
  name?: string,
): Promise<Project> {
  return withProjectMaintenance(projectId, () =>
    withLibraryLock(() =>
      withProjectLock(projectId, async () => {
        const source = await getProject(projectId);
        assertStandaloneProject(privateRoot(projectId));
        if (
          source.id !== projectId ||
          (await fs.lstat(privateRoot(projectId))).isSymbolicLink() ||
          (
            await fs.lstat(paths.screensDir(projectId)).catch(() => null)
          )?.isSymbolicLink()
        )
          throw new BadRequestError(
            "The project or screenshot directory is not a regular owned directory.",
          );
        const areaId =
          source.areaId &&
          !(await listAreas()).some((a) => a.id === source.areaId)
            ? undefined
            : source.areaId;
        await assertArea(areaId);
        // Older projects kept run choices only alongside the generated model. Copy configuration alone.
        const preferences =
          source.generationPreferences ??
          (await loadModel(source.id).catch(() => null))?.options;
        // Validate every referenced image before creating a destination. Only screenshot files are copied.
        for (const screen of source.screens) {
          if (!/^[A-Za-z0-9_-]{1,100}$/.test(screen.id))
            throw new BadRequestError("Invalid screenshot identifier.");
          if (
            screen.fileName !==
              `${screen.id}/${path.basename(screen.fileName)}` ||
            !/^v\d+\.(png|jpe?g|webp|gif)$/i.test(
              path.basename(screen.fileName),
            )
          )
            throw new BadRequestError("Invalid screenshot version path.");
          await validateTree(path.join(paths.screensDir(source.id), screen.id));
          await fs.access(screenImagePath(source.id, screen));
        }
        return createProject(
          {
            name: name ?? `${source.name.slice(0, 113)} (copy)`,
            description: source.description,
            additionalContext: source.additionalContext,
            formatId: source.formatId,
            areaId,
            localOnly: source.localOnly,
            ...{ workspaceDir: path.dirname(paths.projectDir(source.id)) },
          },
          async (copy) => {
            copy.description = source.description;
            copy.additionalContext = source.additionalContext;
            copy.llm = { ...source.llm };
            if (preferences) copy.generationPreferences = { ...preferences };
            for (const screen of source.screens) {
              const id = `scr_${nanoid(10).replace(/-/g, "_")}`;
              const target = path.join(paths.screensDir(copy.id), id);
              await fs.mkdir(target, { recursive: true });
              for (const file of await fs.readdir(
                path.join(paths.screensDir(source.id), screen.id),
              )) {
                if (!/^v\d+\.(png|jpe?g|webp|gif)$/i.test(file)) continue;
                const from = path.join(
                  paths.screensDir(source.id),
                  screen.id,
                  file,
                );
                if (!(await fs.lstat(from)).isFile())
                  throw new BadRequestError(
                    "Screenshot versions must be regular image files.",
                  );
                await writeFileAtomic(
                  path.join(target, file),
                  await readOwnedFile(from),
                );
              }
              const { analysedVersion: _analysis, ...metadata } = screen;
              copy.screens.push({
                ...metadata,
                id,
                fileName: `${id}/${path.basename(screen.fileName)}`,
              });
            }
            // A fresh managed output directory is intentional: never inherit another project's write destination.
          },
        );
      }),
    ),
  );
}

async function deletionPlan(
  project: Project,
  root = privateRoot(project.id),
): Promise<ProjectDeletionPreview> {
  assertStandaloneProject(root);
  {
    await inventoryTree(root);
    return {
      projectId: project.id,
      name: project.name,
      updatedAt: project.updatedAt,
      paths: [root],
    };
  }
}

/** Reuse the existing reversible folder move, while reserving the project against new work. */
export async function moveProjectToTrash(
  projectId: string,
  confirmation: string,
  expectedUpdatedAt: string,
): Promise<void> {
  if (confirmation !== projectId)
    throw new BadRequestError(
      "Confirm the exact project before moving it to trash.",
    );
  return withProjectMaintenance(projectId, () =>
    withLibraryLock(() =>
      withProjectLock(projectId, async () => {
        const project = await getProject(projectId);
        if (project.id !== projectId)
          throw new BadRequestError(
            "The stored project identity does not match its folder.",
          );
        if (project.updatedAt !== expectedUpdatedAt)
          throw new ConflictError(
            "The project changed. Close the dialog and review moving it to trash again.",
          );
        await deletionPlan(project);
        // Move the complete owned project; never act on unrelated folders.
        await deleteProject(projectId);
        // Persisted history moved intact. Do not attach old in-memory jobs to a newly reused live ID.
        forgetProjectJobs(projectId);
      }),
    ),
  );
}

async function trashDeletionPlan(
  trashId: string,
): Promise<TrashDeletionPreview & { inventory?: TreeInventory }> {
  const { root, project } = await readTrashedProject(trashId);
  const plan = await deletionPlan(project, root);
  const inventory =
    process.platform === "win32" ? await lifecycleInventory(root) : undefined;
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        trashId,
        project,
        paths: plan.paths,
        ...(inventory ? { inventory: inventory.digest } : {}),
      }),
    )
    .digest("hex");
  return { ...plan, trashId, revision, ...(inventory ? { inventory } : {}) };
}

export async function previewTrashDeletion(
  trashId: string,
): Promise<TrashDeletionPreview> {
  return withLibraryLock(() => trashDeletionPlan(trashId));
}

export async function permanentlyDeleteTrashedProject(
  trashId: string,
  confirmation: string,
  expectedRevision: string,
): Promise<void> {
  if (confirmation !== trashId)
    throw new BadRequestError(
      "Confirm the exact trash entry before deleting permanently.",
    );
  const { project } = await readTrashedProject(trashId);
  return withProjectMaintenance(project.id, () =>
    withLibraryLock(() =>
      withProjectLock(project.id, async () => {
        const plan = await trashDeletionPlan(trashId);
        if (plan.revision !== expectedRevision)
          throw new ConflictError(
            "The saved project changed. Go back and review permanent deletion again.",
          );
        const { root } = await readTrashedProject(trashId);
        {
          await releaseProjectPins(project.id);
          try {
            await purgeReviewedTree(root, plan.inventory!);
          } catch (error) {
            await restoreProjectPins(project.id).catch(() => {});
            throw error;
          }
          await forgetRegistryProject(project.id);
          forgetProjectJobs(project.id);
          return;
        }
      }),
    ),
  );
}
export async function previewProjectDeletion(
  projectId: string,
): Promise<ProjectDeletionPreview> {
  return withLibraryLock(() =>
    withProjectLock(projectId, async () => {
      const project = await getProject(projectId);
      if (project.id !== projectId)
        throw new BadRequestError(
          "The stored project identity does not match its folder.",
        );
      return deletionPlan(project);
    }),
  );
}
export async function permanentlyDeleteProject(
  projectId: string,
  confirmation: string,
  expectedUpdatedAt: string,
): Promise<void> {
  throw new BadRequestError(
    "Move this complete project to Trash first, then review permanent deletion there.",
  );
}
