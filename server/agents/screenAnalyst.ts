import { readOwnedFile } from "../storage/fsUtils";
/**
 * OWNER: agents builder.
 * Screen Analyst agent (vision): one screen image → exhaustive ScreenAnalysis (regions + every element).
 * With thoroughness 'thorough', a second Inspector pass compares the inventory with the image and
 * adds/corrects missing elements.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type {
  LLMConnection,
  Project,
  Screen,
  ScreenAnalysis,
  Thoroughness,
} from "@shared/types";
import {
  BadRequestError,
  CancelledError,
  LLMError,
  errorMessage,
} from "../errors";
import type { JobContext } from "../jobs/jobManager";
import { stopsTheRun } from "../llm/errors";
import { prepareImageForLLM, prepareRegionForLLM } from "../llm/images";
import { connectionSupportsVision } from "../llm/registry";
import { generateStructured } from "../llm/structured";
import type { LLMContentPart, LLMImage } from "../llm/types";
import { screenImagePath } from "../storage/projectStore";
import { callBase, isMockConnection, sortedScreens } from "./context";
import {
  INPUT_TYPES,
  analysisToOutput,
  screenKeyFor,
  toScreenAnalysis,
} from "./ids";
import { isSampleHash } from "./mock/sampleScreens";
import { mockInspection, mockScreenAnalysis } from "./mock/screenMock";
import { inspectorSystem, screenAnalystSystem } from "./prompts";
import {
  InspectorOutputSchema,
  ScreenAnalysisOutputSchema,
  type InspectorOutput,
  type ScreenAnalysisOutput,
} from "./schemas";
import { oneLine } from "./text";
import {
  adaptiveReading,
  ownSection,
  reuseReadingKeys,
  type ReadingParts,
} from "./adaptiveReading";
import {
  ScreenReadingSchema,
  READER_DETAIL_INSTRUCTIONS,
} from "./readerContract";

export interface AnalyseScreenArgs {
  ctx: JobContext;
  project: Project;
  screen: Screen;
  /** Image version to analyse (default screen.version). */
  version?: number;
  connection: LLMConnection;
  thoroughness: Thoroughness;
  /** screenKeys already taken by other screens (to keep keys unique). */
  takenScreenKeys: string[];
  /**
   * Previous analysis of the same screen, when re-analysing a replaced image: the agent is asked to reuse
   * existing element keys for unchanged/renamed elements so ids stay stable across versions.
   */
  previous?: ScreenAnalysis;
  /** A complete validated first pass from the same input/reader contract, awaiting inspection. */
  firstPass?: ScreenAnalysis;
  onFirstPass?: (analysis: ScreenAnalysis) => Promise<void>;
  readingParts?: ReadingParts;
  onReadingParts?: (state: ReadingParts) => Promise<void>;
}

/** Text that introduces the screen and explains how the attached image(s) map onto the full screen. */
function screenIntro(
  screen: Screen,
  version: number,
  images: readonly LLMImage[],
): string {
  const lines = [
    `# Screen to analyse`,
    `Name: "${screen.name}" · id=${screen.id} · image version ${version} · ${screen.width}×${screen.height}px`,
  ];
  if (screen.notes.trim())
    lines.push(
      `BA notes for this screen (treat as facts from the product owner): ${screen.notes.trim()}`,
    );
  const tiles = images.filter((img) => img.region && img.region.count > 1);
  if (tiles.length) {
    lines.push(
      "",
      `The screen is tall, so it is sent as ${tiles.length} overlapping tiles. Each tile's caption states which part of the FULL screen it covers.`,
      "Report every element ONCE (elements in the overlap appear in two tiles) and give bounds as percent of the FULL screen:",
      "full-screen y = tile top% + (y within the tile in %) × (tile bottom% − tile top%) / 100 (likewise x for side-by-side tiles).",
    );
    for (const t of tiles) {
      const r = t.region!;
      lines.push(
        `- Tile ${r.index}: x ${r.leftPct}%–${r.rightPct}%, y ${r.topPct}%–${r.bottomPct}% of the full screen`,
      );
    }
  }
  return lines.join("\n");
}

