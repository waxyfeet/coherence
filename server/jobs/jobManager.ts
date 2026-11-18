import { redactDiagnostic, safeDiagnosticValue } from "../security/diagnostics";
import {
  JOB_DIAGNOSTICS_VERSION,
  safeJobDiagnostics,
  safeJobResult,
} from "../security/jobDiagnostics";
/**
 * OWNER: server-core builder.
 * In-memory job registry with SSE fan-out. Finished jobs are persisted to <projectDir>/jobs/<jobId>.json
 * so the UI can show history after a restart. A project may run at most ONE job at a time
 * (startJob throws ConflictError otherwise) — this keeps model writes simple.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type {
  Job,
  JobEvent,
  JobFailure,
  JobLiveCall,
  JobKind,
  JobLogEntry,
  JobStatus,
  LLMUsage,
  LogLevel,
  ProjectStatus,
} from "@shared/types";
import { paths } from "../config";
import { RequestBudget } from "../llm/capacity";
import type { LiveCalls } from "../llm/types";
import { describeFailure } from "./failure";
import { emit as emitControl } from "../lifecycle/control";

import { writeQueuedRecord } from "../storage/windowsStorageGuard";
import { getSettings } from "../storage/settingsStore";
import {
  CancelledError,
  ConflictError,
  NotFoundError,
  errorMessage,
} from "../errors";
import {
  isNotFound,
  pathExists,
  readJsonIfExists,
  writeJsonAtomic,
} from "../storage/fsUtils";
import {
  getProject,
  isValidProjectId,
  saveProject,
  withProjectLock,
  listProjectIds,
} from "../storage/projectStore";

/** Handed to every job runner. All methods are cheap and safe to call often. */
export interface JobContext {
  /** Shared by all stages/derived contexts; never serialized as project data. */
  readonly resources?: RequestBudget;
  readonly jobId: string;
  readonly projectId: string;
  /** Aborted when the BA cancels the job. Pass it to every LLM / HTTP call. */
  readonly signal: AbortSignal;
  log(level: LogLevel, message: string): void;
  info(message: string): void;
  warn(message: string): void;
  /** Declare all stage names up front so the UI can show "stage 2 of 5". */
  setStages(stages: string[]): void;
  /** Enter a stage (must be one of setStages, or it is appended). Resets current=0 and sets total. */
  stage(name: string, total?: number): void;
  /** Set absolute progress within the current stage. */
  progress(current: number, total?: number, label?: string): void;
  /** current += 1 (optionally update the label). Safe to call from parallel tasks. */
  tick(label?: string): void;
  /** Accumulate LLM usage (calls default 1 when tokens are given). */
  addUsage(usage: Partial<LLMUsage>): void;
  /** Throws CancelledError if the job was cancelled. */
  throwIfCancelled(): void;
  /** AI requests in flight, shown live in the activity panel; never saved. */
  readonly live?: LiveCalls;
}

/** Live progress reaches the activity panel at most this often. */
export const LIVE_EVENT_MS = 500;

/** Logs kept per job (oldest dropped first). */
export const MAX_LOG_ENTRIES = 2000;
/** Jobs returned by listJobs. */
export const MAX_LISTED_JOBS = 50;

/** Finished jobs kept in memory (they are on disk too). */
const MAX_FINISHED_IN_MEMORY = 200;

export const JOB_KIND_LABEL: Record<JobKind, string> = {
  "figma-import": "Importing Figma frames",
  generate: "Generating use cases",
  "impact-analysis": "Analysing impact",
  "impact-apply": "Applying impact changes",
  "screen-reanalysis": "Re-analysing a screen",
  export: "Exporting work items",
  "delivery-plan": "Planning delivery",
  "delivery-publish": "Publishing work items",
  revise: "Revising a use case",
};

const TERMINAL: JobStatus[] = ["succeeded", "failed", "cancelled"];
const JOB_ID_RE = /^job_[A-Za-z0-9_-]{6,40}$/;

