/**
 * OWNER: graph builder.
 * Pure model mutations used by the impact jobs: marking use cases stale, restoring their statuses,
 * merging a re-analysed screen into the model, and composing the Use Case Writer's revision notes.
 * Kept free of I/O so they are unit-testable and can be re-applied to a freshly loaded model inside the
 * project lock.
 */
import type {
  FlowLink,
  ImpactItem,
  ImpactReport,
  ImpactStatus,
  ScreenAnalysis,
  SolutionModel,
  UIElement,
  UseCase,
  UseCaseStatus,
} from "@shared/types";
import { ownerForRegion, ownerForScreen } from "./graph";
import { describeElementForPrompt } from "./impactPrompts";
import { indexModel, type ModelIndex } from "./modelIndex";
import { elementDisplayLabel, elementName, truncate } from "./text";

/* ------------------------------------------------------------------ */
/* Stale marking                                                       */
/* ------------------------------------------------------------------ */

export function needsAttention(item: ImpactItem): boolean {
  return item.severity === "high" || item.severity === "medium";
}

/**
 * An impact report as stored. `modelGeneratedAt` (the model.generatedAt the analysis ran against) is written
 * with every new report; reports from before it was recorded do not have it.
 */
export type TrackedImpactReport = ImpactReport & { modelGeneratedAt?: string };

/** Reports whose stale flags are still in force: not discarded and not completely applied. */
export function isOpenReport(report: Pick<ImpactReport, "status">): boolean {
  return report.status === "analysed" || report.status === "partially-applied";
}

type FlaggingReport = Pick<
  ImpactReport,
  "id" | "createdAt" | "status" | "previousStatuses" | "appliedUseCaseIds"
>;

/**
 * True while `report` still asks for the use case to change: it is open, holds the use case's status from
 * before the flag (previousStatuses lists the use cases it flags; an apply drops the ones the BA left out)
 * and has not rewritten it yet.
 */
export function stillFlags(
  report: Omit<FlaggingReport, "id" | "createdAt">,
  useCaseId: string,
): boolean {
  return (
    isOpenReport(report) &&
    Object.hasOwn(report.previousStatuses ?? {}, useCaseId) &&
    !(report.appliedUseCaseIds ?? []).includes(useCaseId)
  );
}

/** The oldest of `reports` that still flags the use case — the one that takes its stale flag over. */
export function nextFlaggingReport<R extends FlaggingReport>(
  reports: readonly R[],
  useCaseId: string,
): R | undefined {
  return reports
    .filter((r) => stillFlags(r, useCaseId))
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )[0];
}

/**
 * True when the specs were regenerated after `report` was analysed. Re-generation renumbers use cases (and
 * their rules and scenarios), so the report's ids may now name different use cases. Reports from before
 * modelGeneratedAt was recorded fall back to their creation time: a project runs one job at a time, so a
 * generation that finished after the analysis has a later generatedAt.
 */
export function regeneratedSince(
  report: Pick<TrackedImpactReport, "createdAt" | "modelGeneratedAt">,
  model: Pick<SolutionModel, "generatedAt">,
): boolean {
  if (report.modelGeneratedAt)
    return report.modelGeneratedAt !== model.generatedAt;
  return model.generatedAt > report.createdAt;
}

/**
 * Marks use cases with a high/medium item 'stale' (staleReason = reportId) and records their status before
 * the flag in previousStatuses. A use case another open report (in `others`) already flags keeps that report
 * as its staleReason, so discarding THIS report never un-flags it; its original status is recorded here
 * too, so this report can take the flag over when the other one is closed, and a rewrite through either
 * report keeps the BA's edited/approved protection.
 * MUTATES the model. Returns the statuses to restore on discard and the ids that changed.
 */
