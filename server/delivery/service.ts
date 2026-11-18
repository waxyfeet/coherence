/**
 * Delivery planning service: the plan job (read-only discovery → reviewed content → deterministic plan → optional
 * bounded AI suggestions → validation), local re-planning when the BA answers a decision, approval and previews.
 * Plans are portable project files (<project>/delivery/plans/<system>.json); nothing here writes to a tracker.
 */
import path from "node:path";
import type { DeliveryPlanRequest, DeliveryPlanView } from "@shared/api";
import type {
  DeliveryPlan,
  DeliveryPlanOptions,
  DestinationSchema,
  PlanAiRecord,
} from "@shared/delivery";
import type { ExternalSystem, Project, SolutionModel } from "@shared/types";
import { BadRequestError, ConflictError, NotFoundError } from "../errors";
import { paths } from "../config";
import { loadExportContent, type ExportContent } from "../export/content";
import { requireIntegration } from "../export/exporter";
import { isUnsettled, listExportJournals } from "../export/journal";
import { getFormat } from "../formats/registry";
import { activeJobFor, type JobContext } from "../jobs/jobManager";
import {
  resolveJobConnection,
  savedProjectConnections,
} from "../agents/connections";
import {
  getProject,
  loadModel,
  withProjectLock,
} from "../storage/projectStore";
import { readJsonIfExists, writeJsonAtomic } from "../storage/fsUtils";
import {
  DELIVERY_SCHEMA_VERSION,
  NewerDataError,
  isNewerFormat,
} from "../storage/formats";
import { suggestMappings } from "./aiMapping";
import {
  configuredIdentity,
  discoverDestination,
  readCachedSchema,
  sameDestination,
  type TrackerSettings,
} from "./discovery";
import { contentFingerprint } from "./evidence";
import {
  buildPlan,
  journalTargetFingerprint,
  type PlanInputs,
} from "./planner";
import { readProfile, ruleFor, saveRules } from "./profiles";
import {
  readPublished,
  readRemoteSnapshot,
  writeRemoteSnapshot,
} from "./publishRecord";
import { readExistingItems, remoteInputs } from "./remoteRead";
import { publishingState } from "./publishing";
import { renderItem, type PayloadPreview } from "./render";
import { checkText } from "./values";
import { planFingerprint, validatePlan } from "./validate";

export const DELIVERY_PLAN_STAGES = [
  "Reading the destination",
  "Reading reviewed requirements",
  "Mapping",
  "Validating",
] as const;

const SYSTEMS: ExternalSystem[] = ["jira", "azdo", "github"];

export function assertSystem(value: string): ExternalSystem {
  if (!SYSTEMS.includes(value as ExternalSystem))
    throw new BadRequestError(`Unknown destination "${value}".`);
  return value as ExternalSystem;
}

function planFile(projectId: string, system: ExternalSystem): string {
  return path.join(
    paths.projectDir(projectId),
    "delivery",
    "plans",
    `${system}.json`,
  );
}

/** The stored plan, or undefined; a damaged file is reported rather than silently replaced. */
export async function readPlan(
  projectId: string,
  system: ExternalSystem,
): Promise<DeliveryPlan | undefined> {
  const raw = await readJsonIfExists<DeliveryPlan>(
    planFile(projectId, system),
  ).catch(() => {
    throw new ConflictError(
      `The saved ${system} delivery plan could not be read. Plan again to replace it.`,
    );
  });
  if (!raw) return undefined;
  // A newer plan is refused, never replaced by planning again with this version (installer finding ST-06).
  if (isNewerFormat(raw.schemaVersion, DELIVERY_SCHEMA_VERSION))
    throw new NewerDataError(`The saved ${system} delivery plan`);
  if (
    raw.schemaVersion !== 1 ||
    raw.system !== system ||
    raw.projectId !== projectId ||
    !Array.isArray(raw.items) ||
    !Array.isArray(raw.decisions)
  )
    throw new ConflictError(
      `The saved ${system} delivery plan is not a plan this version understands. Plan again to replace it.`,
    );
  return raw;
}

