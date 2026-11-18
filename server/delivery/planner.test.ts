import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DeliveryPlan,
  DeliveryPlanOptions,
  DestinationSchema,
  MappingProfile,
} from "@shared/delivery";
import type { ExternalSystem, UseCase } from "@shared/types";
import type { ExportContent } from "../export/content";
import { httpDefaults } from "../export/http";
import {
  mockFetch,
  sampleContent,
  sampleModel,
  sampleProject,
  sampleUseCase,
} from "../export/testUtils";
import { adfText, markdownToAdf } from "./adf";
import { compareField } from "./compare";
import { discoverAzdo } from "./discovery/azdo";
import { discoverGitHub } from "./discovery/github";
import { finishSchema, type TrackerSettings } from "./discovery";
import { discoverJira } from "./discovery/jira";
import { buildPlan, comparableValue, type PlanInputs } from "./planner";
import { fieldSignature } from "./profiles";
import { renderItem } from "./render";
import {
  adoCustomRequirementFields,
  azdoRoutes,
  azdoSettings,
  githubRoutes,
  githubSettings,
  jiraRoutes,
  jiraSettings,
  SECRETS,
} from "./testFixtures";
import { validatePlan } from "./validate";

beforeEach(() => {
  httpDefaults.baseDelayMs = 0;
});
afterEach(() => {
  httpDefaults.baseDelayMs = 800;
  vi.unstubAllGlobals();
});

const OPTIONS: DeliveryPlanOptions = {
  includeUnapproved: false,
  groupByFeature: true,
  linkDependencies: true,
  useAi: false,
};

function cases(): UseCase[] {
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
      filePath: "use-cases/UC-001-open.md",
    }),
    sampleUseCase(),
  ];
}

function contentsOf(useCases: UseCase[]): ExportContent[] {
  return useCases.map((useCase) => sampleContent(useCase));
}

async function schemaFor(
  system: ExternalSystem,
  settings: TrackerSettings,
  routes: Parameters<typeof mockFetch>[0],
): Promise<DestinationSchema> {
  mockFetch(routes);
  const draft =
    system === "azdo"
      ? await discoverAzdo(settings as never)
      : system === "jira"
        ? await discoverJira(settings as never)
        : await discoverGitHub(settings as never);
  vi.unstubAllGlobals();
  return finishSchema(draft, "2026-11-02T00:00:00.000Z");
}

type PlanArgs = Omit<
  PlanInputs,
  "projectId" | "project" | "model" | "options" | "contents"
> & {
  useCases?: UseCase[];
  contents?: ExportContent[];
  options?: Partial<DeliveryPlanOptions>;
};

function plan(input: PlanArgs): DeliveryPlan {
  const { useCases: given, contents: loaded, options, ...rest } = input;
  const useCases = given ?? cases();
  const contents = loaded ?? contentsOf(useCases);
  const draft = buildPlan({
    projectId: "acme",
    project: sampleProject(),
    model: sampleModel(useCases),
    now: "2026-11-02T10:00:00.000Z",
    ...rest,
    options: { ...OPTIONS, ...options },
    contents,
  });
  return validatePlan(draft, {
    schema: input.schema,
    contents: new Map(contents.map((c) => [c.useCase.id, c])),
  });
}

const field = (p: DeliveryPlan, itemId: string, fieldId: string) =>
  p.items
    .find((i) => i.id === itemId)
    ?.fields.find((f) => f.fieldId === fieldId);

function answer(
  p: DeliveryPlan,
  answers: Record<string, string>,
): DeliveryPlan {
  return {
    ...p,
    decisions: p.decisions.map((d) =>
      answers[d.id]
        ? {
            ...d,
            resolution: {
              value: answers[d.id],
              at: "2026-11-02T10:05:00.000Z",
              saveAsRule: true,
            },
          }
        : d,
    ),
  };
}

