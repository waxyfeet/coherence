import { readOwnedFile } from "../storage/fsUtils";
/**
 * OWNER: server-core builder.
 * Projects, screens (upload / edit / reorder / replace / delete / image bytes / re-analyse) and Figma import.
 */

import path from "node:path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { BadRequestError, NotFoundError } from "../errors";

import { runScreenReanalysis } from "../graph/impact";
import {
  exportFigmaFrames,
  listFigmaFrames,
  figmaThumbnail,
} from "../importers/figma";
import { runFigmaImport } from "../importers/figmaImport";
import { getFormat } from "../formats/registry";
import { startJob } from "../jobs/jobManager";
import {
  uploadScreens,
  uploadSingleScreen,
  uploadedFile,
  uploadedFiles,
} from "../middleware/upload";
import { param, parseBody } from "../middleware/validate";
import { createDemoProject } from "../storage/demo";
import { isNotFound } from "../storage/fsUtils";
import { EXT_TO_MIME } from "../storage/imageInfo";
import {
  addScreens,
  createProject,
  deleteScreen,
  getProject,
  listProjects,
  reorderScreens,
  replaceScreenImage,
  screenImagePath,
  updateProject,
  updateScreen,
} from "../storage/projectStore";
import { getFigmaToken } from "../storage/settingsStore";
import { assertArea, withLibraryLock } from "../storage/areaStore";
import {
  assertConnection,
  assertNoActiveJob,
  getProjectDetail,
  queryString,
  requireModel,
  sendJobStarted,
} from "./helpers";
import {
  createProjectSchema,
  figmaFramesSchema,
  figmaImportSchema,
  reanalyseScreenSchema,
  reorderScreensSchema,
  updateProjectSchema,
  updateScreenSchema,
} from "./schemas";

/** How long DELETE waits for a cancelled job to stop writing before moving the folder. */

/** Screens must not change under a running generation / re-analysis (it would record the wrong analysedVersion). */
function assertScreensEditable(projectId: string): void {
  assertNoActiveJob(projectId, "change the screens", [
    "generate",
    "screen-reanalysis",
    "figma-import",
  ]);
}

/** Runs before multer, so a missing project or a running generation is reported before a big upload is buffered. */
async function screenUploadPrecheck(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const bytes = Number(req.headers["content-length"]);
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new BadRequestError(
      "Screenshot uploads require a known Content-Length. Upload files from the browser or send a fixed-length multipart body.",
    );
  if (bytes > 100 * 1024 * 1024)
    throw new BadRequestError(
      "This upload exceeds the 100 MB total request limit. Send fewer screenshots at a time.",
    );
  const projectId = param(req, "pid");
  await getProject(projectId);
  assertScreensEditable(projectId);
  next();
}

async function figmaToken(): Promise<string> {
  const token = await getFigmaToken();
  if (!token)
    throw new BadRequestError(
      "Add a Figma token in Settings to import frames from Figma.",
    );
  return token;
}