async function writePlan(plan: DeliveryPlan) {
  const existing = await readJsonIfExists<{ schemaVersion?: unknown }>(
    planFile(plan.projectId, plan.system),
  ).catch(() => undefined);
  if (isNewerFormat(existing?.schemaVersion, DELIVERY_SCHEMA_VERSION))
    throw new NewerDataError(`The saved ${plan.system} delivery plan`);
  await writeJsonAtomic(planFile(plan.projectId, plan.system), plan);
}

interface Loaded {
  project: Project;
  model: SolutionModel;
  contents: ExportContent[];
  missingIds: string[];
}

async function loadSources(
  projectId: string,
  selection: string[] | undefined,
  onEach?: (id: string) => void,
): Promise<Loaded> {
  const project = await getProject(projectId);
  const model = await loadModel(projectId);
  if (!model?.useCases.length)
    throw new BadRequestError(
      "This project has no use cases yet — generate and review the specifications first.",
    );
  const format = getFormat(model.formatId || project.formatId);
  const wanted = selection ? new Set(selection) : undefined;
  const contents: ExportContent[] = [];
  for (const uc of model.useCases) {
    if (wanted && !wanted.has(uc.id)) continue;
    contents.push(await loadExportContent(project, model, uc, format));
    onEach?.(uc.id);
  }
  const missingIds = selection
    ? selection.filter((id) => !model.useCases.some((u) => u.id === id))
    : [];
  return { project, model, contents, missingIds };
}

async function uncertainUseCases(
  projectId: string,
  system: ExternalSystem,
  settings: TrackerSettings,
): Promise<Set<string>> {
  const fingerprint = journalTargetFingerprint(system, settings);
  const ids = new Set<string>();
  for (const journal of await listExportJournals(projectId))
    if (journal.targetFingerprint === fingerprint)
      for (const op of journal.operations)
        if (isUnsettled(op) && op.key.startsWith("item:"))
          ids.add(op.key.slice(5));
  return ids;
}

function optionsFrom(req: DeliveryPlanRequest): DeliveryPlanOptions {
  return {
    ...(req.useCaseIds?.length
      ? { useCaseIds: [...new Set(req.useCaseIds)] }
      : {}),
    includeUnapproved: !!req.includeUnapproved,
    groupByFeature: req.groupByFeature ?? true,
    linkDependencies: req.linkDependencies ?? true,
    useAi: !!req.useAi,
  };
}

function plannerInput(
  base: Omit<PlanInputs, "previous" | "suggestions" | "ai">,
  previous: DeliveryPlan | undefined,
): PlanInputs {
  // Answers only carry over when the plan is for the same destination.
  const same =
    previous &&
    sameDestination(previous.destination.identity, base.schema.identity);
  return { ...base, ...(same ? { previous } : {}) };
}

