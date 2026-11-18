/**
 * OWNER: formats builder.
 * Merges a parsed use case file into the SolutionModel: content from the body, structural fields from the
 * front matter (validated against the model), status/revision rules, element links restored for the
 * graph. Pure — the caller persists.
 */
import {
  slugify,
  type BddScenario,
  type BusinessRule,
  type SolutionModel,
  type UseCase,
  type UseCaseDiff,
  type UseCaseSection,
} from "@shared/types";
import type { ParsedUseCase } from "../formats/types";
import { diffUseCases, hasContentChanges } from "./useCaseDiff";

export interface MergeOutcome {
  /** The merged (or newly created) use case — not yet in the model; see applyMerge. */
  useCase?: UseCase;
  isNew: boolean;
  /** Diff against the previous model version (all sections for a new use case). */
  diff?: UseCaseDiff;
  /** True when content/structure changed (not just the status). */
  contentChanged: boolean;
  /** Fatal: nothing was merged. */
  errors: string[];
  /** Non-fatal parse and reference problems, readable by a BA. */
  warnings: string[];
}

const USE_CASE_ID = /^UC-\d{3,}$/;

export function mergeParsedUseCase(
  model: SolutionModel,
  parsed: ParsedUseCase,
  relPath: string,
  now: string,
): MergeOutcome {
  const warnings = [...parsed.warnings];
  if (parsed.errors.length)
    return {
      isNew: false,
      contentChanged: false,
      errors: [...parsed.errors],
      warnings,
    };

  const p = parsed.useCase;
  const before = model.useCases.find((uc) => uc.id === p.id);
  if (!before && !USE_CASE_ID.test(p.id)) {
    return {
      isNew: false,
      contentChanged: false,
      errors: [`"${p.id}" is not a use case id — use the form UC-012.`],
      warnings,
    };
  }
  const base = before ?? newUseCase(model, p.id, relPath, p.title ?? "", now);
  const elementIndex = new Map(
    model.screens.flatMap((s) => s.elements.map((e) => [e.id, e] as const)),
  );
  const screenIds = new Set(model.screens.map((s) => s.screenId));

  // ── Structural fields (front matter), validated against the model ──
  let featureId = base.featureId;
  if (p.featureId !== undefined && p.featureId !== base.featureId) {
    if (!p.featureId || model.features.some((f) => f.id === p.featureId))
      featureId = p.featureId;
    else
      warnings.push(
        `featureId "${p.featureId}" is not a known feature (${model.features.map((f) => f.id).join(", ") || "none"}); the use case stays in ${base.featureId || "no feature"}.`,
      );
  }
  let personaId = base.personaId;
  if (p.personaId !== undefined && p.personaId !== base.personaId) {
    if (!p.personaId || model.personas.some((x) => x.id === p.personaId))
      personaId = p.personaId;
    else
      warnings.push(
        `personaId "${p.personaId}" is not a known persona; the use case keeps ${base.personaId || "no persona"}.`,
      );
  }
  const keepKnown = (
    ids: string[] | undefined,
    fallback: string[],
    known: (id: string) => boolean,
    what: string,
  ) => {
    if (!ids) return fallback;
    const unknown = ids.filter((id) => !known(id));
    for (const id of unknown)
      warnings.push(
        `${what} "${id}" does not exist in the solution model and was ignored.`,
      );
    return ids.filter(known);
  };
  const nextScreenIds = keepKnown(
    p.screenIds,
    base.screenIds,
    (id) => screenIds.has(id),
    "Screen id",
  );
  const nextElementIds = keepKnown(
    p.elementIds,
    base.elementIds,
    (id) => elementIndex.has(id),
    "Element",
  );
  const dependsOn = validateDependencies(
    model,
    base.id,
    p.dependsOn ?? base.dependsOn,
    warnings,
  );
  const elementsChanged = !sameList(nextElementIds, base.elementIds);
  const regionIds = elementsChanged
    ? [
        ...new Set(
          nextElementIds
            .map((id) => elementIndex.get(id)?.regionId)
            .filter((r): r is string => !!r),
        ),
      ]
    : base.regionIds;

  // ── Content (body) ──
  const businessRules = (p.businessRules ?? base.businessRules).map((rule) =>
    restoreRuleElement(rule, base.businessRules),
  );
  for (const rule of businessRules) {
    if (rule.elementId && !elementIndex.has(rule.elementId)) {
      warnings.push(
        `${rule.id} refers to element "${rule.elementId}", which is not on any analysed screen.`,
      );
    }
  }
  const scenarios = (p.scenarios ?? base.scenarios).map((sc) =>
    restoreScenarioElements(sc, base.scenarios, nextElementIds, elementIndex),
  );

  const draft: UseCase = {
    ...base,
    title: p.title ?? base.title,
    formatId: p.formatId || base.formatId,
    featureId,
    personaId,
    screenIds: nextScreenIds,
    regionIds,
    elementIds: nextElementIds,
    dependsOn,
    size: p.size ?? base.size,
    scope: p.scope ?? base.scope,
    story: p.story ?? base.story,
    preconditions: p.preconditions ?? base.preconditions,
    postconditions: p.postconditions ?? base.postconditions,
    businessRules,
    scenarios,
    assumptions: p.assumptions ?? base.assumptions,
    openQuestions: p.openQuestions ?? base.openQuestions,
    notes: p.notes ?? base.notes,
    external: p.external ?? base.external,
    filePath: relPath,
  };

  if (!before) {
    const status = p.status === "approved" ? "approved" : "edited";
    const created: UseCase = {
      ...draft,
      status,
      revision: Math.max(1, p.revision ?? 1),
      updatedAt: now,
      staleReason: undefined,
    };
    delete created.staleReason;
    return {
      useCase: created,
      isNew: true,
      contentChanged: true,
      diff: newUseCaseDiff(created, relPath),
      errors: [],
      warnings: [
        ...warnings,
        `${created.id} is new — it was added to the solution model.`,
      ],
    };
  }

  const contentDiff = diffUseCases(before, { ...draft, status: before.status });
  const contentChanged = hasContentChanges(contentDiff);
  // A front matter with an older revision than the model was written before the model moved on (e.g. an
  // editor buffer or a file saved before its front matter was refreshed): its status is not a decision.
  const staleFrontMatter =
    p.revision !== undefined && p.revision < before.revision;
  // Status rules: the BA approving wins; any content edit makes it 'edited'; otherwise honour a manual change.
  let status = before.status;
  if (contentChanged && before.status === "approved" && p.status === "approved")
    status = "edited";
  else if (p.status === "approved") status = "approved";
  else if (contentChanged) status = "edited";
  else if (p.status && p.status !== before.status && !staleFrontMatter)
    status = p.status;

  const revision =
    Math.max(before.revision, p.revision ?? 0) + (contentChanged ? 1 : 0);
  const after: UseCase = {
    ...draft,
    internalId: before.internalId,
    status,
    revision,
    updatedAt:
      contentChanged || status !== before.status ? now : before.updatedAt,
  };
  if (status === "stale")
    after.staleReason = p.staleReason ?? before.staleReason;
  else delete after.staleReason;

  const diff = diffUseCases(before, after);
  return {
    useCase: after,
    isNew: false,
    contentChanged,
    diff,
    errors: [],
    warnings,
  };
}

