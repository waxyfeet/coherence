import { readOwnedFile } from "../storage/fsUtils";
/**
 * OWNER: graph builder.
 * Impact analysis (deterministic trace + Impact Analyst agent), applying an impact report (Use Case Writer
 * rewrites + re-render), and screen re-analysis after an image is replaced.
 */
import { customAlphabet } from "nanoid";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import type {
  AnalyseImpactRequest,
  ApplyImpactRequest,
  ApplyImpactResult,
  ReanalyseScreenRequest,
} from "@shared/api";
import type {
  ChangeLogEntry,
  ChangeRequest,
  ImpactReport,
  ImpactStatus,
  LLMConnection,
  Project,
  ScreenAnalysis,
  SolutionModel,
  UseCase,
} from "@shared/types";
import { analyseScreen } from "../agents/screenAnalyst";
import { writeUseCaseContent } from "../agents/writer";
import {
  savedProjectConnections,
  resolveJobConnection,
} from "../agents/connections";
import {
  BadRequestError,
  CancelledError,
  ConflictError,
  errorMessage,
  NotFoundError,
} from "../errors";
import { getFormat } from "../formats/registry";
import type { OutputFormat } from "../formats/types";
import type { JobContext } from "../jobs/jobManager";
import { connectionLabel, connectionSupportsVision } from "../llm/registry";
import { generateStructured, type UsageReport } from "../llm/structured";
import { statOrNull } from "../specs/files";
import {
  refreshDerivedFiles,
  resolveSpecPath,
  rewriteUseCaseFrontMatter,
  syncFromDisk,
  writeSpecs,
  type WriteSpecsResult,
} from "../specs/specStore";
import { diffUseCases } from "../specs/useCaseDiff";
import {
  getImpactReport,
  getProject,
  listImpactReports,
  loadModel,
  saveImpactReport,
  saveModel,
  saveProject,
  withProjectLock,
} from "../storage/projectStore";
import { traceImpact } from "./graph";
import {
  buildRevisionNotes,
  isOpenReport,
  keepFlagAfterRewrite,
  markStale,
  mergeScreenAnalysis,
  needsAttention,
  regeneratedSince,
  reportStatusAfterApply,
  restoreStatuses,
  statusAfterRewrite,
  type ScreenMergeResult,
  type TrackedImpactReport,
} from "./impactApply";
import { mergeImpactAnalysis } from "./impactMerge";
import { mockImpactAnalysis } from "./impactMock";
import {
  buildImpactUserPrompt,
  IMPACT_ANALYST_SYSTEM_PROMPT,
} from "./impactPrompts";
import { impactAnalystSchema, type ImpactAnalystOutput } from "./impactSchema";
import { indexModel, normaliseUseCaseId } from "./modelIndex";
import { diffScreenAnalysesWith } from "./screenDiff";
import { elementDisplayLabel, joinList, plural, truncate } from "./text";

export const IMPACT_STAGES = [
  "Tracing dependencies",
  "Analysing impact",
  "Saving report",
] as const;
export const REANALYSIS_STAGES = [
  "Reading the new screen",
  "Comparing versions",
  ...IMPACT_STAGES,
] as const;
export const APPLY_STAGES = [
  "Preparing changes",
  "Rewriting use cases",
  "Writing files",
] as const;

const reportSuffix = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 6);

