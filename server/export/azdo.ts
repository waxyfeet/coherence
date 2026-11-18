/**
 * Azure DevOps client (Work Item Tracking REST 7.1, JSON Patch, Basic auth with ":<PAT>").
 * Description and Acceptance Criteria are HTML (converted from markdown with `marked`, raw HTML escaped).
 * Feature groups become Features (found by WIQL title match or created) linked with
 * System.LinkTypes.Hierarchy-Reverse (= "Parent"); dependencies use System.LinkTypes.Dependency-Reverse
 * (= "Predecessor") from the dependent item to its prerequisite.
 * Updating an existing item leaves the delivery team's planning alone: Area/Iteration path are set on create
 * only, story points only while empty, and a parent is replaced only when Coherence set it.
 */
import type { TestConnectionResponse } from "@shared/api";
import type {
  AzdoSettings,
  ExportPreview,
  ExternalLink,
  FeatureGroup,
} from "@shared/types";
import { STORY_POINTS } from "@shared/types";
import { IntegrationError, errorMessage } from "../errors";
import {
  azdoErrorMessage,
  basicAuth,
  normaliseBaseUrl,
  RemoteServiceError,
  requestJson,
  type ServiceInfo,
} from "./http";
import {
  buildDescriptionMarkdown,
  buildScenariosMarkdown,
  exportTitle,
  truncate,
  type ExportContent,
} from "./content";
import { escapeHtml, markdownToHtml } from "./markdown";
import { OWN_TAG } from "./identity";
import type {
  LinkInput,
  LinkOutcome,
  RemoteRef,
  TrackerClient,
  TrackerEnv,
  UpsertInput,
  UpsertResult,
} from "./types";

export const AZDO_SERVICE: ServiceInfo = {
  label: "Azure DevOps",
  extractMessage: azdoErrorMessage,
  authHint:
    'Check the personal access token in Settings → Integrations (it needs the "Work Items: Read & write" scope and must not be expired).',
};

const API_VERSION = "api-version=7.1";
export const PARENT_REL = "System.LinkTypes.Hierarchy-Reverse";
export const PREDECESSOR_REL = "System.LinkTypes.Dependency-Reverse";
const ACCEPTANCE_FIELD = "Microsoft.VSTS.Common.AcceptanceCriteria";
/** Marks the parent relations Coherence adds, so an update can tell them from a parent the team chose. */
export const PARENT_COMMENT = "Feature group (Coherence)";
/** The same mark on relations added before the visible rename (installer Stage 7): still Coherence's own. */
export const LEGACY_PARENT_COMMENT = "Feature group (ScreenScribe)";

export interface JsonPatchOp {
  op: "add" | "remove" | "replace" | "test";
  path: string;
  value?: unknown;
}

export function validateAzdoSettings(s: AzdoSettings): { orgUrl: string } {
  const missing: string[] = [];
  if (!s.orgUrl?.trim()) missing.push("organisation URL");
  if (!s.project?.trim()) missing.push("project");
  if (!s.pat?.trim()) missing.push("personal access token");
  if (missing.length)
    throw new IntegrationError(
      `Azure DevOps settings are incomplete: missing ${missing.join(", ")}.`,
    );
  return {
    orgUrl: normaliseBaseUrl(s.orgUrl, "The Azure DevOps organisation URL"),
  };
}

export function azdoHeaders(s: AzdoSettings): Record<string, string> {
  return { Authorization: basicAuth("", s.pat.trim()) };
}

export function azdoWorkItemUrl(
  orgUrl: string,
  project: string,
  id: number | string,
): string {
  return `${orgUrl}/${encodeURIComponent(project.trim())}/_workitems/edit/${id}`;
}

/** The form AzDO expects in relation urls. */
export function azdoWorkItemApiUrl(
  orgUrl: string,
  id: number | string,
): string {
  return `${orgUrl}/_apis/wit/workItems/${id}`;
}

/** Agile: Story Points, Scrum (PBI): Effort, CMMI (Requirement): Size. */
export function storyPointsField(workItemType: string): string {
  const type = workItemType.trim().toLowerCase();
  if (type === "product backlog item")
    return "Microsoft.VSTS.Scheduling.Effort";
  if (type === "requirement") return "Microsoft.VSTS.Scheduling.Size";
  return "Microsoft.VSTS.Scheduling.StoryPoints";
}

