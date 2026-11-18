/**
 * OWNER: server-core builder.
 * Generation and job tracking: POST /generate, job list / detail / cancel, and the SSE event stream.
 */
import express from "express";
import type { Request, Response } from "express";
import type { GenerationOptions, Job, JobEvent } from "@shared/types";
import { DEFAULT_GENERATION_OPTIONS } from "@shared/types";
import { runGeneration } from "../agents/pipeline";
import { clearAnalysisCache } from "../agents/runState";
import { BadRequestError } from "../errors";
import {
  cancelJob,
  getJob,
  getLiveJob,
  isTerminalStatus,
  listJobs,
  startJob,
  subscribe,
} from "../jobs/jobManager";
import { param, parseBody } from "../middleware/validate";
import { getProject } from "../storage/projectStore";
import {
  assertConnection,
  assertKeyAvailable,
  assertNoActiveJob,
  definedOnly,
  sendJobStarted,
} from "./helpers";
import { generateSchema } from "./schemas";

/** Logs returned per job by the list endpoint (the detail endpoint returns all of them). */
export const LIST_LOG_LIMIT = 200;
export const SSE_HEARTBEAT_MS = 15_000;

function trimLogs(job: Job): Job {
  return job.logs.length > LIST_LOG_LIMIT
    ? { ...job, logs: job.logs.slice(-LIST_LOG_LIMIT) }
    : job;
}

function openEventStream(res: Response): (event: JobEvent) => void {
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  // Ask EventSource to wait a little before reconnecting after we close a finished stream.
  res.write("retry: 5000\n\n");
  return (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
}

async function streamJobEvents(req: Request, res: Response): Promise<void> {
  const jobId = param(req, "jobId");
  // Snapshot and subscribe in the same tick, so no event can fall between them.
  const live = getLiveJob(jobId);
  if (!live) {
    // Finished in an earlier run of the server: one snapshot, then close.
    const job = await getJob(jobId);
    const send = openEventStream(res);
    send({ type: "snapshot", job });
    res.end();
    return;
  }

  const send = openEventStream(res);
  send({ type: "snapshot", job: live });
  if (isTerminalStatus(live.status)) {
    res.end();
    return;
  }

  let closed = false;
  let unsubscribe = () => {};
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": heartbeat\n\n");
  }, SSE_HEARTBEAT_MS);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    if (!res.writableEnded) res.end();
  };
  unsubscribe = subscribe(jobId, (event) => {
    send(event);
    if (event.type === "status" && isTerminalStatus(event.status)) cleanup();
  });
  // 'close' on the response fires when the browser goes away (or after we end the stream).
  res.on("close", cleanup);
}

export function jobsRouter(): express.Router {
  const router = express.Router();

  router.post("/projects/:pid/generate", async (req, res) => {
    const projectId = param(req, "pid");
    const body = parseBody(generateSchema, req);
    const project = await getProject(projectId);
    if (!project.screens.length)
      throw new BadRequestError(
        "Add at least one screen before generating specs.",
      );
    await assertConnection(body.visionConnectionId, "screen-reading");
    await assertConnection(body.textConnectionId, "spec-writing");
    await assertKeyAvailable(body.visionConnectionId);
    await assertKeyAvailable(body.textConnectionId);
    const options: GenerationOptions = {
      ...DEFAULT_GENERATION_OPTIONS,
      ...definedOnly(body),
    };
    const job = await startJob("generate", projectId, (ctx) =>
      runGeneration(ctx, projectId, options),
    );
    sendJobStarted(res, job);
  });

  // Abandon a stopped run (tester build WP5): its kept readings and stage checkpoints go, so the next run starts
  // fresh. The job itself stays in Activity.
  router.post("/projects/:pid/generate/abandon", async (req, res) => {
    const projectId = param(req, "pid");
    await getProject(projectId);
    assertNoActiveJob(projectId, "abandon the last run");
    await clearAnalysisCache(projectId);
    res.json({ ok: true });
  });

  router.get("/projects/:pid/jobs", async (req, res) => {
    const projectId = param(req, "pid");
    await getProject(projectId);
    res
      .set("Cache-Control", "no-store")
      .json((await listJobs(projectId)).map(trimLogs));
  });

  router.get("/jobs/:jobId", async (req, res) => {
    res
      .set("Cache-Control", "no-store")
      .json(await getJob(param(req, "jobId")));
  });

  router.get("/jobs/:jobId/events", streamJobEvents);

  router.post("/jobs/:jobId/cancel", async (req, res) => {
    const jobId = param(req, "jobId");
    await getJob(jobId);
    // Cancelling a job that has just finished is not an error for the BA — the result is the same.
    cancelJob(jobId);
    res.json({ ok: true });
  });

  return router;
}
