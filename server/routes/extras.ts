/**
 * OWNER: server-core builder.
 * Server-side nice-to-haves beyond the v1 contract in shared/api.ts (the UI can adopt them later):
 *
 * GET    /api/projects/:pid/history                          → ModelSnapshotInfo[] (newest first)
 * POST   /api/projects/:pid/history/:snapshotId/restore      → SolutionModel  (current model is snapshotted first; 409 while a job runs)
 * GET    /api/trash                                          → TrashedProjectInfo[] (deleted projects, newest first)
 * POST   /api/trash/:trashId/restore                         → Project        (409 if the id is taken again)
 * POST   /api/projects/:pid/reveal-output                    → { ok: true, path }  (opens the output folder in Explorer / Finder)
 */
import fs from "node:fs/promises";
import express from "express";
import { z } from "zod";
import { BadRequestError, errorMessage } from "../errors";
import { revealFolder } from "../platform/revealFolder";
import { param, parseBody } from "../middleware/validate";
import {
  previewTrashDeletion,
  permanentlyDeleteTrashedProject,
} from "../storage/projectLifecycle";
import { getProject } from "../storage/projectStore";
import {
  listModelSnapshots,
  listTrash,
  restoreFromTrash,
  restoreModelSnapshot,
} from "../storage/recovery";
import { assertNoActiveJob } from "./helpers";

export function extrasRouter(): express.Router {
  const router = express.Router();

  router.get("/projects/:pid/history", async (req, res) => {
    res
      .set("Cache-Control", "no-store")
      .json(await listModelSnapshots(param(req, "pid")));
  });

  router.post(
    "/projects/:pid/history/:snapshotId/restore",
    async (req, res) => {
      const projectId = param(req, "pid");
      await getProject(projectId);
      assertNoActiveJob(projectId, "restore an earlier version of the specs");
      res.json(await restoreModelSnapshot(projectId, param(req, "snapshotId")));
    },
  );

  router.get("/trash", async (_req, res) => {
    res.set("Cache-Control", "no-store").json(await listTrash());
  });

  router.post("/trash/:trashId/restore", async (req, res) => {
    res.json(await restoreFromTrash(param(req, "trashId")));
  });
  router.get("/trash/:trashId/deletion-preview", async (req, res) => {
    res
      .set("Cache-Control", "no-store")
      .json(await previewTrashDeletion(param(req, "trashId")));
  });
  router.post("/trash/:trashId/permanent-delete", async (req, res) => {
    const body = parseBody(
      z.object({
        confirmation: z.string().min(1),
        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
      }),
      req,
    );
    await permanentlyDeleteTrashedProject(
      param(req, "trashId"),
      body.confirmation,
      body.expectedRevision,
    );
    res.json({ ok: true });
  });

  router.post("/projects/:pid/reveal-output", async (req, res) => {
    const project = await getProject(param(req, "pid"));
    const stat = await fs.stat(project.outputDir).catch(() => undefined);
    if (!stat?.isDirectory()) {
      throw new BadRequestError(
        "The output folder does not exist yet — generate specs first, then open it.",
      );
    }
    try {
      await revealFolder(project.outputDir);
    } catch (err) {
      throw new BadRequestError(
        `Could not open the folder (${errorMessage(err)}). Its path is ${project.outputDir}`,
      );
    }
    res.json({ ok: true, path: project.outputDir });
  });

  return router;
}
