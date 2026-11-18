/**
 * Test-only builders for projects, screens, analyses and use cases.
 */
import type {
  ElementType,
  LLMConnection,
  Project,
  Screen,
  ScreenAnalysis,
  ScreenRegion,
  SolutionModel,
  UIElement,
  UseCase,
} from "@shared/types";
import { DEFAULT_GENERATION_OPTIONS } from "@shared/types";

export function screen(
  id: string,
  name: string,
  order: number,
  notes = "",
): Screen {
  return {
    id,
    name,
    notes,
    order,
    version: 1,
    fileName: `${id}/v1.png`,
    originalFileName: `${name}.png`,
    mimeType: "image/png",
    width: 1440,
    height: 900,
    sizeBytes: 1000,
    uploadedAt: "2026-10-14T00:00:00.000Z",
    analysedVersion: 1,
  };
}

export function project(
  screens: Screen[],
  extra: Partial<Project> = {},
): Project {
  return {
    id: "acme",
    name: "Acme Orders",
    description: "B2B ordering portal for sales reps.",
    additionalContext: "",
    formatId: "use-case-bdd",
    outputDir: "/tmp/acme-specs",
    llm: {},
    screens,
    status: "draft",
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
    ...extra,
  };
}

export interface ElementSpec {
  key: string;
  type?: ElementType;
  label?: string;
  region?: string;
  extra?: Partial<UIElement>;
}

/** Analysis with regions in the order they first appear in `elements`. */
export function analysis(
  screenId: string,
  screenKey: string,
  elements: ElementSpec[],
  extra: Partial<ScreenAnalysis> = {},
): ScreenAnalysis {
  const regions: ScreenRegion[] = [];
  const out: UIElement[] = [];
  for (const spec of elements) {
    const regionKey = spec.region ?? "main";
    let region = regions.find((r) => r.key === regionKey);
    if (!region) {
      region = {
        id: `${screenKey}.${regionKey}`,
        key: regionKey,
        screenId,
        name: regionKey.replace(/_/g, " "),
        purpose: "",
        layout: "",
        elementIds: [],
      };
      regions.push(region);
    }
    const id = `${screenKey}.${spec.key}`;
    out.push({
      id,
      key: spec.key,
      screenId,
      regionId: region.id,
      type: spec.type ?? "button",
      label: spec.label ?? spec.key,
      description: `${spec.key} element.`,
      inferred: [],
      ...spec.extra,
    });
    region.elementIds.push(id);
  }
  return {
    screenId,
    screenVersion: 1,
    screenKey,
    title: screenKey,
    purpose: "",
    screenType: "other",
    personas: ["Sales rep"],
    regions,
    elements: out,
    dataEntities: [],
    openQuestions: [],
    analysedAt: "2026-10-14T00:00:00.000Z",
    ...extra,
  };
}

export function useCase(id: string, extra: Partial<UseCase> = {}): UseCase {
  return {
    id,
    slug: id.toLowerCase(),
    title: `Use case ${id}`,
    formatId: "use-case-bdd",
    featureId: "FEAT-01",
    personaId: "persona-sales-rep",
    screenIds: [],
    regionIds: [],
    elementIds: [],
    dependsOn: [],
    order: 1,
    size: "M",
    scope: "",
    story: { asA: "sales rep", iWant: "do things", soThat: "things are done" },
    preconditions: [],
    postconditions: [],
    businessRules: [],
    scenarios: [],
    assumptions: [],
    openQuestions: [],
    notes: "",
    status: "generated",
    revision: 1,
    updatedAt: "2026-10-14T00:00:00.000Z",
    external: [],
    ...extra,
  };
}

/** The offline demo connection (no network). */
export function mockConnection(
  extra: Partial<LLMConnection> = {},
): LLMConnection {
  return {
    id: "conn_mock",
    name: "Offline demo",
    provider: "mock",
    model: "demo",
    concurrency: 4,
    requestTimeoutSec: 60,
    structuredOutput: "auto",
    vision: "auto",
    refusalFallback: false,
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
    ...extra,
  };
}

export function model(
  screens: ScreenAnalysis[],
  useCases: UseCase[],
  extra: Partial<SolutionModel> = {},
): SolutionModel {
  return {
    schemaVersion: 1,
    projectId: "acme",
    formatId: "use-case-bdd",
    generatedAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
    generator: { vision: "mock/demo", text: "mock/demo" },
    options: { ...DEFAULT_GENERATION_OPTIONS },
    summary: "",
    personas: [
      {
        id: "persona-sales-rep",
        name: "Sales rep",
        description: "",
        goals: [],
      },
    ],
    screens,
    flows: [],
    features: [
      {
        id: "FEAT-01",
        name: "General",
        description: "",
        useCaseIds: useCases.map((u) => u.id),
      },
    ],
    useCases,
    review: [],
    changeLog: [],
    ...extra,
  };
}
