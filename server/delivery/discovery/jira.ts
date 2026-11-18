/**
 * Jira discovery (GET only). Cloud uses REST v3 (descriptions and multi-line custom fields are Atlassian Document
 * Format); Server/Data Center uses REST v2 (wiki markup) — the variants are not treated as identical.
 * Create metadata comes from the per-project, per-issue-type createmeta endpoints; the combined createmeta is
 * deprecated. Only fields on the create screen can be set when an issue is created.
 */
import type {
  DestinationCapability,
  DestinationField,
  DestinationHierarchy,
  DestinationItemType,
  DestinationLinkType,
  FieldKind,
  FieldRole,
  ItemLevel,
} from "@shared/delivery";
import type { JiraSettings } from "@shared/types";
import { IntegrationError, errorMessage } from "../../errors";
import {
  JIRA_SERVICE,
  jiraHeaders,
  validateJiraSettings,
} from "../../export/jira";
import { targetBase } from "../../export/target";
import { LIMITS, permittedValues, untrustedText } from "../untrusted";
import { ReadOnlyClient } from "./readOnly";
import type { DiscoveryDraft } from "./types";

interface IssueTypeInfo {
  id?: string;
  name?: string;
  subtask?: boolean;
  hierarchyLevel?: number;
}
interface FieldMeta {
  fieldId?: string;
  key?: string;
  name?: string;
  required?: boolean;
  hasDefaultValue?: boolean;
  operations?: string[];
  schema?: {
    type?: string;
    items?: string;
    system?: string;
    custom?: string;
  };
  allowedValues?: { id?: string; name?: string; value?: string }[];
}
interface Paged<T> {
  issueTypes?: T[];
  fields?: T[];
  values?: T[];
  total?: number;
  isLast?: boolean;
}

const PAGE = 50;
const MAX_PAGES = 4;
/** Jira text fields hold 32,767 characters; summary 255. */
const TEXT_LIMIT = 32_767;

const CUSTOM = "com.atlassian.jira.plugin.system.customfieldtypes:";
export const EPIC_LINK = "com.pyxis.greenhopper.jira:gh-epic-link";
export const EPIC_NAME = "com.pyxis.greenhopper.jira:gh-epic-label";
const STORY_POINTS = "com.pyxis.greenhopper.jira:jsw-story-points";

export function jiraFieldShape(
  meta: FieldMeta,
  settings: Pick<JiraSettings, "storyPointsFieldId">,
): { kind: FieldKind; role: FieldRole; maxLength?: number } {
  const system = meta.schema?.system;
  const custom = meta.schema?.custom ?? "";
  const id = meta.fieldId ?? meta.key ?? "";
  switch (system) {
    case "summary":
      return { kind: "single-line", role: "title", maxLength: 255 };
    case "description":
      return { kind: "rich-text", role: "description", maxLength: TEXT_LIMIT };
    case "labels":
      return { kind: "labels", role: "labels" };
    case "priority":
      return { kind: "option", role: "priority" };
    case "parent":
      return { kind: "reference", role: "parent" };
    case "issuetype":
    case "project":
      return { kind: "unknown", role: "structural" };
    case "reporter":
    case "assignee":
      return { kind: "user", role: "team" };
    case "duedate":
      return { kind: "date", role: "team" };
    case "components":
    case "fixVersions":
    case "versions":
      return { kind: "multi-option", role: "team" };
    case "environment":
      return { kind: "rich-text", role: "team", maxLength: TEXT_LIMIT };
    case undefined:
      break;
    default:
      return { kind: "unknown", role: "team" };
  }
  if (custom === EPIC_LINK) return { kind: "reference", role: "parent" };
  if (custom === EPIC_NAME)
    return { kind: "single-line", role: "epic-name", maxLength: 255 };
  if (
    custom === STORY_POINTS ||
    (id && id === settings.storyPointsFieldId?.trim())
  )
    return { kind: "number", role: "estimate" };
  if (
    custom.startsWith("com.pyxis.greenhopper.jira:") ||
    custom.startsWith("com.atlassian.jpo") ||
    custom.startsWith("com.atlassian.teams")
  )
    return { kind: "unknown", role: "team" };
  switch (custom.startsWith(CUSTOM) ? custom.slice(CUSTOM.length) : "") {
    case "textfield":
    case "url":
      return { kind: "single-line", role: "custom", maxLength: 255 };
    case "textarea":
      return { kind: "rich-text", role: "custom", maxLength: TEXT_LIMIT };
    case "float":
      return { kind: "number", role: "custom" };
    case "select":
    case "radiobuttons":
      return { kind: "option", role: "custom" };
    case "multiselect":
    case "multicheckboxes":
      return { kind: "multi-option", role: "custom" };
    case "datepicker":
    case "datetime":
      return { kind: "date", role: "custom" };
    case "userpicker":
    case "multiuserpicker":
      return { kind: "user", role: "custom" };
    case "labels":
      return { kind: "labels", role: "custom" };
  }
  switch (meta.schema?.type) {
    case "string":
      return { kind: "single-line", role: "custom", maxLength: 255 };
    case "number":
      return { kind: "number", role: "custom" };
    case "date":
    case "datetime":
      return { kind: "date", role: "custom" };
    case "option":
      return { kind: "option", role: "custom" };
    case "user":
      return { kind: "user", role: "custom" };
    default:
      return { kind: "unknown", role: "custom" };
  }
}

