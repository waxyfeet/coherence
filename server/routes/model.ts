/**
 * OWNER: server-core builder.
 * Solution model & knowledge graph: GET /model, GET /graph, use case status, "Revise with AI".
 */
import express from "express";
import { z } from "zod";
import type { SolutionGraph } from "@shared/types";
import { runReviseUseCase } from "../agents/revise";
import { NotFoundError } from "../errors";
import { buildGraph } from "../graph/graph";
import { startJob, activeJobFor } from "../jobs/jobManager";
import { param, parseBody } from "../middleware/validate";
import { getProject, loadModel } from "../storage/projectStore";
import { setUseCaseStatus, syncFromDisk } from "../specs/specStore";
import {
  applyRevisionProposal,
  reviewRevisionProposal,
  discardRevisionProposal,
} from "../specs/revisionProposals";
import {
  assertConnection,
  assertNoActiveJob,
  requireModel,
  requireModelOr404,
  sendJobStarted,
} from "./helpers";
import { reviseUseCaseSchema, useCaseStatusSchema } from "./schemas";

export function modelRouter(): express.Router {
  const router = express.Router();
  router.get("/projects/:pid/proposals/:proposalId", async (req, res) =>
    res
      .set("Cache-Control", "no-store")
      .json(
        await reviewRevisionProposal(
          param(req, "pid"),
          param(req, "proposalId"),
        ),
      ),
  );
  router.post(
    "/projects/:pid/proposals/:proposalId/discard",
    async (req, res) =>
      res.json(
        await discardRevisionProposal(
          param(req, "pid"),
          param(req, "proposalId"),
        ),
      ),
  );

  router.get("/projects/:pid/model", async (req, res) => {
    const projectId = param(req, "pid");
    const project = await getProject(projectId);
    if (project.storage && !activeJobFor(projectId))
      await syncFromDisk(project, { requireComplete: true });
    res
      .set("Cache-Control", "no-store")
      .json(await requireModelOr404(projectId));
  });

  router.get("/projects/:pid/graph", async (req, res) => {
    const projectId = param(req, "pid");
    await getProject(projectId);
    const model = await loadModel(projectId);
    const graph: SolutionGraph = model
      ? buildGraph(model)
      : { nodes: [], edges: [] };
    res.set("Cache-Control", "no-store").json(graph);
  });

  router.patch("/projects/:pid/use-cases/:ucId/status", async (req, res) => {
    const projectId = param(req, "pid");
    const useCaseId = param(req, "ucId");
    const { status } = parseBody(useCaseStatusSchema, req);
    const project = await getProject(projectId);
    const model = await requireModelOr404(projectId);
    if (!model.useCases.some((uc) => uc.id === useCaseId))
      throw new NotFoundError(`Use case ${useCaseId} was not found.`);
    // A running generation / revision writes the whole model at its end and would silently undo the change.
    assertNoActiveJob(projectId, "change a use case status", [
      "generate",
      "revise",
    ]);
    res.json(await setUseCaseStatus(project, useCaseId, status));
  });

  router.post("/projects/:pid/use-cases/:ucId/revise", async (req, res) => {
    const projectId = param(req, "pid");
    const useCaseId = param(req, "ucId");
    const body = parseBody(reviseUseCaseSchema, req);
    await getProject(projectId);
    const model = await requireModel(projectId, "revising a use case");
    if (!model.useCases.some((uc) => uc.id === useCaseId))
      throw new NotFoundError(`Use case ${useCaseId} was not found.`);
    await assertConnection(body.connectionId);
    const job = await startJob("revise", projectId, (ctx) =>
      runReviseUseCase(ctx, projectId, useCaseId, {
        ...body,
        proposalOnly: true,
      }),
    );
    sendJobStarted(res, job);
  });
  router.post(
    "/projects/:pid/proposals/:proposalId/apply",
    async (req, res) => {
      const pid = param(req, "pid");
      await getProject(pid);
      assertNoActiveJob(pid, "apply a revision proposal");
      const { reviewToken } = parseBody(
        z.object({ reviewToken: z.string().regex(/^[a-f0-9]{64}$/) }),
        req,
      );
      res.json(
        await applyRevisionProposal(pid, param(req, "proposalId"), reviewToken),
      );
    },
  );

  return router;
}