export function markStale(
  model: SolutionModel,
  items: ImpactItem[],
  reportId: string,
  exclude: ReadonlySet<string> = new Set(),
  others: readonly ImpactReport[] = [],
): { previousStatuses: Record<string, UseCaseStatus>; markedIds: string[] } {
  const previousStatuses: Record<string, UseCaseStatus> = {};
  const markedIds: string[] = [];
  for (const item of items) {
    if (!needsAttention(item) || exclude.has(item.useCaseId)) continue;
    const uc = model.useCases.find((u) => u.id === item.useCaseId);
    if (!uc) continue;
    if (uc.status === "stale") {
      const owner = others.find(
        (r) => r.id === uc.staleReason && r.id !== reportId && isOpenReport(r),
      );
      // 'stale' = original unknown: restored (or rewritten) as plain generated content.
      if (owner)
        previousStatuses[uc.id] = owner.previousStatuses?.[uc.id] ?? "stale";
      continue;
    }
    previousStatuses[uc.id] = uc.status;
    uc.status = "stale";
    uc.staleReason = reportId;
    markedIds.push(uc.id);
  }
  return { previousStatuses, markedIds };
}

/**
 * Lifts this report's stale flags, except for the use cases in `keep`. A use case another open report (in
 * `others`) still flags stays stale and is handed over to that report; the rest get their previous status
 * back. MUTATES the model. Returns the ids whose status or staleReason changed.
 */
export function restoreStatuses(
  model: SolutionModel,
  report: ImpactReport,
  keep: ReadonlySet<string> = new Set(),
  others: readonly ImpactReport[] = [],
): string[] {
  const changed: string[] = [];
  const candidates = others.filter((r) => r.id !== report.id);
  for (const [id, previous] of Object.entries(report.previousStatuses ?? {})) {
    if (keep.has(id)) continue;
    const uc = model.useCases.find((u) => u.id === id);
    if (!uc || uc.status !== "stale" || uc.staleReason !== report.id) continue;
    const heir = nextFlaggingReport(candidates, id);
    if (heir) {
      uc.staleReason = heir.id;
    } else {
      uc.status = previous === "stale" ? "generated" : previous;
      delete uc.staleReason;
    }
    changed.push(id);
  }
  return changed;
}

/**
 * Status of a use case after the writer rewrote it for this report. Content the BA edited or approved stays
 * 'edited' (like "Revise with AI"), so a later re-generation with "preserve edited" cannot overwrite it;
 * everything else is plain generated content again. For a stale use case the status before the flag comes
 * from the report that flags it (`owner`, when that is another report), else from this report's own record.
 */
export function statusAfterRewrite(
  current: Pick<UseCase, "id" | "status" | "staleReason">,
  report: Pick<ImpactReport, "id" | "previousStatuses">,
  owner?: Pick<ImpactReport, "id" | "previousStatuses">,
): UseCaseStatus {
  let before: UseCaseStatus | undefined = current.status;
  if (before === "stale") {
    const flaggedBy =
      owner && current.staleReason === owner.id ? owner : undefined;
    before =
      flaggedBy?.previousStatuses?.[current.id] ??
      report.previousStatuses?.[current.id];
  }
  return before === "edited" || before === "approved" ? "edited" : "generated";
}

/**
 * After a rewrite (`uc` carries its new status): when other open reports (in `others`) still ask for changes
 * to the use case, it stays stale, flagged by the oldest of them, and their record of its status before the
 * flag becomes the rewritten content's status — discarding them later must not restore an approval the new
 * content never had. Otherwise the flag is gone. MUTATES `uc` and those reports. Returns the reports changed.
 */
export function keepFlagAfterRewrite<R extends FlaggingReport>(
  uc: UseCase,
  others: readonly R[],
): R[] {
  const heir = nextFlaggingReport(others, uc.id);
  if (!heir) {
    delete uc.staleReason;
    return [];
  }
  const flagging = others.filter((r) => stillFlags(r, uc.id));
  for (const r of flagging)
    r.previousStatuses[uc.id] = uc.status === "stale" ? "generated" : uc.status;
  uc.status = "stale";
  uc.staleReason = heir.id;
  return flagging;
}