/** "IR-20261014-k3x9qa" */
export function newReportId(now = new Date()): string {
  return `IR-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${reportSuffix()}`;
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

async function requireModel(projectId: string): Promise<SolutionModel> {
  const model = await loadModel(projectId);
  if (!model) {
    throw new BadRequestError(
      "There are no generated specs yet. Generate the specs first — impact analysis works on the generated use cases.",
    );
  }
  return model;
}

/** Missing explicit or remembered assignments must be replaced deliberately, never by a cloud default. */
async function resolvePreferredConnection(
  project: Project,
  explicit: string | undefined,
  preferred: { id?: string; modelId?: string; acknowledged?: boolean }[],
  selection: {
    modelId?: string;
    reading?: boolean;
    acknowledged?: boolean;
    refreshMetadata?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<LLMConnection> {
  const { connection } = await resolveJobConnection(
    project,
    explicit,
    preferred.map((choice) => ({
      ...choice,
      id: choice.id,
      use: "impact analysis or screen reanalysis",
    })),
    undefined,
    selection,
  );
  return connection;
}

async function textConnectionFor(
  ctx: JobContext,
  project: Project,
  explicit?: string,
  modelId?: string,
): Promise<LLMConnection> {
  const choices = await savedProjectConnections(project);
  return resolvePreferredConnection(
    project,
    explicit,
    [{ id: choices.textConnectionId, modelId: choices.textModelId }],
    { modelId, refreshMetadata: !!ctx.resources, signal: ctx.signal },
  );
}

function usageReporter(ctx: JobContext) {
  return (u: UsageReport) =>
    ctx.addUsage({
      calls: 1,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      costUsd: u.costUsd,
    });
}

function embedImages(model: SolutionModel): boolean {
  return model.options?.embedScreenImages ?? true;
}

/**
 * Re-render the given use case files (plus support files). With no ids we still refresh the support files
 * (CHANGELOG.md…) but ask writeSpecs to preserve edited/approved files, so an "all files" interpretation of
 * an empty list can never overwrite the BA's work.
 */
function writeTouchedSpecs(
  project: Project,
  model: SolutionModel,
  useCaseIds: string[],
): Promise<WriteSpecsResult> {
  return writeSpecs(project, model, {
    preserveEdited: useCaseIds.length === 0,
    embedScreenImages: embedImages(model),
    useCaseIds,
  });
}

/**
 * Status-only changes (stale marks, restored statuses): rewrite just the front matter of those use case
 * files and refresh the derived files. The bodies stay byte for byte as they are on disk — they may hold BA
 * edits that were never synced, which a full re-render from the model would silently overwrite.
 */
async function writeStatusChanges(
  project: Project,
  model: SolutionModel,
  useCaseIds: string[],
): Promise<string[]> {
  const written = useCaseIds.length
    ? await rewriteUseCaseFrontMatter(project, model, useCaseIds)
    : [];
  return [...written, ...(await refreshDerivedFiles(project, model))];
}

/**
 * The other impact reports of the project whose stale flags are still in force. Reports analysed before the
 * last generation are left out: their use case ids may now name different use cases.
 */
async function otherOpenReports(
  projectId: string,
  model: SolutionModel,
  reportId?: string,
): Promise<ImpactReport[]> {
  return (await listImpactReports(projectId)).filter(
    (r) => r.id !== reportId && isOpenReport(r) && !regeneratedSince(r, model),
  );
}

/** What a use case file looked like before a long-running rewrite (see runApplyImpact). */
interface FileBaseline {
  hash?: string;
  revision: number;
  updatedAt: string;
  file?: string;
  mtimeMs?: number;
}

async function fileBaseline(
  project: Project,
  uc: UseCase,
): Promise<FileBaseline> {
  let file: string | undefined;
  try {
    file = uc.filePath ? resolveSpecPath(project, uc.filePath) : undefined;
  } catch {
    file = undefined; // an unusable recorded path: writeSpecs renders to the format's own path
  }
  const content = file
    ? await readOwnedFile(file).catch(() => undefined)
    : undefined;
  return {
    revision: uc.revision,
    updatedAt: uc.updatedAt,
    file,
    mtimeMs: await mtimeOf(file),
    hash: content
      ? createHash("sha256").update(content).digest("hex")
      : undefined,
  };
}

async function mtimeOf(file: string | undefined): Promise<number | undefined> {
  if (!file) return undefined;
  try {
    return (await statOrNull(file))?.mtimeMs;
  } catch {
    return undefined;
  }
}

/** The use case file was written (in the app or in an external editor) since the baseline. */
async function fileChangedSince(
  base: FileBaseline | undefined,
): Promise<boolean> {
  if (!base) return false;
  if ((await mtimeOf(base.file)) !== base.mtimeMs) return true;
  const content = base.file
    ? await readOwnedFile(base.file).catch(() => undefined)
    : undefined;
  return (
    (content
      ? createHash("sha256").update(content).digest("hex")
      : undefined) !== base.hash
  );
}

function isEmptyScreenDiff(change: ChangeRequest): boolean {
  const d = change.screenDiff;
  return !!d && !d.added.length && !d.removed.length && !d.modified.length;
}

/** Validates a change request and fills what can be derived (md-edit target, description). Returns a copy. */
function normaliseChange(input: ChangeRequest): ChangeRequest {
  const change: ChangeRequest = structuredClone(input);
  change.description = (change.description ?? "").trim();
  if (change.targetId !== undefined)
    change.targetId = change.targetId.trim() || undefined;
  if (change.useCaseDiff) {
    if (!change.targetId && change.targetKind !== "free") {
      change.targetKind = "usecase";
      change.targetId = change.useCaseDiff.useCaseId;
    }
    if (!change.description) {
      change.description = `${change.useCaseDiff.useCaseId} was edited: ${change.useCaseDiff.summary || change.useCaseDiff.changedSections.join(", ")}`;
    }
  }
  if (change.screenDiff && !change.description)
    change.description = change.screenDiff.summary;
  if (!change.description) {
    throw new BadRequestError(
      'Describe the change — for example "Password must be at least 12 characters" — so its knock-on effects can be analysed.',
    );
  }
  return change;
}

/* ------------------------------------------------------------------ */
/* Impact analysis                                                     */
/* ------------------------------------------------------------------ */

interface AnalyseOptions {
  pendingScreenAnalysis?: ScreenAnalysis;
  /** Extra changelog entries recorded with the report (e.g. 'screen-reanalysed'). */
  extraChangeLog?: (report: ImpactReport) => ChangeLogEntry[];
}

async function analyseAndPersist(
  ctx: JobContext,
  project: Project,
  model: SolutionModel,
  change: ChangeRequest,
  connection: LLMConnection,
  opts: AnalyseOptions = {},
): Promise<ImpactReport> {
  ctx.stage("Tracing dependencies");
  const trace = traceImpact(model, change);
  ctx.info(
    `Dependency trace: ${plural(trace.directUseCaseIds.length, "direct use case")}, ${trace.downstreamUseCaseIds.length} downstream, ` +
      `${trace.upstreamUseCaseIds.length} upstream, ${trace.relatedUseCaseIds.length} related.`,
  );
  ctx.throwIfCancelled();

  ctx.stage("Analysing impact", 1);
  let output: ImpactAnalystOutput;
  let analysedBy: string;
  if (isEmptyScreenDiff(change)) {
    // Nothing functional changed: no AI call needed, the report just records the new version.
    output = mockImpactAnalysis({ model, change, trace });
    analysedBy = "deterministic (no functional changes)";
    ctx.info("No functional changes detected — the AI analysis was skipped.");
  } else {
    let format: OutputFormat | undefined;
    try {
      format = getFormat(model.formatId || project.formatId);
    } catch (err) {
      ctx.warn(
        `Use cases are summarised for the analyst because their format could not be loaded: ${errorMessage(err)}`,
      );
    }
    output = await generateStructured({
      connection,
      system: IMPACT_ANALYST_SYSTEM_PROMPT,
      content: [
        {
          type: "text",
          text: buildImpactUserPrompt({
            project,
            model,
            change,
            trace,
            format,
          }),
        },
      ],
      purpose: `impact-analysis:${change.targetKind}`,
      schema: impactAnalystSchema,
      schemaName: "impact_analysis",
      mock: () => mockImpactAnalysis({ model, change, trace }),
      signal: ctx.signal,
      onUsage: usageReporter(ctx),
      resources: ctx.resources,
      log: (level, message) => ctx.log(level, message),
    });
    analysedBy = connectionLabel(connection);
  }
  ctx.tick("Impact Analyst");
  const merged = mergeImpactAnalysis({ model, change, trace, output });

  ctx.stage("Saving report");
  ctx.throwIfCancelled();
  const now = new Date();
  const report: TrackedImpactReport = {
    id: newReportId(now),
    projectId: project.id,
    createdAt: now.toISOString(),
    modelGeneratedAt: model.generatedAt,
    change,
    deterministic: trace,
    items: merged.items,
    summary: merged.summary,
    risks: merged.risks,
    suggestedNewUseCases: merged.suggestedNewUseCases,
    status: "analysed",
    analysedBy,
    previousStatuses: {},
    ...(opts.pendingScreenAnalysis
      ? { pendingScreenAnalysis: opts.pendingScreenAnalysis }
      : {}),
  };

  // The use case the BA just edited is the new source of truth — never flag it stale.
  const exclude = new Set<string>(
    change.useCaseDiff ? trace.directUseCaseIds : [],
  );
  const attention = report.items.filter(needsAttention);
  const high = attention.filter((i) => i.severity === "high").length;

  await withProjectLock(project.id, async () => {
    const fresh = await requireModel(project.id);
    const { previousStatuses, markedIds } = markStale(
      fresh,
      report.items,
      report.id,
      exclude,
      await otherOpenReports(project.id, fresh),
    );
    report.previousStatuses = previousStatuses;

    const at = new Date().toISOString();
    for (const entry of opts.extraChangeLog?.(report) ?? [])
      fresh.changeLog.push(entry);
    fresh.changeLog.push({
      at,
      kind: "impact-analysed",
      summary: `Impact analysis ${report.id}: ${truncate(change.description, 140)} — ${
        attention.length
          ? `${plural(attention.length, "use case")} need${attention.length === 1 ? "s" : ""} attention (${high} high, ${attention.length - high} medium)`
          : "no use case needs to change"
      }.`,
      useCaseIds: report.items
        .filter((i) => i.severity !== "none")
        .map((i) => i.useCaseId),
      reportId: report.id,
    });

    // The report goes first: stale marks in the model must always point at an existing report.
    await saveImpactReport(report);
    try {
      await writeStatusChanges(await getProject(project.id), fresh, markedIds);
    } catch (err) {
      ctx.warn(
        `The report was saved, but the spec files could not be updated: ${errorMessage(err)}. Use "Re-render" on the Specs page to retry.`,
      );
    }
    await saveModel(project.id, fresh);
    if (markedIds.length)
      ctx.info(
        `Marked ${joinList(markedIds, 8)} as stale until the impact is applied or discarded.`,
      );
  });
  return report;
}

/**
 * traceImpact → Impact Analyst LLM call (with the change, the impacted use cases' full content and the
 * chain) → ImpactReport. Marks impacted use cases (severity high|medium) 'stale' (previous statuses kept
 * in the report), rewrites their front matter, appends a changeLog entry, persists the report + model.
 */
export async function runImpactAnalysis(
  ctx: JobContext,
  projectId: string,
  req: AnalyseImpactRequest,
): Promise<ImpactReport> {
  ctx.setStages([...IMPACT_STAGES]);
  const project = await getProject(projectId);
  const model = await requireModel(projectId);
  const change = normaliseChange(req.change);
  const connection = await textConnectionFor(
    ctx,
    project,
    req.connectionId,
    req.modelId,
  );
  return analyseAndPersist(ctx, project, model, change, connection);
}

/* ------------------------------------------------------------------ */
/* Apply                                                               */
/* ------------------------------------------------------------------ */

/** Removed element ids must not linger in rewritten content either. */
function dropRemovedReferences(
  uc: UseCase,
  removed: ReadonlySet<string>,
): UseCase {
  if (!removed.size) return uc;
  return {
    ...uc,
    businessRules: uc.businessRules.map((r) => {
      if (!r.elementId || !removed.has(r.elementId)) return r;
      const { elementId: _dropped, ...rest } = r;
      return rest;
    }),
    scenarios: uc.scenarios.map((s) => ({
      ...s,
      elementIds: s.elementIds.filter((id) => !removed.has(id)),
    })),
  };
}

/**
 * Rewrites the selected use cases with the Use Case Writer (revisionNotes = change + suggestedChanges),
 * merges report.pendingScreenAnalysis into the model when present, bumps revision, status → 'generated'
 * ('edited' when the BA had edited or approved it, so re-generation keeps protecting it),
 * re-renders their .md files (+ support files), marks the report applied/partially-applied. Persists.
 */
export async function runApplyImpact(
  ctx: JobContext,
  projectId: string,
  reportId: string,
  req: ApplyImpactRequest,
): Promise<ApplyImpactResult> {
  ctx.setStages([...APPLY_STAGES]);
  ctx.stage("Preparing changes");
  const project = await getProject(projectId);
  const report = await getImpactReport(projectId, reportId);
  if (report.status === "discarded") {
    throw new ConflictError(
      "This impact report was discarded. Run a new impact analysis to apply changes.",
    );
  }
  if (report.status === "applied")
    throw new ConflictError("This impact report has already been applied.");
  if (regeneratedSince(report, await requireModel(projectId))) {
    throw new ConflictError(
      "The specs were regenerated after this impact analysis, so its use case ids may now point at different use cases. Discard this report and run the impact analysis again.",
    );
  }
  // Pick up edits made to the .md files outside the app, so the rewrites start from what the BA sees (as Revise does).
  try {
    const sync = await syncFromDisk(project, { requireComplete: true });
    if (sync.changed.length)
      ctx.info(
        `Picked up edits made outside the app first: ${joinList(
          sync.changed.map((d) => d.useCaseId),
          8,
        )}.`,
      );
  } catch (err) {
    if (err instanceof CancelledError || ctx.signal.aborted) throw err;
    throw new ConflictError(
      "Changes were not applied because human edits could not be synchronized safely. Repair or restore the specification files and sync before retrying.",
    );
  }
  const model = await requireModel(projectId);
  const warnings: string[] = [];

  // Which use cases to rewrite (default: everything the report says needs work and is not done yet).
  const alreadyApplied = new Set(report.appliedUseCaseIds ?? []);
  const requested =
    req.useCaseIds ??
    report.items
      .filter((i) => i.severity !== "none" && !alreadyApplied.has(i.useCaseId))
      .map((i) => i.useCaseId);
  const known = new Set(model.useCases.map((u) => u.id));
  const selected: string[] = [];
  for (const raw of requested) {
    const id = known.has(raw) ? raw : normaliseUseCaseId(raw);
    if (!id || !known.has(id)) {
      warnings.push(`${raw} is no longer part of the specs and was skipped.`);
      continue;
    }
    if (!selected.includes(id)) selected.push(id);
  }
  if (!selected.length && !report.pendingScreenAnalysis) {
    throw new BadRequestError("Select at least one use case to update.");
  }
  const ixBefore = indexModel(model);
  const ordered = ixBefore.sortUseCases(selected);
  const selectedSet = new Set(ordered);

  // New elements go to the region's owner, else to a direct use case the BA chose to rewrite.
  const direct = report.deterministic.directUseCaseIds;
  const fallbackOwners = [
    ...direct.filter((id) => selectedSet.has(id)),
    ...direct,
  ];

  const working = structuredClone(model);
  let screenMerge: ScreenMergeResult | undefined;
  if (report.pendingScreenAnalysis) {
    screenMerge = mergeScreenAnalysis(
      working,
      report.pendingScreenAnalysis,
      fallbackOwners,
    );
    warnings.push(...screenMerge.warnings);
    if (screenMerge.merged) {
      ctx.info(
        `Merged the new analysis of ${screenMerge.screenTitle} (version ${screenMerge.toVersion}): ${screenMerge.addedElements.length} added, ${screenMerge.removedElements.length} removed elements.`,
      );
      for (const a of screenMerge.assignments) {
        if (selectedSet.has(a.useCaseId)) continue;
        const el = screenMerge.addedElements.find((e) => e.id === a.elementId);
        warnings.push(
          `New element ${el ? elementDisplayLabel(el) : a.elementId} was assigned to ${a.useCaseId}, which was not selected — rewrite it later to add its business rules.`,
        );
      }
      for (const [ucId, els] of screenMerge.removedByUseCase) {
        if (selectedSet.has(ucId)) continue;
        warnings.push(
          `${ucId} still describes removed ${joinList(els.map(elementDisplayLabel))} — it was not selected for rewriting.`,
        );
      }
    }
  }

  // The rewrites take a while; a use case saved in the app or edited on disk meanwhile must not be overwritten.
  const baselines = new Map<string, FileBaseline>();
  for (const id of new Set([
    ...ordered,
    ...(screenMerge?.touchedUseCaseIds ?? []),
  ])) {
    const uc = model.useCases.find((u) => u.id === id);
    if (uc) baselines.set(id, await fileBaseline(project, uc));
  }

  const connection = ordered.length
    ? await textConnectionFor(ctx, project, req.connectionId, req.modelId)
    : undefined;
  const format = getFormat(working.formatId || project.formatId);
  const includeImages = connection
    ? connectionSupportsVision(connection)
    : false;
  const wix = indexModel(working);

  ctx.stage("Rewriting use cases", ordered.length);
  const rewritten = new Map<string, UseCase>();
  const failed = new Set<string>();
  let firstError: unknown;
  await Promise.all(
    ordered.map(async (id) => {
      const uc = working.useCases.find((u) => u.id === id)!;
      const item = report.items.find((i) => i.useCaseId === id);
      const revisionNotes = buildRevisionNotes({
        report,
        useCase: uc,
        item,
        ix: wix,
        screenMerge,
      });
      try {
        const next = await writeUseCaseContent({
          ctx,
          project,
          model: working,
          useCase: uc,
          connection: connection!,
          format,
          revisionNotes,
          includeImages,
        });
        rewritten.set(id, next);
        try {
          const d = diffUseCases(uc, next);
          ctx.info(
            d.changedSections.length
              ? `${id} rewritten: ${d.summary}`
              : `${id} rewritten (no content changes).`,
          );
        } catch {
          ctx.info(`${id} rewritten.`);
        }
      } catch (err) {
        if (err instanceof CancelledError || ctx.signal.aborted) throw err;
        failed.add(id);
        firstError ??= err;
        warnings.push(`${id} could not be rewritten: ${errorMessage(err)}`);
        ctx.warn(`${id} could not be rewritten: ${errorMessage(err)}`);
      } finally {
        ctx.tick(id);
      }
    }),
  );
  if (ordered.length && !rewritten.size)
    throw (
      firstError ??
      new Error("None of the selected use cases could be rewritten.")
    );

  ctx.stage("Writing files");
  ctx.throwIfCancelled();
  let result: ApplyImpactResult | undefined;
  let finalStatus = report.status as ImpactStatus;
  await withProjectLock(projectId, async () => {
    const fresh = await requireModel(projectId);
    const now = new Date().toISOString();

    const others = await otherOpenReports(projectId, fresh, report.id);
    const changedReports = new Map<string, ImpactReport>();
    const changedDuringApply = async (
      current: UseCase | undefined,
    ): Promise<boolean> => {
      const base = current ? baselines.get(current.id) : undefined;
      return (
        !!base &&
        (current!.revision !== base.revision || (await fileChangedSince(base)))
      );
    };

    // Re-apply the (deterministic) screen merge to the freshly loaded model, then splice in the rewrites.
    const merge = report.pendingScreenAnalysis
      ? mergeScreenAnalysis(fresh, report.pendingScreenAnalysis, fallbackOwners)
      : undefined;
    const removed = new Set(merge?.removedElements.map((e) => e.id) ?? []);
    const updated: string[] = [];
    for (const id of ordered) {
      const next = rewritten.get(id);
      if (!next) continue;
      const idx = fresh.useCases.findIndex((u) => u.id === id);
      if (idx < 0) {
        warnings.push(
          `${id} was removed while the impact was being applied; its rewrite was discarded.`,
        );
        continue;
      }
      const current = fresh.useCases[idx];
      if (await changedDuringApply(current)) {
        // Saving the rewrite would silently overwrite that edit; the use case stays flagged for a later apply.
        failed.add(id);
        warnings.push(
          `${id} was edited while the impact was being applied, so its rewrite was not saved — apply this report again to update it.`,
        );
        continue;
      }
      const cleaned = dropRemovedReferences(next, removed);
      const merged: UseCase = {
        ...cleaned,
        // Structure comes from the model (after the screen merge); content from the writer.
        id: current.id,
        slug: current.slug,
        formatId: current.formatId,
        featureId: current.featureId,
        personaId: current.personaId,
        screenIds: current.screenIds,
        regionIds: current.regionIds,
        elementIds: current.elementIds,
        dependsOn: current.dependsOn,
        order: current.order,
        external: current.external,
        filePath: current.filePath,
        revision: current.revision + 1,
        status: statusAfterRewrite(
          current,
          report,
          others.find((r) => r.id === current.staleReason),
        ),
        updatedAt: now,
      };
      for (const r of keepFlagAfterRewrite(merged, others))
        changedReports.set(r.id, r);
      if (merged.status === "stale")
        warnings.push(
          `${id} stays marked stale: impact report ${merged.staleReason} also asks for changes to it.`,
        );
      fresh.useCases[idx] = merged;
      updated.push(id);
    }

    // Items the BA left out are no longer considered stale (unless another open report still flags them);
    // failed rewrites stay flagged.
    const keep = new Set([...updated, ...failed]);
    const restored = restoreStatuses(fresh, report, keep, others);
    for (const id of Object.keys(report.previousStatuses ?? {})) {
      if (!keep.has(id)) delete report.previousStatuses[id];
    }
    report.appliedUseCaseIds = [
      ...new Set([...(report.appliedUseCaseIds ?? []), ...updated]),
    ];
    report.status = finalStatus = reportStatusAfterApply(
      report,
      new Set(report.appliedUseCaseIds),
      failed,
    );
    report.appliedAt = now;

    const parts: string[] = [];
    if (updated.length) parts.push(`rewrote ${joinList(updated, 8)}`);
    if (merge?.merged)
      parts.push(`merged ${merge.screenTitle} version ${merge.toVersion}`);
    if (failed.size) parts.push(`${failed.size} could not be rewritten`);
    fresh.changeLog.push({
      at: now,
      kind: "impact-applied",
      summary: `Applied impact report ${report.id}: ${parts.length ? joinList(parts, parts.length) : "no changes"}.`,
      useCaseIds: updated,
      reportId: report.id,
    });

    const freshProject = await getProject(projectId);
    if (merge?.merged) {
      const screen = freshProject.screens.find((s) => s.id === merge.screenId);
      if (screen) {
        screen.analysedVersion = merge.toVersion;
        await saveProject(freshProject);
      }
    }

    // Rewritten or structurally changed use cases get a full re-render; status-only ones keep their bodies,
    // and so do structurally changed ones whose file was edited meanwhile (its front matter carries the ids).
    const touched: string[] = [];
    const editedMeanwhile: string[] = [];
    for (const id of new Set([
      ...updated,
      ...(merge?.touchedUseCaseIds ?? []),
    ])) {
      if (
        !updated.includes(id) &&
        (await changedDuringApply(fresh.useCases.find((u) => u.id === id)))
      )
        editedMeanwhile.push(id);
      else touched.push(id);
    }
    for (const id of editedMeanwhile) {
      warnings.push(
        `${id} was edited while the impact was being applied, so only its front matter was updated for the new screen — check its business rules and scenarios.`,
      );
    }
    const statusOnly = [...new Set([...restored, ...editedMeanwhile])].filter(
      (id) => !touched.includes(id),
    );
    let written: string[] = [];
    try {
      written = (await writeTouchedSpecs(freshProject, fresh, touched)).written;
      if (statusOnly.length)
        written.push(
          ...(await rewriteUseCaseFrontMatter(freshProject, fresh, statusOnly)),
        );
    } catch (err) {
      warnings.push(
        `The specs were updated, but the files could not be written: ${errorMessage(err)}. Use "Re-render" on the Specs page to retry.`,
      );
    }
    for (const other of changedReports.values()) await saveImpactReport(other);
    await saveImpactReport(report);
    await saveModel(projectId, fresh, { snapshot: true });
    result = { updatedUseCaseIds: updated, writtenFiles: written, warnings };
  });
  ctx.info(
    finalStatus === "applied"
      ? `Impact applied: ${plural(result!.updatedUseCaseIds.length, "use case")} updated.`
      : `Impact partially applied: ${plural(result!.updatedUseCaseIds.length, "use case")} updated; the rest can be applied later.`,
  );
  return result!;
}

/** Restores previousStatuses, marks the report discarded. Persists. */
export async function discardImpact(
  projectId: string,
  reportId: string,
): Promise<ImpactReport> {
  return withProjectLock(projectId, async () => {
    const report = await getImpactReport(projectId, reportId);
    if (report.status === "discarded") return report;
    if (report.status === "applied") {
      throw new ConflictError(
        "This impact report has already been applied, so it can no longer be discarded.",
      );
    }
    const model = await loadModel(projectId);
    if (model) {
      // A use case another open report still flags stays stale, flagged by that report.
      const restored = restoreStatuses(
        model,
        report,
        new Set(),
        await otherOpenReports(projectId, model, reportId),
      );
      if (restored.length) {
        await writeStatusChanges(await getProject(projectId), model, restored);
        await saveModel(projectId, model);
      }
    }
    report.status = "discarded";
    await saveImpactReport(report);
    return report;
  });
}

/* ------------------------------------------------------------------ */
/* Screen re-analysis                                                  */
/* ------------------------------------------------------------------ */

/**
 * After a screen image was replaced: analyse the new version (Screen Analyst with `previous`),
 * diffScreenAnalyses, then run the impact analysis with change.source = 'screen-replace' and
 * report.pendingScreenAnalysis = remapped analysis.
 */
export async function runScreenReanalysis(
  ctx: JobContext,
  projectId: string,
  screenId: string,
  req: ReanalyseScreenRequest,
): Promise<ImpactReport> {
  ctx.setStages([...REANALYSIS_STAGES]);
  const project = await getProject(projectId);
  const screen = project.screens.find((s) => s.id === screenId);
  if (!screen)
    throw new NotFoundError("Screen not found — it may have been deleted.");
  const model = await requireModel(projectId);
  const previous = model.screens.find((s) => s.screenId === screenId);
  if (!previous) {
    throw new BadRequestError(
      `“${screen.name}” has not been analysed yet, so there is nothing to compare with. Run Generate to include it in the specs.`,
    );
  }
  if (screen.version === previous.screenVersion) {
    ctx.warn(
      `The image of “${screen.name}” has not changed since it was analysed; any differences come from re-reading the same image.`,
    );
  }

  const choices = await savedProjectConnections(project);
  const visionConnection = await resolvePreferredConnection(
    project,
    req.connectionId,
    [
      {
        id: choices.visionConnectionId,
        modelId: choices.visionModelId,
        acknowledged: choices.visionAcknowledged,
      },
    ],
    {
      modelId: req.modelId,
      reading: true,
      refreshMetadata: !!ctx.resources,
      signal: ctx.signal,
      acknowledged: req.visionAcknowledged,
    },
  );
  if (!connectionSupportsVision(visionConnection)) {
    throw new BadRequestError(
      `The AI connection “${visionConnection.name}” cannot read images. Choose a connection with vision support to re-analyse screens.`,
    );
  }

  ctx.stage("Reading the new screen", 1);
  const analysis = await analyseScreen({
    ctx,
    project,
    screen,
    version: screen.version,
    connection: visionConnection,
    thoroughness: model.options?.thoroughness ?? "standard",
    takenScreenKeys: model.screens
      .filter((s) => s.screenId !== screenId)
      .map((s) => s.screenKey),
    previous,
  });
  ctx.tick(screen.name);

  ctx.stage("Comparing versions");
  const projectNames = new Map(project.screens.map((s) => [s.id, s.name]));
  const modelNames = new Map(model.screens.map((s) => [s.screenId, s.title]));
  const { diff, remapped } = diffScreenAnalysesWith(
    previous,
    { ...analysis, screenVersion: screen.version },
    {
      screenName: (id) => projectNames.get(id) ?? modelNames.get(id),
    },
  );
  ctx.info(diff.summary);

  const change: ChangeRequest = {
    targetKind: "screen",
    targetId: screenId,
    description: diff.summary,
    source: "screen-replace",
    screenDiff: diff,
  };
  // An explicitly chosen connection is used for both steps; otherwise the project's text connection.
  const analystConnection = req.connectionId
    ? visionConnection
    : await textConnectionFor(ctx, project);
  return analyseAndPersist(ctx, project, model, change, analystConnection, {
    pendingScreenAnalysis: remapped,
    extraChangeLog: (report) => [
      {
        at: new Date().toISOString(),
        kind: "screen-reanalysed",
        summary: `Re-analysed “${screen.name}” (version ${diff.fromVersion} → ${diff.toVersion}): ${diff.summary}`,
        useCaseIds: report.items
          .filter((i) => i.severity !== "none")
          .map((i) => i.useCaseId),
        reportId: report.id,
      },
    ],
  });
}
