/**
 * What publishing needs from each destination (docs/ARCHITECTURE.md, "Publishing"), so one publish job
 * (publish.ts) drives Azure DevOps, Jira and GitHub the same way: find Coherence's earlier items, check before writing where
 * the destination can, create, update, link, and read current values for comparison.
 */
import type {
  DeliveryPlan,
  PlannedItem,
  PlannedRelationship,
} from "@shared/delivery";
import type {
  AzdoSettings,
  ExternalSystem,
  GitHubSettings,
  JiraSettings,
} from "@shared/types";
import { relationTargetId } from "../export/azdo";
import { IntegrationError } from "../errors";
import { AzdoWorkItems } from "./azdoClient";
import {
  createRequest,
  dependencyRequest,
  relationTarget,
  updateRequest,
  type KeyOf,
} from "./azdoRequests";
import type { TrackerSettings } from "./discovery";
import { GitHubIssues } from "./githubClient";
import {
  githubAddLabelsRequest,
  githubCreateRequest,
  githubUpdateRequest,
  unsentFields,
} from "./githubRequests";
import { JiraIssues } from "./jiraClient";
import {
  jiraCreateRequest,
  jiraLinkRequest,
  jiraUpdateRequest,
} from "./jiraRequests";

export interface Publisher {
  /** The project the journal and the record are for (ADO project, Jira project key). */
  readonly project: string;
  /** Whether the destination can check a write without saving it (Azure DevOps validateOnly). */
  readonly checksBeforeWriting: boolean;
  /** Items Coherence made earlier in the configured project: id and the text a durable key is searched in. */
  ownItems(plan: DeliveryPlan): Promise<{ key: string; text: string }[]>;
  checkCreate(
    plan: DeliveryPlan,
    item: PlannedItem,
    keyOf: KeyOf,
    withoutParent: boolean,
  ): Promise<void>;
  checkUpdate(plan: DeliveryPlan, item: PlannedItem): Promise<void>;
  /** Keys of existing items the plan knows only by name (GitHub milestones and labels), by plan item id. */
  prepare?(plan: DeliveryPlan): Promise<Map<string, string>>;
  /** Creates one item; returns its key, and a note when the destination silently left something out. */
  create(
    plan: DeliveryPlan,
    item: PlannedItem,
    keyOf: KeyOf,
  ): Promise<{ key: string; note?: string }>;
  /** Updates one item, refused when it changed since the plan read it. */
  update(plan: DeliveryPlan, item: PlannedItem): Promise<void>;
  hasDependency(r: PlannedRelationship, keyOf: KeyOf): Promise<boolean>;
  addDependency(
    plan: DeliveryPlan,
    r: PlannedRelationship,
    keyOf: KeyOf,
  ): Promise<void>;
  /** Current values and revision (ADO rev; Jira last-updated time) of existing items, by key. */
  readCurrent(
    keys: string[],
  ): Promise<Map<string, { rev: number; fields: Record<string, unknown> }>>;
  browseUrl(key: string): string;
}

class AzdoPublisher implements Publisher {
  readonly checksBeforeWriting = true;
  readonly project: string;
  private readonly client: AzdoWorkItems;

  constructor(settings: AzdoSettings, signal?: AbortSignal) {
    this.client = new AzdoWorkItems(settings, signal);
    this.project = settings.project.trim();
  }

  async ownItems(_plan: DeliveryPlan) {
    return (
      await this.client.readItems(await this.client.coherenceItemIds())
    ).map((w) => ({ key: w.id, text: w.description }));
  }

  checkCreate(
    plan: DeliveryPlan,
    item: PlannedItem,
    keyOf: KeyOf,
    withoutParent: boolean,
  ) {
    return this.client.check(
      createRequest(plan, item, this.client.target, keyOf, {
        validateOnly: true,
        withoutParent,
      }),
    );
  }