function toField(
  meta: FieldMeta,
  settings: JiraSettings,
): DestinationField | undefined {
  const id = (meta.fieldId ?? meta.key ?? "").trim();
  if (!id || !/^[\w.-]+$/.test(id)) return undefined;
  const shape = jiraFieldShape(meta, settings);
  const allowed =
    shape.kind === "option" || shape.kind === "multi-option"
      ? permittedValues(
          (meta.allowedValues ?? []).map((v) => v.name ?? v.value),
        )
      : {};
  return {
    id,
    name: untrustedText(meta.name ?? id, LIMITS.name) || id,
    kind: shape.kind,
    role: shape.role,
    required: !!meta.required,
    hasDefault: !!meta.hasDefaultValue,
    readOnly: Array.isArray(meta.operations)
      ? !meta.operations.includes("set")
      : false,
    custom: id.startsWith("customfield_"),
    ...(allowed.values ? { allowedValues: allowed.values } : {}),
    ...(allowed.truncated ? { allowedValuesTruncated: true } : {}),
    ...(shape.maxLength ? { maxLength: shape.maxLength } : {}),
    sourceType: untrustedText(
      meta.schema?.custom ?? meta.schema?.system ?? meta.schema?.type ?? "",
      80,
    ),
  };
}

function levelOf(
  type: IssueTypeInfo,
  settings: JiraSettings,
  cloud: boolean,
): ItemLevel {
  if (type.subtask) return "subtask";
  if (cloud && typeof type.hierarchyLevel === "number") {
    if (type.hierarchyLevel < 0) return "subtask";
    if (type.hierarchyLevel >= 1) return "portfolio";
    return "requirement";
  }
  const epic = (settings.epicIssueType?.trim() || "Epic").toLowerCase();
  return type.name?.trim().toLowerCase() === epic ? "portfolio" : "requirement";
}

