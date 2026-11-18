/**
 * Synthetic destination configurations for delivery-mapping tests: mocked Azure DevOps, Jira and GitHub
 * metadata responses (no customer backlog, no live service). Used only by *.test.ts files.
 */
import type { AzdoSettings, GitHubSettings, JiraSettings } from "@shared/types";
import type { MockResponse } from "../export/testUtils";

export type Route = [
  RegExp,
  MockResponse | ((call: { url: string }) => MockResponse),
];

export const SECRETS = ["pat-secret-123", "jira-secret-456", "ghp_secret789"];

export const azdoSettings = (
  over: Partial<AzdoSettings> = {},
): AzdoSettings => ({
  orgUrl: "https://dev.azure.com/acme",
  project: "Portal",
  pat: "pat-secret-123",
  workItemType: "User Story",
  parentWorkItemType: "Feature",
  areaPath: "Portal\\Web",
  iterationPath: "",
  tags: ["coherence-test"],
  ...over,
});

export const jiraSettings = (
  over: Partial<JiraSettings> = {},
): JiraSettings => ({
  baseUrl: "https://acme.atlassian.net",
  email: "ba@acme.test",
  apiToken: "jira-secret-456",
  projectKey: "POR",
  issueType: "Story",
  epicIssueType: "Epic",
  labels: [],
  linkType: "Blocks",
  deployment: "cloud",
  ...over,
});

export const githubSettings = (
  over: Partial<GitHubSettings> = {},
): GitHubSettings => ({
  owner: "acme",
  repo: "portal",
  token: "ghp_secret789",
  labels: [],
  apiBaseUrl: "https://api.github.com",
  useMilestonesForFeatures: true,
  ...over,
});

/* ------------------------------------------------------------------ */
/* Azure DevOps                                                         */
/* ------------------------------------------------------------------ */

const adoDefs = [
  ["System.Title", "Title", "string"],
  ["System.Description", "Description", "html"],
  ["Microsoft.VSTS.Common.AcceptanceCriteria", "Acceptance Criteria", "html"],
  ["System.Tags", "Tags", "plainText"],
  ["System.AreaPath", "Area Path", "treePath"],
  ["System.IterationPath", "Iteration Path", "treePath"],
  ["System.State", "State", "string"],
  ["System.AssignedTo", "Assigned To", "string", { isIdentity: true }],
  ["Microsoft.VSTS.Scheduling.StoryPoints", "Story Points", "double"],
  [
    "Microsoft.VSTS.Common.Priority",
    "Priority",
    "integer",
    { isPicklist: true },
  ],
  [
    "Microsoft.VSTS.Common.ValueArea",
    "Value Area",
    "string",
    { isPicklist: true },
  ],
  ["Custom.BusinessUnit", "Business Unit", "string", { isPicklist: true }],
  ["Custom.ValueStatement", "Value Statement", "plainText"],
  ["System.Id", "ID", "integer", { readOnly: true }],
] as const;

type TypeFieldSpec = {
  referenceName: string;
  name: string;
  alwaysRequired?: boolean;
  defaultValue?: unknown;
  allowedValues?: unknown[];
  helpText?: string;
};

const f = (
  referenceName: string,
  name: string,
  extra: Partial<TypeFieldSpec> = {},
): TypeFieldSpec => ({ referenceName, name, ...extra });

export const adoStoryFields = (): TypeFieldSpec[] => [
  f("System.Id", "ID"),
  f("System.Title", "Title", { alwaysRequired: true }),
  f("System.Description", "Description"),
  f("Microsoft.VSTS.Common.AcceptanceCriteria", "Acceptance Criteria"),
  f("System.Tags", "Tags"),
  f("System.AreaPath", "Area Path", { defaultValue: "Portal" }),
  f("System.IterationPath", "Iteration Path", { defaultValue: "Portal" }),
  f("System.State", "State", { alwaysRequired: true, defaultValue: "New" }),
  f("System.AssignedTo", "Assigned To"),
  f("Microsoft.VSTS.Scheduling.StoryPoints", "Story Points"),
  f("Microsoft.VSTS.Common.Priority", "Priority", {
    defaultValue: 2,
    allowedValues: [1, 2, 3, 4],
  }),
  f("Microsoft.VSTS.Common.ValueArea", "Value Area", {
    alwaysRequired: true,
    defaultValue: "Business",
    allowedValues: ["Architectural", "Business"],
  }),
];