  checkUpdate(plan: DeliveryPlan, item: PlannedItem) {
    return this.client.check(
      updateRequest(plan, item, this.client.target, { validateOnly: true }),
    );
  }

  async create(plan: DeliveryPlan, item: PlannedItem, keyOf: KeyOf) {
    return {
      key: await this.client.send(
        createRequest(plan, item, this.client.target, keyOf),
      ),
    };
  }

  async update(plan: DeliveryPlan, item: PlannedItem) {
    // The revision test inside the request makes Azure DevOps refuse it when the item changed.
    await this.client.send(updateRequest(plan, item, this.client.target));
  }

  async hasDependency(r: PlannedRelationship, keyOf: KeyOf) {
    const from = keyOf(r.fromItemId);
    const to = relationTarget(r, keyOf);
    if (!from || !to) return false;
    return (await this.client.relations(from)).some(
      (x) => x.rel === r.linkTypeId && relationTargetId(x.url) === to,
    );
  }

  async addDependency(
    plan: DeliveryPlan,
    r: PlannedRelationship,
    keyOf: KeyOf,
  ) {
    const request = dependencyRequest(plan, r, this.client.target, keyOf);
    if (!request)
      throw new IntegrationError("Both work items must exist to link them.");
    await this.client.send(request);
  }

  readCurrent(keys: string[]) {
    return this.client.readCurrent(keys);
  }

  browseUrl(key: string) {
    return this.client.browseUrl(key);
  }
}

class JiraPublisher implements Publisher {
  readonly checksBeforeWriting = false;
  readonly project: string;
  private readonly client: JiraIssues;

  constructor(settings: JiraSettings, signal?: AbortSignal) {
    this.client = new JiraIssues(settings, signal);
    this.project = this.client.site.projectKey;
  }

  async ownItems(plan: DeliveryPlan) {
    // Epics may have no Labels field, so the plan's group types are read too; the durable key decides.
    const groupTypes = [
      ...new Set(
        plan.items.filter((i) => i.role === "group").map((i) => i.typeId),
      ),
    ].filter(Boolean);
    return (await this.client.coherenceIssues(groupTypes)).map((i) => ({
      key: i.key,
      // ADF (Cloud) or wiki text (Data Center): the durable key appears verbatim in either.
      text: JSON.stringify(i.fields?.description ?? ""),
    }));
  }

  // Jira has no way to check a write without saving it.
  async checkCreate() {}
  async checkUpdate() {}

  async create(plan: DeliveryPlan, item: PlannedItem, keyOf: KeyOf) {
    return {
      key: await this.client.create(
        jiraCreateRequest(plan, item, this.client.site, keyOf),
      ),
    };
  }

  async update(plan: DeliveryPlan, item: PlannedItem) {
    const key = item.existing?.key ?? "";
    const updatedAt = item.existing?.remoteRev;
    if (updatedAt === undefined)
      throw new IntegrationError(
        `${key} hasn't been compared with Jira yet; plan again.`,
      );
    await this.client.update(
      key,
      jiraUpdateRequest(plan, item, this.client.site),
      updatedAt,
    );
  }

  async hasDependency(r: PlannedRelationship, keyOf: KeyOf) {
    const dependent = keyOf(r.fromItemId);
    const prerequisite = r.toItemId ? keyOf(r.toItemId) : r.toExternal?.key;
    if (!dependent || !prerequisite) return false;
    // On the dependent, "<prerequisite> blocks this" lists the prerequisite as the inwardIssue.
    return (await this.client.links(dependent)).some(
      (l) =>
        (l.type?.name ?? "").toLowerCase() ===
          (r.linkTypeId ?? "").toLowerCase() &&
        l.inwardIssue?.key === prerequisite,
    );
  }

  async addDependency(
    _plan: DeliveryPlan,
    r: PlannedRelationship,
    keyOf: KeyOf,
  ) {
    const request = jiraLinkRequest(r, this.client.site, keyOf);
    if (!request)
      throw new IntegrationError("Both issues must exist to link them.");
    await this.client.addLink(request);
  }

