import { randomUUID } from "node:crypto";
import type { SolutionModel, UseCase } from "@shared/types";
import type { PlanResult } from "./planner";
const normal = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const number = (id: string) => Number(/^UC-(\d+)$/.exec(id)?.[1] ?? 0);
function overlap(a: string[], b: string[]) {
  const shared = a.filter((id) => b.includes(id)).length;
  return shared / (new Set([...a, ...b]).size || 1);
}
/** Immutable display IDs and internal UUIDs are independent from topological build order. */
export function stabilisePlan(
  plan: PlanResult,
  previous: SolutionModel | null,
): number {
  const newIds = new Set(plan.newIds);
  const locked = new Set(
    plan.useCases.filter((u) => !newIds.has(u.id)).map((u) => u.id),
  );
  const previousCases = (previous?.useCases ?? []).filter(
    (u) => !locked.has(u.id),
  );
  const candidates: { next: UseCase; before: UseCase; score: number }[] = [];
  for (const next of plan.useCases.filter((u) => newIds.has(u.id)))
    for (const before of previousCases) {
      const sameTitle = normal(next.title) === normal(before.title);
      const shared = overlap(next.elementIds, before.elementIds);
      if (sameTitle || shared >= 0.5)
        candidates.push({ next, before, score: (sameTitle ? 2 : 0) + shared });
    }
  candidates.sort((a, b) => b.score - a.score || a.next.order - b.next.order);
  const matches = new Map<string, UseCase>(),
    used = new Set<string>();
  for (const c of candidates)
    if (!matches.has(c.next.id) && !used.has(c.before.id)) {
      matches.set(c.next.id, c.before);
      used.add(c.before.id);
    }
  let nextNumber = Math.max(
    previous?.nextUseCaseNumber ?? 1,
    ...(previous?.useCases ?? []).map((u) => number(u.id) + 1),
    ...plan.useCases
      .filter((u) => locked.has(u.id))
      .map((u) => number(u.id) + 1),
  );
  const ids = new Map<string, string>();
  for (const uc of plan.useCases) {
    const before = matches.get(uc.id);
    ids.set(
      uc.id,
      locked.has(uc.id)
        ? uc.id
        : (before?.id ?? `UC-${String(nextNumber++).padStart(3, "0")}`),
    );
  }
  const previousById = new Map(previous?.useCases.map((u) => [u.id, u]));
  for (const uc of plan.useCases) {
    const temporary = uc.id;
    const before =
      matches.get(temporary) ??
      (locked.has(temporary) ? previousById.get(temporary) : undefined);
    uc.id = ids.get(temporary)!;
    uc.internalId = before?.internalId ?? uc.internalId ?? randomUUID();
    uc.dependsOn = uc.dependsOn.map((id) => ids.get(id) ?? id);
  }
  for (const f of plan.features)
    f.useCaseIds = f.useCaseIds.map((id) => ids.get(id) ?? id);
  plan.newIds = plan.newIds.map((id) => ids.get(id)!);
  return nextNumber;
}