/** The plan job. AI runs only when requested and only for questions left open by deterministic mapping. */
export async function runDeliveryPlan(
  ctx: JobContext,
  projectId: string,
  req: DeliveryPlanRequest,
) {
  ctx.setStages([...DELIVERY_PLAN_STAGES]);
  const system = req.target;
  ctx.stage("Reading the destination", 1);
  const settings = (await requireIntegration(system)) as TrackerSettings;
  const { schema, fromCache } = await discoverDestination(system, settings, {
    refresh: !!req.refreshDestination,
    signal: ctx.signal,
  });
  ctx.info(
    fromCache
      ? `Using the destination structure read on ${schema.discoveredAt.slice(0, 10)} (choose "Refresh destination" to read it again).`
      : `Read the destination's structure with ${schema.requestCount} read-only request(s); nothing was changed there.`,
  );
  for (const gap of schema.gaps) ctx.warn(gap);
  ctx.tick();

  const options = optionsFrom(req);
  const { project, model, contents, missingIds } = await (async () => {
    ctx.stage("Reading reviewed requirements");
    return loadSources(projectId, options.useCaseIds, (id) => ctx.tick(id));
  })();
  ctx.throwIfCancelled();

  ctx.stage("Mapping", 1);
  const previous = await readPlan(projectId, system).catch(() => undefined);
  const base = {
    projectId,
    project,
    model,
    system,
    settings,
    schema,
    contents,
    missingIds,
    options,
    profile: await readProfile(schema.identity),
    uncertainUseCaseIds: await uncertainUseCases(projectId, system, settings),
    published: await readPublished(projectId, schema.identity),
  };
  // Work items published earlier are read (GET only) so changes can be compared with what the team did there.
  const snapshot = await readExistingItems(
    system,
    settings,
    buildPlan(plannerInput(base, previous)),
    ctx,
  );
  if (snapshot)
    await withProjectLock(projectId, () =>
      writeRemoteSnapshot(projectId, schema.identity, snapshot),
    );
  Object.assign(base, remoteInputs(snapshot));
  let draft = buildPlan(plannerInput(base, previous));
  let ai: PlanAiRecord = {
    requested: false,
    outcome: "not-requested",
    questions: 0,
    accepted: 0,
    rejected: 0,
  };
  if (options.useAi) {
    try {
      const saved = await savedProjectConnections(project);
      const { connection } = await resolveJobConnection(
        project,
        undefined,
        [
          {
            id: saved.textConnectionId,
            modelId: saved.textModelId,
            use: "writing the specs",
          },
        ],
        undefined,
        { refreshMetadata: !!ctx.resources, signal: ctx.signal },
      );
      const included = contents.filter((c) =>
        draft.sources.some((s) => s.useCaseId === c.useCase.id && s.included),
      );
      const result = await suggestMappings({
        draft,
        schema,
        contents: included,
        connection,
        signal: ctx.signal,
        resources: ctx.resources,
        log: (level, message) => ctx.log(level, message),
        onUsage: (u) =>
          ctx.addUsage({
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            ...(u.costUsd !== undefined ? { costUsd: u.costUsd } : {}),
          }),
      });
      ai = result.record;
      if (result.suggestions.length)
        draft = buildPlan({
          ...plannerInput(base, previous),
          suggestions: result.suggestions,
          ai,
        });
    } catch (err) {
      if ((err as Error)?.name === "CancelledError") throw err;
      ai = {
        requested: true,
        outcome: "unavailable",
        questions: 0,
        accepted: 0,
        rejected: 0,
        message: `AI was not used: ${(err as Error)?.message ?? String(err)} The plan was prepared without it.`,
      };
    }
    if (ai.message) ctx.info(ai.message);
  }
  draft = { ...draft, ai };
  ctx.tick();

  ctx.stage("Validating", 1);
  const plan = validatePlan(draft, {
    schema,
    contents: new Map(contents.map((c) => [c.useCase.id, c])),
  });
  await withProjectLock(projectId, () => writePlan(plan));
  ctx.tick();
  ctx.info(
    `${plan.summary.items} item(s) planned · ${plan.summary.blocking} blocking problem(s) · ${plan.summary.openDecisions} open decision(s). Nothing was sent to the destination.`,
  );
  return {
    target: system,
    planId: plan.id,
    revision: plan.revision,
    readiness: plan.readiness,
    summary: plan.summary,
    ai: plan.ai,
  };
}

async function schemaForPlan(
  plan: DeliveryPlan,
  settings: TrackerSettings,
): Promise<DestinationSchema> {
  const identity = configuredIdentity(plan.system, settings);
  if (!sameDestination(identity, plan.destination.identity))
    throw new ConflictError(
      "The destination in Settings changed since this plan was made. Plan again for the new destination.",
    );
  const schema = await readCachedSchema(identity);
  if (!schema)
    throw new ConflictError(
      "The saved destination structure is missing. Plan again to read it.",
    );
  return schema;
}