interface JobEntry {
  persistence: Promise<void>;
  pendingCheckpoint?: Job;
  persistenceScheduled?: boolean;
  job: Job;
  stages: string[];
  controller: AbortController;
  listeners: Set<(event: JobEvent) => void>;
  /** Settles when the runner has finished and the final state is recorded. */
  done: Promise<void>;
}

const jobs = new Map<string, JobEntry>();
const maintenance = new Set<string>();
/** Projects whose next job is writing its queued record: it counts as active before its ID exists. */
const starting = new Map<string, JobKind>();

/** Prevent a new job racing a copy/delete, and settle finished jobs' final disk writes first. */
export async function withProjectMaintenance<T>(
  projectId: string,
  action: () => Promise<T>,
): Promise<T> {
  if (
    maintenance.has(projectId) ||
    starting.has(projectId) ||
    activeJobFor(projectId)
  )
    throw new ConflictError(
      "This project is busy. Finish or cancel its operation before duplicating or deleting it.",
    );
  maintenance.add(projectId);
  try {
    await Promise.all(
      [...jobs.values()]
        .filter((e) => e.job.projectId === projectId)
        .map((e) => e.done),
    );
    return await action();
  } finally {
    maintenance.delete(projectId);
  }
}

export function forgetProjectJobs(
  projectId: string,
  onlyIds?: ReadonlySet<string>,
): void {
  for (const [id, entry] of jobs)
    if (
      entry.job.projectId === projectId &&
      (!onlyIds || onlyIds.has(id)) &&
      isTerminalStatus(entry.job.status)
    ) {
      jobs.delete(id);
      const index = finishedOrder.indexOf(id);
      if (index >= 0) finishedOrder.splice(index, 1);
    }
}
const finishedOrder: string[] = [];

const now = () => new Date().toISOString();

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL.includes(status);
}

function emit(entry: JobEntry, event: JobEvent): void {
  entry.job.eventSequence = (entry.job.eventSequence ?? 0) + 1;
  // The file is a latest-state checkpoint, not an event journal. Superseded
  // pending snapshots coalesce while IO is in flight; SSE still emits every
  // event, and completion waits for the final full log/result checkpoint.
  entry.pendingCheckpoint = snapshot(entry.job);
  if (!entry.persistenceScheduled) {
    entry.persistenceScheduled = true;
    entry.persistence = entry.persistence.then(async () => {
      try {
        while (entry.pendingCheckpoint) {
          const checkpoint = entry.pendingCheckpoint;
          entry.pendingCheckpoint = undefined;
          await persistJob(checkpoint);
        }
      } finally {
        entry.persistenceScheduled = false;
      }
    });
  }
  for (const listener of [...entry.listeners]) {
    try {
      const { result, ...diagnostics } = event as JobEvent & {
        result?: unknown;
      };
      listener({
        ...(safeDiagnosticValue(diagnostics) as JobEvent),
        ...(result === undefined
          ? {}
          : { result: safeJobResult(entry.job.kind, result) }),
      } as JobEvent);
    } catch (err) {
      console.warn(`[jobs] An event listener failed: ${errorMessage(err)}`);
    }
  }
  if (event.type === "status") reportActiveJobs();
}

let reportedActive = 0;
/** Managed mode: the launcher learns each change in the running-job count, for its Quit and sign-out warnings. */
function reportActiveJobs(): void {
  const active = activeJobCount();
  if (active === reportedActive) return;
  reportedActive = active;
  emitControl("jobs", { active });
}

function snapshot(job: Job): Job {
  let copy: Job;
  try {
    copy = structuredClone(job);
  } catch {
    // A runner returned something structuredClone rejects (e.g. a function); the wire format is JSON anyway.
    copy = JSON.parse(JSON.stringify(job)) as Job;
  }
  return safeJobDiagnostics(copy);
}

