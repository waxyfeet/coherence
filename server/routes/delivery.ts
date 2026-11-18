/**
 * Delivery planning and publishing routes (Intelligent Delivery Mapping, contract in shared/api.ts). Discovery is
 * read-only and runs inside the plan job. The publish job is the only tracker write in Coherence, and only for
 * destinations unlocked in delivery/publishing.ts; the classic export's live-write lock in routes/export.ts is
 * unchanged. The check job only reads.
 */
import express from "express";
import { z } from "zod";
import { EXTERNAL_SYSTEM_LABEL } from "@shared/api";
import type { ExternalSystem } from "@shared/types";
import { BadRequestError, ConflictError } from "../errors";
import { runDeliveryCheck, runDeliveryPublish } from "../delivery/publish";
import { PUBLISH_TARGETS } from "../delivery/publishing";
import { startJob } from "../jobs/jobManager";
import { param, parseBody } from "../middleware/validate";
import { getProject } from "../storage/projectStore";
import { getIntegration } from "../storage/settingsStore";
import {
  approvePlan,
  assertSystem,
  getPlanView,
  previewPlanItem,
  resolveDecision,
  runDeliveryPlan,
  setAttachment,
} from "../delivery/service";
import { requireModel, sendJobStarted } from "./helpers";

const target = z.enum(["jira", "azdo", "github"]);
const planRequestSchema = z.object({
  target,
  useCaseIds: z.array(z.string().min(1).max(40)).max(500).optional(),
  includeUnapproved: z.boolean().optional(),
  groupByFeature: z.boolean().optional(),
  linkDependencies: z.boolean().optional(),
  useAi: z.boolean().optional(),
  refreshDestination: z.boolean().optional(),
});
const decisionSchema = z.object({
  decisionId: z.string().min(1).max(400),
  value: z.string().min(1).max(4000).nullable(),
  saveAsRule: z.boolean().optional(),
});
const attachmentSchema = z.object({
  attachmentId: z.string().min(1).max(400),
  include: z.boolean(),
});
const publishSchema = z.object({
  revision: z.number().int().min(1),
  fingerprint: z.string().regex(/^[0-9a-f]{32}$/),
});

function assertPublishable(system: ExternalSystem) {
  if (!PUBLISH_TARGETS[system])
    throw new ConflictError(
      `Publishing to ${EXTERNAL_SYSTEM_LABEL[system]} isn't available in this version yet.`,
    );
}

export function deliveryRouter(): express.Router {
  const router = express.Router();

  router.post("/projects/:pid/delivery/plans", async (req, res) => {
    const projectId = param(req, "pid");
    const body = parseBody(planRequestSchema, req);
    await getProject(projectId);
    await requireModel(projectId, "delivery planning");
    if (!(await getIntegration(body.target)))
      throw new BadRequestError(
        `${EXTERNAL_SYSTEM_LABEL[body.target]} is not set up yet — add it under Settings → Integrations.`,
      );
    const job = await startJob("delivery-plan", projectId, (ctx) =>
      runDeliveryPlan(ctx, projectId, body),
    );
    sendJobStarted(res, job);
  });

  router.get("/projects/:pid/delivery/plans/:target", async (req, res) => {
    const projectId = param(req, "pid");
    await getProject(projectId);
    res
      .set("Cache-Control", "no-store")
      .json(await getPlanView(projectId, assertSystem(param(req, "target"))));
  });

  router.post(
    "/projects/:pid/delivery/plans/:target/decisions",
    async (req, res) => {
      const projectId = param(req, "pid");
      const body = parseBody(decisionSchema, req);
      await getProject(projectId);
      res.json(
        await resolveDecision(
          projectId,
          assertSystem(param(req, "target")),
          body,
        ),
      );
    },
  );

  router.post(
    "/projects/:pid/delivery/plans/:target/attachments",
    async (req, res) => {
      const projectId = param(req, "pid");
      const body = parseBody(attachmentSchema, req);
      await getProject(projectId);
      res.json(
        await setAttachment(
          projectId,
          assertSystem(param(req, "target")),
          body,
        ),
      );
    },
  );

  router.post(
    "/projects/:pid/delivery/plans/:target/approve",
    async (req, res) => {
      const projectId = param(req, "pid");
      await getProject(projectId);
      res.json(
        await approvePlan(projectId, assertSystem(param(req, "target"))),
      );
    },
  );

  router.post(
    "/projects/:pid/delivery/plans/:target/publish",
    async (req, res) => {
      const projectId = param(req, "pid");
      const system = assertSystem(param(req, "target"));
      const body = parseBody(publishSchema, req);
      await getProject(projectId);
      assertPublishable(system);
      const job = await startJob("delivery-publish", projectId, (ctx) =>
        runDeliveryPublish(ctx, projectId, system, body),
      );
      sendJobStarted(res, job);
    },
  );

  router.post(
    "/projects/:pid/delivery/plans/:target/check",
    async (req, res) => {
      const projectId = param(req, "pid");
      const system = assertSystem(param(req, "target"));
      await getProject(projectId);
      assertPublishable(system);
      const job = await startJob("delivery-publish", projectId, (ctx) =>
        runDeliveryCheck(ctx, projectId, system),
      );
      sendJobStarted(res, job);
    },
  );

  router.get(
    "/projects/:pid/delivery/plans/:target/items/:itemId/preview",
    async (req, res) => {
      const projectId = param(req, "pid");
      await getProject(projectId);
      res
        .set("Cache-Control", "no-store")
        .json(
          await previewPlanItem(
            projectId,
            assertSystem(param(req, "target")),
            param(req, "itemId"),
          ),
        );
    },
  );

  return router;
}
