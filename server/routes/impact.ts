/**
 * OWNER: server-core builder.
 * Impact analysis: instant deterministic preview, AI analysis job, reports, apply job, discard.
 */
import express from "express";
import { BadRequestError } from "../errors";
import { traceImpact } from "../graph/graph";
import {
  discardImpact,
  runApplyImpact,
  runImpactAnalysis,
} from "../graph/impact";
import { startJob } from "../jobs/jobManager";
import { param, parseBody } from "../middleware/validate";
import {
  getImpactReport,
  getProject,
  listImpactReports,
} from "../storage/projectStore";
import {
  assertConnection,
  assertNoActiveJob,
  requireModel,
  sendJobStarted,
} from "./helpers";
import {
  analyseImpactSchema,
  applyImpactSchema,
  previewChangeSchema,
} from "./schemas";

export function impactRouter(): express.Router {
  const router = express.Router();

  router.post("/projects/:pid/impact/preview", async (req, res) => {
    const projectId = param(req, "pid");
    const change = parseBody(previewChangeSchema, req);
    await getProject(projectId);
    const model = await requireModel(projectId, "impact analysis");
    res.json(traceImpact(model, change));
  });

  router.post("/projects/:pid/impact", async (req, res) => {
    const projectId = param(req, "pid");
    const body = parseBody(analyseImpactSchema, req);
    await getProject(projectId);
    await requireModel(projectId, "impact analysis");
    await assertConnection(body.connectionId);
    const job = await startJob("impact-analysis", projectId, (ctx) =>
      runImpactAnalysis(ctx, projectId, body),
    );
    sendJobStarted(res, job);
  });

  router.get("/projects/:pid/impact", async (req, res) => {
    const projectId = param(req, "pid");
    await getProject(projectId);
    res
      .set("Cache-Control", "no-store")
      .json(await listImpactReports(projectId));
  });

  router.get("/projects/:pid/impact/:reportId", async (req, res) => {
    const projectId = param(req, "pid");
    await getProject(projectId);
    res
      .set("Cache-Control", "no-store")
      .json(await getImpactReport(projectId, param(req, "reportId")));
  });

  router.post("/projects/:pid/impact/:reportId/apply", async (req, res) => {
    const projectId = param(req, "pid");
    const reportId = param(req, "reportId");
    const body = parseBody(applyImpactSchema, req);
    await getProject(projectId);
    const report = await getImpactReport(projectId, reportId);
    if (report.status === "discarded")
      throw new BadRequestError(
        "This impact report was discarded — run a new analysis to apply changes.",
      );
    await requireModel(projectId, "applying an impact report");
    await assertConnection(body.connectionId);
    const job = await startJob("impact-apply", projectId, (ctx) =>
      runApplyImpact(ctx, projectId, reportId, body),
    );
    sendJobStarted(res, job);
  });

  router.post("/projects/:pid/impact/:reportId/discard", async (req, res) => {
    const projectId = param(req, "pid");
    const reportId = param(req, "reportId");
    await getProject(projectId);
    await getImpactReport(projectId, reportId);
    assertNoActiveJob(projectId, "discard an impact report");
    res.json(await discardImpact(projectId, reportId));
  });

  return router;
}
