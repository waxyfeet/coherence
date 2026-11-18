import { capacityBatches } from "./capacityBatches";
/**
 * Journey Mapper agent (text, optionally with small thumbnails): solution summary, personas, flows between
 * screens (with the triggering element), data entities and the journey order. The model's answer is
 * validated against the real screens and elements; navigation the Screen Analyst already recorded is added
 * deterministically so no flow is lost.
 */
import type {
  FlowLink,
  LLMConnection,
  Persona,
  Project,
  ScreenAnalysis,
} from "@shared/types";
import { slugify } from "@shared/types";
import { CancelledError, errorMessage } from "../errors";
import type { JobContext } from "../jobs/jobManager";
import { thumbnailForLLM } from "../llm/images";
import { connectionSupportsVision } from "../llm/registry";
import { generateStructured } from "../llm/structured";
import type { LLMContentPart } from "../llm/types";
import { screenImagePath } from "../storage/projectStore";
import {
  callBase,
  compactInventoryBlock,
  isMockConnection,
  sortedScreens,
} from "./context";
import { indexElements } from "./ids";
import { mockJourney } from "./mock/journeyMock";
import { journeyMapperSystem } from "./prompts";
import { JourneyOutputSchema, type JourneyOutput } from "./schemas";
import { dedupeText, normText, oneLine, sentence, uniqueKey } from "./text";

/** Thumbnails help the mapper see the overall layout; beyond this many screens they cost more than they add. */
export const MAX_JOURNEY_THUMBNAILS = 12;

export interface DataEntity {
  name: string;
  description: string;
  fields: string[];
  screenIds: string[];
}

export interface JourneyResult {
  summary: string;
  personas: Persona[];
  flows: FlowLink[];
  dataEntities: DataEntity[];
  /** Every analysed screen id, in the order a user first meets them. */
  journeyOrder: string[];
}

export interface MapJourneysArgs {
  ctx: JobContext;
  project: Project;
  analyses: readonly ScreenAnalysis[];
  connection: LLMConnection;
}

/** Raw mapper output → validated journey (pure; unit tested). */
export function normaliseJourney(
  raw: JourneyOutput,
  project: Project,
  analyses: readonly ScreenAnalysis[],
): { journey: JourneyResult; repairs: string[] } {
  const repairs: string[] = [];
  const screens = sortedScreens(project).filter((s) =>
    analyses.some((a) => a.screenId === s.id),
  );
  const screenIds = new Set(screens.map((s) => s.id));
  const byName = new Map(
    screens.map((s) => [s.name.trim().toLowerCase(), s.id]),
  );
  const resolveScreen = (value: string): string | undefined => {
    const v = value.trim();
    if (screenIds.has(v)) return v;
    return byName.get(v.toLowerCase());
  };
  const elements = indexElements(analyses);

  // Personas: role names, unique ids, at least one.
  const personaIds = new Set<string>();
  const personas: Persona[] = [];
  const seenNames = new Set<string>();
  for (const p of raw.personas) {
    const name = p.name.trim();
    if (!name || seenNames.has(normText(name))) continue;
    seenNames.add(normText(name));
    personas.push({
      id: uniqueKey(`persona-${slugify(name, 40)}`, personaIds, "-"),
      name,
      description: p.description.trim(),
      goals: dedupeText(p.goals),
    });
  }
  if (!personas.length) {
    const fromScreens = dedupeText(analyses.flatMap((a) => a.personas));
    const name = fromScreens[0] ?? "User";
    personas.push({
      id: uniqueKey(`persona-${slugify(name, 40)}`, personaIds, "-"),
      name,
      description: `Uses ${project.name}.`,
      goals: [],
    });
    repairs.push(`No personas were identified — using "${name}".`);
  }

  // Flows: real screens only, real elements only, no duplicates.
  const flows: FlowLink[] = [];
  const flowKeys = new Set<string>();
  const addFlow = (
    from: string,
    to: string,
    trigger: string,
    elementId: string | undefined,
    condition: string,
  ): void => {
    const key = `${from}>${to}>${elementId ?? normText(trigger)}`;
    if (flowKeys.has(key)) return;
    flowKeys.add(key);
    const flow: FlowLink = {
      id: `flow-${flows.length + 1}`,
      fromScreenId: from,
      toScreenId: to,
      trigger: trigger.trim() || "Navigate",
    };
    if (elementId) flow.elementId = elementId;
    if (condition.trim()) flow.condition = condition.trim();
    flows.push(flow);
  };
  for (const f of raw.flows) {
    const from = resolveScreen(f.fromScreenId);
    const to = resolveScreen(f.toScreenId);
    if (!from || !to || from === to) {
      repairs.push(
        `Dropped flow "${oneLine(f.trigger, 60)}" (${f.fromScreenId} → ${f.toScreenId}): not between two different uploaded screens.`,
      );
      continue;
    }
    let elementId: string | undefined = f.elementId.trim() || undefined;
    if (elementId && elements.get(elementId)?.screenId !== from) {
      repairs.push(
        `Flow "${oneLine(f.trigger, 60)}" referenced element "${elementId}" which is not on the source screen — kept the flow without it.`,
      );
      elementId = undefined;
    }
    addFlow(from, to, f.trigger, elementId, f.condition);
  }
  // Navigation the analyst saw on the screens is a flow even when the mapper forgot it.
  for (const a of analyses) {
    for (const e of a.elements) {
      if (
        !e.navigatesToScreenId ||
        e.navigatesToScreenId === a.screenId ||
        !screenIds.has(e.navigatesToScreenId)
      )
        continue;
      if (
        flows.some(
          (f) =>
            f.fromScreenId === a.screenId &&
            f.toScreenId === e.navigatesToScreenId &&
            (f.elementId === e.id || !f.elementId),
        )
      )
        continue;
      const label = e.label || e.placeholder || e.type.replace(/_/g, " ");
      addFlow(
        a.screenId,
        e.navigatesToScreenId,
        e.type === "table" || e.type === "list"
          ? `Select a row in "${label}"`
          : `Select "${label}"`,
        e.id,
        "",
      );
    }
  }

  // Data entities: real screens, merged by name.
  const entities = new Map<string, DataEntity>();
  for (const d of raw.dataEntities) {
    const name = d.name.trim();
    if (!name) continue;
    const key = normText(name);
    const ids = d.screenIds
      .map(resolveScreen)
      .filter((id): id is string => Boolean(id));
    const existing = entities.get(key);
    if (existing) {
      existing.fields = dedupeText([...existing.fields, ...d.fields]);
      existing.screenIds = [...new Set([...existing.screenIds, ...ids])];
    } else {
      entities.set(key, {
        name,
        description: d.description.trim(),
        fields: dedupeText(d.fields),
        screenIds: [...new Set(ids)],
      });
    }
  }

  // Journey order: valid ids once each, then any screen the mapper forgot in the BA's order.
  const order: string[] = [];
  for (const id of raw.journeyOrder) {
    const resolved = resolveScreen(id);
    if (resolved && !order.includes(resolved)) order.push(resolved);
  }
  for (const s of screens) if (!order.includes(s.id)) order.push(s.id);

  const summary = raw.summary.trim()
    ? raw.summary.trim()
    : sentence(
        `${project.name}${project.description.trim() ? ` — ${oneLine(project.description, 240)}` : ""}`,
      );

  return {
    journey: {
      summary,
      personas,
      flows,
      dataEntities: [...entities.values()],
      journeyOrder: order,
    },
    repairs,
  };
}

