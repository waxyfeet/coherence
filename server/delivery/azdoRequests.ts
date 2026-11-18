/**
 * The one place Azure DevOps requests are built from a delivery plan: the payload preview, the validate-only check
 * and the real publish all come from here, so what the BA previews is what is sent (only work item ids differ).
 * Work Item Tracking REST 7.1, JSON Patch. Pure: no request is made here.
 */
import type {
  DeliveryPlan,
  DestinationField,
  PlannedField,
  PlannedItem,
  PlannedRelationship,
} from "@shared/delivery";
import {
  azdoWorkItemApiUrl,
  PARENT_COMMENT,
  PARENT_REL,
  PREDECESSOR_REL,
  type JsonPatchOp,
} from "../export/azdo";
import { markdownToHtml } from "../export/markdown";

export const AZDO_API_VERSION = "api-version=7.1";

export interface AzdoTarget {
  /** Normalised organisation URL, "https://dev.azure.com/acme". */
  orgUrl: string;
  project: string;
}

/** A work item id for a plan item that exists (earlier or in this run); undefined when it does not exist yet. */
export type KeyOf = (itemId: string) => string | undefined;

export interface AzdoRequest {
  method: "POST" | "PATCH";
  url: string;
  ops: JsonPatchOp[];
}

function fieldOf(
  plan: DeliveryPlan,
  item: PlannedItem,
  fieldId: string,
): DestinationField | undefined {
  return plan.destinationTypes
    .find((t) => t.id === item.typeId)
    ?.fields?.find((f) => f.id === fieldId);
}

function numericOption(field: DestinationField | undefined): boolean {
  return /^(integer|double|picklistinteger|picklistdouble)$/i.test(
    field?.sourceType ?? "",
  );
}

/** A planned value as Azure DevOps takes it: rich text as HTML, tags joined with "; ", numeric picklists as numbers. */
export function azdoFieldValue(
  plan: DeliveryPlan,
  item: PlannedItem,
  f: PlannedField,
): unknown {
  if (f.kind === "rich-text" && typeof f.value === "string")
    return markdownToHtml(f.value);
  if (f.kind === "labels" && Array.isArray(f.value)) return f.value.join("; ");
  if (f.kind === "option" && numericOption(fieldOf(plan, item, f.fieldId)))
    return Number(f.value);
  return f.value;
}

export function projectUrl(target: AzdoTarget, path: string): string {
  return `${target.orgUrl}/${encodeURIComponent(target.project)}${path}`;
}

export function workItemUrl(target: AzdoTarget, id: string): string {
  return projectUrl(
    target,
    `/_apis/wit/workitems/${encodeURIComponent(id)}?${AZDO_API_VERSION}`,
  );
}

/** Relationships that leave this item: its parent (sent with the item) and its dependencies (sent afterwards). */
export function plannedRelations(
  plan: DeliveryPlan,
  item: PlannedItem,
): { parent?: PlannedRelationship; dependencies: PlannedRelationship[] } {
  const rels = plan.relationships.filter(
    (r) => r.fromItemId === item.id && r.status === "planned",
  );
  return {
    parent: rels.find((r) => r.kind === "parent" && r.via === "relation"),
    dependencies: rels.filter((r) => r.kind === "dependency" && r.linkTypeId),
  };
}

export function relationTarget(
  r: PlannedRelationship,
  keyOf: KeyOf,
): string | undefined {
  return r.toItemId ? keyOf(r.toItemId) : r.toExternal?.key;
}

export function parentRelation(
  target: AzdoTarget,
  parentId: string,
): JsonPatchOp {
  return {
    op: "add",
    path: "/relations/-",
    value: {
      rel: PARENT_REL,
      url: azdoWorkItemApiUrl(target.orgUrl, parentId),
      attributes: { comment: PARENT_COMMENT },
    },
  };
}

/**
 * Create one work item. The parent link travels in the same request, so the item and its link succeed or fail
 * together; `withoutParent` leaves it out for a validate-only check made before the parent exists.
 */
export function createRequest(
  plan: DeliveryPlan,
  item: PlannedItem,
  target: AzdoTarget,
  keyOf: KeyOf,
  opts: { validateOnly?: boolean; withoutParent?: boolean } = {},
): AzdoRequest {
  const ops: JsonPatchOp[] = item.fields
    .filter((f) => f.value !== null)
    .map((f) => ({
      op: "add",
      path: `/fields/${f.fieldId}`,
      value: azdoFieldValue(plan, item, f),
    }));
  const { parent } = plannedRelations(plan, item);
  const parentId = parent ? relationTarget(parent, keyOf) : undefined;
  if (parent && !opts.withoutParent) {
    if (!parentId)
      throw new Error(
        `${item.id}: its parent ${parent.toItemId ?? ""} has no work item id yet.`,
      );
    ops.push(parentRelation(target, parentId));
  }
  return {
    method: "POST",
    url: projectUrl(
      target,
      `/_apis/wit/workitems/$${encodeURIComponent(item.typeId)}?${AZDO_API_VERSION}${opts.validateOnly ? "&validateOnly=true" : ""}`,
    ),
    ops,
  };
}

/**
 * Update an existing work item: only the fields the comparison says to send (team edits are kept). The first
 * operation tests the work item's revision read when planning, so an edit made in between makes Azure DevOps refuse
 * the whole update instead of overwriting it.
 */
export function updateRequest(
  plan: DeliveryPlan,
  item: PlannedItem,
  target: AzdoTarget,
  opts: { validateOnly?: boolean } = {},
): AzdoRequest {
  const rev = item.existing?.remoteRev;
  return {
    method: "PATCH",
    url: `${workItemUrl(target, item.existing?.key ?? "")}${opts.validateOnly ? "&validateOnly=true" : ""}`,
    ops: [
      ...(rev === undefined
        ? []
        : [{ op: "test" as const, path: "/rev", value: rev }]),
      ...item.fields
        .filter((f) => f.value !== null && f.updateAction === "send")
        .map((f) => ({
          op: "add" as const,
          path: `/fields/${f.fieldId}`,
          value: azdoFieldValue(plan, item, f),
        })),
    ],
  };
}

/** Link a dependent work item to its prerequisite ("Predecessor"), with Coherence's comment. */
export function dependencyRequest(
  plan: DeliveryPlan,
  r: PlannedRelationship,
  target: AzdoTarget,
  keyOf: KeyOf,
): AzdoRequest | undefined {
  const from = keyOf(r.fromItemId);
  const to = relationTarget(r, keyOf);
  if (!from || !to) return undefined;
  const fromUc = r.fromItemId.replace(/^uc:/, "");
  const toUc = r.toExternal?.useCaseId ?? r.toItemId?.replace(/^uc:/, "");
  return {
    method: "PATCH",
    url: workItemUrl(target, from),
    ops: [
      {
        op: "add",
        path: "/relations/-",
        value: {
          rel: r.linkTypeId ?? PREDECESSOR_REL,
          url: azdoWorkItemApiUrl(target.orgUrl, to),
          attributes: { comment: `${fromUc} depends on ${toUc} (Coherence)` },
        },
      },
    ],
  };
}
