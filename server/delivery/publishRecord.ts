/**
 * What Coherence has published to one destination: the work items it created or adopted, keyed by durable key, and
 * the last run's results (docs/ARCHITECTURE.md, "Publishing"). One secret-free file per destination,
 * <project>/delivery/published/<system>-<identity hash>.json, so a different project in Settings never inherits
 * another destination's items. Callers hold the project lock when writing.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  DestinationIdentity,
  PlannedItemRole,
  PublishRunSummary,
} from "@shared/delivery";
import type { ExternalSystem, ISODate } from "@shared/types";
import { paths } from "../config";
import { ConflictError } from "../errors";
import { readJsonIfExists, writeJsonAtomic } from "../storage/fsUtils";

export interface PublishedEntry {
  durableKey: string;
  /** Plan item id when it was published ("group:FEAT-01", "uc:UC-003"). */
  itemId: string;
  role: PlannedItemRole;
  /** Work item id ("4711"). */
  key: string;
  url: string;
  title: string;
  useCaseId?: string;
  /** Use case revision that was published. */
  revision?: number;
  featureName?: string;
  publishedAt: ISODate;
  how: "created" | "adopted" | "updated";
  /**
   * What Coherence sent for each field it owns, in comparable form (rich text as visible text): the baseline that
   * tells a later edit in Coherence from an edit made by the team. Absent for adopted items.
   */
  sent?: Record<string, SentValue>;
}

export type SentValue = string | number | string[] | null;

/** Current values of existing work items, read when planning, so a local re-plan can compare without requests. */
export interface RemoteSnapshot {
  readAt: ISODate;
  /** By plan item id. Missing: the work item could not be found. */
  items: Record<
    string,
    { rev: number; values: Record<string, SentValue> } | { missing: true }
  >;
}

export interface PublishedRecord {
  schemaVersion: 1;
  system: ExternalSystem;
  identity: DestinationIdentity;
  entries: PublishedEntry[];
  lastRun?: PublishRunSummary;
}

function identityHash(identity: DestinationIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        identity.system,
        identity.base.toLowerCase(),
        identity.container.toLowerCase(),
      ]),
    )
    .digest("hex")
    .slice(0, 12);
}

function recordFile(projectId: string, identity: DestinationIdentity): string {
  return path.join(
    paths.projectDir(projectId),
    "delivery",
    "published",
    `${identity.system}-${identityHash(identity)}.json`,
  );
}

export async function readPublished(
  projectId: string,
  identity: DestinationIdentity,
): Promise<PublishedRecord> {
  const raw = await readJsonIfExists<PublishedRecord>(
    recordFile(projectId, identity),
  ).catch(() => {
    throw new ConflictError(
      "The record of what was published to this destination could not be read, so nothing can be published safely. Restore the file or ask for help.",
    );
  });
  if (raw && (raw.schemaVersion !== 1 || !Array.isArray(raw.entries)))
    throw new ConflictError(
      "The record of what was published to this destination is from a newer or unknown version of Coherence.",
    );
  return (
    raw ?? {
      schemaVersion: 1,
      system: identity.system,
      identity,
      entries: [],
    }
  );
}

/** Adds or replaces entries (by durable key) and optionally the last run. */
export async function writePublished(
  projectId: string,
  identity: DestinationIdentity,
  change: { entries?: PublishedEntry[]; lastRun?: PublishRunSummary },
): Promise<PublishedRecord> {
  const record = await readPublished(projectId, identity);
  const entries = new Map(record.entries.map((e) => [e.durableKey, e]));
  for (const entry of change.entries ?? [])
    entries.set(entry.durableKey, entry);
  const next: PublishedRecord = {
    ...record,
    entries: [...entries.values()],
    ...(change.lastRun ? { lastRun: change.lastRun } : {}),
  };
  await writeJsonAtomic(recordFile(projectId, identity), next);
  return next;
}

function snapshotFile(projectId: string, identity: DestinationIdentity) {
  return recordFile(projectId, identity).replace(/\.json$/, ".remote.json");
}

export async function readRemoteSnapshot(
  projectId: string,
  identity: DestinationIdentity,
): Promise<RemoteSnapshot | undefined> {
  return (
    (await readJsonIfExists<RemoteSnapshot>(
      snapshotFile(projectId, identity),
    ).catch(() => undefined)) ?? undefined
  );
}

export async function writeRemoteSnapshot(
  projectId: string,
  identity: DestinationIdentity,
  snapshot: RemoteSnapshot,
): Promise<void> {
  await writeJsonAtomic(snapshotFile(projectId, identity), snapshot);
}