describe("Azure DevOps plans", () => {
  it("maps a standard Agile project without any decisions, AI or invented values", async () => {
    const settings = azdoSettings();
    const schema = await schemaFor("azdo", settings, azdoRoutes());
    const p = plan({ system: "azdo", settings, schema });
    expect(p.readiness).toBe("ready");
    expect(p.items.map((i) => [i.id, i.typeName, i.operation])).toEqual([
      ["group:FEAT-01", "Feature", "create"],
      ["uc:UC-001", "User Story", "create"],
      ["uc:UC-003", "User Story", "create"],
    ]);
    const title = field(p, "uc:UC-003", "System.Title")!;
    expect(title.value).toBe("[UC-003] Sign in with email and password");
    expect(title.provenance.kind).toBe("requirement");
    const ac = field(
      p,
      "uc:UC-003",
      "Microsoft.VSTS.Common.AcceptanceCriteria",
    )!;
    expect(ac.value).toContain("SC-01 · Successful sign-in");
    const description = field(p, "uc:UC-003", "System.Description")!
      .value as string;
    expect(description).toContain("BR-01 · Email address");
    expect(description).not.toContain("## Acceptance criteria");
    expect(description).toMatch(/rev 2 · coh-[0-9a-f]{12}_/);
    expect(field(p, "uc:UC-003", "System.AreaPath")).toMatchObject({
      value: "Portal\\Web",
      ownership: "team",
      provenance: { kind: "rule", by: "settings" },
    });
    // Estimates are never invented: story points wait for a decision; priority and value area keep their defaults.
    expect(
      field(p, "uc:UC-003", "Microsoft.VSTS.Scheduling.StoryPoints"),
    ).toBeUndefined();
    expect(
      field(p, "uc:UC-003", "Microsoft.VSTS.Common.Priority"),
    ).toBeUndefined();
    expect(
      field(p, "uc:UC-003", "Microsoft.VSTS.Common.ValueArea"),
    ).toBeUndefined();
    expect(
      p.decisions.find(
        (d) => d.fieldId === "Microsoft.VSTS.Scheduling.StoryPoints",
      ),
    ).toMatchObject({ blocking: false });
    expect(p.relationships).toContainEqual(
      expect.objectContaining({
        id: "parent:uc:UC-003",
        toItemId: "group:FEAT-01",
        via: "relation",
        status: "planned",
      }),
    );
    expect(p.relationships).toContainEqual(
      expect.objectContaining({
        id: "dependency:uc:UC-003:UC-001",
        toItemId: "uc:UC-001",
        linkTypeId: "System.LinkTypes.Dependency-Reverse",
        status: "planned",
      }),
    );
    expect(p.attachments.every((a) => !a.include)).toBe(true);
    const json = JSON.stringify(p);
    for (const s of SECRETS) expect(json).not.toContain(s);
  });

  it("puts scenarios in the description and asks for required custom fields when the process lacks them", async () => {
    const settings = azdoSettings({ workItemType: "Requirement" });
    const schema = await schemaFor(
      "azdo",
      settings,
      azdoRoutes({
        requirementType: "Requirement",
        requirementFields: adoCustomRequirementFields(),
      }),
    );
    const first = plan({ system: "azdo", settings, schema });
    expect(first.readiness).toBe("needs-decisions");
    const description = field(first, "uc:UC-003", "System.Description")!;
    expect(description.value).toContain("## Acceptance criteria");
    expect(description.substitution).toMatch(/no acceptance criteria field/);
    const unit = first.decisions.find(
      (d) => d.id === "field:Requirement:Custom.BusinessUnit",
    )!;
    expect(unit).toMatchObject({ kind: "field-value", blocking: true });
    expect(unit.options.map((o) => o.value)).toEqual([
      "value:Retail",
      "value:Wholesale",
      "value:Shared Services",
    ]);
    const value = first.decisions.find(
      (d) => d.id === "field:Requirement:Custom.ValueStatement",
    )!;
    expect(value.suggestion).toMatchObject({
      value: "evidence:story.soThat",
      provenance: { kind: "inference", by: "heuristic" },
    });
    // An unanswered suggestion is used as an assumption the BA can change, never as a saved rule.
    expect(value.resolution).toMatchObject({
      assumed: true,
      saveAsRule: false,
    });
    expect(field(first, "uc:UC-003", "Custom.ValueStatement")).toMatchObject({
      value: "I can access my account securely",
      provenance: { kind: "inference", by: "heuristic" },
    });
    expect(
      first.issues
        .filter((i) => i.code === "required-missing")
        .every((i) => i.decisionId),
    ).toBe(true);

    const answered = plan({
      system: "azdo",
      settings,
      schema,
      previous: answer(first, {
        "field:Requirement:Custom.BusinessUnit": "value:Retail",
        "field:Requirement:Custom.ValueStatement": "evidence:story.soThat",
      }),
    });
    expect(answered.readiness).toBe("ready");
    expect(field(answered, "uc:UC-003", "Custom.ValueStatement")).toMatchObject(
      {
        value: "I can access my account securely",
        ownership: "coherence",
        provenance: { kind: "rule", evidence: ["story.soThat"] },
      },
    );
    expect(field(answered, "uc:UC-003", "Custom.BusinessUnit")).toMatchObject({
      value: "Retail",
      ownership: "team",
    });
    expect(answered.id).toBe(first.id);
    expect(answered.revision).toBe(first.revision + 1);
    expect(answered.items.map((i) => i.durableKey)).toEqual(
      first.items.map((i) => i.durableKey),
    );
  });

  it("applies saved mappings without asking again and rejects mappings the destination no longer fits", async () => {
    const settings = azdoSettings({ workItemType: "Requirement" });
    const schema = await schemaFor(
      "azdo",
      settings,
      azdoRoutes({
        requirementType: "Requirement",
        requirementFields: adoCustomRequirementFields(),
      }),
    );
    const unitField = schema.itemTypes
      .find((t) => t.id === "Requirement")!
      .fields!.find((f) => f.id === "Custom.BusinessUnit")!;
    const profile: MappingProfile = {
      schemaVersion: 1,
      id: "p",
      identity: schema.identity,
      revision: 3,
      schemaFingerprint: schema.fingerprint,
      updatedAt: "2026-11-01T00:00:00.000Z",
      rules: [
        {
          id: "field:Requirement:Custom.BusinessUnit",
          kind: "field-constant",
          typeId: "Requirement",
          fieldId: "Custom.BusinessUnit",
          value: "value:Wholesale",
          signature: fieldSignature(unitField),
          approvedAt: "2026-11-01T00:00:00.000Z",
        },
        {
          id: "field:Requirement:Custom.ValueStatement",
          kind: "field-evidence",
          typeId: "Requirement",
          fieldId: "Custom.ValueStatement",
          value: "evidence:story.soThat",
          approvedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    };
    const p = plan({ system: "azdo", settings, schema, profile });
    expect(p.readiness).toBe("ready");
    expect(
      field(p, "uc:UC-003", "Custom.BusinessUnit")?.provenance,
    ).toMatchObject({ kind: "rule", label: "Your saved mapping" });
    expect(p.profile?.appliedRules.sort()).toEqual([
      "field:Requirement:Custom.BusinessUnit",
      "field:Requirement:Custom.ValueStatement",
    ]);

    const changed = structuredClone(schema);
    changed.itemTypes
      .find((t) => t.id === "Requirement")!
      .fields!.find((f) => f.id === "Custom.BusinessUnit")!.allowedValues = [
      "Retail",
      "Shared Services",
    ];
    const stale = plan({ system: "azdo", settings, schema: changed, profile });
    expect(stale.profile?.invalidRules).toEqual([
      "field:Requirement:Custom.BusinessUnit",
    ]);
    expect(stale.issues.some((i) => i.code === "rule-invalid")).toBe(true);
    expect(stale.readiness).toBe("needs-decisions");
  });

  it("blocks an area path that does not exist", async () => {
    const settings = azdoSettings({ areaPath: "Portal\\Nowhere" });
    const schema = await schemaFor("azdo", settings, azdoRoutes());
    const p = plan({ system: "azdo", settings, schema });
    expect(p.readiness).toBe("blocked");
    expect(
      p.issues.find((i) => i.code === "value-not-allowed")?.message,
    ).toMatch(/Portal\\Nowhere/);
  });

  it("renders the exact Azure DevOps JSON Patch preview without sending it", async () => {
    const settings = azdoSettings();
    const schema = await schemaFor("azdo", settings, azdoRoutes());
    const { calls } = mockFetch([]);
    const p = plan({ system: "azdo", settings, schema });
    const preview = renderItem(
      p,
      p.items.find((i) => i.id === "uc:UC-003")!,
    );
    expect(calls).toEqual([]);
    expect(preview.request).toBe("POST /_apis/wit/workitems/$User Story");
    const ops = preview.body as { path: string; value: unknown }[];
    expect(
      ops.find(
        (o) => o.path === "/fields/Microsoft.VSTS.Common.AcceptanceCriteria",
      )?.value,
    ).toMatch(/<strong>GIVEN<\/strong>/);
    expect(ops.find((o) => o.path === "/fields/System.Tags")?.value).toBe(
      "coherence-test; Coherence; UC-003",
    );
    expect(ops.find((o) => o.path === "/relations/-")).toMatchObject({
      value: { rel: "System.LinkTypes.Hierarchy-Reverse" },
    });
    expect(preview.relationships[0].description).toMatch(/Dependency-Reverse/);
  });
});

describe("changes after publishing", () => {
  it("plans an update when Coherence would now send something else at the same revision, and only adds tags", async () => {
    const settings = azdoSettings();
    const schema = await schemaFor("azdo", settings, azdoRoutes());
    const uc = sampleUseCase({ dependsOn: [] });
    const first = plan({ system: "azdo", settings, schema, useCases: [uc] });
    const created = first.items.find((i) => i.id === "uc:UC-003")!;
    const sent = Object.fromEntries(
      created.fields
        .filter((f) => f.ownership === "coherence")
        .map((f) => [f.fieldId, comparableValue("html", f) ?? null]),
    ) as Record<string, string | number | string[] | null>;
    const published = {
      schemaVersion: 1 as const,
      system: "azdo" as const,
      identity: schema.identity,
      entries: [
        {
          durableKey: created.durableKey,
          itemId: created.id,
          role: "requirement" as const,
          key: "4711",
          url: "https://dev.azure.com/acme/Portal/_workitems/edit/4711",
          title: created.title,
          useCaseId: "UC-003",
          revision: uc.revision,
          publishedAt: "2026-11-03T10:00:00.000Z",
          how: "created" as const,
          sent,
        },
      ],
    };
    const same = plan({
      system: "azdo",
      settings,
      schema,
      useCases: [uc],
      published,
    });
    expect(same.items.find((i) => i.id === "uc:UC-003")?.operation).toBe(
      "keep",
    );

    // A new tag in Settings: same revision, but Coherence would now send more. The team's own tag stays.
    const remote = new Map([
      [
        "uc:UC-003",
        {
          ...sent,
          "System.Tags": [...(sent["System.Tags"] as string[]), "team-tag"],
        },
      ],
    ]);
    const retagged = plan({
      system: "azdo",
      settings: azdoSettings({ tags: ["coherence-test", "release-1"] }),
      schema,
      useCases: [uc],
      published,
      remote,
      remoteRevs: new Map([["uc:UC-003", 7]]),
    });
    const item = retagged.items.find((i) => i.id === "uc:UC-003")!;
    expect(item.operation).toBe("update");
    expect(item.existing?.remoteRev).toBe(7);
    const tags = item.fields.find((f) => f.fieldId === "System.Tags")!;
    expect(tags.updateAction).toBe("send");
    expect(tags.value).toEqual([
      "coherence-test",
      "Coherence",
      "UC-003",
      "team-tag",
      "release-1",
    ]);
    expect(
      item.fields
        .filter((f) => f.updateAction === "send")
        .map((f) => f.fieldId),
    ).toEqual(["System.Tags"]);
  });
});

describe("literal rule text", () => {
  it("sends Markdown characters in reviewed text exactly as written, and still proves nothing was lost", async () => {
    const settings = azdoSettings();
    const schema = await schemaFor("azdo", settings, azdoRoutes());
    const uc = sampleUseCase({
      dependsOn: [],
      businessRules: [
        {
          id: "BR-01",
          elementId: "login.email",
          element: "Total_amount",
          elementType: "email_input",
          description: "Shows *exactly* the sum.",
          rules: [
            "Total is 2*3*4 units.",
            "Calls __init__ before [submit] runs.",
          ],
        },
      ],
    });
    const p = plan({ system: "azdo", settings, schema, useCases: [uc] });
    expect(p.issues.filter((i) => i.code === "content-lost")).toEqual([]);
    const ops = renderItem(
      p,
      p.items.find((i) => i.id === "uc:UC-003")!,
    ).body as { path: string; value: unknown }[];
    const html = String(
      ops.find((o) => o.path === "/fields/System.Description")?.value,
    );
    expect(html).toContain("Total is 2*3*4 units.");
    expect(html).toContain("Calls __init__ before [submit] runs.");
    expect(html).toContain("Shows *exactly* the sum.");
    expect(html).toContain("Total_amount");
    expect(html).not.toContain("<em>3</em>");
    expect(html).not.toContain("<strong>init</strong>");
    expect(html).not.toContain("<em>exactly</em>");
  });
});

describe("Jira plans", () => {
  it("renders Atlassian Document Format for Cloud and assumes the custom acceptance criteria field from its name", async () => {
    const settings = jiraSettings();
    const schema = await schemaFor("jira", settings, jiraRoutes());
    const p = plan({ system: "jira", settings, schema });
    expect(p.items.find((i) => i.id === "group:FEAT-01")?.typeName).toBe(
      "Epic",
    );
    const ac = p.decisions.find(
      (d) => d.id === "field:10001:customfield_10050",
    )!;
    expect(ac.suggestion?.value).toBe("evidence:scenarios");
    expect(ac.blocking).toBe(false);
    expect(ac.resolution).toMatchObject({
      value: "evidence:scenarios",
      assumed: true,
    });
    expect(field(p, "uc:UC-003", "customfield_10050")!.value).toContain(
      "GIVEN the Login screen is displayed",
    );
    expect(field(p, "uc:UC-003", "description")!.value).not.toContain(
      "## Acceptance criteria",
    );
    expect(
      p.decisions.find((d) => d.id === "field:10001:customfield_10060"),
    ).toMatchObject({ blocking: true });
    expect(p.readiness).toBe("needs-decisions");
    expect(p.relationships).toContainEqual(
      expect.objectContaining({ id: "parent:uc:UC-003", via: "parent-field" }),
    );
    expect(p.relationships).toContainEqual(
      expect.objectContaining({
        id: "dependency:uc:UC-003:UC-001",
        linkTypeId: "Blocks",
      }),
    );
    expect(field(p, "uc:UC-003", "labels")!.value).toEqual([
      "coherence",
      "uc-003",
    ]);

    const ready = plan({
      system: "jira",
      settings,
      schema,
      previous: answer(p, {
        "field:10001:customfield_10050": "evidence:scenarios",
        "field:10001:customfield_10060": "value:Retail",
      }),
    });
    expect(ready.readiness).toBe("ready");
    expect(field(ready, "uc:UC-003", "description")!.value).not.toContain(
      "## Acceptance criteria",
    );
    const preview = renderItem(
      ready,
      ready.items.find((i) => i.id === "uc:UC-003")!,
    );
    expect(preview.request).toBe("POST /rest/api/3/issue");
    const fields = (preview.body as { fields: Record<string, unknown> }).fields;
    expect(fields.project).toEqual({ key: "POR" });
    expect(fields.issuetype).toEqual({ id: "10001" });
    expect(fields.customfield_10060).toEqual({ value: "Retail" });
    expect(fields.parent).toEqual({ key: "{{group:FEAT-01}}" });
    const doc = fields.description as {
      type: string;
      content: { type: string }[];
    };
    expect(doc.type).toBe("doc");
    expect(doc.content.some((n) => n.type === "heading")).toBe(true);
    expect(adfText(fields.customfield_10050 as never)).toContain(
      "GIVEN the Login screen is displayed",
    );
  });

  it("assumes a requirement-like type when the configured issue type does not exist (team-managed), and lets the BA change it", async () => {
    const settings = jiraSettings();
    const schema = await schemaFor(
      "jira",
      settings,
      jiraRoutes({
        types: [
          { id: "20000", name: "Epic", level: 1 },
          { id: "20001", name: "Task", level: 0 },
          { id: "20002", name: "Feature request", level: 0 },
        ],
      }),
    );
    const p = plan({ system: "jira", settings, schema });
    const type = p.decisions.find((d) => d.id === "item-type:requirement")!;
    expect(type.options.map((o) => o.label)).toEqual([
      "Task",
      "Feature request",
    ]);
    expect(type.suggestion?.value).toBe("type:20002");
    expect(type.resolution).toMatchObject({
      value: "type:20002",
      assumed: true,
    });
    expect(p.items.find((i) => i.id === "uc:UC-003")).toMatchObject({
      typeId: "20002",
      typeName: "Feature request",
    });
    const chosen = plan({
      system: "jira",
      settings,
      schema,
      previous: answer(p, { "item-type:requirement": "type:20001" }),
    });
    expect(chosen.items.find((i) => i.id === "uc:UC-003")?.typeName).toBe(
      "Task",
    );
    expect(
      chosen.decisions.find((d) => d.id === "item-type:requirement")?.resolution
        ?.value,
    ).toBe("type:20001");
  });

  it("uses wiki markup and the Epic Link field on Data Center", async () => {
    const settings = jiraSettings({ deployment: "server", email: "" });
    const schema = await schemaFor(
      "jira",
      settings,
      jiraRoutes({ cloud: false }),
    );
    const p = plan({ system: "jira", settings, schema, previous: undefined });
    const epic = p.items.find((i) => i.id === "group:FEAT-01")!;
    expect(
      epic.fields.find((f) => f.fieldId === "customfield_10101")?.value,
    ).toBe("Authentication");
    const ready = plan({
      system: "jira",
      settings,
      schema,
      previous: answer(p, {
        "field:10001:customfield_10060": "value:Wholesale",
      }),
    });
    const preview = renderItem(
      ready,
      ready.items.find((i) => i.id === "uc:UC-003")!,
    );
    const fields = (preview.body as { fields: Record<string, unknown> }).fields;
    expect(preview.request).toBe("POST /rest/api/2/issue");
    expect(typeof fields.description).toBe("string");
    // The custom Acceptance Criteria field is assumed from its name, so the scenarios travel there.
    expect(fields.description).not.toMatch(/\*GIVEN\*/);
    expect(JSON.stringify(fields)).toMatch(/\*GIVEN\*/);
    expect(fields.customfield_10100).toBe("{{group:FEAT-01}}");
  });

  it("refuses to truncate a requirement that exceeds the description limit", async () => {
    const settings = jiraSettings();
    const schema = await schemaFor("jira", settings, jiraRoutes());
    const huge = sampleUseCase({
      businessRules: Array.from({ length: 400 }, (_, i) => ({
        id: `BR-${i + 1}`,
        element: `Field ${i + 1}`,
        elementType: "text_input" as const,
        description:
          "A long description of this input field and its behaviour on the screen.",
        rules: [
          "Mandatory.",
          `Must be at most ${i + 10} characters and match the documented pattern exactly.`,
        ],
      })),
    });
    const p = plan({
      system: "jira",
      settings,
      schema,
      useCases: [cases()[0], huge],
    });
    expect(p.readiness).toBe("blocked");
    expect(p.issues.find((i) => i.code === "value-too-long")?.message).toMatch(
      /will not truncate/,
    );
  });
});

describe("GitHub plans", () => {
  it("reuses an existing milestone, suggests an issue type and keeps dependencies in the body", async () => {
    const settings = githubSettings();
    const schema = await schemaFor("github", settings, githubRoutes());
    const p = plan({ system: "github", settings, schema });
    expect(p.items.find((i) => i.id === "group:FEAT-01")).toMatchObject({
      typeId: "milestone",
      operation: "keep",
    });
    expect(
      p.decisions.find((d) => d.id === "field:issue:type")?.suggestion?.value,
    ).toBe("value:Feature");
    expect(
      p.decisions.find((d) => d.id === "field:issue:issue-field:11")?.suggestion
        ?.value,
    ).toBe("evidence:story.soThat");
    expect(p.readiness).toBe("ready");
    const preview = renderItem(
      p,
      p.items.find((i) => i.id === "uc:UC-003")!,
    );
    const body = preview.body as Record<string, string>;
    expect(body.body.startsWith("**Depends on:** {{uc:UC-001}} (UC-001)")).toBe(
      true,
    );
    expect(body.milestone).toMatch(/group:FEAT-01/);
    expect(body.labels).toEqual(["coherence"]);
  });

  it("groups by label when milestones are off", async () => {
    const settings = githubSettings({ useMilestonesForFeatures: false });
    const schema = await schemaFor(
      "github",
      settings,
      githubRoutes({ org: false }),
    );
    const p = plan({ system: "github", settings, schema });
    expect(p.items.find((i) => i.id === "group:FEAT-01")).toMatchObject({
      typeId: "label",
      title: "feature: Authentication",
      operation: "keep",
    });
    expect(field(p, "uc:UC-003", "labels")?.value).toEqual([
      "coherence",
      "feature: Authentication",
    ]);
  });

  it("blocks screenshots the destination cannot receive and never includes them by default", async () => {
    const settings = githubSettings();
    const schema = await schemaFor("github", settings, githubRoutes());
    const p = plan({ system: "github", settings, schema });
    expect(p.attachments).toHaveLength(2);
    expect(
      p.attachments.every((a) => !a.include && a.supported === "unsupported"),
    ).toBe(true);
    const included = plan({
      system: "github",
      settings,
      schema,
      previous: {
        ...p,
        attachments: p.attachments.map((a) => ({ ...a, include: true })),
      },
    });
    expect(
      included.issues.some((i) => i.code === "attachment-unsupported"),
    ).toBe(true);
    expect(included.readiness).toBe("blocked");
  });
});

describe("sources, identities and safety", () => {
  it("plans approved use cases only unless drafts are included, and blocks stale or unreadable ones", async () => {
    const settings = azdoSettings();
    const schema = await schemaFor("azdo", settings, azdoRoutes());
    const useCases = [
      cases()[0],
      sampleUseCase({ status: "edited" }),
      sampleUseCase({
        id: "UC-004",
        status: "stale",
        staleReason: "Login screen changed",
      }),
    ];
    const p = plan({ system: "azdo", settings, schema, useCases });
    expect(p.items.map((i) => i.id)).toEqual(["group:FEAT-01", "uc:UC-001"]);
    expect(p.sources.find((s) => s.useCaseId === "UC-003")).toMatchObject({
      included: false,
    });
    const drafts = plan({
      system: "azdo",
      settings,
      schema,
      useCases,
      options: { includeUnapproved: true },
    });
    expect(
      drafts.issues.find((i) => i.code === "source-not-approved")?.useCaseId,
    ).toBe("UC-003");
    expect(drafts.issues.find((i) => i.code === "source-stale")).toMatchObject({
      useCaseId: "UC-004",
      severity: "blocking",
    });
    expect(drafts.readiness).toBe("blocked");
    const fallback = sampleContent(
      {},
      {
        source: "model",
        warnings: ["UC-003: the spec file use-cases/x.md was not found"],
      },
    );
    const unreadable = plan({
      system: "azdo",
      settings,
      schema,
      contents: [fallback],
    });
    expect(
      unreadable.issues.find((i) => i.code === "source-unreadable")?.severity,
    ).toBe("blocking");
    const ignored = sampleContent(
      {},
      {
        warnings: [
          "UC-003: SC-01: example tables and doc strings are not supported in this format and were ignored.",
        ],
      },
    );
    expect(
      plan({
        system: "azdo",
        settings,
        schema,
        contents: [ignored],
      }).issues.some((i) => i.code === "content-lost"),
    ).toBe(true);
    const incomplete = sampleContent(
      {},
      { warnings: ["UC-003: The user story is missing: so that."] },
    );
    expect(
      plan({
        system: "azdo",
        settings,
        schema,
        contents: [incomplete],
      }).issues.find((i) => i.code === "source-incomplete"),
    ).toMatchObject({
      severity: "warning",
      message: "UC-003: The user story is missing: so that.",
    });
  });

  it("updates an item exported to this destination, keeps team fields and asks about conflicting edits", async () => {
    const settings = azdoSettings();
    const schema = await schemaFor("azdo", settings, azdoRoutes());
    const exported = sampleUseCase({
      revision: 3,
      external: [
        {
          system: "azdo",
          key: "4711",
          url: "https://dev.azure.com/acme/Portal/_workitems/edit/4711",
          revision: 2,
          exportedAt: "2026-10-30T00:00:00.000Z",
        },
      ],
    });
    const useCases = [cases()[0], exported];
    const first = plan({ system: "azdo", settings, schema, useCases });
    const item = first.items.find((i) => i.id === "uc:UC-003")!;
    expect(item).toMatchObject({
      operation: "update",
      existing: { key: "4711", exportedRevision: 2, currentRevision: 3 },
    });
    expect(item.fields.some((f) => f.fieldId === "System.AreaPath")).toBe(
      false,
    );
    expect(first.issues.some((i) => i.id === "not-compared:uc:UC-003")).toBe(
      true,
    );

    const title = item.fields.find((f) => f.fieldId === "System.Title")!
      .value as string;
    const remote = new Map([
      [
        "uc:UC-003",
        {
          "System.Title": title,
          "System.Description":
            "Team rewrote this description in Azure DevOps.",
          "Microsoft.VSTS.Common.AcceptanceCriteria": "Old criteria",
        },
      ],
    ]);
    const baselines = new Map([
      [
        "uc:UC-003",
        {
          "System.Title": title,
          "System.Description": "What Coherence sent last time.",
          "Microsoft.VSTS.Common.AcceptanceCriteria": "Old criteria",
        },
      ],
    ]);
    const compared = plan({
      system: "azdo",
      settings,
      schema,
      useCases,
      remote,
      baselines,
    });
    const cmp = Object.fromEntries(
      compared.items
        .find((i) => i.id === "uc:UC-003")!
        .comparisons!.map((c) => [c.fieldId, c.state]),
    );
    expect(cmp).toMatchObject({
      "System.Title": "unchanged",
      "System.Description": "conflict",
      "Microsoft.VSTS.Common.AcceptanceCriteria": "coherence-update",
    });
    expect(
      compared.decisions.find(
        (d) => d.id === "conflict:uc:UC-003:System.Description",
      ),
    ).toMatchObject({ blocking: true });
    // Tags were never recorded on either side, so adding Coherence's tags is an ordinary update.
    const sent = compared.items.find((i) => i.id === "uc:UC-003")!.fields;
    expect(
      sent.filter((f) => f.updateAction === "send").map((f) => f.fieldId),
    ).toEqual(["Microsoft.VSTS.Common.AcceptanceCriteria", "System.Tags"]);
    expect(
      sent.find((f) => f.fieldId === "System.Description")?.updateAction,
    ).toBe("awaiting-decision");
    const preview = renderItem(
      compared,
      compared.items.find((i) => i.id === "uc:UC-003")!,
    );
    expect(
      (preview.body as { path: string }[])
        .map((o) => o.path)
        .filter((p) => p.startsWith("/fields/")),
    ).toEqual([
      "/fields/Microsoft.VSTS.Common.AcceptanceCriteria",
      "/fields/System.Tags",
    ]);
    const kept = plan({
      system: "azdo",
      settings,
      schema,
      useCases,
      remote,
      baselines,
      previous: answer(compared, {
        "conflict:uc:UC-003:System.Description": "keep",
      }),
    });
    expect(kept.readiness).toBe("ready");
    expect(
      kept.items
        .find((i) => i.id === "uc:UC-003")!
        .fields.find((f) => f.fieldId === "System.Description")?.updateAction,
    ).toBe("keep-destination");
    expect(compared.readiness).toBe("needs-decisions");

    const unknown = plan({
      system: "azdo",
      settings,
      schema,
      useCases,
      remote,
    });
    expect(
      unknown.items
        .find((i) => i.id === "uc:UC-003")!
        .comparisons!.find((c) => c.fieldId === "System.Description")?.state,
    ).toBe("unknown-origin");
  });

  it("plans a new item when the stored link belongs to another destination, and blocks uncertain exports", async () => {
    const settings = azdoSettings();
    const schema = await schemaFor("azdo", settings, azdoRoutes());
    const elsewhere = sampleUseCase({
      external: [
        {
          system: "azdo",
          key: "12",
          url: "https://dev.azure.com/other/Portal/_workitems/edit/12",
          revision: 2,
          exportedAt: "2026-10-30T00:00:00.000Z",
        },
      ],
    });
    const p = plan({
      system: "azdo",
      settings,
      schema,
      useCases: [cases()[0], elsewhere],
      uncertainUseCaseIds: new Set(["UC-001"]),
    });
    expect(p.items.find((i) => i.id === "uc:UC-003")?.operation).toBe("create");
    expect(p.issues.some((i) => i.code === "existing-other-destination")).toBe(
      true,
    );
    expect(p.issues.find((i) => i.code === "existing-uncertain")).toMatchObject(
      { useCaseId: "UC-001", severity: "blocking" },
    );
  });

  it("ignores suggestions that are not among the permitted options", async () => {
    const settings = azdoSettings({ workItemType: "Requirement" });
    const schema = await schemaFor(
      "azdo",
      settings,
      azdoRoutes({
        requirementType: "Requirement",
        requirementFields: adoCustomRequirementFields(),
      }),
    );
    const p = plan({
      system: "azdo",
      settings,
      schema,
      suggestions: [
        {
          decisionId: "field:Requirement:Custom.BusinessUnit",
          value: "value:Finance",
          rationale: "invented",
          by: "ai",
        },
        {
          decisionId: "field:Requirement:Custom.ValueStatement",
          value: "evidence:budget",
          rationale: "invented",
          by: "ai",
        },
      ],
    });
    expect(
      p.decisions.find((d) => d.id === "field:Requirement:Custom.BusinessUnit")
        ?.suggestion,
    ).toBeUndefined();
    expect(
      p.decisions.find(
        (d) => d.id === "field:Requirement:Custom.ValueStatement",
      )?.suggestion?.provenance.by,
    ).toBe("heuristic");
  });

  it("verifies one-to-many decomposition preserves every scenario and rule", async () => {
    const settings = azdoSettings();
    const schema = await schemaFor("azdo", settings, azdoRoutes());
    const p = plan({ system: "azdo", settings, schema });
    const original = p.items.find((i) => i.id === "uc:UC-003")!;
    const desc = original.fields.find(
      (f) => f.fieldId === "System.Description",
    )!;
    const ac = original.fields.find(
      (f) => f.fieldId === "Microsoft.VSTS.Common.AcceptanceCriteria",
    )!;
    const split = [
      {
        ...original,
        id: "uc:UC-003#1",
        role: "child" as const,
        fields: [original.fields[0], desc],
      },
      {
        ...original,
        id: "uc:UC-003#2",
        role: "child" as const,
        fields: [original.fields[0], ac],
      },
    ];
    const contents = new Map(contentsOf(cases()).map((c) => [c.useCase.id, c]));
    const draft = {
      ...p,
      items: [...p.items.filter((i) => i.id !== "uc:UC-003"), ...split],
      issues: [],
    };
    expect(
      validatePlan(draft, { schema, contents }).issues.some(
        (i) => i.code === "content-lost",
      ),
    ).toBe(false);
    const lossy = {
      ...draft,
      items: draft.items.filter((i) => i.id !== "uc:UC-003#2"),
    };
    const lost = validatePlan(lossy, { schema, contents });
    expect(lost.issues.find((i) => i.code === "content-lost")).toMatchObject({
      useCaseId: "UC-003",
      severity: "blocking",
    });
  });

  it("drops a plan approval as soon as anything it covered changes", async () => {
    const settings = azdoSettings();
    const schema = await schemaFor("azdo", settings, azdoRoutes());
    const p = plan({ system: "azdo", settings, schema });
    const { planFingerprint } = await import("./validate");
    const approved = {
      ...p,
      approval: {
        approvedAt: "x",
        revision: p.revision,
        fingerprint: planFingerprint(p),
      },
    };
    expect(
      plan({ system: "azdo", settings, schema, previous: approved }).approval,
    ).toBeDefined();
    const edited = [
      cases()[0],
      sampleUseCase({ title: "Sign in with a passkey" }),
    ];
    expect(
      plan({
        system: "azdo",
        settings,
        schema,
        previous: approved,
        useCases: edited,
      }).approval,
    ).toBeUndefined();
  });
});

describe("Atlassian Document Format", () => {
  it("converts headings, lists, emphasis, gherkin and links, and never passes raw HTML", () => {
    const doc = markdownToAdf(
      "## Rules\n\n- **Mandatory**; see [docs](https://x.test/a)\n- [local](../a.md) and `code`\n\n```gherkin\nGIVEN a\nTHEN b\n```\n\n<script>alert(1)</script>\n\n![img](../screens/a.png)",
    );
    expect(doc.content[0]).toMatchObject({
      type: "heading",
      attrs: { level: 2 },
    });
    const json = JSON.stringify(doc);
    expect(json).toContain('"type":"bulletList"');
    expect(json).toContain('"href":"https://x.test/a"');
    expect(json).not.toContain("../a.md");
    expect(json).toContain(
      '{"type":"text","text":"GIVEN","marks":[{"type":"strong"}]}',
    );
    expect(json).toContain("<script>alert(1)</script>");
    expect(json).not.toMatch(/"type":"(html|inlineCard|media)"/);
    expect(adfText(doc)).toContain("screen image: img");
  });
});

describe("three-way comparison", () => {
  it("classifies team edits, Coherence edits, conflicts and unknown origin", () => {
    expect(compareField("d", "Description", "new", "old", "old").state).toBe(
      "coherence-update",
    );
    expect(compareField("d", "Description", "old", "team", "old").state).toBe(
      "team-modified",
    );
    expect(compareField("d", "Description", "new", "team", "old").state).toBe(
      "conflict",
    );
    expect(compareField("d", "Description", "same", "same").state).toBe(
      "unchanged",
    );
    expect(compareField("d", "Description", "new", "team").state).toBe(
      "unknown-origin",
    );
    expect(compareField("l", "Labels", ["B", "a"], ["A", "b"], []).state).toBe(
      "unchanged",
    );
  });
});