export async function discoverJira(
  settings: JiraSettings,
  signal?: AbortSignal,
): Promise<DiscoveryDraft> {
  const { baseUrl } = validateJiraSettings(settings);
  const cloud = settings.deployment !== "server";
  const api = cloud ? "/rest/api/3" : "/rest/api/2";
  const key = settings.projectKey.trim();
  const k = encodeURIComponent(key);
  const client = new ReadOnlyClient(
    JIRA_SERVICE,
    baseUrl,
    jiraHeaders(settings),
    signal,
  );
  const gaps: string[] = [];

  const project = await client.get<{
    key?: string;
    name?: string;
    style?: string;
    issueTypes?: IssueTypeInfo[];
  }>(`${api}/project/${k}`, [404]);
  if (project.status === 404)
    throw new IntegrationError(
      `Jira project "${key}" was not found, or the account cannot see it. Nothing was changed.`,
    );

  const types: IssueTypeInfo[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.get<Paged<IssueTypeInfo>>(
      `${api}/issue/createmeta/${k}/issuetypes?startAt=${page * PAGE}&maxResults=${PAGE}`,
    );
    const batch = res.data?.issueTypes ?? res.data?.values ?? [];
    types.push(...batch);
    const total = res.data?.total;
    if (
      batch.length < PAGE ||
      res.data?.isLast === true ||
      (typeof total === "number" && types.length >= total)
    )
      break;
    if (page === MAX_PAGES - 1)
      gaps.push("Only the first 200 issue types were read.");
  }
  // Cloud's project response carries hierarchy levels that createmeta may omit.
  const projectLevels = new Map(
    (project.data?.issueTypes ?? []).map((t) => [t.id, t.hierarchyLevel]),
  );
  const configured = settings.issueType?.trim() || "Story";
  const configuredEpic = settings.epicIssueType?.trim() || "Epic";
  const itemTypes: DestinationItemType[] = types
    .filter((t) => typeof t.id === "string" && t.id && t.name?.trim())
    .map((t) => {
      const info = {
        ...t,
        hierarchyLevel: t.hierarchyLevel ?? projectLevels.get(t.id),
      };
      const level = levelOf(info, settings, cloud);
      const name = t.name!.trim();
      return {
        id: t.id!,
        name: untrustedText(name, LIMITS.name) || name,
        level,
        ...((level === "requirement" && name === configured) ||
        (level === "portfolio" && name === configuredEpic)
          ? { isDefault: true }
          : {}),
      };
    });
  if (!itemTypes.length)
    throw new IntegrationError(
      `The Jira account cannot create issues in "${key}" (no issue types are available to it), so a delivery plan cannot be prepared.`,
    );

  const wanted = [
    ...itemTypes.filter((t) => t.isDefault),
    ...itemTypes
      .filter((t) => !t.isDefault && t.level === "requirement")
      .slice(0, 3),
    ...itemTypes
      .filter((t) => !t.isDefault && t.level === "portfolio")
      .slice(0, 1),
  ];
  for (const type of wanted) {
    try {
      const fields: DestinationField[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await client.get<Paged<FieldMeta>>(
          `${api}/issue/createmeta/${k}/issuetypes/${encodeURIComponent(type.id)}?startAt=${page * 100}&maxResults=100`,
        );
        const batch = res.data?.fields ?? res.data?.values ?? [];
        for (const meta of batch) {
          const field = toField(meta, settings);
          if (field) fields.push(field);
        }
        const total = res.data?.total;
        if (
          batch.length < 100 ||
          res.data?.isLast === true ||
          (typeof total === "number" && fields.length >= total)
        )
          break;
      }
      type.fields = fields;
    } catch (err) {
      gaps.push(
        `The create-screen fields of "${type.name}" could not be read (${errorMessage(err)}); its required fields are Unknown.`,
      );
    }
  }

  const linkTypes: DestinationLinkType[] = [];
  try {
    const res = await client.get<{
      issueLinkTypes?: {
        id?: string;
        name?: string;
        inward?: string;
        outward?: string;
      }[];
    }>(`${api}/issueLinkType`);
    for (const l of res.data?.issueLinkTypes ?? []) {
      const name = l.name?.trim();
      if (!name || /[\u0000-\u001f]/.test(name)) continue;
      linkTypes.push({
        id: name,
        name: untrustedText(name, LIMITS.name) || name,
        kind: /block|depend|precede/i.test(name) ? "dependency" : "related",
        direction: untrustedText(l.inward ?? "", 60) || undefined,
      });
    }
  } catch (err) {
    gaps.push(
      `Issue link types could not be read (${errorMessage(err)}); dependency links are Unknown.`,
    );
  }

  const hierarchy: DestinationHierarchy[] = [];
  const portfolio = itemTypes.filter((t) => t.level === "portfolio");
  const requirement = itemTypes.filter((t) => t.level === "requirement");
  const subtask = itemTypes.filter((t) => t.level === "subtask");
  for (const parent of portfolio)
    for (const child of requirement) {
      if (cloud)
        hierarchy.push({
          parentTypeId: parent.id,
          childTypeId: child.id,
          via: "parent-field",
        });
      else if (child.fields?.some((f) => f.role === "parent"))
        hierarchy.push({
          parentTypeId: parent.id,
          childTypeId: child.id,
          via: "epic-link",
        });
    }
  for (const parent of requirement)
    for (const child of subtask)
      hierarchy.push({
        parentTypeId: parent.id,
        childTypeId: child.id,
        via: "parent-field",
      });
  if (
    !cloud &&
    portfolio.length &&
    !hierarchy.some((h) => h.via === "epic-link")
  )
    gaps.push(
      "No Epic Link field is on the story create screen, so stories cannot be placed under epics when they are created.",
    );

  const requirementType = itemTypes.find(
    (t) => t.isDefault && t.level === "requirement",
  );
  const acField = requirementType?.fields?.find((f) =>
    /acceptance\s*criteria/i.test(f.name),
  );
  const capabilities: DestinationCapability[] = [
    {
      id: "acceptance-criteria-field",
      state: acField
        ? "supported"
        : requirementType?.fields
          ? "unsupported"
          : "unknown",
      note: acField
        ? `"${acField.name}" looks like an acceptance criteria field; using it needs your confirmation.`
        : "Jira has no standard Acceptance Criteria field; scenarios go in the Description unless you map a custom field.",
    },
    {
      id: "rich-text-format",
      state: "supported",
      note: cloud
        ? "Jira Cloud: description and multi-line fields use Atlassian Document Format (REST v3)."
        : "Jira Server/Data Center: description and multi-line fields use wiki markup (REST v2).",
    },
    {
      id: "attachments",
      state: "supported",
      note: "Issues accept attachments; Coherence uploads none without your approval.",
    },
  ];

  return {
    identity: {
      system: "jira",
      base: targetBase("jira", settings) ?? baseUrl.toLowerCase(),
      container: key.toLowerCase(),
      variant: cloud ? "cloud" : "server",
    },
    textFormat: cloud ? "adf" : "jira-wiki",
    itemTypes,
    linkTypes,
    hierarchy,
    capabilities,
    gaps,
    requestCount: client.requests.length,
  };
}
