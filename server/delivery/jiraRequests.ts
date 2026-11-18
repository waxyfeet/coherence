/**
 * The one place Jira requests are built from a delivery plan: the payload preview and the real publish both come from
 * here, so what the BA previews is what is sent (only issue keys differ). Cloud uses REST v3 with Atlassian Document
 * Format; Server/Data Center uses v2 with wiki markup (DestinationSchema.textFormat). Pure: no request is made here.
 *
 * Link direction (server/export/jira.ts): with type "Blocks", the inwardIssue blocks the outwardIssue, so the
 * prerequisite is the inwardIssue and the dependent use case the outwardIssue.
 */
import type {
  DeliveryPlan,
  PlannedField,
  PlannedItem,
  PlannedRelationship,
} from "@shared/delivery";
import { markdownToJiraWiki } from "../export/markdown";
import { markdownToAdf } from "./adf";
import type { KeyOf } from "./azdoRequests";

export interface JiraTarget {
  /** Normalised site URL, "https://acme.atlassian.net". */
  baseUrl: string;
  projectKey: string;
  /** "3" (Cloud, ADF) or "2" (Server/Data Center, wiki markup). */
  api: "2" | "3";
}

export interface JiraRequest {
  method: "POST" | "PUT";
  url: string;
  body: unknown;
}

export function jiraApi(plan: Pick<DeliveryPlan, "destination">): "2" | "3" {
  return plan.destination.textFormat === "adf" ? "3" : "2";
}

function fieldOf(plan: DeliveryPlan, item: PlannedItem, fieldId: string) {
  return plan.destinationTypes
    .find((t) => t.id === item.typeId)
    ?.fields?.find((f) => f.id === fieldId);
}

/** A planned value as Jira takes it: rich text as ADF or wiki markup, options as {value} ({name} for priority). */
export function jiraFieldValue(
  plan: DeliveryPlan,
  item: PlannedItem,
  f: PlannedField,
): unknown {
  if (f.kind === "rich-text" && typeof f.value === "string")
    return plan.destination.textFormat === "adf"
      ? markdownToAdf(f.value)
      : markdownToJiraWiki(f.value);
  if (f.kind === "option")
    return fieldOf(plan, item, f.fieldId)?.role === "priority"
      ? { name: f.value }
      : { value: f.value };
  if (f.kind === "multi-option" && Array.isArray(f.value))
    return f.value.map((value) => ({ value }));
  return f.value;
}

/** The item's parent, set through the Parent field (Cloud) or the Epic Link field (Data Center). */
export function jiraParent(
  plan: DeliveryPlan,
  item: PlannedItem,
): PlannedRelationship | undefined {
  return plan.relationships.find(
    (r) =>
      r.fromItemId === item.id &&
      r.kind === "parent" &&
      r.status === "planned" &&
      (r.via === "parent-field" || r.via === "epic-link"),
  );
}

export function jiraDependencies(
  plan: DeliveryPlan,
  item: PlannedItem,
): PlannedRelationship[] {
  return plan.relationships.filter(
    (r) =>
      r.fromItemId === item.id &&
      r.kind === "dependency" &&
      r.status === "planned" &&
      !!r.linkTypeId,
  );
}

function target(r: PlannedRelationship, keyOf: KeyOf): string | undefined {
  return r.toItemId ? keyOf(r.toItemId) : r.toExternal?.key;
}

/** Create one issue, with its parent in the same request (a new Epic is always created first). */
export function jiraCreateRequest(
  plan: DeliveryPlan,
  item: PlannedItem,
  site: JiraTarget,
  keyOf: KeyOf,
): JiraRequest {
  const fields: Record<string, unknown> = {
    project: { key: site.projectKey },
    issuetype: { id: item.typeId },
  };
  for (const f of item.fields)
    if (f.value !== null) fields[f.fieldId] = jiraFieldValue(plan, item, f);
  const parent = jiraParent(plan, item);
  if (parent) {
    const key = target(parent, keyOf);
    if (!key)
      throw new Error(
        `${item.id}: its parent ${parent.toItemId ?? ""} has no issue key yet.`,
      );
    if (parent.via === "parent-field") fields.parent = { key };
    else {
      const link = plan.destinationTypes
        .find((t) => t.id === item.typeId)
        ?.fields?.find((f) => f.role === "parent");
      if (link) fields[link.id] = key;
    }
  }
  return {
    method: "POST",
    url: `${site.baseUrl}/rest/api/${site.api}/issue`,
    body: { fields },
  };
}

/**
 * Update an existing issue: only the fields the comparison says to send. Labels are only ever added ("add"
 * operations), so a label the team adds in the meantime is never removed.
 */
export function jiraUpdateRequest(
  plan: DeliveryPlan,
  item: PlannedItem,
  site: JiraTarget,
): JiraRequest {
  const fields: Record<string, unknown> = {};
  const update: Record<string, { add: string }[]> = {};
  for (const f of item.fields) {
    if (f.value === null || f.updateAction !== "send") continue;
    if (f.kind === "labels" && Array.isArray(f.value))
      update[f.fieldId] = f.value.map((add) => ({ add }));
    else fields[f.fieldId] = jiraFieldValue(plan, item, f);
  }
  return {
    method: "PUT",
    url: `${site.baseUrl}/rest/api/${site.api}/issue/${encodeURIComponent(item.existing?.key ?? "")}`,
    body: {
      ...(Object.keys(fields).length ? { fields } : {}),
      ...(Object.keys(update).length ? { update } : {}),
    },
  };
}

/** "<prerequisite> blocks <dependent>": the prerequisite is the inwardIssue. */
export function jiraLinkRequest(
  r: PlannedRelationship,
  site: JiraTarget,
  keyOf: KeyOf,
): JiraRequest | undefined {
  const dependent = keyOf(r.fromItemId);
  const prerequisite = target(r, keyOf);
  if (!dependent || !prerequisite || !r.linkTypeId) return undefined;
  return {
    method: "POST",
    url: `${site.baseUrl}/rest/api/${site.api}/issueLink`,
    body: {
      type: { name: r.linkTypeId },
      inwardIssue: { key: prerequisite },
      outwardIssue: { key: dependent },
    },
  };
}
