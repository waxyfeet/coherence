/**
 * OWNER: graph builder.
 * Merges the Impact Analyst's output with the deterministic trace. The trace is authoritative about
 * WHICH use cases are impacted and how (relation); the model contributes judgement (severity, reason,
 * concrete edits). Unknown ids are dropped so the UI never links to something that does not exist.
 */
import type {
  ChangeRequest,
  DeterministicImpact,
  ImpactItem,
  ImpactRelation,
  ImpactReport,
  ImpactSeverity,
  SolutionModel,
} from "@shared/types";
import type { ImpactAnalystItem, ImpactAnalystOutput } from "./impactSchema";
import {
  buildMockContext,
  mockItemFor,
  mockSummary,
  type MockContext,
} from "./impactMock";
import { relationOf } from "./impactPrompts";
import {
  indexModel,
  normaliseChildId,
  normaliseUseCaseId,
  type ModelIndex,
} from "./modelIndex";
import { normaliseLabel } from "./text";

export interface MergedImpact {
  items: ImpactItem[];
  summary: string;
  risks: string[];
  suggestedNewUseCases: ImpactReport["suggestedNewUseCases"];
}

export const SEVERITY_RANK: Record<ImpactSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};
const RELATION_RANK: Record<ImpactRelation, number> = {
  direct: 0,
  downstream: 1,
  upstream: 2,
  related: 3,
};

