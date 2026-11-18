/**
 * Azure DevOps discovery (Work Item Tracking REST 7.1, GET only): project, type categories, work item types,
 * per-type fields with required/default/permitted values, field definitions, relation types and area/iteration
 * trees. Process rules that make a field required only in some states are not exposed by these endpoints; the
 * capability matrix records that only server-side validation could confirm them.
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
import type { AzdoSettings } from "@shared/types";
import { IntegrationError, errorMessage } from "../../errors";
import {
  AZDO_SERVICE,
  azdoHeaders,
  validateAzdoSettings,
} from "../../export/azdo";
import { targetBase } from "../../export/target";
import { LIMITS, permittedValues, untrustedText } from "../untrusted";
import { ReadOnlyClient } from "./readOnly";
import type { DiscoveryDraft } from "./types";

const V = "api-version=7.1";

interface Category {
  referenceName?: string;
  name?: string;
  defaultWorkItemType?: { name?: string };
  workItemTypes?: { name?: string }[];
}
interface WorkItemType {
  name?: string;
  referenceName?: string;
  isDisabled?: boolean;
}
interface TypeField {
  referenceName?: string;
  name?: string;
  alwaysRequired?: boolean;
  defaultValue?: unknown;
  allowedValues?: unknown[];
  helpText?: string;
}
interface FieldDefinition {
  referenceName?: string;
  name?: string;
  type?: string;
  readOnly?: boolean;
  isPicklist?: boolean;
  isIdentity?: boolean;
}
interface RelationType {
  referenceName?: string;
  name?: string;
  attributes?: { usage?: string; enabled?: boolean };
}
interface ClassificationNode {
  name?: string;
  structureType?: string;
  children?: ClassificationNode[];
}

const CATEGORY_LEVEL: Record<string, ItemLevel> = {
  "Microsoft.EpicCategory": "portfolio",
  "Microsoft.FeatureCategory": "portfolio",
  "Microsoft.RequirementCategory": "requirement",
  "Microsoft.TaskCategory": "task",
};

const ROLE: Record<string, FieldRole> = {
  "System.Title": "title",
  "System.Description": "description",
  "Microsoft.VSTS.Common.AcceptanceCriteria": "acceptance-criteria",
  "System.Tags": "labels",
  "Microsoft.VSTS.Scheduling.StoryPoints": "estimate",
  "Microsoft.VSTS.Scheduling.Effort": "estimate",
  "Microsoft.VSTS.Scheduling.Size": "estimate",
  "Microsoft.VSTS.Common.Priority": "priority",
  "System.AreaPath": "area",
  "System.IterationPath": "iteration",
};

const STRUCTURAL = new Set([
  "System.Id",
  "System.Rev",
  "System.TeamProject",
  "System.WorkItemType",
  "System.AreaId",
  "System.IterationId",
  "System.NodeName",
  "System.AuthorizedAs",
  "System.AuthorizedDate",
  "System.RevisedDate",
  "System.Watermark",
  "System.Parent",
  "System.CommentCount",
  "System.ExternalLinkCount",
  "System.HyperLinkCount",
  "System.AttachedFileCount",
  "System.RelatedLinkCount",
  "System.RemoteLinkCount",
  "System.PersonId",
  "System.IsDeleted",
]);

/** Fields owned by the delivery team: state, people, dates, planning and ranking. */
function isTeamField(id: string): boolean {
  if (
    /^System\.(State|Reason|AssignedTo|CreatedBy|ChangedBy|CreatedDate|ChangedDate|History|BoardColumn|BoardColumnDone|BoardLane)$/.test(
      id,
    )
  )
    return true;
  return /^Microsoft\.VSTS\./.test(id) && !(id in ROLE);
}