/** "Coherence; UC-003; <configured tags>" (de-duplicated, case-insensitive; existing tags are kept). */
export function buildAzdoTags(
  s: AzdoSettings,
  useCaseId: string,
  existing = "",
): string {
  const all = [...existing.split(";"), OWN_TAG, useCaseId, ...(s.tags ?? [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of all) {
    const tag = raw.trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out.join("; ");
}

export function buildAzdoDescriptionHtml(content: ExportContent): string {
  return markdownToHtml(
    buildDescriptionMarkdown(content, {
      includeScenarios: false,
      includeFooter: true,
    }),
  );
}

export function buildAzdoAcceptanceHtml(content: ExportContent): string {
  return markdownToHtml(buildScenariosMarkdown(content.useCase, 4));
}

export interface AzdoFieldOptions {
  includeStoryPoints: boolean;
  /** The work item type has no Acceptance Criteria field (e.g. CMMI) — scenarios go into the description. */
  acceptanceInDescription?: boolean;
  /** Merge with these existing tags (update). */
  existingTags?: string;
  /** Updating an existing item: Area/Iteration path are left as the team set them. */
  update?: boolean;
}

export function buildAzdoFieldOps(
  content: ExportContent,
  s: AzdoSettings,
  opts: AzdoFieldOptions,
): JsonPatchOp[] {
  const uc = content.useCase;
  const description = opts.acceptanceInDescription
    ? `${buildAzdoDescriptionHtml(content)}\n<h2>Acceptance criteria</h2>\n${buildAzdoAcceptanceHtml(content)}`
    : buildAzdoDescriptionHtml(content);
  const ops: JsonPatchOp[] = [
    { op: "add", path: "/fields/System.Title", value: exportTitle(uc) },
    { op: "add", path: "/fields/System.Description", value: description },
  ];
  if (!opts.acceptanceInDescription)
    ops.push({
      op: "add",
      path: `/fields/${ACCEPTANCE_FIELD}`,
      value: buildAzdoAcceptanceHtml(content),
    });
  ops.push({
    op: "add",
    path: "/fields/System.Tags",
    value: buildAzdoTags(s, uc.id, opts.existingTags),
  });
  if (!opts.update && s.areaPath?.trim())
    ops.push({
      op: "add",
      path: "/fields/System.AreaPath",
      value: s.areaPath.trim(),
    });
  if (!opts.update && s.iterationPath?.trim())
    ops.push({
      op: "add",
      path: "/fields/System.IterationPath",
      value: s.iterationPath.trim(),
    });
  if (opts.includeStoryPoints) {
    ops.push({
      op: "add",
      path: `/fields/${storyPointsField(s.workItemType || "User Story")}`,
      value: STORY_POINTS[uc.size] ?? STORY_POINTS.M,
    });
  }
  return ops;
}

export function parentRelationOp(
  orgUrl: string,
  parentId: string,
): JsonPatchOp {
  return {
    op: "add",
    path: "/relations/-",
    value: {
      rel: PARENT_REL,
      url: azdoWorkItemApiUrl(orgUrl, parentId),
      attributes: { comment: PARENT_COMMENT },
    },
  };
}

export function predecessorRelationOp(
  orgUrl: string,
  prerequisiteId: string,
  comment: string,
): JsonPatchOp {
  return {
    op: "add",
    path: "/relations/-",
    value: {
      rel: PREDECESSOR_REL,
      url: azdoWorkItemApiUrl(orgUrl, prerequisiteId),
      attributes: { comment },
    },
  };
}

/** Title of a feature parent — the lookup must use the same truncated title that create sends. */
export function featureParentTitle(name: string): string {
  return truncate(name.trim(), 255);
}

/** "SELECT … WHERE [System.Title] = '<name>'" — single quotes doubled. */
export function buildFeatureWiql(workItemType: string, name: string): string {
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  return `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = ${q(workItemType)} AND [System.Title] = ${q(featureParentTitle(name))} AND [System.State] <> 'Removed' ORDER BY [System.Id] ASC`;
}

export function previewAzdo(
  content: ExportContent,
  s: AzdoSettings,
  existing?: ExternalLink,
): ExportPreview {
  const uc = content.useCase;
  const fields: Record<string, string> = {
    Project: s.project,
    "Work item type": s.workItemType?.trim() || "User Story",
    "System.Title": exportTitle(uc),
    "System.Tags": buildAzdoTags(s, uc.id),
    "System.AreaPath": `${s.areaPath?.trim() || "(project default)"} — new work items only; updates keep the current value`,
    "System.IterationPath": `${s.iterationPath?.trim() || "(project default)"} — new work items only; updates keep the current value`,
    Parent: content.featureName
      ? `${s.parentWorkItemType?.trim() || "Feature"} "${content.featureName}" — found or created when "Create feature parents" is on (updates keep a parent chosen in Azure DevOps)`
      : "None (the use case has no feature group)",
    "Story points": `${STORY_POINTS[uc.size]} (size ${uc.size}) → ${storyPointsField(s.workItemType || "User Story")} when "Include story points" is on (updates fill it only when empty)`,
    Predecessors: uc.dependsOn.length
      ? `${uc.dependsOn.join(", ")} (when "Link dependencies" is on)`
      : "None",
    "Existing work item": existing
      ? `${existing.key} — updated when "Update existing" is on`
      : "None — a new work item will be created",
  };
  return {
    target: "azdo",
    useCaseId: uc.id,
    title: exportTitle(uc),
    bodyFormat: "html",
    description: buildAzdoDescriptionHtml(content),
    acceptanceCriteria: buildAzdoAcceptanceHtml(content),
    fields,
  };
}

interface WorkItem {
  id: number;
  fields?: Record<string, unknown>;
  relations?: {
    rel: string;
    url: string;
    attributes?: Record<string, unknown>;
  }[];
}

/** Work item id at the end of a relation url (".../_apis/wit/workItems/123"). */
export function relationTargetId(url: string): string | undefined {
  return /\/workItems\/(\d+)\/?$/i.exec(url)?.[1];
}

export class AzdoClient implements TrackerClient {
  readonly system = "azdo" as const;
  readonly label = "Azure DevOps";
  private readonly orgUrl: string;
  private readonly headers: Record<string, string>;
  private readonly project: string;
  private acceptanceInDescription = false;
  private storyPointsDropped = false;

  constructor(
    private readonly settings: AzdoSettings,
    private readonly env: TrackerEnv,
  ) {
    this.orgUrl = validateAzdoSettings(settings).orgUrl;
    this.headers = azdoHeaders(settings);
    this.project = settings.project.trim();
  }

  private projectUrl(path: string): string {
    return `${this.orgUrl}/${encodeURIComponent(this.project)}${path}`;
  }

  /**
   * Create = POST to /workitems/$Type, update = PATCH /workitems/{id}; both take a JSON Patch body.
   * `idempotent`: the ops only set fields (or add a link AzDO rejects as "already exists"), so a retry after a 5xx is safe.
   */
  private jsonPatch<T>(
    method: "POST" | "PATCH",
    url: string,
    ops: JsonPatchOp[],
    allow?: number[],
    idempotent?: boolean,
  ) {
    return requestJson<T>(AZDO_SERVICE, url, {
      method,
      json: ops,
      contentType: "application/json-patch+json",
      headers: this.headers,
      signal: this.env.signal,
      allowStatuses: allow,
      idempotent,
    });
  }

  private get<T>(url: string, allow?: number[]) {
    return requestJson<T>(AZDO_SERVICE, url, {
      headers: this.headers,
      signal: this.env.signal,
      allowStatuses: allow,
    });
  }

  private createUrl(type: string): string {
    return this.projectUrl(
      `/_apis/wit/workitems/$${encodeURIComponent(type)}?${API_VERSION}`,
    );
  }

  private itemUrl(id: string, query = ""): string {
    return this.projectUrl(
      `/_apis/wit/workitems/${encodeURIComponent(id)}?${query ? `${query}&` : ""}${API_VERSION}`,
    );
  }

  private ref(id: number | string): RemoteRef {
    return {
      key: String(id),
      url: azdoWorkItemUrl(this.orgUrl, this.project, id),
    };
  }

  async ensureParent(
    feature: FeatureGroup,
  ): Promise<{ action: "created" | "skipped"; ref: RemoteRef }> {
    const type = this.settings.parentWorkItemType?.trim() || "Feature";
    try {
      const { data } = await requestJson<{ workItems?: { id: number }[] }>(
        AZDO_SERVICE,
        this.projectUrl(`/_apis/wit/wiql?${API_VERSION}`),
        {
          method: "POST",
          json: { query: buildFeatureWiql(type, feature.name) },
          headers: this.headers,
          signal: this.env.signal,
          idempotent: true,
        },
      );
      const id = data?.workItems?.[0]?.id;
      if (id) return { action: "skipped", ref: this.ref(id) };
    } catch (err) {
      if (err instanceof RemoteServiceError && err.remoteStatus === 401)
        throw err;
      this.env.log.warn(
        `Could not search Azure DevOps for an existing ${type} "${feature.name}" (${errorMessage(err)}) — creating a new one.`,
      );
    }
    const ops: JsonPatchOp[] = [
      {
        op: "add",
        path: "/fields/System.Title",
        value: featureParentTitle(feature.name),
      },
      {
        op: "add",
        path: "/fields/System.Description",
        value: `<p>${escapeHtml(feature.description.trim() || feature.name)}</p>\n<p><em>Feature group ${escapeHtml(feature.id)} generated by Coherence</em></p>`,
      },
      {
        op: "add",
        path: "/fields/System.Tags",
        value: buildAzdoTags(this.settings, feature.id),
      },
    ];
    if (this.settings.areaPath?.trim())
      ops.push({
        op: "add",
        path: "/fields/System.AreaPath",
        value: this.settings.areaPath.trim(),
      });
    if (this.settings.iterationPath?.trim())
      ops.push({
        op: "add",
        path: "/fields/System.IterationPath",
        value: this.settings.iterationPath.trim(),
      });
    const { data } = await this.jsonPatch<WorkItem>(
      "POST",
      this.createUrl(type),
      ops,
    );
    return { action: "created", ref: this.ref(data.id) };
  }

  /** Send; when the work item type lacks Acceptance Criteria / the story points field, adapt and retry. */
  private async sendItem(
    method: "POST" | "PATCH",
    url: string,
    build: (opts: AzdoFieldOptions) => JsonPatchOp[],
    opts: AzdoFieldOptions,
    allow?: number[],
    idempotent?: boolean,
  ) {
    let current = {
      ...opts,
      acceptanceInDescription:
        opts.acceptanceInDescription || this.acceptanceInDescription,
    };
    if (this.storyPointsDropped) current.includeStoryPoints = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.jsonPatch<WorkItem>(
          method,
          url,
          build(current),
          allow,
          idempotent,
        );
      } catch (err) {
        const field = missingField(err);
        if (!field || attempt >= 2) throw err;
        if (field === ACCEPTANCE_FIELD && !current.acceptanceInDescription) {
          this.acceptanceInDescription = true;
          this.env.log.warn(
            `The "${this.settings.workItemType}" work item type has no Acceptance Criteria field — BDD scenarios were added to the description instead.`,
          );
          current = { ...current, acceptanceInDescription: true };
        } else if (
          field ===
            storyPointsField(this.settings.workItemType || "User Story") &&
          current.includeStoryPoints
        ) {
          this.storyPointsDropped = true;
          this.env.log.warn(
            `The "${this.settings.workItemType}" work item type has no ${field} field — items were exported without story points.`,
          );
          current = { ...current, includeStoryPoints: false };
        } else {
          throw err;
        }
      }
    }
  }

  async upsert(input: UpsertInput): Promise<UpsertResult> {
    const { content } = input;
    const uc = content.useCase;
    const type = this.settings.workItemType?.trim() || "User Story";
    const parentId = input.parent?.key;

    if (input.existing) {
      const id = input.existing.key.replace(/^#/, "");
      const current = await this.get<WorkItem>(
        this.itemUrl(id, "$expand=relations"),
        [404],
      );
      if (current.status !== 404) {
        const relationOps: JsonPatchOp[] = [];
        if (parentId) {
          const relations = current.data.relations ?? [];
          const index = relations.findIndex((r) => r.rel === PARENT_REL);
          const currentParent =
            index === -1 ? undefined : relationTargetId(relations[index].url);
          if (index === -1)
            relationOps.push(parentRelationOp(this.orgUrl, parentId));
          else if (currentParent !== parentId) {
            const comment = relations[index].attributes?.comment;
            if (
              comment === PARENT_COMMENT ||
              comment === LEGACY_PARENT_COMMENT
            ) {
              // Coherence set the old parent, so the use case moved to another feature group.
              relationOps.push(
                { op: "remove", path: `/relations/${index}` },
                parentRelationOp(this.orgUrl, parentId),
              );
            } else {
              this.env.log.info(
                `${uc.id}: work item ${id} keeps the parent ${currentParent ?? ""} chosen in Azure DevOps (its feature group's ${this.settings.parentWorkItemType?.trim() || "Feature"} is ${parentId}).`,
              );
            }
          }
        }
        const fields = current.data.fields ?? {};
        const existingTags =
          typeof fields["System.Tags"] === "string"
            ? (fields["System.Tags"] as string)
            : "";
        const points =
          fields[storyPointsField(this.settings.workItemType || "User Story")];
        const res = await this.sendItem(
          "PATCH",
          this.itemUrl(id),
          (o) => [
            ...buildAzdoFieldOps(content, this.settings, o),
            ...relationOps,
          ],
          {
            // Estimates belong to the team once set; fill them only while empty.
            includeStoryPoints:
              input.options.includeStoryPoints &&
              (points === undefined || points === null || points === ""),
            existingTags,
            update: true,
          },
          [404],
          relationOps.length === 0,
        );
        if (res.status !== 404) return { action: "updated", ref: this.ref(id) };
      }
      this.env.log.warn(
        `${uc.id}: work item ${id} no longer exists in Azure DevOps — creating a new one.`,
      );
    }

    const res = await this.sendItem(
      "POST",
      this.createUrl(type),
      (o) => [
        ...buildAzdoFieldOps(content, this.settings, o),
        ...(parentId ? [parentRelationOp(this.orgUrl, parentId)] : []),
      ],
      { includeStoryPoints: input.options.includeStoryPoints },
    );
    if (!res.data?.id)
      throw new IntegrationError(
        `Azure DevOps created the work item for ${uc.id} but did not return its id.`,
      );
    return { action: "created", ref: this.ref(res.data.id) };
  }

  async linkDependencies(input: LinkInput): Promise<LinkOutcome[]> {
    const id = input.ref.key;
    const existing = new Set<string>();
    if (input.preExisting) {
      try {
        const { data } = await this.get<WorkItem>(
          this.itemUrl(id, "$expand=relations"),
        );
        for (const r of data.relations ?? []) {
          const target =
            r.rel === PREDECESSOR_REL ? relationTargetId(r.url) : undefined;
          if (target) existing.add(target);
        }
      } catch (err) {
        this.env.log.warn(
          `Could not read the existing links of work item ${id} (${errorMessage(err)}); links will be added anyway.`,
        );
      }
    }
    const outcomes: LinkOutcome[] = [];
    for (const dep of input.dependencies) {
      if (existing.has(dep.ref.key)) {
        outcomes.push({ toUseCaseId: dep.useCaseId, ok: true });
        continue;
      }
      try {
        await this.jsonPatch(
          "PATCH",
          this.itemUrl(id),
          [
            predecessorRelationOp(
              this.orgUrl,
              dep.ref.key,
              `${input.content.useCase.id} depends on ${dep.useCaseId} (Coherence)`,
            ),
          ],
          undefined,
          true,
        );
        outcomes.push({ toUseCaseId: dep.useCaseId, ok: true });
      } catch (err) {
        // Re-running an export may find the link already there — that is the desired state.
        const ok =
          err instanceof RemoteServiceError &&
          /already exists/i.test(azdoErrorMessage(err.body) || err.message);
        outcomes.push(
          ok
            ? { toUseCaseId: dep.useCaseId, ok: true }
            : {
                toUseCaseId: dep.useCaseId,
                ok: false,
                error: errorMessage(err),
              },
        );
      }
    }
    return outcomes;
  }
}

/** "TF51535: Cannot find field Microsoft.VSTS.Common.AcceptanceCriteria." → the field reference name. */
export function missingField(err: unknown): string | undefined {
  if (!(err instanceof RemoteServiceError) || err.remoteStatus !== 400)
    return undefined;
  const msg = azdoErrorMessage(err.body) || err.message;
  return /TF51535:[^.]*?field\s+([\w.]+?)\.?(?:\s|$)/i.exec(msg)?.[1];
}

export async function testAzdo(
  settings: AzdoSettings,
): Promise<TestConnectionResponse> {
  const started = Date.now();
  try {
    const { orgUrl } = validateAzdoSettings(settings);
    const headers = azdoHeaders(settings);
    const project = settings.project.trim();
    const get = <T>(url: string) =>
      requestJson<T>(AZDO_SERVICE, url, { headers, allowStatuses: [404] });

    const proj = await get<{ name?: string }>(
      `${orgUrl}/_apis/projects/${encodeURIComponent(project)}?${API_VERSION}`,
    );
    if (proj.status === 404) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Project "${project}" was not found in ${orgUrl}, or the token cannot see it.`,
      };
    }
    const types = [
      settings.workItemType?.trim() || "User Story",
      settings.parentWorkItemType?.trim() || "Feature",
    ];
    const missing: string[] = [];
    for (const type of types) {
      const res = await get(
        `${orgUrl}/${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}?${API_VERSION}`,
      );
      if (res.status === 404) missing.push(type);
    }
    if (missing.length) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Connected to project "${proj.data?.name ?? project}", but it has no work item type ${missing.map((m) => `"${m}"`).join(" or ")} (Agile uses "User Story", Scrum "Product Backlog Item", CMMI "Requirement").`,
      };
    }
    return {
      ok: true,
      latencyMs: Date.now() - started,
      message: `Connected to Azure DevOps project "${proj.data?.name ?? project}"; work item types ${types.map((t) => `"${t}"`).join(" and ")} are available.`,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: errorMessage(err),
    };
  }
}