/** Re-plan locally (no AI, no destination requests) after the BA changes an answer or an attachment. */
async function replan(
  projectId: string,
  system: ExternalSystem,
  change: (previous: DeliveryPlan) => DeliveryPlan,
): Promise<DeliveryPlan> {
  return withProjectLock(projectId, async () => {
    const stored = await readPlan(projectId, system);
    if (!stored)
      throw new NotFoundError(
        "There is no delivery plan for this destination yet.",
      );
    const settings = (await requireIntegration(system)) as TrackerSettings;
    const schema = await schemaForPlan(stored, settings);
    const previous = change(stored);
    const loaded = await loadSources(projectId, stored.options.useCaseIds);
    const draft = buildPlan({
      projectId,
      ...loaded,
      system,
      settings,
      schema,
      options: stored.options,
      profile: await readProfile(schema.identity),
      uncertainUseCaseIds: await uncertainUseCases(projectId, system, settings),
      published: await readPublished(projectId, schema.identity),
      ...remoteInputs(await readRemoteSnapshot(projectId, schema.identity)),
      previous,
      ai: stored.ai,
    });
    const plan = validatePlan(draft, {
      schema,
      contents: new Map(loaded.contents.map((c) => [c.useCase.id, c])),
    });
    await writePlan(plan);
    return plan;
  });
}

/** After a publish or a check: the plan again (no AI, no requests), so published items show as already there. */
export async function replanAfterPublish(
  projectId: string,
  system: ExternalSystem,
): Promise<DeliveryPlan> {
  return replan(projectId, system, (previous) => previous);
}

/** Answers and settings can't change while a publish is reading the plan. */
function assertNotPublishing(projectId: string) {
  if (activeJobFor(projectId)?.kind === "delivery-publish")
    throw new ConflictError(
      "Publishing is running for this project. Wait for it to finish, then change the plan.",
    );
}

/** Why the stored plan no longer matches the project, the settings or the destination snapshot. */
export async function planStaleness(plan: DeliveryPlan): Promise<string[]> {
  const reasons: string[] = [];
  const settings = (await requireIntegration(plan.system).catch(
    () => undefined,
  )) as TrackerSettings | undefined;
  if (!settings) return ["The destination is no longer set up in Settings."];
  if (
    !sameDestination(
      configuredIdentity(plan.system, settings),
      plan.destination.identity,
    )
  )
    return ["The destination in Settings changed since this plan was made."];
  const schema = await readCachedSchema(plan.destination.identity);
  if (schema && schema.fingerprint !== plan.destination.schemaFingerprint)
    reasons.push(
      "The destination's structure changed since this plan was made.",
    );
  const loaded = await loadSources(
    plan.projectId,
    plan.options.useCaseIds,
  ).catch(() => undefined);
  if (!loaded)
    return [...reasons, "The project's use cases could not be read."];
  for (const source of plan.sources) {
    const content = loaded.contents.find(
      (c) => c.useCase.id === source.useCaseId,
    );
    if (!content) reasons.push(`${source.useCaseId} no longer exists.`);
    else if (contentFingerprint(content) !== source.fingerprint)
      reasons.push(`${source.useCaseId} changed since this plan was made.`);
  }
  for (const c of loaded.contents)
    if (!plan.sources.some((s) => s.useCaseId === c.useCase.id))
      reasons.push(`${c.useCase.id} is new since this plan was made.`);
  return reasons;
}

export async function planView(plan: DeliveryPlan): Promise<DeliveryPlanView> {
  const stale = await planStaleness(plan);
  const settings = (await requireIntegration(plan.system).catch(
    () => undefined,
  )) as TrackerSettings | undefined;
  return {
    plan,
    stale,
    fingerprint: planFingerprint(plan),
    publishing: await publishingState(plan, stale, settings),
  };
}

export async function getPlanView(projectId: string, system: ExternalSystem) {
  const plan = await readPlan(projectId, system);
  if (!plan)
    throw new NotFoundError(
      "There is no delivery plan for this destination yet.",
    );
  return planView(plan);
}