/** Puts a merge outcome into the model (replacing or appending) and keeps feature groups consistent. */
export function applyMerge(model: SolutionModel, outcome: MergeOutcome): void {
  const uc = outcome.useCase;
  if (!uc) return;
  const index = model.useCases.findIndex((x) => x.id === uc.id);
  if (index >= 0) model.useCases[index] = uc;
  else model.useCases.push(uc);
  for (const feature of model.features) {
    const has = feature.useCaseIds.includes(uc.id);
    if (feature.id === uc.featureId && !has) feature.useCaseIds.push(uc.id);
    if (feature.id !== uc.featureId && has)
      feature.useCaseIds = feature.useCaseIds.filter((id) => id !== uc.id);
  }
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function newUseCase(
  model: SolutionModel,
  id: string,
  relPath: string,
  title: string,
  now: string,
): UseCase {
  const file = relPath.split("/").pop() ?? relPath;
  const stem = file
    .replace(/\.(md|markdown)$/i, "")
    .replace(new RegExp(`^${id}-?`, "i"), "");
  return {
    id,
    slug: slugify(stem || title || id),
    title,
    formatId: model.formatId,
    featureId: "",
    personaId: "",
    screenIds: [],
    regionIds: [],
    elementIds: [],
    dependsOn: [],
    order:
      model.useCases.reduce((max, uc) => Math.max(max, uc.order || 0), 0) + 1,
    size: "M",
    scope: "",
    story: { asA: "", iWant: "", soThat: "" },
    preconditions: [],
    postconditions: [],
    businessRules: [],
    scenarios: [],
    assumptions: [],
    openQuestions: [],
    notes: "",
    status: "edited",
    revision: 1,
    updatedAt: now,
    external: [],
    filePath: relPath,
  };
}

function newUseCaseDiff(uc: UseCase, relPath: string): UseCaseDiff {
  const sections: UseCaseSection[] = [
    "title",
    "story",
    "scope",
    "preconditions",
    "postconditions",
    "rules",
    "scenarios",
  ];
  if (uc.dependsOn.length) sections.push("dependencies");
  if (uc.elementIds.length) sections.push("elements");
  return {
    useCaseId: uc.id,
    changedSections: sections,
    summary: `New use case ${uc.id} '${uc.title}' added from ${relPath}`,
    details: [
      `Added use case ${uc.id} '${uc.title}'`,
      ...uc.businessRules.map((r) => `Added ${r.id} '${r.element}'`),
      ...uc.scenarios.map((s) => `Added ${s.id} '${s.title}'`),
      ...uc.dependsOn.map((d) => `Now depends on ${d}`),
    ],
  };
}

/** Drops unknown, self and cycle-creating dependencies (with a warning each). */
function validateDependencies(
  model: SolutionModel,
  id: string,
  deps: string[],
  warnings: string[],
): string[] {
  const known = new Set(model.useCases.map((uc) => uc.id));
  const graph = new Map(model.useCases.map((uc) => [uc.id, uc.dependsOn]));
  const out: string[] = [];
  for (const dep of deps) {
    if (dep === id) {
      warnings.push(
        `${id} cannot depend on itself; that dependency was ignored.`,
      );
      continue;
    }
    if (!known.has(dep)) {
      warnings.push(
        `dependsOn "${dep}" is not a known use case and was ignored.`,
      );
      continue;
    }
    graph.set(id, [...out, dep]);
    if (reaches(graph, dep, id)) {
      warnings.push(
        `Depending on ${dep} would create a circular chain (${dep} already leads to ${id}); that dependency was ignored.`,
      );
      continue;
    }
    out.push(dep);
  }
  return out;
}

function reaches(
  graph: Map<string, string[]>,
  from: string,
  target: string,
): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === target) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(graph.get(cur) ?? []));
  }
  return false;
}

