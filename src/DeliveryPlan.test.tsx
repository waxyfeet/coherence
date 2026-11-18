import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { DeliveryPlanView } from "../shared/api";
import { publishScope, type DeliveryPlan } from "../shared/delivery";
import { httpDefaults } from "../server/export/http";
import {
  mockFetch,
  sampleContent,
  sampleModel,
  sampleProject,
  sampleUseCase,
} from "../server/export/testUtils";
import { discoverAzdo } from "../server/delivery/discovery/azdo";
import { finishSchema } from "../server/delivery/discovery";
import { buildPlan } from "../server/delivery/planner";
import { validatePlan } from "../server/delivery/validate";
import {
  adoCustomRequirementFields,
  azdoRoutes,
  azdoSettings,
} from "../server/delivery/testFixtures";
import {
  DeliveryPlanSummary,
  planHeadline,
  PublishConfirmation,
  PublishResults,
} from "./DeliveryPlan";

afterEach(() => vi.unstubAllGlobals());

async function customPlan(): Promise<DeliveryPlan> {
  httpDefaults.baseDelayMs = 0;
  mockFetch(
    azdoRoutes({
      requirementType: "Requirement",
      requirementFields: adoCustomRequirementFields(),
    }),
  );
  const settings = azdoSettings({ workItemType: "Requirement" });
  const schema = finishSchema(await discoverAzdo(settings));
  const useCases = [sampleUseCase({ dependsOn: [] })];
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

function state(
  plan: DeliveryPlan,
  over: Partial<DeliveryPlanView["publishing"]> = {},
): DeliveryPlanView["publishing"] {
  return {
    enabled: true,
    scope: publishScope(plan),
    needsCheck: 0,
    ...over,
  };
}

function render(view: DeliveryPlanView) {
  return renderToStaticMarkup(
    <DeliveryPlanSummary
      view={view}
      onAnswer={() => {}}
      onPreview={() => {}}
      onAttachment={() => {}}
      onPublish={() => {}}
      onCheck={() => {}}
    />,
  );
}

it("asks only what it can't assume, shows the assumptions, and says which items stay behind and why", async () => {
  const plan = await customPlan();
  expect(planHeadline(plan)).toBe("1 Feature · 1 Requirement");
  const scope = publishScope(plan);
  // Business Unit has no suggestion: the requirement stays behind, and so does its Feature.
  expect(scope.send).toEqual([]);
  expect(scope.notSent.map((n) => n.itemId).sort()).toEqual([
    "group:FEAT-01",
    "uc:UC-003",
  ]);
  const markup = render({
    plan,
    stale: [],
    fingerprint: "f",
    publishing: state(plan, {
      blockedReason: `Nothing can be sent yet: ${scope.notSent[0].reason}`,
    }),
  });
  expect(markup).toContain("YOUR DECISIONS (1)");
  expect(markup).toContain(
    "Which &quot;Business Unit&quot; value should &quot;Requirement&quot; items get?",
  );
  expect(markup).toContain("ASSUMED (1)");
  expect(markup).toContain("Story: So that (benefit)");
  expect(markup).toContain("Not sent");
  expect(markup).toContain("SCREENSHOTS (NOT SENT IN THIS VERSION)");
  expect(markup).toMatch(
    /<button[^>]*disabled=""[^>]*>.*Publish to Azure DevOps…/,
  );
  expect(markup).toContain("Nothing can be sent yet");
  expect(markup).not.toContain("Approve plan");
});

it("offers Publish when items can go, and Check when an earlier write needs checking", async () => {
  const plan = await customPlan();
  const answered: DeliveryPlan = {
    ...plan,
    decisions: plan.decisions.map((d) =>
      d.fieldId === "Custom.BusinessUnit"
        ? {
            ...d,
            resolution: { value: "value:Retail", at: "", saveAsRule: false },
          }
        : d,
    ),
    issues: plan.issues.filter((i) => i.severity !== "blocking"),
  };
  const markup = render({
    plan: answered,
    stale: [],
    fingerprint: "f",
    publishing: state(answered, { needsCheck: 1 }),
  });
  expect(markup).not.toMatch(
    /<button[^>]*disabled=""[^>]*>.*Publish to Azure DevOps…/,
  );
  expect(markup).toContain("Publish to Azure DevOps…");
  expect(markup).toContain("Check Azure DevOps");
  expect(markup).toContain("2 new work items would be sent");

  const confirmation = renderToStaticMarkup(
    <PublishConfirmation
      view={{
        plan: answered,
        stale: [],
        fingerprint: "f",
        publishing: state(answered),
      }}
      destination="https://dev.azure.com/acme · Portal"
    />,
  );
  expect(confirmation).toContain("https://dev.azure.com/acme · Portal");
  expect(confirmation).toContain("1 × Feature · 1 × Requirement");
  expect(confirmation).toContain("Assumed (1)");
  expect(confirmation).toContain(
    "Coherence never deletes, closes or reassigns anything",
  );
});

it("keeps publishing switched off where this version can't publish, and says so", async () => {
  const plan = await customPlan();
  const markup = render({
    plan: { ...plan, readiness: "ready" },
    stale: ["UC-003 changed since this plan was made."],
    fingerprint: "f",
    publishing: state(plan, {
      enabled: false,
      blockedReason:
        "Publishing to Azure DevOps isn't available in this version yet.",
    }),
  });
  expect(markup).toContain(
    "This plan is out of date: UC-003 changed since this plan was made.",
  );
  expect(markup).not.toContain("Publish to Azure DevOps…");
  expect(markup).toContain("available in this version yet");
});

it("lists the last run's results with links and what needs checking", () => {
  const markup = renderToStaticMarkup(
    <PublishResults
      run={{
        jobId: "job_1",
        startedAt: "2026-11-03T10:00:00.000Z",
        finishedAt: "2026-11-03T10:01:00.000Z",
        status: "stopped",
        message:
          'The outcome of "[UC-002] Pay" is unknown, so the run stopped.',
        destination: "Azure DevOps · portal",
        items: [
          {
            itemId: "uc:UC-001",
            title: "[UC-001] Open",
            typeName: "User Story",
            outcome: "created",
            key: "4711",
            url: "https://dev.azure.com/acme/Portal/_workitems/edit/4711",
          },
          {
            itemId: "uc:UC-002",
            title: "[UC-002] Pay",
            typeName: "User Story",
            outcome: "uncertain",
            message: 'Choose "Check Azure DevOps" before publishing again.',
          },
        ],
        links: [],
      }}
    />,
  );
  expect(markup).toContain("Stopped early");
  expect(markup).toContain("#4711");
  expect(markup).toContain("Needs checking");
  expect(markup).toContain("Copy 1 IDs");
});