function createContext(entry: JobEntry): JobContext {
  const { job, controller } = entry;
  const isActive = () => !isTerminalStatus(job.status);

  const pushLog = (level: LogLevel, message: string) => {
    if (!isActive()) return;
    const logEntry: JobLogEntry = {
      at: now(),
      level,
      message: redactDiagnostic(message),
      stage: job.progress.stage || undefined,
    };
    job.logs.push(logEntry);
    if (job.logs.length > MAX_LOG_ENTRIES)
      job.logs.splice(0, job.logs.length - MAX_LOG_ENTRIES);
    emit(entry, { type: "log", entry: logEntry });
  };

  const emitProgress = () =>
    emit(entry, { type: "progress", progress: { ...job.progress } });

  // Live progress goes to the listeners only: it changes many times a second and is never saved.
  const calls = new Map<number, JobLiveCall>();
  let nextCall = 0;
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  const flushLive = () => {
    liveTimer = undefined;
    if (!isActive()) return;
    const event: JobEvent = { type: "live", calls: [...calls.values()] };
    for (const listener of [...entry.listeners]) {
      try {
        listener(safeDiagnosticValue(event) as JobEvent);
      } catch (err) {
        console.warn(`[jobs] An event listener failed: ${errorMessage(err)}`);
      }
    }
  };
  const scheduleLive = () => {
    if (liveTimer || !isActive()) return;
    liveTimer = setTimeout(flushLive, LIVE_EVENT_MS);
    liveTimer.unref?.();
  };
  const live: LiveCalls = {
    start(purpose, model) {
      const id = ++nextCall;
      calls.set(id, { id, purpose, model, phase: "waiting", received: 0 });
      scheduleLive();
      return {
        stream({ text, thinking }) {
          const call = calls.get(id);
          if (!call) return;
          if (text && text > 0) {
            call.received += text;
            call.phase = "writing";
          } else if (thinking && call.phase === "waiting")
            call.phase = "thinking";
          scheduleLive();
        },
        end() {
          if (calls.delete(id)) scheduleLive();
        },
      };
    },
  };

  const ctx: JobContext = {
    live,
    resources: new RequestBudget(),
    jobId: job.id,
    projectId: job.projectId,
    signal: controller.signal,
    log: pushLog,
    info: (message) => pushLog("info", message),
    warn: (message) => pushLog("warn", message),
    setStages(stages) {
      if (!isActive()) return;
      entry.stages = [...stages];
      const index = entry.stages.indexOf(job.progress.stage);
      job.progress = {
        ...job.progress,
        stageIndex: index >= 0 ? index : 0,
        stageCount: entry.stages.length,
      };
      emitProgress();
    },
    stage(name, total) {
      if (!isActive()) return;
      let index = entry.stages.indexOf(name);
      if (index < 0) {
        entry.stages.push(name);
        index = entry.stages.length - 1;
      }
      job.progress = {
        stage: name,
        stageIndex: index,
        stageCount: entry.stages.length,
        current: 0,
        total: total ?? 0,
      };
      emitProgress();
      pushLog("info", `${name}…`);
    },
    progress(current, total, label) {
      if (!isActive()) return;
      job.progress = {
        ...job.progress,
        current: Math.max(0, current),
        total: total ?? job.progress.total,
        label: label ?? job.progress.label,
      };
      emitProgress();
    },
    tick(label) {
      if (!isActive()) return;
      const current = job.progress.current + 1;
      job.progress = {
        ...job.progress,
        current,
        // Never show "5 of 4" when a runner under-declared the total.
        total: Math.max(job.progress.total, current),
        label: label ?? job.progress.label,
      };
      emitProgress();
    },
    addUsage(usage) {
      if (!isActive()) return;
      const inputTokens = usage.inputTokens ?? 0;
      const outputTokens = usage.outputTokens ?? 0;
      const calls =
        usage.calls ??
        (usage.inputTokens !== undefined || usage.outputTokens !== undefined
          ? 1
          : 0);
      const next: LLMUsage = {
        calls: job.usage.calls + calls,
        inputTokens: job.usage.inputTokens + inputTokens,
        outputTokens: job.usage.outputTokens + outputTokens,
      };
      const cost =
        calls > 0
          ? usage.costUsd !== undefined &&
            (job.usage.calls === 0 || job.usage.costUsd !== undefined)
            ? (job.usage.costUsd ?? 0) + usage.costUsd
            : undefined
          : job.usage.costUsd;
      if (cost !== undefined) {
        next.costUsd = cost;
        next.estimateSource =
          "Bundled indicative provider rates; verify invoices";
        next.pricingAsOf = "2026-10-15";
      }
      job.usage = next;
      emit(entry, { type: "usage", usage: { ...next } });
    },
    throwIfCancelled() {
      if (controller.signal.aborted)
        throw new CancelledError("Cancelled by the user");
    },
  };
  return ctx;
}

