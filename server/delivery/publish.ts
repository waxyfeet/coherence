/**
 * Publishing a delivery plan to Azure DevOps or Jira (docs/ARCHITECTURE.md, "Publishing"), through the
 * destination's Publisher (publishers.ts). Not an approval workflow: everything the plan can send is sent, everything
 * else is listed with its reason.
 *
 * Gate (nothing is written until all pass): the destination is unlocked in this build; the stored plan is the one
 * the BA confirmed (revision and fingerprint); it is not stale; no earlier write has an unknown outcome; a fresh
 * read of the destination has the same structure; Coherence's earlier items are found (adopted, never duplicated);
 * where the destination can check without saving (Azure DevOps validateOnly), it accepts every write first (refused
 * items stay behind with its reason). Jira has no such check, so a refusal there is found while writing.
 *
 * Writes, one at a time and each journalled first: Features or Epics, then work items with their parent in the same
 * request, then updates, then dependency links (after reading the item's links). The run stops at the first write with an unknown
 * outcome, on refused credentials and on a long rate limit; Stop takes effect between writes. Coherence never
 * deletes, closes, reassigns or comments, and never sends bypassRules or suppressNotifications.
 */
import type {
  DeliveryPlan,
  PlannedItem,
  PublishItemResult,
  PublishLinkResult,
  PublishRunSummary,
} from "@shared/delivery";
import { publishScope } from "@shared/delivery";
import type { DeliveryPublishRequest } from "@shared/api";
import { EXTERNAL_SYSTEM_LABEL } from "@shared/api";
import type { ExternalSystem } from "@shared/types";
import { ConflictError, NotFoundError, errorMessage } from "../errors";
import { recordTrackerLinks, requireIntegration } from "../export/exporter";
import { RemoteServiceError } from "../export/http";
import { createExportJournal, settleOperation } from "../export/journal";
import type { JobContext } from "../jobs/jobManager";
import { withProjectLock } from "../storage/projectStore";
import { provenRefusal } from "./azdoClient";
import { relationTarget } from "./azdoRequests";
import {
  discoverDestination,
  writeCachedSchema,
  type TrackerSettings,
} from "./discovery";
import { publisherFor } from "./publishers";
import { PUBLISH_TARGETS, uncertainOperations } from "./publishing";
import {
  readPublished,
  writePublished,
  type PublishedEntry,
  type SentValue,
} from "./publishRecord";
import { planStaleness, readPlan, replanAfterPublish } from "./service";
import { planFingerprint } from "./validate";
import { comparableValue, journalIdentity } from "./planner";

export const PUBLISH_STAGES = [
  "Checking the destination",
  "Creating Features",
  "Creating work items",
  "Updating work items",
  "Linking",
  "Recording",
] as const;

/** The job result: counts only. Messages from the destination stay in the project's publish record. */
export interface PublishJobResult {
  status: PublishRunSummary["status"];
  counts: Record<PublishItemResult["outcome"], number>;
  links: number;
}

function stopsTheRun(error: unknown, label: string): string | undefined {
  if (!(error instanceof RemoteServiceError)) return undefined;
  if (error.remoteStatus === 401 || error.remoteStatus === 403)
    return `${label} rejected the credentials (${error.remoteStatus}). Check the token in Settings → Integrations; it needs permission to create and edit ${label === "Jira" ? "issues" : "work items (Work Items: Read & write)"}.`;
  if (error.remoteStatus === 429)
    return `${label} asked Coherence to slow down. Try again in a few minutes; publishing again sends only what is missing.`;
  return undefined;
}

/** The service status plus the protocol facts Coherence keeps (a rule error names its field and rule). */
function refusalText(error: unknown): string {
  const fact =
    error instanceof RemoteServiceError
      ? (error.body as { message?: unknown } | undefined)?.message
      : undefined;
  const text = errorMessage(error);
  return typeof fact === "string" && fact ? `${text} ${fact}` : text;
}

