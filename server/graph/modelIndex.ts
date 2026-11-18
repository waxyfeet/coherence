/**
 * OWNER: graph builder.
 * Lookup tables over a SolutionModel, built once per call. The graph, the impact trace and the impact
 * apply step all ask the same questions ("which use cases cover this element?", "who depends on UC-003?"),
 * so the answers live here and stay consistent.
 */
import type {
  BusinessRule,
  BddScenario,
  Persona,
  ScreenAnalysis,
  ScreenRegion,
  SolutionModel,
  UIElement,
  UseCase,
} from "@shared/types";

export interface ModelIndex {
  model: SolutionModel;
  useCases: UseCase[];
  useCaseById: Map<string, UseCase>;
  screenById: Map<string, ScreenAnalysis>;
  screenByKey: Map<string, ScreenAnalysis>;
  elementById: Map<string, UIElement>;
  regionById: Map<string, ScreenRegion>;
  personaById: Map<string, Persona>;
  /** Element id → use case ids that cover it (elementIds, a rule governing it, a scenario exercising it). */
  coveringUseCases: Map<string, string[]>;
  /** Use case id → use case ids that list it in dependsOn (consumers of its postconditions). */
  dependents: Map<string, string[]>;
  /** Use case id → every element it touches (elementIds ∪ rule elements ∪ scenario elements). */
  useCaseElements: Map<string, string[]>;
  /** Use case id → screens it appears on (screenIds ∪ screens of its elements). */
  useCaseScreens: Map<string, string[]>;
  /** Screen id → use case ids appearing on it. */
  screenUseCases: Map<string, string[]>;
  /** Element id → order position across the model (screen order, then element order). */
  elementOrder: Map<string, number>;
  /** Screen id → position in model.screens. */
  screenOrder: Map<string, number>;
  /** Sort comparator for use case ids by build order (unknown ids last, then by id). */
  compareUseCases(a: string, b: string): number;
  sortUseCases(ids: Iterable<string>): string[];
  sortElements(ids: Iterable<string>): string[];
  sortScreens(ids: Iterable<string>): string[];
  rule(useCaseId: string, ruleId: string): BusinessRule | undefined;
  scenario(useCaseId: string, scenarioId: string): BddScenario | undefined;
}

function pushUnique(
  map: Map<string, string[]>,
  key: string,
  value: string,
): void {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

export function indexModel(model: SolutionModel): ModelIndex {
  const useCases = [...model.useCases].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );
  const useCaseById = new Map(useCases.map((uc) => [uc.id, uc]));
  const ucPos = new Map(useCases.map((uc, i) => [uc.id, i]));

  const screenById = new Map<string, ScreenAnalysis>();
  const screenByKey = new Map<string, ScreenAnalysis>();
  const elementById = new Map<string, UIElement>();
  const regionById = new Map<string, ScreenRegion>();
  const elementOrder = new Map<string, number>();
  const screenOrder = new Map<string, number>();
  let elPos = 0;
  model.screens.forEach((s, i) => {
    if (screenById.has(s.screenId)) return;
    screenById.set(s.screenId, s);
    screenOrder.set(s.screenId, i);
    if (s.screenKey && !screenByKey.has(s.screenKey))
      screenByKey.set(s.screenKey, s);
    for (const r of s.regions)
      if (!regionById.has(r.id)) regionById.set(r.id, r);
    for (const el of s.elements) {
      if (elementById.has(el.id)) continue;
      elementById.set(el.id, el);
      elementOrder.set(el.id, elPos++);
    }
  });

  const personaById = new Map(model.personas.map((p) => [p.id, p]));

  const coveringUseCases = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  const useCaseElements = new Map<string, string[]>();
  const useCaseScreens = new Map<string, string[]>();
  const screenUseCases = new Map<string, string[]>();

  for (const uc of useCases) {
    const els: string[] = [];
    const add = (id: string | undefined) => {
      if (id && !els.includes(id)) els.push(id);
    };
    uc.elementIds.forEach(add);
    uc.businessRules.forEach((r) => add(r.elementId));
    uc.scenarios.forEach((sc) => sc.elementIds.forEach(add));
    useCaseElements.set(uc.id, els);
    for (const id of els) pushUnique(coveringUseCases, id, uc.id);

    const screens: string[] = [];
    for (const sid of uc.screenIds)
      if (!screens.includes(sid)) screens.push(sid);
    for (const id of els) {
      const sid = elementById.get(id)?.screenId;
      if (sid && !screens.includes(sid)) screens.push(sid);
    }
    useCaseScreens.set(uc.id, screens);
    for (const sid of screens) pushUnique(screenUseCases, sid, uc.id);

    for (const dep of uc.dependsOn)
      if (dep !== uc.id) pushUnique(dependents, dep, uc.id);
  }

  const compareUseCases = (a: string, b: string): number => {
    const pa = ucPos.get(a) ?? Number.MAX_SAFE_INTEGER;
    const pb = ucPos.get(b) ?? Number.MAX_SAFE_INTEGER;
    return pa - pb || a.localeCompare(b);
  };
  for (const list of [
    ...coveringUseCases.values(),
    ...dependents.values(),
    ...screenUseCases.values(),
  ]) {
    list.sort(compareUseCases);
  }

  const byPosition = (pos: Map<string, number>) => (ids: Iterable<string>) =>
    [...new Set(ids)].sort((a, b) => {
      const pa = pos.get(a) ?? Number.MAX_SAFE_INTEGER;
      const pb = pos.get(b) ?? Number.MAX_SAFE_INTEGER;
      return pa - pb || a.localeCompare(b);
    });

  return {
    model,
    useCases,
    useCaseById,
    screenById,
    screenByKey,
    elementById,
    regionById,
    personaById,
    coveringUseCases,
    dependents,
    useCaseElements,
    useCaseScreens,
    screenUseCases,
    elementOrder,
    screenOrder,
    compareUseCases,
    sortUseCases: (ids) => [...new Set(ids)].sort(compareUseCases),
    sortElements: byPosition(elementOrder),
    sortScreens: byPosition(screenOrder),
    rule: (ucId, ruleId) =>
      useCaseById.get(ucId)?.businessRules.find((r) => r.id === ruleId),
    scenario: (ucId, scId) =>
      useCaseById.get(ucId)?.scenarios.find((s) => s.id === scId),
  };
}

/** Split a namespaced node id "UC-003/BR-02" into its parts (undefined when malformed). */
export function splitNamespacedId(
  id: string | undefined,
): { useCaseId: string; childId: string } | undefined {
  if (!id) return undefined;
  const idx = id.indexOf("/");
  if (idx <= 0 || idx === id.length - 1) return undefined;
  return {
    useCaseId: id.slice(0, idx).trim(),
    childId: id.slice(idx + 1).trim(),
  };
}

/** Accepts "UC-3", "uc-003", "UC003" → "UC-003"; undefined when no use case id is present. */
export function normaliseUseCaseId(raw: string): string | undefined {
  const m = /\bUC[-_ ]?(\d{1,4})\b/i.exec(raw);
  if (!m) return undefined;
  return `UC-${m[1].padStart(3, "0")}`;
}

/** Accepts "BR-2", "br02", "UC-003/BR-02" → "BR-02" (prefix BR or SC). */
export function normaliseChildId(
  raw: string,
  prefix: "BR" | "SC",
): string | undefined {
  const m = new RegExp(`\\b${prefix}[-_ ]?(\\d{1,3})\\b`, "i").exec(raw);
  if (!m) return undefined;
  return `${prefix}-${m[1].padStart(2, "0")}`;
}
