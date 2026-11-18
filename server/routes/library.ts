import express from "express";
import { z } from "zod";
import { param, parseBody } from "../middleware/validate";
import {
  listAreas,
  saveArea,
  removeArea,
  withLibraryLock,
} from "../storage/areaStore";
import {
  duplicateProject,
  previewProjectDeletion,
  permanentlyDeleteProject,
  moveProjectToTrash,
} from "../storage/projectLifecycle";
import { listProjects } from "../storage/projectStore";
import { withProjectMaintenance } from "../jobs/jobManager";
const areaSchema = z.object({ name: z.string().max(200) });
const duplicateSchema = z.object({ name: z.string().max(200).optional() });
const deletionSchema = z.object({
  confirmation: z.string().min(1),
  expectedUpdatedAt: z.string().min(1),
});
export function libraryRouter(): express.Router {
  const router = express.Router();
  router.get("/areas", async (_req, res) => res.json(await listAreas()));
  router.post("/areas", async (req, res) =>
    res.status(201).json(await saveArea(parseBody(areaSchema, req).name)),
  );
  router.patch("/areas/:aid", async (req, res) =>
    res.json(
      await saveArea(parseBody(areaSchema, req).name, param(req, "aid")),
    ),
  );
  router.delete("/areas/:aid", async (req, res) => {
    const id = param(req, "aid");
    await withLibraryLock(async () => {
      const members = (await listProjects()).filter((p) => p.areaId === id);
      const reserve = (i: number): Promise<void> =>
        i < members.length
          ? withProjectMaintenance(members[i].id, () => reserve(i + 1))
          : removeArea(id);
      await reserve(0);
    });
    res.json({ ok: true });
  });
  router.post("/projects/:pid/duplicate", async (req, res) =>
    res
      .status(201)
      .json(
        await duplicateProject(
          param(req, "pid"),
          parseBody(duplicateSchema, req).name,
        ),
      ),
  );
  router.get("/projects/:pid/deletion-preview", async (req, res) =>
    res
      .set("Cache-Control", "no-store")
      .json(await previewProjectDeletion(param(req, "pid"))),
  );
  router.post("/projects/:pid/permanent-delete", async (req, res) => {
    const body = parseBody(deletionSchema, req);
    await permanentlyDeleteProject(
      param(req, "pid"),
      body.confirmation,
      body.expectedUpdatedAt,
    );
    res.json({ ok: true });
  });
  router.post("/projects/:pid/trash", async (req, res) => {
    const body = parseBody(deletionSchema, req);
    await moveProjectToTrash(
      param(req, "pid"),
      body.confirmation,
      body.expectedUpdatedAt,
    );
    res.json({ ok: true });
  });
  return router;
}