function journeyContent(
  project: Project,
  analyses: readonly ScreenAnalysis[],
): string {
  return [
    "# Element inventory of every screen",
    compactInventoryBlock(analyses, sortedScreens(project)),
    "",
    "Map the journeys across these screens: summary, personas, every flow between uploaded screens (with the exact triggering element id), data entities and the journey order of ALL screen ids.",
  ].join("\n");
}

export async function mapJourneys(
  args: MapJourneysArgs,
): Promise<JourneyResult> {
  const { ctx, project, analyses, connection } = args;
  const content: LLMContentPart[] = [];
  const screens = sortedScreens(project).filter((s) =>
    analyses.some((a) => a.screenId === s.id),
  );

  if (
    !isMockConnection(connection) &&
    connectionSupportsVision(connection) &&
    screens.length <= MAX_JOURNEY_THUMBNAILS
  ) {
    try {
      const thumbs = await Promise.all(
        screens.map((s) => {
          const version =
            analyses.find((a) => a.screenId === s.id)?.screenVersion ??
            s.version;
          return thumbnailForLLM(
            screenImagePath(project.id, s, version),
            `Thumbnail of "${s.name}" (id=${s.id})`,
          );
        }),
      );
      content.push({
        type: "text",
        text: "Small thumbnails of the screens, for layout context only (the inventory below is authoritative):",
      });
      for (const image of thumbs) content.push({ type: "image", image });
    } catch (err) {
      if (err instanceof CancelledError || ctx.signal.aborted) throw err;
      ctx.log(
        "debug",
        `Screen thumbnails for the journey map could not be prepared (${errorMessage(err)}) — continuing with the inventory only.`,
      );
    }
  }
  content.push({ type: "text", text: journeyContent(project, analyses) });

  const batches = await capacityBatches(
    analyses,
    async (subset) =>
      generateStructured({
        ...callBase(ctx, connection, "journey-map"),
        system: journeyMapperSystem(project),
        content:
          subset === analyses
            ? content
            : [{ type: "text", text: journeyContent(project, subset) }],
        schema: JourneyOutputSchema,
        schemaName: "journey_map",
        mock: () => mockJourney(project, subset),
      }),
    ctx.signal,
    (message) => ctx.warn(message),
  );
  const raw: JourneyOutput =
    batches.length === 1
      ? batches[0]
      : {
          summary: batches.map((b) => b.summary).join("\n"),
          personas: batches.flatMap((b) => b.personas),
          flows: batches.flatMap((b) => b.flows),
          dataEntities: batches.flatMap((b) => b.dataEntities),
          journeyOrder: batches.flatMap((b) => b.journeyOrder),
        };

  const { journey, repairs } = normaliseJourney(raw, project, analyses);
  for (const r of repairs) ctx.log("debug", r);
  return journey;
}