/** A BA deleting the backtick id line by accident should not cut the rule loose from its element. */
function restoreRuleElement(
  rule: BusinessRule,
  previous: BusinessRule[],
): BusinessRule {
  if (
    rule.elementId ||
    rule.elementType === "general" ||
    rule.elementType === "screen"
  )
    return rule;
  const old = previous.find((r) => r.id === rule.id && r.elementId);
  if (
    old &&
    old.element.trim().toLowerCase() === rule.element.trim().toLowerCase()
  ) {
    return {
      ...rule,
      elementId: old.elementId,
      elementType:
        rule.elementType === "other" ? old.elementType : rule.elementType,
    };
  }
  return rule;
}

function stepsKey(sc: BddScenario): string {
  return JSON.stringify(
    [sc.given, sc.when, sc.then].map((list) =>
      list.map((s) => s.replace(/\s+/g, " ").trim()),
    ),
  );
}

/**
 * Scenario → element links are not written in the markdown. Unchanged scenarios keep theirs; edited or
 * new ones are inferred from quoted labels ("Sign in") and backticked ids in their steps.
 */
function restoreScenarioElements(
  sc: BddScenario,
  previous: BddScenario[],
  elementIds: string[],
  elementIndex: Map<string, { id: string; label: string }>,
): BddScenario {
  const old = previous.find((s) => s.id === sc.id);
  if (old && stepsKey(old) === stepsKey(sc))
    return { ...sc, elementIds: [...old.elementIds] };
  const text = [...sc.given, ...sc.when, ...sc.then].join("\n");
  const quoted = new Set(
    [...text.matchAll(/"([^"]{1,80})"|“([^”]{1,80})”|`([^`]{1,120})`/g)].map(
      (m) => (m[1] ?? m[2] ?? m[3]).trim().toLowerCase(),
    ),
  );
  const found = elementIds.filter((id) => {
    const el = elementIndex.get(id);
    if (!el) return false;
    return (
      quoted.has(id.toLowerCase()) ||
      (el.label.trim().length > 1 && quoted.has(el.label.trim().toLowerCase()))
    );
  });
  if (found.length) return { ...sc, elementIds: found };
  return {
    ...sc,
    elementIds: old
      ? old.elementIds.filter((id) => elementIds.includes(id))
      : [],
  };
}
