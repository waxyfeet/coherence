/**
 * Destination payload previews for planned items — exactly what a future publish would send, rendered from the
 * plan's canonical values. Nothing here performs a request. Items that do not exist yet are referenced by
 * placeholders ("{{group:FEAT-01}}"), because their keys are only known after creation.
 */
import type {
  DeliveryPlan,
  DestinationField,
  PlannedField,
  PlannedItem,
  TextFormat,
} from "@shared/delivery";
import { markdownToHtml, markdownToJiraWiki } from "../export/markdown";
import { adfText, markdownToAdf } from "./adf";
import {
  AZDO_API_VERSION,
  createRequest,
  dependencyRequest,
  plannedRelations,
  projectUrl,
  relationTarget,
  updateRequest,
  type AzdoTarget,
} from "./azdoRequests";
import {
  jiraApi,
  jiraCreateRequest,
  jiraDependencies,
  jiraLinkRequest,
  jiraUpdateRequest,
  type JiraTarget,
} from "./jiraRequests";
import {
  githubAddLabelsRequest,
  githubCreateRequest,
  githubUpdateRequest,
  unsentFields,
  type GitHubTarget,
} from "./githubRequests";

export interface PayloadPreview {
  itemId: string;
  system: DeliveryPlan["system"];
  operation: PlannedItem["operation"];
  format: TextFormat;
  /** Illustrative request line; never sent in this milestone. */
  request: string;
  body: unknown;
  /** Second-pass relationship requests (links, sub-issues, dependencies). */
  relationships: { description: string; body: unknown }[];
  notes: string[];
}

/** A rich-text value in the destination's own format. */
export function renderRich(format: TextFormat, markdown: string): unknown {
  switch (format) {
    case "html":
      return markdownToHtml(markdown);
    case "jira-wiki":
      return markdownToJiraWiki(markdown);
    case "adf":
      return markdownToAdf(markdown);
    case "markdown":
      return markdown;
  }
}

/** Characters the destination will count for a rich-text value (ADF: its visible text). */
export function renderedLength(format: TextFormat, markdown: string): number {
  const rendered = renderRich(format, markdown);
  return typeof rendered === "string"
    ? rendered.length
    : adfText(rendered as Parameters<typeof adfText>[0]).length;
}

function placeholder(plan: DeliveryPlan, itemId: string): string {
  const item = plan.items.find((i) => i.id === itemId);
  return item?.existing?.key ?? `{{${itemId}}}`;
}

function fieldOf(plan: DeliveryPlan, item: PlannedItem, fieldId: string) {
  return plan.destinationTypes
    .find((t) => t.id === item.typeId)
    ?.fields?.find((f) => f.id === fieldId);
}

