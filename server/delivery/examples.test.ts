/**
 * Synthetic example delivery plans (server/delivery/examples). The committed files are golden
 * outputs: this test regenerates them with WRITE_DELIVERY_EXAMPLES=1 and otherwise checks they still match.
 * Only synthetic fixtures are used — no customer backlog, no live service.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeliveryPlan, DeliveryPlanOptions } from "@shared/delivery";
import type { ExternalSystem } from "@shared/types";
import { ROOT_DIR } from "../config";
import { httpDefaults } from "../export/http";
import {
  mockFetch,
  sampleContent,
  sampleModel,
  sampleProject,
  sampleUseCase,
} from "../export/testUtils";
import { discoverAzdo } from "./discovery/azdo";
import { discoverGitHub } from "./discovery/github";
import { finishSchema, type TrackerSettings } from "./discovery";
import { discoverJira } from "./discovery/jira";
import { buildPlan } from "./planner";
import { renderItem } from "./render";
import * as fx from "./testFixtures";
import { validatePlan } from "./validate";

const DIR = path.join(ROOT_DIR, "server", "delivery", "examples");
const NOW = "2026-11-02T10:00:00.000Z";
const OPTIONS: DeliveryPlanOptions = {
  includeUnapproved: false,
  groupByFeature: true,
  linkDependencies: true,
  useAi: false,
};

afterEach(() => vi.unstubAllGlobals());

function useCases() {
  return [
    sampleUseCase({
      id: "UC-001",
      title: "Open the app",
      dependsOn: [],
      businessRules: [],
      scenarios: [
        {
          id: "SC-01",
          title: "App opens",
          type: "happy",
          given: ["the app is installed"],
          when: ["the user opens the app"],
          then: ["the Login screen is displayed"],
          elementIds: [],
        },
      ],
    }),
    sampleUseCase(),
  ];
}

async function example(
  name: string,
  system: ExternalSystem,
  settings: TrackerSettings,
  routes: Parameters<typeof mockFetch>[0],
) {
  httpDefaults.baseDelayMs = 0;
  mockFetch(routes);
  const draftSchema =
    system === "azdo"
      ? await discoverAzdo(settings as never)
      : system === "jira"
        ? await discoverJira(settings as never)
        : await discoverGitHub(settings as never);
  vi.unstubAllGlobals();
  const schema = finishSchema(draftSchema, NOW);
  const cases = useCases();
  const contents = cases.map((u) => sampleContent(u));
  const plan: DeliveryPlan = {
    ...validatePlan(
      buildPlan({
        projectId: "acme",
        project: sampleProject(),
        model: sampleModel(cases),
        system,
        settings,
        schema,
        contents,
        options: OPTIONS,
        now: NOW,
      }),
      { schema, contents: new Map(contents.map((c) => [c.useCase.id, c])) },
    ),
    id: `dp_example_${name}`,
  };
  const preview = renderItem(
    plan,
    plan.items.find((i) => i.id === "uc:UC-003")!,
  );
  return { plan, preview };
}

const EXAMPLES = [
  ["azdo-agile", "azdo", fx.azdoSettings(), fx.azdoRoutes()],
  [
    "azdo-custom-process",
    "azdo",
    fx.azdoSettings({ workItemType: "Requirement" }),
    fx.azdoRoutes({
      requirementType: "Requirement",
      requirementFields: fx.adoCustomRequirementFields(),
    }),
  ],
  ["jira-cloud", "jira", fx.jiraSettings(), fx.jiraRoutes()],
  ["github-org", "github", fx.githubSettings(), fx.githubRoutes()],
] as const;

describe("example delivery plans", () => {
  for (const [name, system, settings, routes] of EXAMPLES)
    it(`${name} matches the committed example`, async () => {
      const { plan, preview } = await example(
        name,
        system,
        settings,
        routes as never,
      );
      const text = `${JSON.stringify({ plan, previewOfUC003: preview }, null, 2)}\n`;
      for (const s of fx.SECRETS) expect(text).not.toContain(s);
      const file = path.join(DIR, `${name}.json`);
      if (process.env.WRITE_DELIVERY_EXAMPLES === "1") {
        await fs.mkdir(DIR, { recursive: true });
        await fs.writeFile(file, text);
      }
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(
        JSON.parse(text),
      );
    });
});