function assertUnlocked(system: ExternalSystem) {
  if (!PUBLISH_TARGETS[system])
    throw new ConflictError(
      `Publishing to ${EXTERNAL_SYSTEM_LABEL[system]} isn't available in this version yet.`,
    );
}

/** The durable key a journal operation key stands for ("parent:<key>", "item:UC-003"). */
function durableKeyOf(plan: DeliveryPlan, opKey: string): string | undefined {
  if (opKey.startsWith("parent:")) return opKey.slice(7);
  if (opKey.startsWith("item:"))
    return plan.items.find((i) => i.id === `uc:${opKey.slice(5)}`)?.durableKey;
  return undefined;
}

/** Coherence's earlier work items in this project, by durable key (lowest id first). */
function byDurableKey<T extends { key: string; text: string }>(
  remote: T[],
  key: string,
): T[] {
  // Lowest number first: ADO ids, or the number in a Jira key ("POR-12").
  const n = (k: string) => Number(/(\d+)$/.exec(k)?.[1] ?? 0);
  return remote
    .filter((r) => r.text.includes(key))
    .sort((a, b) => n(a.key) - n(b.key));
}

function entryFor(
  plan: DeliveryPlan,
  item: PlannedItem,
  key: string,
  url: string,
  how: PublishedEntry["how"],
  sent?: PublishedEntry["sent"],
): PublishedEntry {
  const useCaseId =
    item.role === "group" ? undefined : item.sources.useCaseIds[0];
  return {
    durableKey: item.durableKey,
    itemId: item.id,
    role: item.role,
    key,
    url,
    title: item.title,
    ...(useCaseId
      ? {
          useCaseId,
          revision: plan.sources.find((s) => s.useCaseId === useCaseId)
            ?.revision,
        }
      : { featureName: item.title }),
    publishedAt: new Date().toISOString(),
    how,
    ...(sent ? { sent } : {}),
  };
}

/** What a write sends for the fields Coherence owns, in comparable form: the next comparison's baseline. */
function sentValues(
  plan: DeliveryPlan,
  item: PlannedItem,
  previous: PublishedEntry["sent"] = {},
): NonNullable<PublishedEntry["sent"]> {
  const sent = { ...previous };
  for (const f of item.fields)
    if (
      f.ownership === "coherence" &&
      (item.operation === "create" ||
        f.updateAction === "send" ||
        f.updateAction === "unchanged")
    )
      sent[f.fieldId] =
        (comparableValue(plan.destination.textFormat, f) as SentValue) ?? null;
  return sent;
}

async function record(
  ctx: JobContext,
  plan: DeliveryPlan,
  entries: PublishedEntry[],
  summary: PublishRunSummary,
) {
  await withProjectLock(plan.projectId, () =>
    writePublished(plan.projectId, plan.destination.identity, {
      entries,
      lastRun: summary,
    }),
  );
  const links = entries.filter((e) => e.useCaseId);
  if (links.length)
    try {
      await recordTrackerLinks(
        ctx,
        plan.projectId,
        plan.system,
        links.map((e) => ({
          useCaseId: e.useCaseId!,
          key: e.key,
          url: e.url,
          revision: e.revision ?? 0,
        })),
        `Published ${links.length} use case(s) to ${plan.destination.label}.`,
      );
    } catch (err) {
      ctx.warn(
        `The work items are recorded for this destination, but the use case links could not be saved (${errorMessage(err)}).`,
      );
    }
  try {
    await replanAfterPublish(plan.projectId, plan.system);
  } catch (err) {
    ctx.warn(
      `Published, but the plan could not be refreshed (${errorMessage(err)}). Plan again to see the result.`,
    );
  }
}

function jobResult(summary: PublishRunSummary): PublishJobResult {
  const counts = {
    created: 0,
    updated: 0,
    reused: 0,
    unchanged: 0,
    refused: 0,
    uncertain: 0,
    "not-sent": 0,
  };
  for (const item of summary.items) counts[item.outcome]++;
  return {
    status: summary.status,
    counts,
    links: summary.links.filter((l) => l.outcome === "added").length,
  };
}