/** A synthetic custom process: requirement type without Acceptance Criteria and with required custom fields. */
export const adoCustomRequirementFields = (): TypeFieldSpec[] => [
  f("System.Title", "Title", { alwaysRequired: true }),
  f("System.Description", "Description"),
  f("System.Tags", "Tags"),
  f("System.AreaPath", "Area Path", { defaultValue: "Portal" }),
  f("System.IterationPath", "Iteration Path", { defaultValue: "Portal" }),
  f("System.State", "State", {
    alwaysRequired: true,
    defaultValue: "Proposed",
  }),
  f("Custom.BusinessUnit", "Business Unit", {
    alwaysRequired: true,
    allowedValues: ["Retail", "Wholesale", "Shared Services"],
    helpText: "Which business unit funds this work.",
  }),
  f("Custom.ValueStatement", "Value Statement", {
    alwaysRequired: true,
    helpText: "Describe the business value delivered.",
  }),
];

const adoFeatureFields = (): TypeFieldSpec[] => [
  f("System.Title", "Title", { alwaysRequired: true }),
  f("System.Description", "Description"),
  f("System.Tags", "Tags"),
  f("System.AreaPath", "Area Path", { defaultValue: "Portal" }),
  f("System.State", "State", { alwaysRequired: true, defaultValue: "New" }),
];

export interface AzdoFixture {
  requirementType?: string;
  requirementFields?: TypeFieldSpec[];
  extraTypes?: string[];
  relationTypesStatus?: number;
}

export function azdoRoutes(fx: AzdoFixture = {}): Route[] {
  const req = fx.requirementType ?? "User Story";
  const reqFields = fx.requirementFields ?? adoStoryFields();
  const base = "https://dev\\.azure\\.com/acme";
  const types = [
    "Epic",
    "Feature",
    req,
    "Task",
    "Bug",
    "Code Review Request",
    ...(fx.extraTypes ?? []),
  ];
  return [
    [
      new RegExp(`^GET ${base}/_apis/projects/Portal\\?`),
      { json: { id: "p1", name: "Portal" } },
    ],
    [
      new RegExp(`^GET ${base}/Portal/_apis/wit/workitemtypes\\?`),
      {
        json: {
          value: types.map((name) => ({ name, referenceName: `X.${name}` })),
        },
      },
    ],
    [
      new RegExp(`^GET ${base}/Portal/_apis/wit/workitemtypecategories\\?`),
      {
        json: {
          value: [
            {
              referenceName: "Microsoft.EpicCategory",
              defaultWorkItemType: { name: "Epic" },
              workItemTypes: [{ name: "Epic" }],
            },
            {
              referenceName: "Microsoft.FeatureCategory",
              defaultWorkItemType: { name: "Feature" },
              workItemTypes: [{ name: "Feature" }],
            },
            {
              referenceName: "Microsoft.RequirementCategory",
              defaultWorkItemType: { name: req },
              workItemTypes: [
                { name: req },
                ...(fx.extraTypes ?? []).map((name) => ({ name })),
              ],
            },
            {
              referenceName: "Microsoft.TaskCategory",
              defaultWorkItemType: { name: "Task" },
              workItemTypes: [{ name: "Task" }],
            },
            {
              referenceName: "Microsoft.BugCategory",
              defaultWorkItemType: { name: "Bug" },
              workItemTypes: [{ name: "Bug" }],
            },
            {
              referenceName: "Microsoft.HiddenCategory",
              workItemTypes: [{ name: "Code Review Request" }],
            },
          ],
        },
      },
    ],
    [
      new RegExp(`^GET ${base}/Portal/_apis/wit/fields\\?`),
      {
        json: {
          value: adoDefs.map(([referenceName, name, type, extra]) => ({
            referenceName,
            name,
            type,
            ...(extra ?? {}),
          })),
        },
      },
    ],
    [
      new RegExp(
        `^GET ${base}/Portal/_apis/wit/workitemtypes/Feature/fields\\?`,
      ),
      { json: { value: adoFeatureFields() } },
    ],
    [
      new RegExp(`^GET ${base}/Portal/_apis/wit/workitemtypes/Epic/fields\\?`),
      { json: { value: adoFeatureFields() } },
    ],
    [
      new RegExp(
        `^GET ${base}/Portal/_apis/wit/workitemtypes/${encodeURIComponent(req).replace(/%/g, "%")}/fields\\?`,
      ),
      { json: { value: reqFields } },
    ],
    ...(fx.extraTypes ?? []).map((name): Route => [
      new RegExp(
        `^GET ${base}/Portal/_apis/wit/workitemtypes/${encodeURIComponent(name)}/fields\\?`,
      ),
      { json: { value: reqFields } },
    ]),
    [
      new RegExp(`^GET ${base}/_apis/wit/workitemrelationtypes\\?`),
      fx.relationTypesStatus
        ? { status: fx.relationTypesStatus, json: { message: "nope" } }
        : {
            json: {
              value: [
                {
                  referenceName: "System.LinkTypes.Hierarchy-Reverse",
                  name: "Parent",
                  attributes: { usage: "workItemLink", enabled: true },
                },
                {
                  referenceName: "System.LinkTypes.Hierarchy-Forward",
                  name: "Child",
                  attributes: { usage: "workItemLink", enabled: true },
                },
                {
                  referenceName: "System.LinkTypes.Dependency-Reverse",
                  name: "Predecessor",
                  attributes: { usage: "workItemLink", enabled: true },
                },
                {
                  referenceName: "System.LinkTypes.Related",
                  name: "Related",
                  attributes: { usage: "workItemLink", enabled: true },
                },
                {
                  referenceName: "AttachedFile",
                  name: "Attached File",
                  attributes: { usage: "resourceLink" },
                },
              ],
            },
          },
    ],
    [
      new RegExp(`^GET ${base}/Portal/_apis/wit/classificationnodes\\?`),
      {
        json: {
          value: [
            {
              name: "Portal",
              structureType: "area",
              children: [{ name: "Web" }, { name: "Mobile" }],
            },
            {
              name: "Portal",
              structureType: "iteration",
              children: [{ name: "Sprint 1" }],
            },
          ],
        },
      },
    ],
  ];
}

