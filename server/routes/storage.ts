import express from "express";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import { parseBody, param } from "../middleware/validate";
import { BadRequestError, ConflictError } from "../errors";
import {
  workspaceSettings,
  changeWorkspace,
  openProjectFolder,
} from "../storage/projectRegistry";
import { getProject, withProjectLock } from "../storage/projectStore";
import {
  findProjects,
  projectArchive,
  removeFromLibrary,
} from "../storage/projectLibrary";
import { withLibraryLock } from "../storage/areaStore";
import { windowsFolderDialog } from "../platform/outputFolder";
import { revealFolder } from "../platform/revealFolder";
import { regularPath } from "../storage/pathSafety";

const absolutePath = z
  .string()
  .min(1)
  .max(4000)
  .refine(
    (value) =>
      path.isAbsolute(value) &&
      !value.includes("\0") &&
      !value.split(/[\\/]/).includes(".."),
  );
let choosing = false;
export function storageRouter() {
  const router = express.Router();
  router.get("/storage", async (_req, res) =>
    res.set("Cache-Control", "no-store").json(await workspaceSettings()),
  );
  router.put("/storage/workspace", async (req, res) => {
    const body = parseBody(z.object({ path: absolutePath }), req);
    res.json(await withLibraryLock(() => changeWorkspace(body.path)));
  });
  router.post("/storage/choose-folder", async (req, res) => {
    const body = parseBody(
      z.object({
        purpose: z.enum(["workspace", "project"]),
        initialPath: z.string().max(4000).optional(),
      }),
      req,
    );
    if (process.platform !== "win32")
      throw new BadRequestError("The native folder chooser requires Windows.");
    if (choosing)
      throw new ConflictError(
        "Finish or cancel the current folder chooser first.",
      );
    choosing = true;
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", cancel);
    try {
      let initial = body.initialPath || (await workspaceSettings()).workspace;
      try {
        regularPath(initial);
      } catch {
        initial = path.dirname((await workspaceSettings()).globalData);
      }
      while (!(await fs.stat(initial).catch(() => undefined))?.isDirectory()) {
        const parent = path.dirname(initial);
        if (parent === initial)
          throw new BadRequestError("Choose an available local drive.");
        initial = parent;
      }
      const descriptions = {
        workspace: "Choose the parent folder for Coherence projects",
        project: "Choose a complete Coherence project folder",
      };
      const selected = await windowsFolderDialog(
        initial,
        controller.signal,
        descriptions[body.purpose],
      );
      if (!controller.signal.aborted)
        res.set("Cache-Control", "no-store").json({
          path:
            selected === null
              ? null
              : regularPath(await fs.realpath(selected), false),
        });
    } finally {
      choosing = false;
      res.removeListener("close", cancel);
    }
  });
  router.post("/storage/open", async (req, res) => {
    const body = parseBody(
      z.object({
        path: absolutePath,
        expectedId: z.string().max(100).optional(),
      }),
      req,
    );
    const project = await withLibraryLock(() =>
      openProjectFolder(body.path, body.expectedId),
    );
    res.json(await getProject(project.id));
  });
  // Library maintenance (installer finding ST-09, decision D12).
  router.post("/storage/find", async (req, res) => {
    const body = parseBody(z.object({ path: absolutePath }), req);
    res.json(await findProjects(body.path));
  });
  router.post("/storage/forget/:pid", async (req, res) => {
    const pid = param(req, "pid");
    await withLibraryLock(() => removeFromLibrary(pid));
    res.json({ ok: true });
  });
  router.get("/storage/archive/:pid", async (req, res) => {
    const pid = param(req, "pid");
    const archive = await withProjectLock(pid, () => projectArchive(pid));
    res
      .set({
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${archive.name.replace(/[^A-Za-z0-9._-]/g, "-")}"`,
        "Cache-Control": "no-store",
      })
      .send(archive.data);
  });
  router.post("/storage/reveal/:pid", async (req, res) => {
    const p = await getProject(param(req, "pid"));
    if (!p.projectPath)
      throw new BadRequestError(
        "This project folder is unavailable. Reconnect its complete project folder before continuing.",
      );
    regularPath(p.projectPath, false);
    await revealFolder(p.projectPath);
    res.json({ ok: true });
  });
  return router;
}