export async function runDeliveryPublish(
  ctx: JobContext,
  projectId: string,
  system: ExternalSystem,
  req: DeliveryPublishRequest,
): Promise<PublishJobResult> {
  ctx.setStages([...PUBLISH_STAGES]);
  const startedAt = new Date().toISOString();
  assertUnlocked(system);
  const label = EXTERNAL_SYSTEM_LABEL[system];
  ctx.stage(PUBLISH_STAGES[0]);

  /* ── Gate ── */
  const settings = (await requireIntegration(system)) as TrackerSettings;
  const plan = await readPlan(projectId, system);
  if (!plan)
    throw new NotFoundError(
      "There is no delivery plan for this destination yet.",
    );
  if (
    plan.revision !== req.revision ||
    planFingerprint(plan) !== req.fingerprint
  )
    throw new ConflictError(
      "The plan changed since you looked at it. Review it again, then publish. Nothing was sent.",
    );
  const stale = await planStaleness(plan);
  if (stale.length)
    throw new ConflictError(
      `Plan again first: ${stale.join(" ")} Nothing was sent.`,
    );
  const unsettled = await uncertainOperations(projectId, system, settings);
  if (unsettled.length)
    throw new ConflictError(
      `${unsettled.length} earlier write(s) to ${label} had an unknown outcome. Choose "Check ${label}" first. Nothing was sent.`,
    );
  const scope = publishScope(plan);
  if (!scope.send.length)
    throw new ConflictError(
      scope.notSent.length
        ? `Nothing can be sent yet: ${scope.notSent[0].reason}`
        : `Everything in this plan is already in ${label}.`,
    );
  const { schema } = await discoverDestination(system, settings, {
    refresh: true,
    keepCache: true,
    signal: ctx.signal,
  });
  if (schema.fingerprint !== plan.destination.schemaFingerprint) {
    if (schema.gaps.length)
      throw new ConflictError(
        `Coherence couldn't read ${label} completely (${schema.gaps[0]}). Nothing was sent; try again.`,
      );
    await writeCachedSchema(schema);
    throw new ConflictError(
      `${label} changed since this plan was made (its work item types, fields or rules). Nothing was sent; plan again.`,
    );
  }
  const publisher = publisherFor(system, settings, ctx.signal);
  const remote = await publisher.ownItems(plan);
  const published = await readPublished(projectId, plan.destination.identity);
  ctx.info(
    `${label} has ${remote.length} work item(s) made by Coherence in ${publisher.project}.`,
  );

  /* ── Identity: what exists already ── */
  const keys = new Map<string, string>();
  const results = new Map<string, PublishItemResult>();
  const entries: PublishedEntry[] = [];
  const links: PublishLinkResult[] = [];
  const touched = new Set<string>();
  const result = (
    item: PlannedItem,
    outcome: PublishItemResult["outcome"],
    message?: string,
    key?: string,
  ) =>
    results.set(item.id, {
      itemId: item.id,
      title: item.title,
      typeName: item.typeName,
      outcome,
      ...(key ? { key, url: publisher.browseUrl(key) } : {}),
      ...(message ? { message } : {}),
    });
  for (const item of plan.items)
    if (item.existing) keys.set(item.id, item.existing.key);
  for (const [id, key] of (await publisher.prepare?.(plan)) ?? [])
    keys.set(id, key);
  const keyOf = (id: string) => keys.get(id);
  const sending = scope.send.map((id) => plan.items.find((i) => i.id === id)!);
  const toUpdate = sending.filter((i) => i.operation === "update");
  for (const item of sending.filter((i) => i.operation === "create")) {
    const found = byDurableKey(remote, item.durableKey);
    if (!found.length) continue;
    keys.set(item.id, found[0].key);
    touched.add(item.id);
    entries.push(
      entryFor(
        plan,
        item,
        found[0].key,
        publisher.browseUrl(found[0].key),
        "adopted",
      ),
    );
    result(
      item,
      "reused",
      found.length > 1
        ? `${found.length} work items carry this item's key; Coherence uses the oldest.`
        : "Made by Coherence earlier; recorded instead of creating it again.",
      found[0].key,
    );
  }

  /* ── Check every create without saving it ── */
  const toCreate = sending.filter(
    (i) => i.operation === "create" && !keys.has(i.id),
  );
  const parentOf = (item: PlannedItem) => {
    const parent = plan.relationships.find(
      (r) =>
        r.fromItemId === item.id &&
        r.kind === "parent" &&
        r.status === "planned",
    );
    return parent?.toItemId
      ? plan.items.find((i) => i.id === parent.toItemId)
      : undefined;
  };
  const leftBehind = (item: PlannedItem, reason: string) =>
    result(item, "not-sent", reason);
  ctx.progress(
    0,
    toCreate.length + toUpdate.length,
    "Checking each item without saving it",
  );
  for (const item of toCreate) {
    const parent = parentOf(item);
    if (parent && results.get(parent.id)?.outcome === "refused") {
      leftBehind(item, `Its parent "${parent.title}" would be refused.`);
      continue;
    }
    try {
      await publisher.checkCreate(
        plan,
        item,
        keyOf,
        !!parent && !keys.has(parent.id),
      );
    } catch (err) {
      if (stopsTheRun(err, label) || !provenRefusal(err)) throw err; // nothing was sent yet
      result(item, "refused", `${label} would refuse it. ${refusalText(err)}`);
    }
    ctx.tick(item.title);
  }
  for (const item of toUpdate) {
    try {
      await publisher.checkUpdate(plan, item);
    } catch (err) {
      if (stopsTheRun(err, label) || !provenRefusal(err)) throw err; // nothing was sent yet
      result(
        item,
        "refused",
        `${label} would refuse the update. ${refusalText(err)} If the work item was edited in ${label} after this plan was made, plan again.`,
      );
    }
    ctx.tick(item.title);
  }
  // A Feature whose use cases were all refused is not created on its own.
  for (const group of toCreate.filter((i) => i.role === "group"))
    if (
      !results.has(group.id) &&
      !toCreate.some((c) => c.parentItemId === group.id && !results.has(c.id))
    )
      leftBehind(group, "None of its use cases can be sent.");

  /* ── Writes ── */
  const journal = await createExportJournal(
    projectId,
    ctx.jobId,
    system,
    journalIdentity(system, settings),
  );
  if (!journal)
    throw new NotFoundError("The project folder could not be found.");
  let stopped: string | undefined;
  const create = async (item: PlannedItem, opKey: string) => {
    if (stopped) return;
    if (ctx.signal.aborted) {
      stopped = "Stopped by you. Publishing again sends only what is missing.";
      return;
    }
    const parent = parentOf(item);
    if (parent && !keys.has(parent.id)) {
      leftBehind(
        item,
        `Its parent "${parent.title}" isn't in ${label}: ${results.get(parent.id)?.message ?? "it wasn't created"}`,
      );
      return;
    }
    try {
      const id = await journal.operation(
        opKey,
        item.role === "group" ? "parent" : "item",
        () => publisher.create(plan, item, keyOf),
        provenRefusal,
      );
      keys.set(item.id, id.key);
      touched.add(item.id);
      entries.push(
        entryFor(
          plan,
          item,
          id.key,
          publisher.browseUrl(id.key),
          "created",
          sentValues(plan, item),
        ),
      );
      result(item, "created", id.note, id.key);
    } catch (err) {
      const stop = stopsTheRun(err, label);
      if (provenRefusal(err)) {
        result(item, "refused", `${label} refused it. ${refusalText(err)}`);
        if (stop) stopped = stop;
      } else {
        result(
          item,
          "uncertain",
          `${label} didn't confirm whether it was saved (${errorMessage(err)}). Choose "Check ${label}" before publishing again.`,
        );
        stopped = `The outcome of "${item.title}" is unknown, so the run stopped. Choose "Check ${label}" before publishing again.`;
      }
    }
  };
  const ready = toCreate.filter((i) => !results.has(i.id));
  const groups = ready.filter((i) => i.role === "group");
  const requirements = ready.filter((i) => i.role !== "group");
  ctx.stage(PUBLISH_STAGES[1], groups.length);
  for (const g of groups) {
    await create(g, `parent:${g.durableKey}`);
    ctx.tick(g.title);
  }
  ctx.stage(PUBLISH_STAGES[2], requirements.length);
  for (const r of requirements) {
    await create(r, `item:${r.sources.useCaseIds[0]}`);
    ctx.tick(r.title);
  }

  /* ── Updates: only the fields the comparison allows, guarded by the revision read when planning ── */
  const updates = toUpdate.filter((i) => !results.has(i.id));
  ctx.stage(PUBLISH_STAGES[3], updates.length);
  for (const item of updates) {
    if (stopped) break;
    if (ctx.signal.aborted) {
      stopped = "Stopped by you. Publishing again sends only what is missing.";
      break;
    }
    const key = item.existing!.key;
    try {
      // A repeated update fails its revision test, so no outcome needs checking before trying again.
      await journal.operation(
        `update:${item.sources.useCaseIds[0]}:${item.existing!.currentRevision}`,
        "item",
        async () => ({
          key: (await publisher.update(plan, item), key),
        }),
        () => true,
      );
      touched.add(item.id);
      const before = published.entries.find(
        (e) => e.durableKey === item.durableKey,
      );
      entries.push(
        entryFor(
          plan,
          item,
          key,
          publisher.browseUrl(key),
          "updated",
          sentValues(plan, item, before?.sent),
        ),
      );
      const kept = item.fields.filter(
        (f) => f.updateAction === "keep-destination",
      ).length;
      result(
        item,
        "updated",
        kept ? `${kept} field(s) edited in ${label} were kept.` : undefined,
        key,
      );
    } catch (err) {
      const stop = stopsTheRun(err, label);
      if (provenRefusal(err)) {
        result(
          item,
          "refused",
          `${label} refused the update. ${refusalText(err)} If the work item was edited in ${label} after this plan was made, plan again.`,
          key,
        );
        if (stop) stopped = stop;
      } else {
        result(
          item,
          "uncertain",
          `${label} didn't confirm the update (${errorMessage(err)}). Plan again: the comparison shows whether it arrived, and nothing is overwritten twice.`,
          key,
        );
        stopped = `The update of "${item.title}" wasn't confirmed, so the run stopped. Plan again before publishing.`;
      }
    }
    ctx.tick(item.title);
  }

  /* ── Dependency links: only where one end is new or newly found ── */
  if (ctx.signal.aborted)
    stopped ??= "Stopped by you. Publishing again sends only what is missing.";
  const dependencies = plan.relationships.filter(
    (r) =>
      r.kind === "dependency" &&
      r.status === "planned" &&
      r.linkTypeId &&
      (touched.has(r.fromItemId) || (!!r.toItemId && touched.has(r.toItemId))),
  );
  ctx.stage(PUBLISH_STAGES[4], dependencies.length);
  for (const r of dependencies) {
    const from = keyOf(r.fromItemId);
    const to = relationTarget(r, keyOf);
    const base = { relationshipId: r.id, fromItemId: r.fromItemId };
    if (stopped || !from || !to) {
      links.push({
        ...base,
        outcome: "not-sent",
        message: stopped
          ? "The run stopped before it."
          : `One of the two work items isn't in ${label} yet; publishing again adds the link.`,
      });
      continue;
    }
    try {
      if (await publisher.hasDependency(r, keyOf))
        links.push({ ...base, outcome: "already" });
      else {
        // A link is re-read before it is added, so a repeat finds it instead of duplicating it: nothing blocks a retry.
        await journal.operation(
          `link:${r.id}`,
          "links",
          () => publisher.addDependency(plan, r, keyOf),
          () => true,
        );
        links.push({ ...base, outcome: "added" });
      }
    } catch (err) {
      links.push({
        ...base,
        outcome: provenRefusal(err) ? "refused" : "uncertain",
        message: refusalText(err),
      });
      stopped ??= stopsTheRun(err, label);
    }
    ctx.tick();
  }

  /* ── Record ── */
  ctx.stage(PUBLISH_STAGES[5]);
  const summary: PublishRunSummary = {
    jobId: ctx.jobId,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: stopped ? "stopped" : "completed",
    ...(stopped ? { message: stopped } : {}),
    destination: `${label} · ${publisher.project}`,
    items: plan.items.map(
      (item): PublishItemResult =>
        results.get(item.id) ?? {
          itemId: item.id,
          title: item.title,
          typeName: item.typeName,
          ...(scope.unchanged.includes(item.id)
            ? {
                outcome: "unchanged",
                ...(item.existing
                  ? {
                      key: item.existing.key,
                      url: publisher.browseUrl(item.existing.key),
                    }
                  : {}),
              }
            : {
                outcome: "not-sent",
                message:
                  scope.notSent.find((n) => n.itemId === item.id)?.reason ??
                  "The run stopped before it.",
              }),
        },
    ),
    links,
  };
  await record(ctx, plan, entries, summary);
  const out = jobResult(summary);
  ctx.info(
    `${out.counts.created} created, ${out.counts.reused} found and recorded, ${out.counts.refused} refused, ${out.counts["not-sent"]} not sent, ${out.links} link(s) added.${stopped ? ` ${stopped}` : ""}`,
  );
  return out;
}

