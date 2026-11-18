/**
 * Which destinations this build may publish to, and what the Export page is told about publishing a plan
 * (docs/ARCHITECTURE.md, "Publishing"). A destination is unlocked only by this constant, set when its
 * publishing is built and tested; a token or a setting never unlocks anything.
 */
import type { DeliveryPlan, PublishingState } from "@shared/delivery";
import { publishScope } from "@shared/delivery";
import { EXTERNAL_SYSTEM_LABEL } from "@shared/api";
import type { ExternalSystem } from "@shared/types";
import { isUnsettled, listExportJournals } from "../export/journal";
import type { TrackerSettings } from "./discovery";
import { journalTargetFingerprint } from "./planner";
import { readPublished } from "./publishRecord";

/** Azure DevOps (cloud), Jira (Cloud and Data Center) and GitHub (github.com and Enterprise) from 3 Nov 2026, on the owner's instruction. */
export const PUBLISH_TARGETS: Readonly<Record<ExternalSystem, boolean>> = {
  azdo: true,
  jira: true,
  github: true,
};

/** Journal operations for this destination whose outcome is still unknown. */
export async function uncertainOperations(
  projectId: string,
  system: ExternalSystem,
  settings: TrackerSettings,
) {
  const fingerprint = journalTargetFingerprint(system, settings);
  return (await listExportJournals(projectId)).flatMap((journal) =>
    journal.targetFingerprint === fingerprint
      ? journal.operations.filter(isUnsettled).map((op) => ({ journal, op }))
      : [],
  );
}

export async function publishingState(
  plan: DeliveryPlan,
  stale: string[],
  settings: TrackerSettings | undefined,
): Promise<PublishingState> {
  const label = EXTERNAL_SYSTEM_LABEL[plan.system];
  const enabled = PUBLISH_TARGETS[plan.system];
  const scope = publishScope(plan);
  const record = await readPublished(
    plan.projectId,
    plan.destination.identity,
  ).catch(() => undefined);
  const needsCheck = settings
    ? (await uncertainOperations(plan.projectId, plan.system, settings)).length
    : 0;
  const blockedReason = !enabled
    ? `Publishing to ${label} isn't available in this version yet.`
    : !settings
      ? `${label} is no longer set up in Settings.`
      : stale.length
        ? `Plan again first: ${stale[0]}`
        : needsCheck
          ? `${needsCheck} earlier write${needsCheck === 1 ? "" : "s"} to ${label} had an unknown outcome. Choose "Check ${label}" first.`
          : !scope.send.length
            ? scope.notSent.length
              ? `Nothing can be sent yet: ${scope.notSent[0].reason}`
              : `Everything in this plan is already in ${label}.`
            : undefined;
  return {
    enabled,
    ...(blockedReason ? { blockedReason } : {}),
    scope,
    needsCheck,
    ...(record?.lastRun ? { lastRun: record.lastRun } : {}),
  };
}
