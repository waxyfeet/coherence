import { readOwnedFile } from "../storage/fsUtils";
/**
 * OWNER: agents builder.
 * The multi-agent generation pipeline (see ARCHITECTURE.md § Agent pipeline).
 */
import type { GenerateResult } from "@shared/api";
import fs from "node:fs/promises";
import { specificationState } from "../specs/preservation";
import { createHash } from "node:crypto";
import type {
  GenerationOptions,
  ImpactReport,
  Persona,
  Project,
  ScreenAnalysis,
  SolutionModel,
  UseCase,
  UseCaseStatus,
} from "@shared/types";
import { slugify } from "@shared/types";
import { APP_VERSION } from "../config";
import { BadRequestError, CancelledError, errorMessage } from "../errors";
import { stopsTheRun } from "../llm/errors";
import { getFormat } from "../formats/registry";
import type { JobContext } from "../jobs/jobManager";
import { prepareImageForLLM } from "../llm/images";
import { connectionLabel, connectionSupportsVision } from "../llm/registry";
import {
  syncFromDisk,
  writeSpecs,
  type WriteSpecsResult,
} from "../specs/specStore";
import {
  getProject,
  listImpactReports,
  loadModel,
  saveModel,
  saveProject,
  screenImagePath,
  withProjectLock,
} from "../storage/projectStore";
import { resolveJobConnection, savedProjectConnections } from "./connections";
import {
  childAbort,
  deriveContext,
  isMockConnection,
  sortedScreens,
} from "./context";
import { assignScreenKeys, indexElements } from "./ids";
import {
  mapJourneys,
  normaliseJourney,
  type JourneyResult,
} from "./journeyMapper";
import { mockJourney } from "./mock/journeyMock";
import { planUseCases, type PlanResult } from "./planner";
import { stabilisePlan } from "./identity";
import {
  deterministicReview,
  numberFindings,
  reviewUseCases,
  selfRepair,
  type DraftFinding,
} from "./reviewer";
import {
  analysisFingerprint,
  cacheAnalysis,
  cacheReadingParts,
  readReadingParts,
  clearAnalysisCache,
  clearCommitMarker,
  readCachedAnalyses,
  readStage,
  settleInterruptedCommit,
  stageKey,
  writeCommitMarker,
  writeStage,
  type CommitMarker,
} from "./runState";
import { analyseScreen } from "./screenAnalyst";
import { joinAnd, normText, oneLine } from "./text";
import { writeUseCaseContent, writeUseCaseFromInventory } from "./writer";

/** Stage names shown in the UI, in order. */
export const GENERATION_STAGES = [
  "Preparing screens",
  "Reading screens",
  "Mapping journeys",
  "Planning use cases",
  "Writing use cases",
  "Reviewing",
  "Writing files",
] as const;