function cleanList(list: string[], max = 40): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const s = raw
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[-*•]\s+/, "");
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Map the model's "BR-2", "UC-003/BR-02", "br02" onto the use case's actual ids; drop the rest. */
export function resolveChildIds(
  raw: string[],
  existing: string[],
  prefix: "BR" | "SC",
): string[] {
  const byNorm = new Map<string, string>();
  for (const id of existing) byNorm.set(normaliseChildId(id, prefix) ?? id, id);
  const out: string[] = [];
  for (const r of raw) {
    const trimmed = r.trim();
    const hit = existing.includes(trimmed)
      ? trimmed
      : byNorm.get(normaliseChildId(trimmed, prefix) ?? "");
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out.sort((a, b) => existing.indexOf(a) - existing.indexOf(b));
}

function resolveUseCaseId(ix: ModelIndex, raw: string): string | undefined {
  const trimmed = raw.trim();
  if (ix.useCaseById.has(trimmed)) return trimmed;
  const norm = normaliseUseCaseId(trimmed);
  return norm && ix.useCaseById.has(norm) ? norm : undefined;
}

function toImpactItem(
  ix: ModelIndex,
  raw: ImpactAnalystItem,
  useCaseId: string,
  relation: ImpactRelation,
): ImpactItem {
  const uc = ix.useCaseById.get(useCaseId)!;
  return {
    useCaseId,
    relation,
    severity: raw.severity,
    reason: raw.reason.replace(/\s+/g, " ").trim(),
    suggestedChanges: cleanList(raw.suggestedChanges),
    affectedSections: [...new Set(raw.affectedSections)],
    affectedRuleIds: resolveChildIds(
      raw.affectedRuleIds,
      uc.businessRules.map((r) => r.id),
      "BR",
    ),
    affectedScenarioIds: resolveChildIds(
      raw.affectedScenarioIds,
      uc.scenarios.map((s) => s.id),
      "SC",
    ),
  };
}

/** Two items for the same use case (models sometimes split them): keep the worst severity, union the rest. */
function combine(a: ImpactItem, b: ImpactItem): ImpactItem {
  const worst = SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a;
  return {
    ...a,
    severity: worst.severity,
    reason:
      a.reason && b.reason && a.reason !== b.reason
        ? `${worst.reason} ${worst === a ? b.reason : a.reason}`
        : a.reason || b.reason,
    suggestedChanges: cleanList([...a.suggestedChanges, ...b.suggestedChanges]),
    affectedSections: [
      ...new Set([...a.affectedSections, ...b.affectedSections]),
    ],
    affectedRuleIds: [...new Set([...a.affectedRuleIds, ...b.affectedRuleIds])],
    affectedScenarioIds: [
      ...new Set([...a.affectedScenarioIds, ...b.affectedScenarioIds]),
    ],
  };
}

export interface MergeArgs {
  model: SolutionModel;
  change: ChangeRequest;
  trace: DeterministicImpact;
  output: ImpactAnalystOutput;
}

export function mergeImpactAnalysis({
  model,
  change,
  trace,
  output,
}: MergeArgs): MergedImpact {
  const ix = indexModel(model);
  const relation = relationOf(trace);
  const byId = new Map<string, ImpactItem>();

  for (const raw of output.items) {
    const id = resolveUseCaseId(ix, raw.useCaseId);
    if (!id) continue; // the LLM may only add use cases that exist
    const item = toImpactItem(ix, raw, id, relation.get(id) ?? "related");
    const existing = byId.get(id);
    byId.set(id, existing ? combine(existing, item) : item);
  }

  let mockCtx: MockContext | undefined;
  const fallback = (
    id: string,
    rel: ImpactRelation,
  ): ImpactItem | undefined => {
    mockCtx ??= buildMockContext({ model, change, trace });
    const item = mockItemFor(mockCtx, id, rel);
    if (!item) return undefined;
    const merged = toImpactItem(ix, item, id, rel);
    merged.reason = `${merged.reason} (Not assessed by the AI — deterministic assessment from the dependency trace.)`;
    return merged;
  };

  // Every direct use case must be in the report — it is where the change lands.
  for (const id of trace.directUseCaseIds) {
    if (byId.has(id)) continue;
    const item = fallback(id, "direct");
    if (item) byId.set(id, item);
  }

  // A BA edit of postconditions breaks the inherited precondition of every immediate dependent.
  if (change.useCaseDiff?.changedSections.includes("postconditions")) {
    const edited = resolveUseCaseId(ix, change.useCaseDiff.useCaseId);
    for (const dep of edited ? (ix.dependents.get(edited) ?? []) : []) {
      const item =
        byId.get(dep) ?? fallback(dep, relation.get(dep) ?? "downstream");
      if (!item) continue;
      if (SEVERITY_RANK[item.severity] < SEVERITY_RANK.medium) {
        item.severity = "medium";
        item.reason =
          `${item.reason} ${edited}'s postconditions changed, and ${dep} inherits one of them as a precondition.`.trim();
      }
      if (!item.affectedSections.includes("preconditions"))
        item.affectedSections.push("preconditions");
      byId.set(dep, item);
    }
  }

  const items = [...byId.values()].sort(
    (a, b) =>
      RELATION_RANK[a.relation] - RELATION_RANK[b.relation] ||
      ix.compareUseCases(a.useCaseId, b.useCaseId),
  );

  // Suggested new use cases: screen ids must exist (accept keys and titles too), titles de-duplicated.
  const screenIdFor = (raw: string): string | undefined => {
    const t = raw.trim();
    if (ix.screenById.has(t)) return t;
    const byKey = ix.screenByKey.get(t);
    if (byKey) return byKey.screenId;
    const norm = normaliseLabel(t);
    return model.screens.find((s) => normaliseLabel(s.title) === norm)
      ?.screenId;
  };
  const seenTitles = new Set<string>();
  const suggestedNewUseCases: MergedImpact["suggestedNewUseCases"] = [];
  for (const s of output.suggestedNewUseCases) {
    const title = s.title.replace(/\s+/g, " ").trim();
    const key = normaliseLabel(title);
    if (!title || seenTitles.has(key)) continue;
    seenTitles.add(key);
    suggestedNewUseCases.push({
      title,
      reason: s.reason.replace(/\s+/g, " ").trim(),
      screenIds: [
        ...new Set(
          s.screenIds.map(screenIdFor).filter((id): id is string => !!id),
        ),
      ],
    });
  }

  const summary =
    output.summary.replace(/\s+/g, " ").trim() ||
    mockSummary(
      (mockCtx ??= buildMockContext({ model, change, trace })),
      output.items,
    );

  return {
    items,
    summary,
    risks: cleanList(output.risks, 8),
    suggestedNewUseCases,
  };
}