export function azdoFieldKind(
  def: FieldDefinition | undefined,
  id: string,
): FieldKind {
  if (id === "System.Tags") return "labels";
  if (id === "System.AreaPath" || id === "System.IterationPath")
    return "tree-path";
  if (!def?.type) return "unknown";
  if (def.isIdentity) return "user";
  const type = def.type.toLowerCase();
  if (def.isPicklist || type.startsWith("picklist")) return "option";
  switch (type) {
    case "string":
      return "single-line";
    case "plaintext":
    case "history":
      return "multi-line";
    case "html":
      return "rich-text";
    case "integer":
    case "double":
      return "number";
    case "datetime":
      return "date";
    case "boolean":
      return "boolean";
    case "treepath":
      return "tree-path";
    case "identity":
      return "user";
    default:
      return "unknown";
  }
}

export function azdoFieldRole(id: string): FieldRole {
  if (ROLE[id]) return ROLE[id];
  if (STRUCTURAL.has(id)) return "structural";
  if (isTeamField(id) || /^System\./.test(id)) return "team";
  return "custom";
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function toField(
  raw: TypeField,
  definitions: Map<string, FieldDefinition>,
): DestinationField | undefined {
  const id = raw.referenceName?.trim();
  if (!id || !/^[\w.]+$/.test(id)) return undefined;
  const def = definitions.get(id);
  const kind = azdoFieldKind(def, id);
  const role = azdoFieldRole(id);
  const allowed =
    kind === "option" || kind === "multi-option"
      ? permittedValues(raw.allowedValues)
      : {};
  return {
    id,
    name: untrustedText(raw.name ?? def?.name ?? id, LIMITS.name) || id,
    kind,
    role,
    required: !!raw.alwaysRequired,
    hasDefault: hasValue(raw.defaultValue),
    readOnly: !!def?.readOnly,
    custom: role === "custom",
    ...(allowed.values ? { allowedValues: allowed.values } : {}),
    ...(allowed.truncated ? { allowedValuesTruncated: true } : {}),
    // Azure DevOps string fields hold 255 characters; other limits are not published per field.
    ...(kind === "single-line" ? { maxLength: 255 } : {}),
    ...(raw.helpText ? { help: untrustedText(raw.helpText, LIMITS.help) } : {}),
    ...(def?.type ? { sourceType: untrustedText(def.type, 40) } : {}),
  };
}

function treePaths(node: ClassificationNode | undefined): string[] {
  const out: string[] = [];
  const walk = (n: ClassificationNode, prefix: string) => {
    if (out.length >= LIMITS.paths) return;
    const name = (n.name ?? "").trim();
    if (!name || /[\u0000-\u001f]/.test(name)) return;
    const path = prefix ? `${prefix}\\${name}` : name;
    out.push(path);
    for (const child of n.children ?? []) walk(child, path);
  };
  if (node) walk(node, "");
  return out;
}

export async function discoverAzdo(
  settings: AzdoSettings,
  signal?: AbortSignal,
): Promise<DiscoveryDraft> {
  const { orgUrl } = validateAzdoSettings(settings);
  const project = settings.project.trim();
  const client = new ReadOnlyClient(
    AZDO_SERVICE,
    orgUrl,
    azdoHeaders(settings),
    signal,
  );
  const p = `/${encodeURIComponent(project)}`;
  const gaps: string[] = [];

  const proj = await client.get<{ name?: string }>(
    `/_apis/projects/${encodeURIComponent(project)}?${V}`,
    [404],
  );
  if (proj.status === 404)
    throw new IntegrationError(
      `Azure DevOps project "${project}" was not found, or the token cannot see it. Nothing was changed.`,
    );

  const typesRes = await client.get<{ value?: WorkItemType[] }>(
    `${p}/_apis/wit/workitemtypes?${V}`,
  );
  const rawTypes = (typesRes.data?.value ?? []).filter(
    (t) => typeof t.name === "string" && t.name.trim(),
  );
  if (!rawTypes.length)
    throw new IntegrationError(
      "Azure DevOps returned no work item types for this project, so a delivery plan cannot be prepared.",
    );

  // Categories place types in the backlog hierarchy (Epic > Feature > Requirement > Task).
  const levelOf = new Map<string, ItemLevel>();
  const defaults = new Map<ItemLevel | "epic" | "feature", string>();
  const categoryTypes = new Map<string, string[]>();
  try {
    const cats = await client.get<{ value?: Category[] }>(
      `${p}/_apis/wit/workitemtypecategories?${V}`,
    );
    for (const cat of cats.data?.value ?? []) {
      const ref = cat.referenceName ?? "";
      const names = (cat.workItemTypes ?? [])
        .map((t) => t.name?.trim() ?? "")
        .filter(Boolean);
      categoryTypes.set(ref, names);
      const level = CATEGORY_LEVEL[ref];
      if (!level) continue;
      for (const name of names)
        if (!levelOf.has(name)) levelOf.set(name, level);
      const def = cat.defaultWorkItemType?.name?.trim();
      if (def) {
        if (ref === "Microsoft.EpicCategory") defaults.set("epic", def);
        else if (ref === "Microsoft.FeatureCategory")
          defaults.set("feature", def);
        else defaults.set(level, def);
      }
    }
  } catch (err) {
    gaps.push(
      `The backlog levels of work item types could not be read (${errorMessage(err)}); type placement uses names and your settings.`,
    );
  }
  const hidden = new Set(categoryTypes.get("Microsoft.HiddenCategory") ?? []);

  const definitions = new Map<string, FieldDefinition>();
  try {
    const defs = await client.get<{ value?: FieldDefinition[] }>(
      `${p}/_apis/wit/fields?${V}`,
    );
    for (const d of defs.data?.value ?? [])
      if (d.referenceName) definitions.set(d.referenceName, d);
  } catch (err) {
    gaps.push(
      `Field data types could not be read (${errorMessage(err)}); affected fields are treated as Unknown.`,
    );
  }

  const configured = settings.workItemType?.trim();
  const configuredParent = settings.parentWorkItemType?.trim();
  const requirementDefault = defaults.get("requirement");
  const itemTypes: DestinationItemType[] = rawTypes
    .filter((t) => !hidden.has(t.name!.trim()))
    .map((t) => {
      const name = t.name!.trim();
      const level =
        levelOf.get(name) ??
        (name === configured
          ? "requirement"
          : name === configuredParent
            ? "portfolio"
            : "other");
      return {
        id: name,
        name: untrustedText(name, LIMITS.name) || name,
        level,
        ...(t.isDisabled ? { disabled: true } : {}),
        ...((level === "requirement" && name === requirementDefault) ||
        (level === "portfolio" && name === defaults.get("feature"))
          ? { isDefault: true }
          : {}),
      };
    });

  // Expand fields only for the types a plan can use: requirement level, configured types, feature and epic defaults.
  const wanted = new Set<string>(
    itemTypes
      .filter((t) => !t.disabled && t.level === "requirement")
      .map((t) => t.id)
      .slice(0, 4),
  );
  for (const name of [
    configured,
    configuredParent,
    defaults.get("feature"),
    defaults.get("epic"),
  ])
    if (name && itemTypes.some((t) => t.id === name)) wanted.add(name);
  for (const type of itemTypes.filter((t) => wanted.has(t.id))) {
    try {
      const res = await client.get<{ value?: TypeField[] }>(
        `${p}/_apis/wit/workitemtypes/${encodeURIComponent(type.id)}/fields?$expand=allowedValues&${V}`,
      );
      type.fields = (res.data?.value ?? [])
        .map((f) => toField(f, definitions))
        .filter((f): f is DestinationField => !!f);
    } catch (err) {
      gaps.push(
        `The fields of "${type.name}" could not be read (${errorMessage(err)}); its required fields are Unknown.`,
      );
    }
  }

  const linkTypes: DestinationLinkType[] = [];
  try {
    const rels = await client.get<{ value?: RelationType[] }>(
      `/_apis/wit/workitemrelationtypes?${V}`,
    );
    for (const r of rels.data?.value ?? []) {
      const id = r.referenceName?.trim();
      if (!id || r.attributes?.usage !== "workItemLink") continue;
      if (r.attributes?.enabled === false) continue;
      linkTypes.push({
        id,
        name: untrustedText(r.name ?? id, LIMITS.name) || id,
        kind: /Hierarchy/.test(id)
          ? "parent"
          : /Dependency/.test(id)
            ? "dependency"
            : "related",
      });
    }
  } catch (err) {
    gaps.push(
      `Link types could not be read (${errorMessage(err)}); parent and dependency links are Unknown.`,
    );
  }

  let areas: string[] | undefined;
  let iterations: string[] | undefined;
  try {
    const nodes = await client.get<{ value?: ClassificationNode[] }>(
      `${p}/_apis/wit/classificationnodes?$depth=14&${V}`,
    );
    const list = nodes.data?.value ?? [];
    areas = treePaths(list.find((n) => n.structureType === "area"));
    iterations = treePaths(list.find((n) => n.structureType === "iteration"));
  } catch (err) {
    gaps.push(
      `Area and iteration paths could not be read (${errorMessage(err)}); configured paths cannot be checked.`,
    );
  }

  const hierarchy: DestinationHierarchy[] = [];
  const typesAt = (ref: string) =>
    (categoryTypes.get(ref) ?? []).filter((n) =>
      itemTypes.some((t) => t.id === n && !t.disabled),
    );
  const pairs: [string, string][] = [
    ["Microsoft.EpicCategory", "Microsoft.FeatureCategory"],
    ["Microsoft.FeatureCategory", "Microsoft.RequirementCategory"],
    ["Microsoft.RequirementCategory", "Microsoft.TaskCategory"],
  ];
  for (const [parent, child] of pairs)
    for (const p1 of typesAt(parent))
      for (const c1 of typesAt(child))
        hierarchy.push({ parentTypeId: p1, childTypeId: c1, via: "relation" });
  if (
    configuredParent &&
    configured &&
    !hierarchy.some(
      (h) =>
        h.parentTypeId === configuredParent && h.childTypeId === configured,
    ) &&
    itemTypes.some((t) => t.id === configuredParent) &&
    itemTypes.some((t) => t.id === configured)
  )
    hierarchy.push({
      parentTypeId: configuredParent,
      childTypeId: configured,
      via: "relation",
    });

  const requirementType =
    itemTypes.find((t) => t.id === configured) ??
    itemTypes.find((t) => t.isDefault && t.level === "requirement");
  const capabilities: DestinationCapability[] = [
    requirementType?.fields
      ? requirementType.fields.some((f) => f.role === "acceptance-criteria")
        ? {
            id: "acceptance-criteria-field",
            state: "supported",
            note: `"${requirementType.name}" has an Acceptance Criteria field.`,
          }
        : {
            id: "acceptance-criteria-field",
            state: "unsupported",
            note: `"${requirementType.name}" has no Acceptance Criteria field; scenarios go in the Description.`,
          }
      : {
          id: "acceptance-criteria-field",
          state: "unknown",
          note: "The requirement type's fields were not read.",
        },
    {
      id: "validate-only",
      state: "supported",
      note: "Azure DevOps can validate a work item without saving it (validateOnly). Not used until live publishing is authorised.",
    },
    {
      id: "conditional-rules",
      state: "unknown",
      note: "Process rules that require fields only in some states are not exposed by metadata.",
    },
    {
      id: "attachments",
      state: "supported",
      note: "Work items accept attachments; Coherence uploads none without your approval.",
    },
  ];

  return {
    identity: {
      system: "azdo",
      base: targetBase("azdo", settings) ?? orgUrl.toLowerCase(),
      container: project.toLowerCase(),
    },
    textFormat: "html",
    itemTypes,
    linkTypes,
    hierarchy,
    ...(areas ? { areas } : {}),
    ...(iterations ? { iterations } : {}),
    capabilities,
    gaps,
    requestCount: client.requests.length,
  };
}