export function projectsRouter(): express.Router {
  const router = express.Router();

  /* ── Projects ── */

  router.get("/projects", async (_req, res) => {
    res.json(await listProjects());
  });

  router.post("/projects", async (req, res) => {
    const body = parseBody(createProjectSchema, req);
    if (body.formatId) getFormat(body.formatId);
    res.status(201).json(
      await withLibraryLock(async () => {
        await assertArea(body.areaId);
        return createProject(body);
      }),
    );
  });

  router.post("/projects/demo", async (_req, res) => {
    res.status(201).json(await createDemoProject());
  });

  router.get("/projects/:pid", async (req, res) => {
    res.json(await getProjectDetail(param(req, "pid")));
  });

  router.patch("/projects/:pid", async (req, res) => {
    const projectId = param(req, "pid");
    assertNoActiveJob(projectId, "edit the project brief or model choices", [
      "generate",
      "screen-reanalysis",
      "revise",
      "impact-apply",
    ]);
    const body = parseBody(updateProjectSchema, req);
    if (body.localOnly !== undefined)
      assertNoActiveJob(projectId, "change the AI data policy");
    if (body.formatId) getFormat(body.formatId);
    if (body.llm?.visionConnectionId)
      await assertConnection(body.llm.visionConnectionId, "screen-reading");
    if (body.llm?.textConnectionId)
      await assertConnection(body.llm.textConnectionId, "spec-writing");
    res.json(
      await withLibraryLock(async () => {
        await assertArea(body.areaId);
        return updateProject(projectId, body);
      }),
    );
  });

  router.delete("/projects/:pid", async (req, res) => {
    throw new BadRequestError(
      "Use the confirmed Move to Trash action for a portable project.",
    );
  });

  /* ── Screens ── */

  router.post(
    "/projects/:pid/screens",
    screenUploadPrecheck,
    uploadScreens,
    async (req, res) => {
      res
        .status(201)
        .json(await addScreens(param(req, "pid"), uploadedFiles(req)));
    },
  );

  router.put("/projects/:pid/screens-order", async (req, res) => {
    assertScreensEditable(param(req, "pid"));
    const { screenIds } = parseBody(reorderScreensSchema, req);
    res.json(await reorderScreens(param(req, "pid"), screenIds));
  });

  router.patch("/projects/:pid/screens/:sid", async (req, res) => {
    assertScreensEditable(param(req, "pid"));
    const body = parseBody(updateScreenSchema, req);
    res.json(await updateScreen(param(req, "pid"), param(req, "sid"), body));
  });

  router.put(
    "/projects/:pid/screens/:sid/image",
    screenUploadPrecheck,
    uploadSingleScreen,
    async (req, res) => {
      res.json(
        await replaceScreenImage(
          param(req, "pid"),
          param(req, "sid"),
          uploadedFile(req),
        ),
      );
    },
  );

  router.delete("/projects/:pid/screens/:sid", async (req, res) => {
    const projectId = param(req, "pid");
    assertScreensEditable(projectId);
    await deleteScreen(projectId, param(req, "sid"));
    res.json({ ok: true });
  });

  router.get("/projects/:pid/screens/:sid/image", async (req, res) => {
    const projectId = param(req, "pid");
    const screenId = param(req, "sid");
    const project = await getProject(projectId);
    const screen = project.screens.find((s) => s.id === screenId);
    if (!screen)
      throw new NotFoundError(
        "That screen was not found — it may have been deleted.",
      );

    const rawVersion = queryString(req.query.version);
    let version: number | undefined;
    if (rawVersion !== undefined && rawVersion !== "") {
      version = Number(rawVersion);
      if (
        !Number.isInteger(version) ||
        version < 1 ||
        version > screen.version
      ) {
        throw new NotFoundError(
          `Version ${rawVersion} of screen "${screen.name}" does not exist.`,
        );
      }
    }
    const file = screenImagePath(projectId, screen, version);
    let buffer: Buffer;
    try {
      buffer = await readOwnedFile(file);
    } catch (err) {
      if (isNotFound(err))
        throw new NotFoundError(
          `The image file of screen "${screen.name}" is missing on disk.`,
        );
      throw err;
    }
    const ext = path.extname(file).slice(1).toLowerCase();
    res.set({
      "Content-Type": EXT_TO_MIME[ext] ?? screen.mimeType,
      // Versioned bytes remain private and must be authenticated on every HTTP read.
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    res.send(buffer);
  });

  router.post("/projects/:pid/screens/:sid/reanalyse", async (req, res) => {
    const projectId = param(req, "pid");
    const screenId = param(req, "sid");
    const body = parseBody(reanalyseScreenSchema, req);
    const project = await getProject(projectId);
    if (!project.screens.some((s) => s.id === screenId))
      throw new NotFoundError(
        "That screen was not found — it may have been deleted.",
      );
    await requireModel(projectId, "impact analysis of a changed screen");
    await assertConnection(body.connectionId);
    const job = await startJob("screen-reanalysis", projectId, (ctx) =>
      runScreenReanalysis(ctx, projectId, screenId, body),
    );
    sendJobStarted(res, job);
  });

  /* ── Figma import ── */

  router.get("/figma/thumbnail/:fileKey/:nodeId", async (req, res) => {
    const buffer = await figmaThumbnail(
      await figmaToken(),
      param(req, "fileKey"),
      param(req, "nodeId"),
    );
    res
      .set({
        "Cache-Control": "no-store",
        "Content-Type": "image/png",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      })
      .send(buffer);
  });

  router.post("/projects/:pid/figma/frames", async (req, res) => {
    await getProject(param(req, "pid"));
    const { fileUrl } = parseBody(figmaFramesSchema, req);
    res.json(await listFigmaFrames(await figmaToken(), fileUrl));
  });

  router.post("/projects/:pid/figma/import", async (req, res) => {
    const projectId = param(req, "pid");
    await getProject(projectId);
    assertScreensEditable(projectId);
    const body = parseBody(figmaImportSchema, req);
    const images = await exportFigmaFrames(
      await figmaToken(),
      body.fileUrl,
      body.frameIds,
      body.scale ?? 2,
    );
    res.status(201).json(await addScreens(projectId, images));
  });

  router.post("/projects/:pid/figma/import-job", async (req, res) => {
    const projectId = param(req, "pid");
    await getProject(projectId);
    const body = parseBody(figmaImportSchema, req);
    const token = await figmaToken();
    const job = await startJob("figma-import", projectId, (ctx) =>
      runFigmaImport(ctx, projectId, token, body),
    );
    sendJobStarted(res, job);
  });

  return router;
}