/** Previous inventory (keys + labels) so a re-analysis keeps element ids stable. */
function previousKeysBlock(previous: ScreenAnalysis): string {
  const regionKey = new Map(previous.regions.map((r) => [r.id, r.key]));
  return [
    "# Previous inventory of this screen (reuse these keys for elements that are still present)",
    "Regions: " +
      previous.regions
        .map((r) => `${r.key} ("${oneLine(r.name, 40)}")`)
        .join(", "),
    ...previous.elements.map(
      (e) =>
        `- ${e.key} · ${e.type} · "${oneLine(e.label, 60)}" · region ${regionKey.get(e.regionId) ?? "?"}`,
    ),
  ].join("\n");
}

function imageParts(images: readonly LLMImage[]): LLMContentPart[] {
  return images.map((image) => ({ type: "image", image }));
}

/**
 * Inspection is an upsert patch. Unchanged records, reading order, labels and IDs survive.
 * Full inventories from older fixtures are also valid patches. No omission means deletion.
 */
export function mergeInspection(
  first: ScreenAnalysisOutput,
  inspected: InspectorOutput,
): { output: ScreenAnalysisOutput; kept: string[] } {
  function upsert<T extends { key: string }>(base: T[], patch: T[]): T[] {
    const updates = new Map<string, T>();
    for (const record of patch) {
      if (!record.key.trim() || updates.has(record.key))
        throw new LLMError(
          "The inspection contained ambiguous record keys; the complete first reading was retained.",
        );
      updates.set(record.key, record);
    }
    const known = new Set(base.map((record) => record.key));
    return [
      ...base.map((record) => updates.get(record.key) ?? record),
      ...patch.filter((record) => !known.has(record.key)),
    ];
  }
  const regions = upsert(first.regions, inspected.regions);
  let elements = upsert(first.elements, inspected.elements);
  const fullUpdates = new Set(inspected.elements.map((element) => element.key));
  function applyCompact<T extends { key: string }>(
    changes: T[],
    apply: (
      element: (typeof elements)[number],
      change: T,
    ) => (typeof elements)[number],
  ) {
    const seen = new Set<string>();
    for (const change of changes) {
      const index = elements.findIndex((element) => element.key === change.key);
      if (index < 0 || seen.has(change.key) || fullUpdates.has(change.key))
        throw new LLMError(
          "The inspection contained an ambiguous or unavailable compact correction; the complete first reading was retained.",
        );
      seen.add(change.key);
      elements[index] = apply(elements[index], change);
    }
  }
  applyCompact(inspected.boundsCorrections, (element, change) => {
    const b = change.bounds;
    if (
      ![b.x, b.y, b.width, b.height].every(Number.isFinite) ||
      b.x < 0 ||
      b.y < 0 ||
      b.width <= 0 ||
      b.height <= 0 ||
      b.x + b.width > 100 ||
      b.y + b.height > 100
    )
      throw new LLMError(
        "The inspection contained invalid image coordinates; the complete first reading was retained.",
      );
    return { ...element, bounds: b };
  });
  applyCompact(inspected.labelCorrections, (element, change) => ({
    ...element,
    label: change.label,
  }));
  const regionKeys = new Set(regions.map((region) => region.key));
  if (elements.some((element) => !regionKeys.has(element.regionKey)))
    throw new LLMError(
      "The inspection referred to an unavailable region; the complete first reading was retained.",
    );
  const keys = new Set(
    [
      ...inspected.elements,
      ...inspected.boundsCorrections,
      ...inspected.labelCorrections,
    ].map((e) => e.key),
  );
  const {
    corrections: _corrections,
    boundsCorrections: _bounds,
    labelCorrections: _labels,
    ...rest
  } = inspected;
  return {
    output: { ...rest, regions, elements },
    kept: first.elements.filter((e) => !keys.has(e.key)).map((e) => e.key),
  };
}

/**
 * SHA-256 of the screen's image when it is one of the bundled samples. A replaced image that is not (an edited
 * copy of a sample) falls back to its earlier versions: the offline generator cannot see what changed, so it
 * keeps returning the inventory it gave before.
 */
