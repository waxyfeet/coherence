/**
 * OWNER: server-core builder.
 * Mounts every /api route (contract: shared/api.ts). Mounted under /api by app.ts.
 */
import express from "express";
import { deliveryRouter } from "./delivery";
import { exportRouter } from "./export";
import { extrasRouter } from "./extras";
import { filesRouter } from "./files";
import { impactRouter } from "./impact";
import { jobsRouter } from "./jobs";
import { modelRouter } from "./model";
import { projectsRouter } from "./projects";
import { settingsRouter } from "./settings";
import { systemRouter } from "./system";
import { libraryRouter } from "./library";
import { storageRouter } from "./storage";

export function apiRouter(): express.Router {
  const router = express.Router();
  router.use(systemRouter());
  router.use(settingsRouter());
  router.use(libraryRouter());
  router.use(storageRouter());
  router.use(projectsRouter());
  router.use(jobsRouter());
  router.use(modelRouter());
  router.use(filesRouter());
  router.use(impactRouter());
  router.use(exportRouter());
  // Intelligent Delivery Mapping: read-only discovery, planning, decisions, approval and previews.
  router.use(deliveryRouter());
  // Beyond the v1 contract: model history restore, trash restore, reveal output folder.
  router.use(extrasRouter());
  return router;
}