export async function resolveDecision(
  projectId: string,
  system: ExternalSystem,
  input: { decisionId: string; value: string | null; saveAsRule?: boolean },
): Promise<DeliveryPlanView> {
  assertNotPublishing(projectId);
  let toSave: { decisionId: string; value: string | null } | undefined;
  // "Change" reopens a remembered answer: forget the saved rule first, or the re-plan would apply it again.
  if (input.value === null) {
    const stored = await readPlan(projectId, system);
    if (stored)
      await saveRules(
        stored.destination.identity,
        stored.destination.schemaFingerprint,
        [],
        [input.decisionId],
      );
  }
  const plan = await replan(projectId, system, (previous) => {
    const decision = previous.decisions.find((d) => d.id === input.decisionId);
    if (!decision)
      throw new NotFoundError(
        "That decision is no longer part of the plan. Refresh the page.",
      );
    if (input.value !== null) {
      const valid =
        decision.options.some((o) => o.value === input.value) ||
        (decision.allowsText &&
          input.value.startsWith("text:") &&
          (() => {
            const field = previous.destinationTypes
              .find((t) => t.id === decision.typeId)
              ?.fields?.find((f) => f.id === decision.fieldId);
            const check = field
              ? checkText(field, input.value.slice(5))
              : undefined;
            if (check && !check.ok) throw new BadRequestError(check.reason);
            return !!check?.ok;
          })());
      if (!valid)
        throw new BadRequestError("Choose one of the offered answers.");
    }
    toSave = { decisionId: decision.id, value: input.value };
    return {
      ...previous,
      decisions: previous.decisions.map((d) =>
        d.id !== decision.id
          ? d
          : input.value === null
            ? { ...d, resolution: undefined }
            : {
                ...d,
                resolution: {
                  value: input.value,
                  at: new Date().toISOString(),
                  // Remembering is opt-in: an answer becomes a rule for every later plan only when asked.
                  saveAsRule: input.saveAsRule ?? false,
                },
              },
      ),
    };
  });
  const decision = plan.decisions.find((d) => d.id === toSave?.decisionId);
  if (decision?.resolution?.saveAsRule) {
    const field = plan.destinationTypes
      .find((t) => t.id === decision.typeId)
      ?.fields?.find((f) => f.id === decision.fieldId);
    const rule = ruleFor(decision, field, new Date().toISOString());
    if (rule)
      await saveRules(
        plan.destination.identity,
        plan.destination.schemaFingerprint,
        [rule],
      );
  }
  return planView(plan);
}

export async function setAttachment(
  projectId: string,
  system: ExternalSystem,
  input: { attachmentId: string; include: boolean },
) {
  assertNotPublishing(projectId);
  const plan = await replan(projectId, system, (previous) => {
    if (!previous.attachments.some((a) => a.id === input.attachmentId))
      throw new NotFoundError("That screenshot is not part of the plan.");
    return {
      ...previous,
      attachments: previous.attachments.map((a) =>
        a.id === input.attachmentId ? { ...a, include: input.include } : a,
      ),
    };
  });
  return planView(plan);
}

/**
 * Approval records that the BA reviewed exactly the stored plan they were shown. It never re-plans first (that
 * would approve content nobody has seen) and it does not publish anything.
 */
export async function approvePlan(projectId: string, system: ExternalSystem) {
  return withProjectLock(projectId, async () => {
    const stored = await readPlan(projectId, system);
    if (!stored)
      throw new NotFoundError(
        "There is no delivery plan for this destination yet.",
      );
    const stale = await planStaleness(stored);
    if (stale.length)
      throw new ConflictError(
        `Plan again before approving: ${stale.join(" ")}`,
      );
    if (stored.readiness !== "ready")
      throw new ConflictError(
        "Only a ready plan can be approved. Resolve the blocking problems and open decisions first.",
      );
    const approved: DeliveryPlan = {
      ...stored,
      approval: {
        approvedAt: new Date().toISOString(),
        revision: stored.revision,
        fingerprint: planFingerprint(stored),
      },
    };
    await writePlan(approved);
    return planView(approved);
  });
}

export async function previewPlanItem(
  projectId: string,
  system: ExternalSystem,
  itemId: string,
): Promise<PayloadPreview> {
  const plan = await readPlan(projectId, system);
  if (!plan)
    throw new NotFoundError(
      "There is no delivery plan for this destination yet.",
    );
  const item = plan.items.find((i) => i.id === itemId);
  if (!item) throw new NotFoundError(`${itemId} is not part of the plan.`);
  return renderItem(plan, item);
}
