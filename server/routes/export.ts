/**
 * OWNER: server-core builder.
 * Export to trackers: preview one item, run an export job, download CSV.
 */
import express from "express";
import { EXTERNAL_SYSTEM_LABEL } from "@shared/api";
import { BadRequestError } from "../errors";
import { exportCsv } from "../export/csv";
import { previewExport, runExport } from "../export/exporter";
import { startJob } from "../jobs/jobManager";
import { param, parseBody, parseQuery } from "../middleware/validate";
import { getProject } from "../storage/projectStore";
import { getIntegration } from "../storage/settingsStore";
import { queryString, requireModel, sendJobStarted } from "./helpers";
import { exportPreviewQuerySchema, exportRequestSchema } from "./schemas";
import { listExportJournals } from "../export/journal";

export function exportRouter(): express.Router {
  const router = express.Router();
  router.get("/projects/:pid/export/journal", async (req, res) => {
    const pid = param(req, "pid");
    await getProject(pid);
    res.set("Cache-Control", "no-store").json(await listExportJournals(pid));
  });

  router.get("/projects/:pid/export/preview", async (req, res) => {
    const projectId = param(req, "pid");
    const { target, useCaseId } = parseQuery(exportPreviewQuerySchema, req);
    await getProject(projectId);
    await requireModel(projectId, "export");
    res
      .set("Cache-Control", "no-store")
      .json(await previewExport(projectId, target, useCaseId));
  });

  router.post("/projects/:pid/export", async (req, res) => {
    const projectId = param(req, "pid");
    const body = parseBody(exportRequestSchema, req);
    if (!body.dryRun)
      throw new BadRequestError(
        "Live tracker writes are locked in this V2 build. Use payload preview, dry run or CSV. An explicitly authorized integration milestone is required to unlock writes.",
      );
    await getProject(projectId);
    const model = await requireModel(projectId, "export");
    if (!(await getIntegration(body.target))) {
      throw new BadRequestError(
        `${EXTERNAL_SYSTEM_LABEL[body.target]} is not set up yet — add it under Settings → Integrations.`,
      );
    }
    const known = new Set(model.useCases.map((uc) => uc.id));
    const unknown = body.useCaseIds.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new BadRequestError(
        `These use cases no longer exist: ${unknown.join(", ")}. Refresh the page and select again.`,
      );
    }
    const job = await startJob("export", projectId, (ctx) =>
      runExport(ctx, projectId, body),
    );
    sendJobStarted(res, job);
  });

  router.get("/projects/:pid/export/csv", async (req, res) => {
    const projectId = param(req, "pid");
    await getProject(projectId);
    await requireModel(projectId, "CSV export");
    const ids = (queryString(req.query.useCaseIds) ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const { fileName, csv } = await exportCsv(
      projectId,
      ids.length ? ids : undefined,
    );
    res.attachment(fileName);
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.send(csv);
  });

  return router;
}