export function renderItem(
  plan: DeliveryPlan,
  item: PlannedItem,
): PayloadPreview {
  const notes: string[] = [];
  const relationships: PayloadPreview["relationships"] = [];
  const set = item.fields.filter(
    (f) =>
      f.value !== null &&
      (f.updateAction === undefined || f.updateAction === "send"),
  );
  const rels = plan.relationships.filter(
    (r) => r.fromItemId === item.id && r.status === "planned",
  );
  const target = (r: (typeof rels)[number]) =>
    r.toItemId ? placeholder(plan, r.toItemId) : (r.toExternal?.key ?? "");
  const base = {
    itemId: item.id,
    system: plan.system,
    operation: item.operation,
    format: plan.destination.textFormat,
  };
  if (item.operation === "keep")
    notes.push("No change is needed; nothing would be sent for this item.");

  if (plan.system === "azdo") {
    // Exactly the publish requests (azdoRequests.ts); work items that don't exist yet appear as {{item id}}.
    const azdo: AzdoTarget = {
      orgUrl: `https://${plan.destination.identity.base}`,
      project: plan.destination.identity.container,
    };
    const keyOf = (id: string) => placeholder(plan, id);
    // The request line without the organisation, project and API version (all fixed by Settings).
    const path = (url: string) =>
      decodeURI(
        url
          .slice(projectUrl(azdo, "").length)
          .replace(`?${AZDO_API_VERSION}`, ""),
      );
    if (item.operation === "keep")
      return {
        ...base,
        request: `Nothing to send: work item ${item.existing?.key ?? ""} is already there`,
        body: [],
        relationships,
        notes,
      };
    if (item.operation === "update") {
      const update = updateRequest(plan, item, azdo);
      return {
        ...base,
        request: `${update.method} ${path(update.url)}`,
        body: update.ops,
        relationships,
        notes: [
          ...notes,
          "Only the fields that changed in Coherence are sent; edits the team made are kept. The revision test makes Azure DevOps refuse the update if the work item changed after this plan was made.",
        ],
      };
    }
    const create = createRequest(plan, item, azdo, keyOf);
    for (const r of plannedRelations(plan, item).dependencies) {
      const link = dependencyRequest(plan, r, azdo, keyOf);
      if (link)
        relationships.push({
          description: `Then: link to ${relationTarget(r, keyOf)} (${r.linkTypeId}) · PATCH ${path(link.url)}`,
          body: link.ops,
        });
    }
    return {
      ...base,
      request: `${create.method} ${path(create.url)}`,
      body: create.ops,
      relationships,
      notes,
    };
  }

  if (plan.system === "jira") {
    // Exactly the publish requests (jiraRequests.ts); issues that don't exist yet appear as {{item id}}.
    const site: JiraTarget = {
      baseUrl: `https://${plan.destination.identity.base}`,
      projectKey: plan.destination.identity.container.toUpperCase(),
      api: jiraApi(plan),
    };
    const keyOf = (id: string) => placeholder(plan, id);
    const path = (url: string) => url.slice(site.baseUrl.length);
    if (item.operation === "keep")
      return {
        ...base,
        request: `Nothing to send: ${item.existing?.key ?? ""} is already there`,
        body: {},
        relationships,
        notes,
      };
    const request =
      item.operation === "update"
        ? jiraUpdateRequest(plan, item, site)
        : jiraCreateRequest(plan, item, site, keyOf);
    if (item.operation === "create")
      for (const r of jiraDependencies(plan, item)) {
        const link = jiraLinkRequest(r, site, keyOf);
        if (link)
          relationships.push({
            description: `Then: "${r.linkTypeId}" link ${target(r)} → ${placeholder(plan, item.id)} · POST ${path(link.url)}`,
            body: link.body,
          });
      }
    return {
      ...base,
      request: `${request.method} ${path(request.url)}`,
      body: request.body,
      relationships,
      notes:
        item.operation === "update"
          ? [
              ...notes,
              "Only the fields that changed in Coherence are sent, and labels are only added. Coherence checks just before sending that nobody edited the issue since this plan was made.",
            ]
          : notes,
    };
  }

  // GitHub: exactly the publish requests (githubRequests.ts); issues and milestones that don't exist yet appear as
  // {{item id}}, and a milestone that already exists by name is resolved to its number when publishing.
  const site: GitHubTarget = {
    apiBase: "",
    repoPath: `/repos/${plan.destination.identity.container}`,
  };
  const keyOf = (id: string) => placeholder(plan, id);
  if (item.operation === "keep")
    return {
      ...base,
      request: `Nothing to send: ${item.existing?.key ?? item.title} is already there`,
      body: {},
      relationships,
      notes,
    };
  const unsent = unsentFields(item);
  if (unsent.length)
    notes.push(
      `Organisation issue fields aren't sent yet: ${unsent.join(", ")}. Set them on GitHub after publishing.`,
    );
  if (item.operation === "update") {
    const update = githubUpdateRequest(plan, item, site, keyOf);
    const labels = githubAddLabelsRequest(item, site);
    if (labels)
      relationships.push({
        description: `Then: add labels · POST ${labels.url}`,
        body: labels.body,
      });
    return {
      ...base,
      request: `${update.method} ${update.url}`,
      body: update.body,
      relationships,
      notes: [
        ...notes,
        "Only the fields that changed in Coherence are sent, and labels are only added. Coherence checks just before sending that nobody edited the issue since this plan was made.",
      ],
    };
  }
  const create = githubCreateRequest(plan, item, site, keyOf);
  return {
    ...base,
    request: `${create.method} ${create.url}`,
    body: create.body,
    relationships,
    notes,
  };
}