/** Previous status to restore if a generation does not finish (the pipeline sets 'generating'). */
async function statusBeforeGeneration(
  projectId: string,
): Promise<ProjectStatus | undefined> {
  try {
    const project = await getProject(projectId);
    if (project.status !== "generating") return project.status;
    return (await pathExists(paths.modelFile(projectId)))
      ? "specified"
      : "draft";
  } catch {
    return undefined;
  }
}

async function restoreProjectStatus(
  projectId: string,
  status: ProjectStatus,
): Promise<void> {
  try {
    await withProjectLock(projectId, async () => {
      const project = await getProject(projectId);
      if (project.status !== "generating") return;
      project.status = status;
      await saveProject(project);
    });
  } catch (err) {
    console.warn(
      `[jobs] Could not restore the status of project "${projectId}": ${errorMessage(err)}`,
    );
  }
}

async function persistJob(job: Job): Promise<void> {
  const dir = paths.jobsDir(job.projectId);
  // A deleted project must not be recreated by a late job write.
  if (!(await pathExists(paths.projectFile(job.projectId)))) return;
  try {
    await writeJsonAtomic(path.join(dir, `${job.id}.json`), snapshot(job));
  } catch (err) {
    console.warn(`[jobs] Could not save job ${job.id}: ${errorMessage(err)}`);
  }
}

async function jobFilesNewestFirst(
  dir: string,
): Promise<{ file: string; mtimeMs: number }[]> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const files = await Promise.all(
    names.map(async (name) => {
      const file = path.join(dir, name);
      try {
        return { file, mtimeMs: (await fs.stat(file)).mtimeMs };
      } catch {
        return undefined;
      }
    }),
  );
  return files
    .filter((f): f is { file: string; mtimeMs: number } => !!f)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function rememberFinished(jobId: string): void {
  finishedOrder.push(jobId);
  while (finishedOrder.length > MAX_FINISHED_IN_MEMORY) {
    const evicted = finishedOrder.shift()!;
    const entry = jobs.get(evicted);
    if (
      entry &&
      isTerminalStatus(entry.job.status) &&
      entry.listeners.size === 0
    )
      jobs.delete(evicted);
  }
}

async function execute<R>(
  entry: JobEntry,
  ctx: JobContext,
  run: (ctx: JobContext) => Promise<R>,
): Promise<void> {
  const { job, controller } = entry;
  job.status = "running";
  job.startedAt = now();
  emit(entry, { type: "status", status: "running" });

  const previousStatus =
    job.kind === "generate"
      ? await statusBeforeGeneration(job.projectId)
      : undefined;
  let status: JobStatus;
  let result: R | undefined;
  let error: string | undefined;
  let failure: JobFailure | undefined;
  try {
    ctx.throwIfCancelled();
    result = await run(ctx);
    status = "succeeded";
  } catch (err) {
    // Runners may surface an abort as some other error (fetch AbortError, LLMError…) — the BA asked to stop.
    if (err instanceof CancelledError || controller.signal.aborted) {
      status = "cancelled";
      error = "Cancelled by the user";
    } else {
      status = "failed";
      error = errorMessage(err) || "The job failed for an unknown reason.";
      failure = describeFailure(err);
      if (!(err instanceof Error) || !("status" in err))
        console.error(`[jobs] ${job.kind} job ${job.id} failed: ${error}`);
    }
  }

  if (status !== "succeeded" && previousStatus)
    await restoreProjectStatus(job.projectId, previousStatus);

  if (status === "cancelled") ctx.log("warn", "Cancelled by the user.");
  else if (status === "failed") ctx.log("error", error ?? "Failed");

  job.status = status;
  job.finishedAt = now();
  if (status === "succeeded") job.result = result;
  else job.error = error;
  if (failure) job.failure = failure;
  emit(entry, {
    type: "status",
    status,
    error,
    ...(failure ? { failure } : {}),
    result: status === "succeeded" ? result : undefined,
  });

  const seconds = (
    (Date.parse(job.finishedAt) - Date.parse(job.startedAt ?? job.createdAt)) /
    1000
  ).toFixed(1);
  console.log(
    `[jobs] ${JOB_KIND_LABEL[job.kind]} (${job.projectId}) ${status} in ${seconds}s`,
  );

  await entry.persistence;
  await persistJob(job);
  rememberFinished(job.id);
}