async function sampleImageHash(
  projectId: string,
  screen: Screen,
  version: number,
): Promise<string | undefined> {
  for (let v = version; v >= 1; v -= 1) {
    try {
      const hash = createHash("sha256")
        .update(await readOwnedFile(screenImagePath(projectId, screen, v)))
        .digest("hex");
      if (isSampleHash(hash)) return hash;
    } catch {
      // A version that is gone from disk is simply skipped.
    }
  }
  return undefined;
}

export async function analyseScreen(
  args: AnalyseScreenArgs,
): Promise<ScreenAnalysis> {
  const { ctx, project, screen, connection, previous } = args;
  const version = args.version ?? screen.version;
  const mock = isMockConnection(connection);
  if (!mock && !connectionSupportsVision(connection)) {
    throw new BadRequestError(
      `The AI connection "${connection.name}" cannot read images, so it cannot analyse "${screen.name}". Choose a connection with vision support for reading screens.`,
    );
  }
  ctx.throwIfCancelled();

  const screenKey = screenKeyFor(screen, args.takenScreenKeys, previous);
  // The offline generator cannot see images, so there is no point decoding them.
  // The offline generator cannot see the image either; its hash only lets it recognise the bundled samples.
  const imageSha256 = mock
    ? await sampleImageHash(project.id, screen, version)
    : undefined;
  const images = mock
    ? []
    : await prepareImageForLLM(screenImagePath(project.id, screen, version), {
        name: screen.name,
      });

  const content: LLMContentPart[] = [
    { type: "text", text: screenIntro(screen, version, images) },
  ];
  if (previous?.elements.length)
    content.push({ type: "text", text: previousKeysBlock(previous) });
  content.push(...imageParts(images));
  content.push({
    type: "text",
    text: `Return the complete inventory of the screen "${screen.name}" above: every region and every visible element, verbatim text, all options, validation for every input and bounds in percent of the full screen.`,
  });

  let partCount = args.firstPass?.reading?.parts ?? 1;
  const firstPass = args.firstPass
    ? analysisToOutput(args.firstPass)
    : mock
      ? await generateStructured({
          ...callBase(ctx, connection, `screen-analysis:${screen.name}`),
          system: screenAnalystSystem(project),
          content,
          schema: ScreenAnalysisOutputSchema,
          schemaName: "screen_analysis",
          mock: () => mockScreenAnalysis(project, screen, imageSha256),
        })
      : await (async () => {
          const result = await adaptiveReading({
            width: screen.width,
            height: screen.height,
            signal: ctx.signal,
            state: args.readingParts,
            save: args.onReadingParts,
            inform: (message) => ctx.info(message),
            read: async (path, core) => {
              if (!path)
                return generateStructured({
                  ...callBase(
                    ctx,
                    connection,
                    `screen-analysis:${screen.name}`,
                  ),
                  system:
                    screenAnalystSystem(project) +
                    "\n\n" +
                    READER_DETAIL_INSTRUCTIONS,
                  content,
                  schema: ScreenReadingSchema,
                  schemaName: "screen_analysis_v2",
                  mock: () => mockScreenAnalysis(project, screen, imageSha256),
                });
              const image = await prepareRegionForLLM(
                screenImagePath(project.id, screen, version),
                screen.name,
                core,
              );
              const r = image.region!;
              const raw = await generateStructured({
                ...callBase(
                  ctx,
                  connection,
                  `screen-analysis:${screen.name}:section-${path}`,
                ),
                system:
                  screenAnalystSystem(project) +
                  "\n\n" +
                  READER_DETAIL_INSTRUCTIONS +
                  "\nFor this SECTION task, bounds MUST be percentages of the ATTACHED CROP, not the full screen. Coherence maps them back. Observe the whole crop, including seam context; do not describe off-crop elements from memory.",
                content: [
                  { type: "text", text: screenIntro(screen, version, []) },
                  ...(previous?.elements.length
                    ? [
                        {
                          type: "text" as const,
                          text: previousKeysBlock(previous),
                        },
                      ]
                    : []),
                  { type: "image", image },
                  {
                    type: "text",
                    text:
                      "Return every visible element of this crop, with exact labels/options and non-zero crop-relative bounds. Never omit an element to fit the answer. This is section " +
                      path +
                      " of the original image; global project and owner notes still apply.",
                  },
                ],
                schema: ScreenReadingSchema,
                schemaName: "screen_analysis_section_v2",
                mock: () => mockScreenAnalysis(project, screen, imageSha256),
              });
              return ownSection(raw, core, {
                x: r.leftPct,
                y: r.topPct,
                width: r.rightPct - r.leftPct,
                height: r.bottomPct - r.topPct,
              });
            },
          });
          partCount = result.parts;
          return reuseReadingKeys(
            result.output,
            previous ? analysisToOutput(previous) : undefined,
          );
        })();

  const screens = sortedScreens(project);
  const convert = (raw: ScreenAnalysisOutput) =>
    toScreenAnalysis({
      raw,
      screen,
      version,
      screenKey,
      validScreenIds: screens.map((s) => s.id),
      screenIdByName: new Map(
        screens.map((s) => [s.name.trim().toLowerCase(), s.id]),
      ),
    });

  let { analysis, repairs } = convert(firstPass);
  analysis.reading = {
    version: 1,
    parts: partCount,
    inspection: args.thoroughness === "thorough" ? "pending" : "not-requested",
  };
  if (args.firstPass)
    ctx.info(
      `Reused the complete first reading of '${screen.name}'; continuing inspection.`,
    );
  else if (analysis.elements.length && args.onFirstPass)
    await args.onFirstPass(analysis);

  if (args.thoroughness === "thorough") {
    try {
      const inventory = JSON.stringify(analysisToOutput(analysis));
      const inspected = await generateStructured({
        ...callBase(ctx, connection, `screen-inspection:${screen.name}`),
        system: inspectorSystem(project),
        content: [
          { type: "text", text: screenIntro(screen, version, images) },
          ...imageParts(images),
          {
            type: "text",
            text: `# Inventory to check (first pass)\n${inventory}`,
          },
          {
            type: "text",
            text: `Check every region of "${screen.name}" against this inventory. Return the screen-level facts and ONLY added/changed region and element records, plus corrections. Unchanged records must not be repeated.`,
          },
        ],
        schema: InspectorOutputSchema,
        schemaName: "screen_inspection",
        mock: () => mockInspection(analysisToOutput(analysis)),
      });
      const merged = mergeInspection(analysisToOutput(analysis), inspected);
      ({ analysis, repairs } = convert(merged.output));
      analysis.reading = { version: 1, parts: partCount, inspection: "passed" };
      if (merged.kept.length) {
        ctx.log(
          "debug",
          `Inspection of "${screen.name}" preserved ${merged.kept.length} unchanged element(s).`,
        );
      }
      const corrections = inspected.corrections.filter((c) => c.trim());
      ctx.info(
        corrections.length
          ? `Inspected '${screen.name}': ${corrections.length} correction(s) — ${oneLine(corrections.slice(0, 3).join("; "), 240)}`
          : `Inspected '${screen.name}': inventory confirmed complete.`,
      );
    } catch (err) {
      if (
        err instanceof CancelledError ||
        ctx.signal.aborted ||
        stopsTheRun(err)
      )
        throw err;
      analysis.reading = { version: 1, parts: partCount, inspection: "failed" };
      // The first pass is a usable inventory; a failed double-check should not sink the whole run.
      ctx.warn(
        `The inspection pass for "${screen.name}" failed (${errorMessage(err)}) — using the first reading.`,
      );
    }
  }

  for (const note of repairs) ctx.log("debug", note);
  const inputs = analysis.elements.filter((e) =>
    INPUT_TYPES.has(e.type),
  ).length;
  ctx.info(
    `Read '${screen.name}': ${analysis.regions.length} regions, ${analysis.elements.length} elements${inputs ? ` (${inputs} inputs)` : ""}`,
  );
  if (!analysis.elements.length) {
    ctx.warn(
      `No elements were found on "${screen.name}". Check that the image shows the screen design, or add notes for the agents.`,
    );
  }
  return analysis;
}
