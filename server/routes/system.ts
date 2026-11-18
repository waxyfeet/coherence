/**
 * OWNER: server-core builder.
 * GET /api/health, GET /api/formats, POST /api/app/quit
 */
import express from "express";
import type { HealthResponse } from "@shared/api";
import { APP_VERSION, config } from "../config";
import { ConflictError } from "../errors";
import { listFormats } from "../formats/registry";
import { emit, managed } from "../lifecycle/control";

export function systemRouter(): express.Router {
  const router = express.Router();

  router.get("/health", (_req, res) => {
    const body: HealthResponse = {
      ok: true,
      version: APP_VERSION,
      dataDir: config.dataDir,
    };
    res.set("Cache-Control", "no-store").json(body);
  });

  router.get("/formats", (_req, res) => {
    res.json(listFormats());
  });

  // An in-app Quit asks the launcher, which warns about running analyses and then stops the app.
  router.post("/app/quit", (_req, res) => {
    if (!managed)
      throw new ConflictError(
        "Quit is available when Coherence is opened from the Start menu. Stop a development server with Ctrl+C.",
      );
    emit("quit-requested");
    res.status(202).json({ accepted: true });
  });

  return router;
}