function isCancellation(err: unknown, signal: AbortSignal): boolean {
  return err instanceof CancelledError || signal.aborted;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/* Shapes a stage checkpoint must have to be reused; anything else runs the stage again. */
function isJourney(v: unknown): v is JourneyResult {
  return (
    isRecord(v) &&
    typeof v.summary === "string" &&
    ["personas", "flows", "dataEntities", "journeyOrder"].every((k) =>
      Array.isArray(v[k]),
    )
  );
}
function isPlanCheckpoint(
  v: unknown,
): v is { plan: PlanResult; nextUseCaseNumber: number } {
  return (
    isRecord(v) &&
    Number.isSafeInteger(v.nextUseCaseNumber) &&
    isRecord(v.plan) &&
    ["features", "useCases", "newIds", "notes"].every((k) =>
      Array.isArray((v.plan as Record<string, unknown>)[k]),
    )
  );
}
const isUseCaseFor =
  (id: string) =>
  (v: unknown): v is UseCase =>
    isRecord(v) &&
    v.id === id &&
    typeof v.title === "string" &&
    ["businessRules", "scenarios", "elementIds", "assumptions"].every((k) =>
      Array.isArray(v[k]),
    );

/** Errors that must reach the job rather than be replaced by a substitute (cancellation, a used-up limit). */
function mustStop(err: unknown, signal: AbortSignal): boolean {
  return isCancellation(err, signal) || stopsTheRun(err);
}

function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** The previous analysis can be reused when the image has not changed since it was analysed. */
function reusableAnalysis(
  options: GenerationOptions,
  screen: Project["screens"][number],
  previous: SolutionModel | null,
  fingerprint: string,
): ScreenAnalysis | undefined {
  if (!options.reuseScreenAnalyses || !previous) return undefined;
  const analysis = previous.screens.find((a) => a.screenId === screen.id);
  if (
    !analysis ||
    screen.analysedVersion !== screen.version ||
    analysis.screenVersion !== screen.version
  )
    return undefined;
  if (analysis.inputFingerprint !== fingerprint) return undefined;
  return analysis;
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const inB = new Set(b);
  const shared = new Set(a.filter((x) => inB.has(x))).size;
  return shared / new Set([...a, ...b]).size;
}

/** Share of elements from which a regenerated use case counts as the same one (element ids are stable across runs). */
const SAME_USE_CASE_OVERLAP = 0.5;

/**
 * Regenerated use cases that continue a previous one keep the BA's notes and the tracker links, and their
 * revision continues — so re-exporting updates the existing work items instead of duplicating them. A
 * successor covers mostly the same elements or has the same title (live models rephrase titles between
 * runs); each previous use case continues in at most one new one, best match first. Also returns the
 * previous use cases with tracker links that no new use case continues.
 */
export function carryOver(
  useCases: readonly UseCase[],
  previous: readonly UseCase[],
): { useCases: UseCase[]; orphaned: UseCase[] } {
  const pairs: { index: number; previous: UseCase; score: number }[] = [];
  useCases.forEach((uc, index) => {
    const slug = slugify(uc.title, 50);
    for (const p of previous) {
      const sameTitle =
        normText(p.title) === normText(uc.title) || p.slug === slug;
      const overlap = jaccard(uc.elementIds, p.elementIds);
      if (!sameTitle && overlap < SAME_USE_CASE_OVERLAP) continue;
      pairs.push({
        index,
        previous: p,
        score:
          (sameTitle ? 1 : 0) +
          overlap +
          0.1 * jaccard(uc.screenIds, p.screenIds),
      });
    }
  });
  pairs.sort((a, b) => b.score - a.score || a.index - b.index);
  const successorOf = new Map<number, UseCase>();
  const continued = new Set<string>();
  for (const pair of pairs) {
    if (successorOf.has(pair.index) || continued.has(pair.previous.id))
      continue;
    successorOf.set(pair.index, pair.previous);
    continued.add(pair.previous.id);
  }
  return {
    useCases: useCases.map((uc, index) => {
      const match = successorOf.get(index);
      return match
        ? {
            ...uc,
            notes: match.notes,
            external: match.external.map((x) => ({ ...x })),
            revision: match.revision + 1,
          }
        : uc;
    }),
    orphaned: previous.filter(
      (p) => !continued.has(p.id) && p.external.length > 0,
    ),
  };
}

/**
 * The status a use case had before an impact report flagged it stale (the report records it). An edited or
 * approved use case must keep its "preserve edited" protection while a report is open.
 */
export function statusBeforeStale(
  uc: Pick<UseCase, "id" | "status" | "staleReason">,
  reports: readonly ImpactReport[],
): UseCaseStatus {
  if (uc.status !== "stale") return uc.status;
  const recorded = (r: ImpactReport | undefined): UseCaseStatus | undefined =>
    r?.previousStatuses?.[uc.id];
  const isOpen = (r: ImpactReport): boolean =>
    r.status === "analysed" || r.status === "partially-applied";
  return (
    recorded(reports.find((r) => r.id === uc.staleReason)) ??
    recorded(reports.find((r) => isOpen(r) && recorded(r) !== undefined)) ??
    "stale"
  );
}

/**
 * Full run: read screens → map journeys → plan use cases → write use cases → review/repair → render .md.
 * Loads the project itself; persists the model (snapshot of the previous one), writes specs, updates the
 * project (status, lastGeneratedAt, screens[].analysedVersion).
 */
export async function runGeneration(
  ctx: JobContext,
  projectId: string,
  options: GenerationOptions,
): Promise<GenerateResult> {
  const warnings: string[] = [];
  const job = deriveContext(ctx, {
    onWarn: (message) => warnings.push(message),
  });
  job.setStages([...GENERATION_STAGES]);

  /* 1. Preparing screens ------------------------------------------------ */
  job.stage("Preparing screens", 1);
  let project = await getProject(projectId);
  const screens = sortedScreens(project);
  if (!screens.length) {
    throw new BadRequestError(
      `"${project.name}" has no screens yet. Add at least one screen on the Screens page, then generate again.`,
    );
  }
  const format = getFormat(project.formatId);
  const savedChoices = await savedProjectConnections(project);
  const vision = await resolveJobConnection(
    project,
    options.visionConnectionId,
    [
      {
        id: savedChoices.visionConnectionId,
        modelId: savedChoices.visionModelId,
        acknowledged: savedChoices.visionAcknowledged,
        use: "reading screens",
      },
    ],
    undefined,
    {
      modelId: options.visionModelId,
      reading: true,
      refreshMetadata: !!ctx.resources,
      signal: ctx.signal,
      acknowledged: options.visionAcknowledged,
    },
  );
  const visionConnection = vision.connection;
  const text = await resolveJobConnection(
    project,
    options.textConnectionId,
    [
      {
        id: savedChoices.textConnectionId,
        modelId: savedChoices.textModelId,
        use: "writing the specs",
      },
    ],
    visionConnection,
    {
      modelId: options.textModelId,
      refreshMetadata: !!ctx.resources,
      signal: ctx.signal,
    },
  );
  const textConnection = text.connection;
  // Persist the effective routes even when the request relied on remembered choices or defaults.
  options = {
    ...options,
    visionConnectionId: visionConnection.id,
    textConnectionId: textConnection.id,
    visionModelId: visionConnection.model,
    textModelId: textConnection.model,
    visionAcknowledged: vision.acknowledged ?? false,
  };

  // Edits made to the .md files outside the app must count as edits before deciding which use cases to keep
  // — but files an interrupted generation left behind are not edits.
  if (options.preserveEdited) {
    try {
      const { syncSafe } = await settleInterruptedCommit(projectId, (message) =>
        job.warn(message),
      );
      if (!syncSafe)
        throw new BadRequestError(
          "The interrupted generation must be recovered before preserving edits can be verified.",
        );
      const sync = await syncFromDisk(project, { requireComplete: true });
      if (sync?.changed.length)
        job.info(
          `Picked up edits made outside the app first: ${sync.changed.map((d) => d.useCaseId).join(", ")}.`,
        );
    } catch (err) {
      if (isCancellation(err, ctx.signal)) throw err;
      throw new BadRequestError(
        "Generation stopped because preserving human edits could not be verified. Check missing or unreadable specification files, repair any sync conflicts or interrupted generation, then retry. No AI request or replacement specification was made.",
      );
    }
  }

  const preservedState = options.preserveEdited
    ? await specificationState(project)
    : undefined;
  let previous: SolutionModel | null = null;
  try {
    previous = await loadModel(projectId);
  } catch (err) {
    if (options.preserveEdited)
      throw new BadRequestError(
        "Generation stopped because the previous model could not be read safely. Restore it before retrying with Preserve human edits enabled.",
      );
    job.warn(
      `The previous specification model could not be read (${errorMessage(err)}) — generating from scratch. The damaged file is kept in the history folder.`,
    );
  }

  // Screens read by an earlier run that failed before it was saved need not be paid for again.
  const cached = options.reuseScreenAnalyses
    ? await readCachedAnalyses(projectId)
    : new Map<string, never>();
  const screenKeys = assignScreenKeys(screens, [
    ...(previous?.screens ?? []),
    ...[...cached.values()].map((c) => c.analysis),
  ]);
  const reader = JSON.stringify({
    contract: "v3-screen-inventory-inspection-delta",
    account: visionConnection.id,
    provider: visionConnection.provider,
    model: visionConnection.model,
    endpoint: visionConnection.baseUrl,
    vision: visionConnection.vision,
    effort: visionConnection.effort,
    structured: visionConnection.structuredOutput,
    name: project.name,
    description: project.description,
    context: project.additionalContext,
  });
  const imageHashes = new Map<string, string>();
  for (const screen of screens)
    imageHashes.set(
      screen.id,
      createHash("sha256")
        .update(await readOwnedFile(screenImagePath(projectId, screen)))
        .digest("hex"),
    );
  const fingerprint = (screen: Project["screens"][number]) =>
    analysisFingerprint(
      screen,
      reader,
      options.thoroughness,
      imageHashes.get(screen.id),
    );
  const resumable = (
    screen: Project["screens"][number],
  ): ScreenAnalysis | undefined => {
    const entry = cached.get(screen.id);
    if (
      !entry ||
      entry.phase === "first-pass" ||
      entry.fingerprint !== fingerprint(screen)
    )
      return undefined;
    return entry.analysis.screenVersion === screen.version &&
      entry.analysis.screenKey === screenKeys.get(screen.id)
      ? entry.analysis
      : undefined;
  };
  const toRead = screens.filter(
    (s) =>
      !reusableAnalysis(options, s, previous, fingerprint(s)) && !resumable(s),
  );
  if (
    toRead.length &&
    !isMockConnection(visionConnection) &&
    !connectionSupportsVision(visionConnection)
  ) {
    throw new BadRequestError(
      `The AI connection "${visionConnection.name}" (${connectionLabel(visionConnection)}) cannot read images, so it cannot read the screens. Choose a connection with vision support for reading screens on the Overview or Generate page.`,
    );
  }

  project = await withProjectLock(projectId, async () => {
    const fresh = await getProject(projectId);
    if (
      preservedState &&
      (await specificationState(fresh)) !== preservedState
    ) {
      throw new BadRequestError(
        "Specification files or human edits changed during generation. No replacement was written. Sync and review the edits, then retry.",
      );
    }
    fresh.status = "generating";
    fresh.generationPreferences = { ...options };
    return saveProject(fresh);
  });
  job.info(
    `Generating specs for "${project.name}": ${plural(screens.length, "screen")}, reading with ${connectionLabel(visionConnection)}, writing with ${connectionLabel(textConnection)} (${options.thoroughness}, ${options.granularity} granularity).`,
  );
  // A larger project legitimately makes more requests: the run's runaway guard grows with it.
  ctx.resources?.expectWork(screens.length);

  job.progress(0, toRead.length || 1);
  if (toRead.length && !isMockConnection(visionConnection)) {
    // Decode (and tile) every image up front: a missing or broken file fails before any AI call is paid for.
    const prepared = await Promise.all(
      toRead.map(async (s) => {
        const images = await prepareImageForLLM(screenImagePath(projectId, s), {
          name: s.name,
        });
        job.tick(s.name);
        return images.length;
      }),
    );
    const tiled = prepared.filter((n) => n > 1).length;
    job.info(
      `Prepared ${plural(toRead.length, "screen image")}${tiled ? ` (${plural(tiled, "tall screen")} split into tiles)` : ""}.`,
    );
  } else {
    job.progress(toRead.length || 1, toRead.length || 1);
  }

  /* 2. Reading screens -------------------------------------------------- */
  job.stage("Reading screens", screens.length);
  const reading = childAbort(ctx.signal);
  const readCtx = deriveContext(job, { signal: reading.signal });
  let analyses: ScreenAnalysis[];
  try {
    analyses = await Promise.all(
      screens.map(async (screen) => {
        const reuse = reusableAnalysis(
          options,
          screen,
          previous,
          fingerprint(screen),
        );
        if (reuse) {
          job.info(
            `Reused the analysis of '${screen.name}' (image unchanged): ${plural(reuse.regions.length, "region")}, ${plural(reuse.elements.length, "element")}.`,
          );
          job.tick(screen.name);
          return reuse;
        }
        const resumed = resumable(screen);
        if (resumed) {
          job.info(
            `Reused the reading of '${screen.name}' from the run that did not finish: ${plural(resumed.regions.length, "region")}, ${plural(resumed.elements.length, "element")}.`,
          );
          job.tick(screen.name);
          return resumed;
        }
        try {
          const analysis = await analyseScreen({
            ctx: readCtx,
            project,
            screen,
            version: screen.version,
            connection: visionConnection,
            thoroughness: options.thoroughness,
            takenScreenKeys: [...screenKeys.entries()]
              .filter(([id]) => id !== screen.id)
              .map(([, key]) => key),
            previous: previous?.screens.find((a) => a.screenId === screen.id),
            readingParts: options.reuseScreenAnalyses
              ? await readReadingParts(
                  projectId,
                  screen.id,
                  fingerprint(screen),
                )
              : undefined,
            onReadingParts: (state) =>
              cacheReadingParts(
                projectId,
                screen.id,
                fingerprint(screen),
                state,
              ),
            firstPass: (() => {
              const entry = cached.get(screen.id);
              return entry?.phase === "first-pass" &&
                entry.fingerprint === fingerprint(screen) &&
                entry.analysis.screenVersion === screen.version &&
                entry.analysis.screenKey === screenKeys.get(screen.id)
                ? entry.analysis
                : undefined;
            })(),
            onFirstPass: async (analysis) => {
              analysis.inputFingerprint = fingerprint(screen);
              await cacheAnalysis(
                projectId,
                fingerprint(screen),
                analysis,
                "first-pass",
              );
            },
          });
          analysis.inputFingerprint = fingerprint(screen);
          await cacheAnalysis(projectId, fingerprint(screen), analysis);
          job.tick(screen.name);
          return analysis;
        } catch (err) {
          // One unreadable screen fails the run; stop paying for the others.
          reading.abort(err);
          throw err;
        }
      }),
    );
  } finally {
    reading.dispose();
  }
  const elementCount = analyses.reduce((n, a) => n + a.elements.length, 0);
  if (!elementCount) {
    throw new BadRequestError(
      "No elements were found on any screen, so there is nothing to specify. Check that the images show the screen designs and try again.",
    );
  }

  // Everything the writing stages depend on besides their own inputs. A run that stops keeps each finished stage
  // under a hash of this and those inputs (stage checkpoints, runState), so Try again resumes where it stopped.
  const writer = JSON.stringify({
    contract: "stages-v1",
    app: APP_VERSION,
    account: textConnection.id,
    provider: textConnection.provider,
    model: textConnection.model,
    endpoint: textConnection.baseUrl,
    vision: textConnection.vision,
    effort: textConnection.effort,
    structured: textConnection.structuredOutput,
    name: project.name,
    description: project.description,
    context: project.additionalContext,
    thoroughness: options.thoroughness,
    format: format.info.id,
  });
  const resume = options.reuseScreenAnalyses;

  /* 3. Mapping journeys ------------------------------------------------- */
  job.stage("Mapping journeys", 1);
  const journeyKey = stageKey("journey", writer, analyses);
  const resumedJourney = resume
    ? await readStage(projectId, "journey", journeyKey, isJourney)
    : undefined;
  let journey: JourneyResult;
  if (resumedJourney) {
    journey = resumedJourney;
    job.info("Reused the journey map from the run that did not finish.");
  } else {
    try {
      journey = await mapJourneys({
        ctx: job,
        project,
        analyses,
        connection: textConnection,
      });
    } catch (err) {
      if (mustStop(err, ctx.signal)) throw err;
      // Flows still come from the navigation the screen analyst recorded; losing the paid-for readings is worse.
      job.warn(
        `The Journey Mapper agent failed (${errorMessage(err)}) — mapped the journeys from the screen inventory instead.`,
      );
      journey = normaliseJourney(
        mockJourney(project, analyses),
        project,
        analyses,
      ).journey;
    }
    await writeStage(projectId, "journey", journeyKey, journey);
  }
  job.tick("Journeys");
  job.info(
    `Mapped ${plural(journey.personas.length, "persona")} (${joinAnd(journey.personas.map((p) => p.name))}) and ${plural(journey.flows.length, "flow")} between ${plural(analyses.length, "screen")}.`,
  );

  /* 4. Planning use cases ----------------------------------------------- */
  job.stage("Planning use cases", 1);
  // An open impact report keeps a flagged use case's real status; edited/approved work stays protected
  // (and stays flagged, so the report can still be discarded).
  const reports =
    options.preserveEdited &&
    previous?.useCases.some((u) => u.status === "stale")
      ? await listImpactReports(projectId).catch(() => [] as ImpactReport[])
      : [];
  const locked =
    options.preserveEdited && previous
      ? previous.useCases.filter((u) => {
          const status = statusBeforeStale(u, reports);
          return status === "edited" || status === "approved";
        })
      : [];
  if (locked.length) {
    job.info(
      `Keeping ${plural(locked.length, "edited or approved use case")} unchanged: ${locked.map((u) => u.id).join(", ")}.`,
    );
    const flagged = locked.filter((u) => u.status === "stale");
    if (flagged.length) {
      job.info(
        `${joinAnd(flagged.map((u) => `${u.id} (${u.staleReason ?? "impact report"})`))} ${flagged.length === 1 ? "is" : "are"} still flagged by an impact analysis — discard the report or update ${flagged.length === 1 ? "it" : "them"} by hand.`,
      );
    }
    const known = indexElements(analyses);
    for (const u of locked) {
      const gone = u.elementIds.filter((id) => !known.has(id));
      if (gone.length)
        job.warn(
          `${u.id} (kept as ${u.status}) refers to ${plural(gone.length, "element")} no longer on the screens (${gone.slice(0, 5).join(", ")}${gone.length > 5 ? ", …" : ""}) — review it.`,
        );
    }
  }
  const planKey = stageKey(
    "plan",
    writer,
    analyses,
    journey,
    options.granularity,
    locked,
    previous?.generatedAt ?? null,
    previous?.features ?? [],
  );
  const resumedPlan = resume
    ? await readStage(projectId, "plan", planKey, isPlanCheckpoint)
    : undefined;
  let plan: PlanResult;
  let nextUseCaseNumber: number;
  if (resumedPlan) {
    ({ plan, nextUseCaseNumber } = resumedPlan);
    job.info("Reused the plan from the run that did not finish.");
    job.tick("Plan");
  } else {
    plan = await planUseCases({
      ctx: job,
      project,
      analyses,
      journey,
      connection: textConnection,
      granularity: options.granularity,
      locked,
      lockedFeatures: previous?.features ?? [],
      formatId: format.info.id,
    });
    job.tick("Plan");
    nextUseCaseNumber = stabilisePlan(plan, previous);
    await writeStage(projectId, "plan", planKey, { plan, nextUseCaseNumber });
  }
  job.info(
    `Planned ${plural(plan.newIds.length, "use case")} in ${plural(plan.features.length, "feature")}${locked.length ? ` (plus ${locked.length} kept)` : ""}.`,
  );

  // Locked use cases may point at personas the new journey map named differently — keep those personas.
  const personas: Persona[] = [...journey.personas];
  for (const u of locked) {
    if (personas.some((p) => p.id === u.personaId)) continue;
    const old = previous?.personas.find((p) => p.id === u.personaId);
    if (old) personas.push(old);
  }

  const now = new Date().toISOString();
  const model: SolutionModel = {
    nextUseCaseNumber,
    schemaVersion: 1,
    projectId,
    formatId: format.info.id,
    generatedAt: now,
    updatedAt: now,
    generator: {
      vision: connectionLabel(visionConnection),
      text: connectionLabel(textConnection),
    },
    options: { ...options },
    summary: journey.summary,
    personas,
    screens: analyses,
    flows: journey.flows,
    features: plan.features,
    useCases: plan.useCases,
    review: [],
    changeLog: previous?.changeLog ?? [],
  };

  /* 5. Writing use cases ------------------------------------------------ */
  const newIds = new Set(plan.newIds);
  const stubs = plan.useCases.filter((u) => newIds.has(u.id));
  job.stage("Writing use cases", stubs.length);
  const includeImages = connectionSupportsVision(textConnection);
  const written = new Map<string, UseCase>();
  const failures: { id: string; error: unknown }[] = [];
  const planHash = stageKey(plan, nextUseCaseNumber);
  await Promise.all(
    stubs.map(async (stub) => {
      const name = `use-case-${stub.id}`;
      const key = stageKey("use-case", writer, planHash, stub, includeImages);
      try {
        const resumed = resume
          ? await readStage(projectId, name, key, isUseCaseFor(stub.id))
          : undefined;
        if (resumed) {
          written.set(stub.id, resumed);
          job.info(
            `Reused ${resumed.id} "${oneLine(resumed.title, 70)}" from the run that did not finish.`,
          );
          return;
        }
        const uc = await writeUseCaseContent({
          ctx: job,
          project,
          model,
          useCase: stub,
          connection: textConnection,
          format,
          includeImages,
        });
        if (isMockConnection(textConnection))
          uc.assumptions = [
            ...uc.assumptions,
            "Synthetic offline fixture content. No AI model analysed or wrote this use case. Review it as a demonstration, not as verified requirements.",
          ];
        written.set(stub.id, uc);
        await writeStage(projectId, name, key, uc);
        job.info(
          `Wrote ${uc.id} "${oneLine(uc.title, 70)}": ${plural(uc.businessRules.length, "rule")}, ${plural(uc.scenarios.length, "scenario")}.`,
        );
      } catch (err) {
        if (isCancellation(err, ctx.signal)) throw err;
        failures.push({ id: stub.id, error: err });
      } finally {
        job.tick(stub.id);
      }
    }),
  );
  // A used-up limit stops the run; its writers were paused together, so the others failed without a request.
  const limit = failures.find((f) => stopsTheRun(f.error));
  if (limit) throw limit.error;
  if (stubs.length && failures.length === stubs.length) throw failures[0].error;

  const fallbackFindings: DraftFinding[] = [];
  for (const { id, error } of failures) {
    const stub = stubs.find((s) => s.id === id)!;
    const reason = errorMessage(error);
    written.set(
      id,
      writeUseCaseFromInventory({ project, model, useCase: stub }, reason),
    );
    job.warn(
      `${id} "${oneLine(stub.title, 60)}" could not be written by the AI (${reason}) — generated it from the screen inventory instead.`,
    );
    fallbackFindings.push({
      severity: "warning",
      category: "other",
      useCaseIds: [id],
      message: `${id} could not be written by the AI (${oneLine(reason, 160)}); its content was generated from the screen inventory only.`,
      suggestion: `Use "Revise with AI" on ${id} or re-generate when the AI connection is available.`,
      resolved: false,
    });
  }

  const previousUseCases = (previous?.useCases ?? []).filter(
    (u) => !locked.some((l) => l.id === u.id),
  );
  const carried = carryOver(
    plan.useCases
      .filter((u) => written.has(u.id))
      .map((u) => written.get(u.id)!),
    previousUseCases,
  );
  const successors = new Map(carried.useCases.map((u) => [u.id, u]));
  model.useCases = plan.useCases.map((u) => successors.get(u.id) ?? u);
  for (const p of carried.orphaned) {
    job.warn(
      `${p.id} "${oneLine(p.title, 60)}" of the previous specs was exported (${p.external.map((x) => `${x.system} ${x.key}`).join(", ")}), but no new use case continues it — the next export creates new work items and leaves ${p.external.length === 1 ? "that one" : "those"} as they are.`,
    );
  }

  /* 6. Reviewing -------------------------------------------------------- */
  const thorough = options.thoroughness === "thorough";
  job.stage("Reviewing", thorough ? 2 : 1);
  const deterministic = deterministicReview(model);
  let agentFindings: DraftFinding[] = [];
  try {
    agentFindings = await reviewUseCases({
      ctx: job,
      project,
      model,
      connection: textConnection,
      deterministic,
    });
  } catch (err) {
    if (mustStop(err, ctx.signal)) throw err;
    job.warn(
      `The Reviewer agent failed (${errorMessage(err)}) — only the automatic checks were applied.`,
    );
  }
  job.tick("Review");

  let findings: DraftFinding[] = [...deterministic, ...agentFindings];
  if (thorough) {
    const repair = await selfRepair({
      ctx: job,
      project,
      model,
      connection: textConnection,
      format,
      includeImages,
      deterministic,
      agent: agentFindings,
      lockedIds: new Set(locked.map((u) => u.id)),
    });
    model.useCases = repair.useCases;
    findings = repair.findings;
    job.tick("Self-repair");
  }
  const executionFindings: DraftFinding[] = [
    ...new Set(
      warnings.filter(
        (w) =>
          w.startsWith("Adapting this stage") ||
          /^The (Journey Mapper|Planner|Reviewer) agent failed/.test(w),
      ),
    ),
  ].map((message) => ({
    severity: "warning",
    category: "other",
    useCaseIds: [],
    message,
    suggestion:
      "Review the affected stage and cross-screen requirements. A completed draft is not a guarantee that every AI check completed.",
    resolved: false,
  }));
  const review = numberFindings([
    ...findings,
    ...fallbackFindings,
    ...executionFindings,
  ]);
  model.review = review;
  const open = review.filter((f) => !f.resolved);
  const errors = open.filter((f) => f.severity === "error").length;
  const warns = open.filter((f) => f.severity === "warning").length;
  const resolvedCount = review.length - open.length;
  job.info(
    `Review: ${plural(errors, "error")}, ${plural(warns, "warning")}, ${plural(open.length - errors - warns, "note")}${resolvedCount ? `; ${resolvedCount} resolved by self-repair` : ""}.`,
  );

  /* 7. Writing files ---------------------------------------------------- */
  job.stage("Writing files", 1);
  job.throwIfCancelled();
  const outcome = await withProjectLock(projectId, async () => {
    const fresh = await getProject(projectId);
    if (preservedState && (await specificationState(fresh)) !== preservedState)
      throw new BadRequestError(
        "Specification files or human edits changed during generation. No replacement was written. Sync and review the edits, then retry.",
      );
    // Changes logged while we were generating (e.g. a BA edit) must not be lost.
    const current = await loadModel(projectId).catch(() => null);
    const finishedAt = new Date().toISOString();
    model.changeLog = [
      ...(current?.changeLog ?? previous?.changeLog ?? []),
      {
        at: finishedAt,
        kind: "generated",
        summary: `Generated ${plural(plan.newIds.length, "use case")} in ${plural(model.features.length, "feature")} from ${plural(analyses.length, "screen")} (${connectionLabel(visionConnection)} / ${connectionLabel(textConnection)}, ${options.thoroughness}, ${options.granularity})${locked.length ? `; kept ${locked.map((u) => u.id).join(", ")} unchanged` : ""}.`,
        useCaseIds: [...plan.newIds],
      },
    ];
    model.updatedAt = finishedAt;
    // Until the model is saved, the files written below do not match model.json; the marker stops a later
    // run from reading them back as the BA's edits if this one fails or dies half-way (see runState).
    const commit: CommitMarker = {
      generatedAt: model.generatedAt,
      startedAt: Date.now(),
    };
    await writeCommitMarker(projectId, commit);
    let files: WriteSpecsResult = { written: [], preserved: [], warnings: [] };
    try {
      // Kept files get fresh front matter and summary links: the other use cases may have new ids.
      files = await writeSpecs(fresh, model, {
        preserveEdited: options.preserveEdited,
        embedScreenImages: options.embedScreenImages,
        refreshPreserved: true,
      });
      for (const warning of files.warnings ?? []) job.warn(warning);
    } catch (err) {
      // The generation itself succeeded (and was paid for): save it, and let the BA write the files again.
      commit.failedAt = Date.now();
      await writeCommitMarker(projectId, commit);
      job.warn(
        `The specs were generated and saved, but the files could not all be written (${errorMessage(err)}). Fix the cause (for example, close a program that has a file of the output folder open), then use "Re-render" on the Specs page.`,
      );
    }
    await saveModel(projectId, model, { snapshot: true });
    if (commit.failedAt === undefined) await clearCommitMarker(projectId);
    await clearAnalysisCache(projectId);

    fresh.status = errors > 0 ? "needs-review" : "specified";
    fresh.lastGeneratedAt = finishedAt;
    for (const s of fresh.screens) {
      const analysis = analyses.find((a) => a.screenId === s.id);
      if (analysis) s.analysedVersion = analysis.screenVersion;
    }
    await saveProject(fresh);
    return { ...files, outputDir: fresh.outputDir };
  });
  job.tick("Files");
  job.info(
    `Wrote ${plural(outcome.written.length, "file")} to ${outcome.outputDir}${outcome.preserved.length ? ` (${plural(outcome.preserved.length, "edited file")} left untouched)` : ""}.`,
  );

  return {
    useCaseCount: model.useCases.length,
    featureCount: model.features.length,
    screenCount: analyses.length,
    fileCount: outcome.written.length,
    outputDir: outcome.outputDir,
    preservedFiles: outcome.preserved,
    warnings,
    review,
  };
}