/* ------------------------------------------------------------------ */
/* Jira                                                                 */
/* ------------------------------------------------------------------ */

const CF = "com.atlassian.jira.plugin.system.customfieldtypes:";

export const jiraStoryFields = (cloud = true) => [
  {
    fieldId: "summary",
    name: "Summary",
    required: true,
    schema: { type: "string", system: "summary" },
    operations: ["set"],
  },
  {
    fieldId: "issuetype",
    name: "Issue Type",
    required: true,
    schema: { type: "issuetype", system: "issuetype" },
  },
  {
    fieldId: "project",
    name: "Project",
    required: true,
    schema: { type: "project", system: "project" },
  },
  {
    fieldId: "description",
    name: "Description",
    required: false,
    schema: { type: "string", system: "description" },
    operations: ["set"],
  },
  {
    fieldId: "labels",
    name: "Labels",
    required: false,
    schema: { type: "array", items: "string", system: "labels" },
    operations: ["add", "set", "remove"],
  },
  {
    fieldId: "priority",
    name: "Priority",
    required: false,
    hasDefaultValue: true,
    schema: { type: "priority", system: "priority" },
    allowedValues: [
      { name: "High", id: "2" },
      { name: "Medium", id: "3" },
      { name: "Low", id: "4" },
    ],
    operations: ["set"],
  },
  {
    fieldId: "reporter",
    name: "Reporter",
    required: true,
    hasDefaultValue: true,
    schema: { type: "user", system: "reporter" },
    operations: ["set"],
  },
  cloud
    ? {
        fieldId: "parent",
        name: "Parent",
        required: false,
        schema: { type: "issuelink", system: "parent" },
        operations: ["set"],
      }
    : {
        fieldId: "customfield_10100",
        name: "Epic Link",
        required: false,
        schema: {
          type: "any",
          custom: "com.pyxis.greenhopper.jira:gh-epic-link",
          customId: 10100,
        },
        operations: ["set"],
      },
  {
    fieldId: "customfield_10016",
    name: "Story point estimate",
    required: false,
    schema: {
      type: "number",
      custom: "com.pyxis.greenhopper.jira:jsw-story-points",
      customId: 10016,
    },
    operations: ["set"],
  },
  {
    fieldId: "customfield_10050",
    name: "Acceptance Criteria",
    required: false,
    schema: { type: "string", custom: `${CF}textarea`, customId: 10050 },
    operations: ["set"],
  },
  {
    fieldId: "customfield_10060",
    name: "Business Unit",
    required: true,
    schema: { type: "option", custom: `${CF}select`, customId: 10060 },
    allowedValues: [
      { value: "Retail", id: "1" },
      { value: "Wholesale", id: "2" },
    ],
    operations: ["set"],
  },
];

const jiraEpicFields = (cloud = true) => [
  {
    fieldId: "summary",
    name: "Summary",
    required: true,
    schema: { type: "string", system: "summary" },
    operations: ["set"],
  },
  {
    fieldId: "issuetype",
    name: "Issue Type",
    required: true,
    schema: { type: "issuetype", system: "issuetype" },
  },
  {
    fieldId: "description",
    name: "Description",
    required: false,
    schema: { type: "string", system: "description" },
    operations: ["set"],
  },
  ...(cloud
    ? []
    : [
        {
          fieldId: "customfield_10101",
          name: "Epic Name",
          required: true,
          schema: {
            type: "string",
            custom: "com.pyxis.greenhopper.jira:gh-epic-label",
            customId: 10101,
          },
          operations: ["set"],
        },
      ]),
];

