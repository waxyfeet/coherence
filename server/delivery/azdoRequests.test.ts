import { afterEach, expect, it, vi } from "vitest";
import type { DeliveryPlan } from "@shared/delivery";
import { httpDefaults } from "../export/http";
import {
  mockFetch,
  sampleContent,
  sampleModel,
  sampleProject,
  sampleUseCase,
} from "../export/testUtils";
import {
  createRequest,
  dependencyRequest,
  plannedRelations,
} from "./azdoRequests";
import { discoverAzdo } from "./discovery/azdo";
import { finishSchema } from "./discovery";
import { buildPlan } from "./planner";
import { renderItem } from "./render";
import { azdoRoutes, azdoSettings } from "./testFixtures";
import { validatePlan } from "./validate";

afterEach(() => vi.unstubAllGlobals());

const target = { orgUrl: "https://dev.azure.com/acme", project: "Portal" };

async function agilePlan(): Promise<DeliveryPlan> {
  httpDefaults.baseDelayMs = 0;
  mockFetch(azdoRoutes());
  const settings = azdoSettings();
  const schema = finishSchema(await discoverAzdo(settings));
  vi.unstubAllGlobals();
  const useCases = [
    sampleUseCase({ id: "UC-001", dependsOn: [], title: "Open the app" }),
    sampleUseCase(),
  ];
  const contents = useCases.map((u) => sampleContent(u));
  return validatePlan(
    buildPlan({
      projectId: "acme",
      project: sampleProject(),
      model: sampleModel(useCases),
      system: "azdo",
      settings,
      schema,
      contents,
      options: {
        includeUnapproved: false,
        groupByFeature: true,
        linkDependencies: true,
        useAi: false,
      },
    }),
    { schema, contents: new Map(contents.map((c) => [c.useCase.id, c])) },
  );
}

it("sends exactly what the preview shows, with only the work item ids filled in", async () => {
  const plan = await agilePlan();
  const item = plan.items.find((i) => i.id === "uc:UC-003")!;
  const preview = renderItem(plan, item);
  const keys: Record<string, string> = {
    "group:FEAT-01": "812",
    "uc:UC-001": "900",
    "uc:UC-003": "901",
  };
  const live = createRequest(plan, item, target, (id) => keys[id]);
  expect(live.method).toBe("POST");
  expect(live.url).toBe(
    "https://dev.azure.com/acme/Portal/_apis/wit/workitems/$User%20Story?api-version=7.1",
  );
  expect(JSON.stringify(live.ops)).toBe(
    JSON.stringify(preview.body).replaceAll("{{group:FEAT-01}}", "812"),
  );
  // The parent travels with the item and carries Coherence's mark; tags carry the identity.
  expect(live.ops.at(-1)).toEqual({
    op: "add",
    path: "/relations/-",
    value: {
      rel: "System.LinkTypes.Hierarchy-Reverse",
      url: "https://dev.azure.com/acme/_apis/wit/workItems/812",
      attributes: { comment: "Feature group (Coherence)" },
    },
  });
  expect(live.ops.find((o) => o.path === "/fields/System.Tags")?.value).toBe(
    "coherence-test; Coherence; UC-003",
  );
  expect(
    String(
      live.ops.find((o) => o.path === "/fields/System.Description")?.value,
    ),
  ).toContain(item.durableKey);

  const dep = plannedRelations(plan, item).dependencies[0];
  const link = dependencyRequest(plan, dep, target, (id) => keys[id])!;
  expect(link).toEqual({
    method: "PATCH",
    url: "https://dev.azure.com/acme/Portal/_apis/wit/workitems/901?api-version=7.1",
    ops: [
      {
        op: "add",
        path: "/relations/-",
        value: {
          rel: "System.LinkTypes.Dependency-Reverse",
          url: "https://dev.azure.com/acme/_apis/wit/workItems/900",
          attributes: { comment: "UC-003 depends on UC-001 (Coherence)" },
        },
      },
    ],
  });
});

it("checks without saving, and without a parent that doesn't exist yet", async () => {
  const plan = await agilePlan();
  const item = plan.items.find((i) => i.id === "uc:UC-003")!;
  const check = createRequest(plan, item, target, () => undefined, {
    validateOnly: true,
    withoutParent: true,
  });
  expect(check.url).toMatch(/\?api-version=7\.1&validateOnly=true$/);
  expect(check.ops.some((o) => o.path === "/relations/-")).toBe(false);
  // A real create never goes out without its parent.
  expect(() => createRequest(plan, item, target, () => undefined)).toThrow(
    /has no work item id yet/,
  );
  const group = plan.items.find((i) => i.id === "group:FEAT-01")!;
  const feature = createRequest(plan, group, target, () => undefined);
  expect(feature.url).toMatch(/\/_apis\/wit\/workitems\/\$Feature\?/);
  expect(
    String(
      feature.ops.find((o) => o.path === "/fields/System.Description")?.value,
    ),
  ).toContain(group.durableKey);
});
