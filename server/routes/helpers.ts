/**
 * OWNER: server-core builder.
 * Small helpers shared by the route modules: derived ProjectDetail, preconditions with BA-readable
 * errors, and the JobStarted response.
 */
import type { Response } from "express";
import type { JobStarted, ProjectDetail } from "@shared/api";
import type { Job, JobKind, Project, SolutionModel } from "@shared/types";
import {
  BadRequestError,
  ConflictError,
  HttpError,
  NotFoundError,
} from "../errors";
import { JOB_KIND_LABEL, activeJobFor } from "../jobs/jobManager";
import { getProject, loadModel } from "../storage/projectStore";
import { getConnection } from "../storage/settingsStore";
import { PROVIDER_PRESETS } from "@shared/providers";
import { resolveApiKey } from "../llm/providers/common";

/** Pure: Project + model + active job → ProjectDetail. */
export function buildProjectDetail(
  project: Project,
  model: SolutionModel | null,
  activeJob?: Job,
): ProjectDetail {
  const useCases = model?.useCases ?? [];
  return {
    ...project,
    useCaseCount: useCases.length,
    hasModel: model !== null,
    staleCount: useCases.filter((uc) => uc.status === "stale").length,
    changedScreenIds: project.screens
      .filter(
        (s) =>
          s.analysedVersion !== undefined && s.analysedVersion !== s.version,
      )
      .map((s) => s.id),
    activeJobId: activeJob?.id,
  };
}

export async function getProjectDetail(
  projectId: string,
): Promise<ProjectDetail> {
  const project = await getProject(projectId);
  const model = await loadModel(projectId);
  return buildProjectDetail(project, model, activeJobFor(projectId));
}

/** @throws BadRequestError when the project has never been generated. */
export async function requireModel(
  projectId: string,
  purpose: string,
): Promise<SolutionModel> {
  const model = await loadModel(projectId);
  if (!model)
    throw new BadRequestError(
      `Generate specs for this project first — ${purpose} needs the generated solution model.`,
    );
  return model;
}

/** @throws NotFoundError (404) when the project has never been generated. */
export async function requireModelOr404(
  projectId: string,
): Promise<SolutionModel> {
  const model = await loadModel(projectId);
  if (!model)
    throw new NotFoundError(
      "This project has not been generated yet — there is no solution model.",
    );
  return model;
}

/** Validates an optional connection id from a request body with a BA-readable message. */
export async function assertConnection(
  connectionId: string | undefined,
  role = "selected",
): Promise<void> {
  if (!connectionId) return;
  try {
    await getConnection(connectionId);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new BadRequestError(
        `The ${role} AI connection no longer exists. Pick another one (or add one in Settings).`,
      );
    }
    throw err;
  }
}

/**
 * A provider whose API always needs a key, with none saved: stop before any work instead of at the first call
 * (owner test note 3). Compatible gateways may need no key, so they are left to the first request.
 */
export async function assertKeyAvailable(
  connectionId: string | undefined,
): Promise<void> {
  if (!connectionId) return;
  const connection = await getConnection(connectionId);
  if (!PROVIDER_PRESETS[connection.provider].apiKeyRequired) return;
  let key: string | undefined;
  try {
    key = resolveApiKey(connection);
  } catch {
    return; // An address the endpoint policy refuses is reported by the call itself.
  }
  if (!key)
    throw new BadRequestError(
      `No API key is saved for ${connection.name}. Add it in Settings → AI connections, then start again.`,
    );
}

/** Blocks operations that would race with a running job's file/model writes. */
export function assertNoActiveJob(
  projectId: string,
  action: string,
  kinds?: JobKind[],
): void {
  const active = activeJobFor(projectId);
  if (active && (!kinds || kinds.includes(active.kind))) {
    throw new ConflictError(
      `${JOB_KIND_LABEL[active.kind]} is in progress — wait for it to finish (or cancel it) before you ${action}.`,
      { activeJobId: active.id, activeJobKind: active.kind },
    );
  }
}

export function sendJobStarted(res: Response, job: Job): void {
  const body: JobStarted = { jobId: job.id, job };
  res.status(202).json(body);
}

/** Drops undefined values so they do not override defaults when spread. */
export function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/** A single string from an Express query value. */
export function queryString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}