/**
 * 'applied' when every high/medium item has been rewritten (now or in an earlier apply) and nothing
 * failed; otherwise 'partially-applied'.
 */
export function reportStatusAfterApply(
  report: ImpactReport,
  appliedIds: ReadonlySet<string>,
  failedIds: ReadonlySet<string>,
): ImpactStatus {
  if (failedIds.size) return "partially-applied";
  const remaining = report.items.filter(
    (i) => needsAttention(i) && !appliedIds.has(i.useCaseId),
  );
  return remaining.length ? "partially-applied" : "applied";
}

/* ------------------------------------------------------------------ */
/* Merging a re-analysed screen                                        */
/* ------------------------------------------------------------------ */

export interface ScreenMergeResult {
  /** False when a newer analysis of the screen is already in the model (nothing changed). */
  merged: boolean;
  screenId: string;
  screenTitle: string;
  fromVersion?: number;
  toVersion: number;
  removedElements: UIElement[];
  addedElements: UIElement[];
  /** element id → use case id that now covers it */
  assignments: { elementId: string; useCaseId: string }[];
  /** Use cases whose structural references changed (elementIds, regionIds, screenIds, scenario elements). */
  touchedUseCaseIds: string[];
  /** use case id → removed elements it used to cover */
  removedByUseCase: Map<string, UIElement[]>;
  warnings: string[];
}

function nextFlowNumber(flows: FlowLink[]): number {
  let max = 0;
  for (const f of flows) {
    const n = Number(/^flow-(\d+)$/.exec(f.id)?.[1] ?? 0);
    if (n > max) max = n;
  }
  return max + 1;
}

/**
 * Replaces the screen's analysis with `analysis` (ids already remapped by diffScreenAnalyses), drops
 * removed element ids from every use case, assigns each added element to the use case covering most of
 * its region (else the first of `fallbackOwners`, else the use case covering most of the screen), and
 * keeps journeys consistent. MUTATES the model.
 */