/**
 * Create and immediately start a job (runs asynchronously). Returns the queued/running job snapshot.
 * The runner's resolved value becomes job.result; a thrown error marks it failed (CancelledError → 'cancelled').
 * @throws ConflictError when the project already has a running job.
 */
export async function startJob<R>(
  kind: JobKind,
  projectId: string,
  run: (ctx: JobContext) => Promise<R>,
): Promise<Job<R>> {
  if (maintenance.has(projectId))
    throw new ConflictError(
      "This project is being copied or deleted. Try again when that operation finishes.",
    );
  const active = activeJobFor(projectId);
  if (active) {
    throw new ConflictError(
      `${JOB_KIND_LABEL[active.kind]} is still running for this project. Wait for it to finish or cancel it, then try again.`,
      { activeJobId: active.id, activeJobKind: active.kind },
    );
  }
  const pending = starting.get(projectId);
  if (pending)
    throw new ConflictError(
      `${JOB_KIND_LABEL[pending]} is starting for this project. Wait for it to finish or cancel it, then try again.`,
      { activeJobKind: pending },
    );

  const job: Job = {
    diagnosticsVersion: JOB_DIAGNOSTICS_VERSION,
    id: `job_${nanoid(12)}`,
    kind,
    projectId,
    status: "queued",
    progress: { stage: "", stageIndex: 0, stageCount: 0, current: 0, total: 0 },
    logs: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    createdAt: now(),
  };
  const entry: JobEntry = {
    persistence: Promise.resolve(),
    job,
    stages: [],
    controller: new AbortController(),
    listeners: new Set(),
    done: Promise.resolve(),
  };
  // A real project has its queued record durably claimed before its ID is exposed. Meanwhile the project counts as
  // busy, so neither a second job nor a copy or delete can start.
  if (fsSync.existsSync(paths.projectFile(projectId))) {
    starting.set(projectId, kind);
    try {
      await writeQueuedRecord(
        paths.projectDir(projectId),
        path.join(paths.jobsDir(projectId), `${job.id}.json`),
        JSON.stringify(job),
      );
    } finally {
      starting.delete(projectId);
    }
  }
  jobs.set(job.id, entry);
  reportActiveJobs();
  const ctx = createContext(entry);
  const initial = snapshot(job) as Job<R>;
  // Start after the caller has the "queued" snapshot and can subscribe. startJob is async, so a microtask would run
  // before the caller resumes; setImmediate waits until it has.
  entry.done = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => execute(entry, ctx, run))
    .catch((err) => {
      console.error(
        `[jobs] Unexpected job manager failure for ${job.id}: ${errorMessage(err)}`,
      );
    });
  return initial;
}

/** Live (in-memory) snapshot, or undefined. Synchronous so an SSE handler can subscribe without missing events. */
export function getLiveJob(jobId: string): Job | undefined {
  const entry = jobs.get(jobId);
  return entry ? snapshot(entry.job) : undefined;
}