export interface JiraFixture {
  cloud?: boolean;
  /** Issue type names (default Epic, Story, Task, Bug, Sub-task). */
  types?: { id: string; name: string; level: number; subtask?: boolean }[];
  storyFields?: ReturnType<typeof jiraStoryFields>;
  injectHelp?: string;
}

export function jiraRoutes(fx: JiraFixture = {}): Route[] {
  const cloud = fx.cloud ?? true;
  const api = cloud ? "3" : "2";
  const base = "https://acme\\.atlassian\\.net";
  const types = fx.types ?? [
    { id: "10000", name: "Epic", level: 1 },
    { id: "10001", name: "Story", level: 0 },
    { id: "10002", name: "Task", level: 0 },
    { id: "10003", name: "Bug", level: 0 },
    { id: "10004", name: "Sub-task", level: -1, subtask: true },
  ];
  const typeList = types.map((t) => ({
    id: t.id,
    name: t.name,
    subtask: !!t.subtask,
    ...(cloud ? { hierarchyLevel: t.level } : {}),
  }));
  const storyFields = fx.storyFields ?? jiraStoryFields(cloud);
  const page = <T>(items: T[], key: "issueTypes" | "fields") =>
    cloud
      ? { [key]: items, total: items.length, startAt: 0, maxResults: 100 }
      : { values: items, isLast: true };
  return [
    [
      new RegExp(`^GET ${base}/rest/api/${api}/project/POR$`),
      { json: { key: "POR", name: "Portal", issueTypes: typeList } },
    ],
    [
      new RegExp(
        `^GET ${base}/rest/api/${api}/issue/createmeta/POR/issuetypes\\?`,
      ),
      { json: page(typeList, "issueTypes") },
    ],
    ...types.map((t): Route => [
      new RegExp(
        `^GET ${base}/rest/api/${api}/issue/createmeta/POR/issuetypes/${t.id}\\?`,
      ),
      {
        json: page(
          t.level === 1 ? jiraEpicFields(cloud) : storyFields,
          "fields",
        ),
      },
    ]),
    [
      new RegExp(`^GET ${base}/rest/api/${api}/issueLinkType$`),
      {
        json: {
          issueLinkTypes: [
            {
              id: "1",
              name: "Blocks",
              inward: "is blocked by",
              outward: "blocks",
            },
            {
              id: "2",
              name: "Relates",
              inward: "relates to",
              outward: "relates to",
            },
          ],
        },
      },
    ],
  ];
}

/* ------------------------------------------------------------------ */
/* GitHub                                                               */
/* ------------------------------------------------------------------ */

export interface GitHubFixture {
  org?: boolean;
  hasIssues?: boolean;
  issueTypesStatus?: number;
}

export function githubRoutes(fx: GitHubFixture = {}): Route[] {
  const org = fx.org ?? true;
  const base = "https://api\\.github\\.com";
  return [
    [
      new RegExp(`^GET ${base}/repos/acme/portal$`),
      {
        json: {
          full_name: "acme/portal",
          has_issues: fx.hasIssues ?? true,
          archived: false,
          owner: { login: "acme", type: org ? "Organization" : "User" },
          permissions: {
            admin: false,
            maintain: false,
            push: true,
            triage: true,
            pull: true,
          },
        },
      },
    ],
    [
      new RegExp(`^GET ${base}/repos/acme/portal/labels\\?`),
      {
        json: [
          { name: "bug" },
          { name: "feature: Authentication" },
          { name: "coherence" },
        ],
      },
    ],
    [
      new RegExp(`^GET ${base}/repos/acme/portal/milestones\\?`),
      { json: [{ title: "Authentication", number: 1 }] },
    ],
    [
      new RegExp(`^GET ${base}/orgs/acme/issue-types$`),
      fx.issueTypesStatus
        ? { status: fx.issueTypesStatus, json: { message: "Forbidden" } }
        : {
            json: [
              { id: 1, name: "Task", is_enabled: true },
              { id: 2, name: "Bug", is_enabled: true },
              { id: 3, name: "Feature", is_enabled: true },
              { id: 4, name: "Retired", is_enabled: false },
            ],
          },
    ],
    [
      new RegExp(`^GET ${base}/orgs/acme/issue-fields$`),
      {
        json: [
          { id: 11, name: "Business value", data_type: "text" },
          {
            id: 12,
            name: "Priority",
            data_type: "single_select",
            options: [{ name: "P0" }, { name: "P1" }, { name: "P2" }],
          },
          { id: 13, name: "Target date", data_type: "date" },
        ],
      },
    ],
  ];
}