export function mergeScreenAnalysis(
  model: SolutionModel,
  analysis: ScreenAnalysis,
  fallbackOwners: string[] = [],
): ScreenMergeResult {
  const idx = model.screens.findIndex((s) => s.screenId === analysis.screenId);
  const old = idx >= 0 ? model.screens[idx] : undefined;
  const result: ScreenMergeResult = {
    merged: false,
    screenId: analysis.screenId,
    screenTitle: analysis.title || old?.title || analysis.screenKey,
    fromVersion: old?.screenVersion,
    toVersion: analysis.screenVersion,
    removedElements: [],
    addedElements: [],
    assignments: [],
    touchedUseCaseIds: [],
    removedByUseCase: new Map(),
    warnings: [],
  };
  if (old && old.screenVersion > analysis.screenVersion) {
    result.warnings.push(
      `A newer analysis of ${result.screenTitle} (version ${old.screenVersion}) is already in the specs, so the screen changes in this report (version ${analysis.screenVersion}) were not merged.`,
    );
    return result;
  }

  // Ownership is decided against the model as it was (where the region's elements are already covered).
  const before = indexModel(model);
  const oldElementIds = new Set(old?.elements.map((e) => e.id) ?? []);
  const newElementIds = new Set(analysis.elements.map((e) => e.id));
  const oldRegionIds = new Set(old?.regions.map((r) => r.id) ?? []);
  const newRegionIds = new Set(analysis.regions.map((r) => r.id));
  result.removedElements = (old?.elements ?? []).filter(
    (e) => !newElementIds.has(e.id),
  );
  result.addedElements = analysis.elements.filter(
    (e) => !oldElementIds.has(e.id),
  );
  const removed = new Set(result.removedElements.map((e) => e.id));

  for (const el of result.removedElements) {
    for (const ucId of before.coveringUseCases.get(el.id) ?? []) {
      const list = result.removedByUseCase.get(ucId) ?? [];
      list.push(el);
      result.removedByUseCase.set(ucId, list);
    }
  }

  const fallback =
    fallbackOwners.find((id) => before.useCaseById.has(id)) ??
    ownerForScreen(before, analysis.screenId);
  for (const el of result.addedElements) {
    const owner = ownerForRegion(before, el.regionId) ?? fallback;
    if (owner) result.assignments.push({ elementId: el.id, useCaseId: owner });
    else
      result.warnings.push(
        `New element ${elementDisplayLabel(el)} on ${result.screenTitle} is not covered by any use case — regenerate or add a use case for it.`,
      );
  }

  // Replace the analysis.
  const copy = structuredClone(analysis);
  if (idx >= 0) model.screens[idx] = copy;
  else model.screens.push(copy);

  const touched = new Set<string>();
  for (const uc of model.useCases) {
    const signature = JSON.stringify([
      uc.elementIds,
      uc.regionIds,
      uc.screenIds,
      uc.scenarios.map((s) => s.elementIds),
    ]);
    uc.elementIds = uc.elementIds.filter((id) => !removed.has(id));
    uc.regionIds = uc.regionIds.filter(
      (id) => !oldRegionIds.has(id) || newRegionIds.has(id),
    );
    for (const sc of uc.scenarios)
      sc.elementIds = sc.elementIds.filter((id) => !removed.has(id));
    for (const a of result.assignments.filter((x) => x.useCaseId === uc.id)) {
      const el = analysis.elements.find((e) => e.id === a.elementId)!;
      if (!uc.elementIds.includes(el.id)) uc.elementIds.push(el.id);
      if (newRegionIds.has(el.regionId) && !uc.regionIds.includes(el.regionId))
        uc.regionIds.push(el.regionId);
      if (!uc.screenIds.includes(analysis.screenId))
        uc.screenIds.push(analysis.screenId);
    }
    if (
      JSON.stringify([
        uc.elementIds,
        uc.regionIds,
        uc.screenIds,
        uc.scenarios.map((s) => s.elementIds),
      ]) !== signature
    ) {
      touched.add(uc.id);
    }
  }
  result.touchedUseCaseIds = before.sortUseCases(touched);

  // Journeys: drop flows triggered by removed elements, add flows for new navigation elements.
  const analysedScreens = new Set(model.screens.map((s) => s.screenId));
  model.flows = model.flows.filter(
    (f) => !f.elementId || !removed.has(f.elementId),
  );
  let n = nextFlowNumber(model.flows);
  for (const el of analysis.elements) {
    const target = el.navigatesToScreenId;
    if (!target || target === analysis.screenId || !analysedScreens.has(target))
      continue;
    if (
      model.flows.some((f) => f.elementId === el.id && f.toScreenId === target)
    )
      continue;
    model.flows.push({
      id: `flow-${n++}`,
      fromScreenId: analysis.screenId,
      toScreenId: target,
      trigger: `Select '${truncate(elementName(el), 60)}'`,
      elementId: el.id,
    });
  }

  result.merged = true;
  return result;
}

/* ------------------------------------------------------------------ */
/* Revision notes for the Use Case Writer                              */
/* ------------------------------------------------------------------ */

const SOURCE_TEXT: Record<ImpactReport["change"]["source"], string> = {
  manual: "change requested by the business analyst",
  "md-edit": "the business analyst edited a use case",
  "screen-replace": "a screen image was replaced",
};

export interface RevisionNotesArgs {
  report: ImpactReport;
  useCase: UseCase;
  item?: ImpactItem;
  /** Index of the model the writer will see (after any screen merge). */
  ix: ModelIndex;
  screenMerge?: ScreenMergeResult;
}