async function findPersistedJob(jobId: string): Promise<Job | undefined> {
  let projectIds: string[];
  try {
    projectIds = await listProjectIds();
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  for (const projectId of projectIds) {
    try {
      const job = await readJsonIfExists<Job>(
        path.join(paths.jobsDir(projectId), `${jobId}.json`),
      );
      if (job) return snapshot(job);
    } catch {
      /* unreadable job file: treat as missing */
    }
  }
  return undefined;
}

/** In-memory first, then <projectDir>/jobs. @throws NotFoundError */
export async function getJob(jobId: string): Promise<Job> {
  await getSettings(); // Register protected/env credential context before exposing legacy diagnostics.
  const live = getLiveJob(jobId);
  if (live) return live;
  if (JOB_ID_RE.test(jobId)) {
    const persisted = await findPersistedJob(jobId);
    if (persisted) return persisted;
  }
  throw new NotFoundError(
    "That job was not found — it may belong to a deleted project.",
  );
}

/** Most recent first (in-memory + persisted), max 50. */
export async function listJobs(projectId: string): Promise<Job[]> {
  await getSettings();
  const byId = new Map<string, Job>();
  for (const entry of jobs.values()) {
    if (entry.job.projectId === projectId)
      byId.set(entry.job.id, snapshot(entry.job));
  }
  if (isValidProjectId(projectId)) {
    const files = await jobFilesNewestFirst(paths.jobsDir(projectId));
    for (const { file } of files.slice(0, MAX_LISTED_JOBS)) {
      const id = path.basename(file, ".json");
      if (byId.has(id)) continue;
      try {
        const job = await readJsonIfExists<Job>(file);
        if (job?.id) byId.set(job.id, snapshot(job));
      } catch {
        /* skip unreadable job files */
      }
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_LISTED_JOBS);
}

/** Running job for a project, if any. */
export function activeJobFor(projectId: string): Job | undefined {
  for (const entry of jobs.values()) {
    if (
      entry.job.projectId === projectId &&
      !isTerminalStatus(entry.job.status)
    )
      return snapshot(entry.job);
  }
  return undefined;
}

/** Jobs still running, for the launcher's Quit and sign-out warnings. */
export function activeJobCount(): number {
  let count = 0;
  for (const entry of jobs.values())
    if (!isTerminalStatus(entry.job.status)) count++;
  return count;
}

/** Subscribe to live events. Returns unsubscribe. The caller sends the snapshot itself (via getJob). */
export function subscribe(
  jobId: string,
  listener: (event: JobEvent) => void,
): () => void {
  const entry = jobs.get(jobId);
  if (!entry) return () => {};
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

/** Returns false if the job is not running. */
export function cancelJob(jobId: string): boolean {
  const entry = jobs.get(jobId);
  if (!entry || isTerminalStatus(entry.job.status)) return false;
  if (!entry.controller.signal.aborted) {
    const logEntry: JobLogEntry = {
      at: now(),
      level: "warn",
      message: "Cancelling…",
      stage: entry.job.progress.stage || undefined,
    };
    entry.job.logs.push(logEntry);
    emit(entry, { type: "log", entry: logEntry });
    entry.controller.abort(new CancelledError("Cancelled by the user"));
  }
  return true;
}

/**
 * Cancel every running job and wait (up to timeoutMs) for them to record their final state.
 * Used on shutdown so projects are not left in 'generating'.
 */
export async function cancelAllJobs(timeoutMs = 5000): Promise<void> {
  const running = [...jobs.values()].filter(
    (e) => !isTerminalStatus(e.job.status),
  );
  for (const entry of running) cancelJob(entry.job.id);
  if (!running.length) return;
  await Promise.race([
    Promise.allSettled(running.map((e) => e.done)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]);
}

/** Resolves when the job has finished and its final state is recorded (for tests / shutdown). */
export async function waitForJob(jobId: string): Promise<Job> {
  const entry = jobs.get(jobId);
  if (entry) await entry.done;
  return getJob(jobId);
}