  readCurrent(keys: string[]) {
    return this.client.readCurrent(keys);
  }

  browseUrl(key: string) {
    return this.client.browseUrl(key);
  }
}

class GitHubPublisher implements Publisher {
  readonly checksBeforeWriting = false;
  readonly project: string;
  private readonly client: GitHubIssues;

  constructor(settings: GitHubSettings, signal?: AbortSignal) {
    this.client = new GitHubIssues(settings, signal);
    this.project = `${settings.owner.trim()}/${settings.repo.trim()}`;
  }

  async ownItems(_plan: DeliveryPlan) {
    return (await this.client.coherenceIssues()).map((i) => ({
      key: `#${i.number}`,
      text: i.body ?? "",
    }));
  }

  /** Milestones and labels that already exist are planned by name: their numbers are read here. */
  async prepare(plan: DeliveryPlan) {
    const keys = new Map<string, string>();
    const groups = plan.items.filter(
      (i) => i.role === "group" && i.operation === "keep" && !i.existing,
    );
    const milestones = groups.some((g) => g.typeId === "milestone")
      ? await this.client.milestones()
      : new Map<string, number>();
    for (const g of groups) {
      if (g.typeId === "label") keys.set(g.id, g.title);
      const n = milestones.get(g.title.trim().toLowerCase());
      if (g.typeId === "milestone" && n !== undefined)
        keys.set(g.id, String(n));
    }
    return keys;
  }

  // GitHub has no way to check a write without saving it.
  async checkCreate() {}
  async checkUpdate() {}

  async create(plan: DeliveryPlan, item: PlannedItem, keyOf: KeyOf) {
    const request = githubCreateRequest(plan, item, this.client.site, keyOf);
    if (item.typeId === "label")
      return { key: await this.client.createLabel(request) };
    if (item.typeId === "milestone")
      return { key: await this.client.createMilestone(request) };
    const made = await this.client.createIssue(request);
    const unsent = unsentFields(item);
    const notes = [
      made.note,
      unsent.length
        ? `Organisation issue fields aren't sent yet: ${unsent.join(", ")}.`
        : "",
    ].filter(Boolean);
    return {
      key: made.key,
      ...(notes.length ? { note: notes.join(" ") } : {}),
    };
  }

  async update(plan: DeliveryPlan, item: PlannedItem) {
    const key = item.existing?.key ?? "";
    const updatedAt = item.existing?.remoteRev;
    if (updatedAt === undefined)
      throw new IntegrationError(
        `${key} hasn't been compared with GitHub yet; plan again.`,
      );
    // Prerequisites keep their numbers in the dependency line: their keys come from the plan.
    const keyOf = (id: string) =>
      plan.items.find((i) => i.id === id)?.existing?.key;
    const patch = githubUpdateRequest(plan, item, this.client.site, keyOf);
    const labels = githubAddLabelsRequest(item, this.client.site);
    await this.client.updateIssue(
      key,
      [
        ...(Object.keys(patch.body as object).length ? [patch] : []),
        ...(labels ? [labels] : []),
      ],
      updatedAt,
    );
  }

  // Dependencies travel as a line in the issue body.
  async hasDependency() {
    return true;
  }
  async addDependency() {}

  readCurrent(keys: string[]) {
    return this.client.readCurrent(keys);
  }

  browseUrl(key: string) {
    return this.client.browseUrl(key);
  }
}

export function publisherFor(
  system: ExternalSystem,
  settings: TrackerSettings,
  signal?: AbortSignal,
): Publisher {
  if (system === "azdo")
    return new AzdoPublisher(settings as AzdoSettings, signal);
  if (system === "jira")
    return new JiraPublisher(settings as JiraSettings, signal);
  if (system === "github")
    return new GitHubPublisher(settings as GitHubSettings, signal);
  throw new IntegrationError(
    "Publishing to this destination isn't available in this version yet.",
  );
}