export function buildRevisionNotes({
  report,
  useCase,
  item,
  ix,
  screenMerge,
}: RevisionNotesArgs): string {
  const { change } = report;
  const lines: string[] = [];
  lines.push(`Impact report ${report.id} — ${SOURCE_TEXT[change.source]}:`);
  lines.push(change.description.trim() || report.summary);

  if (item) {
    lines.push(
      "",
      `Why ${useCase.id} is affected (${item.relation}, severity ${item.severity}): ${item.reason}`,
    );
    if (item.suggestedChanges.length) {
      lines.push("", "Make these changes:");
      for (const s of item.suggestedChanges) lines.push(`- ${s}`);
    }
    if (item.affectedRuleIds.length)
      lines.push(
        `Business rules to revise: ${item.affectedRuleIds.join(", ")}.`,
      );
    if (item.affectedScenarioIds.length)
      lines.push(
        `Scenarios to revise: ${item.affectedScenarioIds.join(", ")}.`,
      );
    if (item.affectedSections.length)
      lines.push(`Sections concerned: ${item.affectedSections.join(", ")}.`);
  }

  const diff = change.useCaseDiff;
  if (diff && diff.useCaseId !== useCase.id) {
    const source = ix.useCaseById.get(diff.useCaseId);
    lines.push(
      "",
      `${diff.useCaseId} was edited by the business analyst: ${diff.summary}`,
    );
    for (const d of diff.details.slice(0, 20))
      lines.push(`- ${truncate(d, 300)}`);
    if (
      source &&
      useCase.dependsOn.includes(source.id) &&
      diff.changedSections.includes("postconditions")
    ) {
      lines.push(
        `${source.id}'s postconditions are now: ${source.postconditions.map((p) => `"${p}"`).join("; ") || "none"}.`,
        `${useCase.id}'s first precondition must be a verbatim copy of one of them, and SC-01's GIVEN must start with the preconditions.`,
      );
    }
    if (
      source &&
      source.dependsOn.includes(useCase.id) &&
      diff.changedSections.includes("preconditions")
    ) {
      lines.push(
        `${source.id} now starts from: ${source.preconditions.map((p) => `"${p}"`).join("; ") || "none"} — one of ${useCase.id}'s postconditions must establish its first precondition verbatim.`,
      );
    }
  }

  const screenDiff = change.screenDiff;
  if (screenDiff && screenMerge?.merged) {
    const title = screenMerge.screenTitle;
    lines.push(
      "",
      `Screen ${title} changed (version ${screenDiff.fromVersion} → ${screenDiff.toVersion}): ${screenDiff.summary}`,
    );
    const added = screenMerge.assignments
      .filter((a) => a.useCaseId === useCase.id)
      .map((a) => ix.elementById.get(a.elementId))
      .filter((el): el is UIElement => !!el);
    if (added.length) {
      lines.push(
        "New elements now covered by this use case — add a business rule for each and exercise them in the scenarios:",
      );
      for (const el of added)
        lines.push(`- ${describeElementForPrompt(el, ix)}`);
    }
    const removed = screenMerge.removedByUseCase.get(useCase.id) ?? [];
    if (removed.length) {
      lines.push(
        "Removed from the screen — delete their business rules and rewrite the scenario steps that use them:",
      );
      for (const el of removed)
        lines.push(`- ${el.id} — ${elementDisplayLabel(el)}`);
    }
    const mine = new Set(ix.useCaseElements.get(useCase.id) ?? []);
    const modified = screenDiff.modified.filter((m) => mine.has(m.before.id));
    if (modified.length) {
      lines.push(
        "Changed on the screen — update their business rules and scenarios to the new facts:",
      );
      for (const m of modified)
        lines.push(
          `- ${m.before.id} “${truncate(elementName(m.after), 60)}”: ${m.changes.join("; ")}`,
        );
    }
  }

  lines.push(
    "",
    "Keep everything else unchanged, keep the existing BR-/SC- ids for items that still exist, and keep the chain intact (preconditions copied verbatim from the postconditions of the use cases this one depends on).",
  );
  return lines.join("\n");
}