/**
 * "Check Azure DevOps": settles writes whose outcome is unknown with read-only searches. A work item carrying the
 * item's durable key is adopted (recorded, never created again); when none exists the write is cleared, so the next
 * publish creates it.
 */
export async function runDeliveryCheck(
  ctx: JobContext,
  projectId: string,
  system: ExternalSystem,
): Promise<PublishJobResult> {
  ctx.setStages([PUBLISH_STAGES[0], PUBLISH_STAGES[5]]);
  const startedAt = new Date().toISOString();
  assertUnlocked(system);
  const label = EXTERNAL_SYSTEM_LABEL[system];
  ctx.stage(PUBLISH_STAGES[0]);
  const settings = (await requireIntegration(system)) as TrackerSettings;
  const plan = await readPlan(projectId, system);
  if (!plan)
    throw new NotFoundError(
      "There is no delivery plan for this destination yet.",
    );
  const unsettled = await uncertainOperations(projectId, system, settings);
  const publisher = publisherFor(system, settings, ctx.signal);
  const remote = unsettled.length ? await publisher.ownItems(plan) : [];
  const entries: PublishedEntry[] = [];
  const items: PublishItemResult[] = [];
  for (const { journal, op } of unsettled) {
    const key = durableKeyOf(plan, op.key);
    const item = plan.items.find((i) => i.durableKey === key);
    const found = key ? byDurableKey(remote, key) : [];
    if (found.length && item) {
      await settleOperation(projectId, journal.id, op.key, {
        resolution: "adopted",
        result: { key: found[0].key },
      });
      entries.push(
        entryFor(
          plan,
          item,
          found[0].key,
          publisher.browseUrl(found[0].key),
          "adopted",
        ),
      );
      items.push({
        itemId: item.id,
        title: item.title,
        typeName: item.typeName,
        outcome: "reused",
        key: found[0].key,
        url: publisher.browseUrl(found[0].key),
        message: `It was saved in ${label}; Coherence recorded it.`,
      });
    } else {
      await settleOperation(projectId, journal.id, op.key, {
        resolution: "not-found",
      });
      if (item)
        items.push({
          itemId: item.id,
          title: item.title,
          typeName: item.typeName,
          outcome: "not-sent",
          message: `It isn't in ${label}; the next publish creates it.`,
        });
    }
    ctx.tick();
  }
  ctx.stage(PUBLISH_STAGES[5]);
  const summary: PublishRunSummary = {
    jobId: ctx.jobId,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: "completed",
    message: unsettled.length
      ? `Checked ${unsettled.length} write(s) with an unknown outcome in ${label}.`
      : "Nothing needed checking.",
    destination: `${label} · ${publisher.project}`,
    items,
    links: [],
  };
  await record(ctx, plan, entries, summary);
  return jobResult(summary);
}
