import { capacityBatches } from "./capacityBatches";
/**
 * Use Case Planner agent (text) + the deterministic validation and repair that make its plan trustworthy:
 * unknown references dropped, every element covered (one repair call, then a deterministic fallback),
 * cycles broken, topological build order (stable by screen order then plan order), ids UC-001…,
 * features FEAT-01… and a verbatim pre/postcondition chain.
 */
import type {
  FeatureGroup,
  Granularity,
  LLMConnection,
  Persona,
  Project,
  Screen,
  ScreenAnalysis,
  ScreenRegion,
  UIElement,
  UseCase,
  UseCaseSize,
} from "@shared/types";
import { formatUseCaseId, slugify } from "@shared/types";
import { CancelledError, errorMessage } from "../errors";
import { stopsTheRun } from "../llm/errors";
import type { JobContext } from "../jobs/jobManager";
import { generateStructured } from "../llm/structured";
import { ENTRY_PRECONDITION, repairChain } from "./chain";
import {
  callBase,
  compactElementLine,
  compactInventoryBlock,
  flowsBlock,
  personasBlock,
  sortedScreens,
} from "./context";
import { indexElements, indexRegions } from "./ids";
import type { JourneyResult } from "./journeyMapper";
import { mockCoverageRepair, mockPlan } from "./mock/plannerMock";
import { coverageRepairSystem, plannerSystem } from "./prompts";
import {
  CoverageRepairOutputSchema,
  PlanOutputSchema,
  type CoverageRepairOutput,
  type PlanFeature,
  type PlannedUseCase,
  type PlanOutput,
} from "./schemas";
import {
  dedupeText,
  normText,
  oneLine,
  sameText,
  titleCase,
  uniqueKey,
} from "./text";

/* ── Plan context ───────────────────────────────────────────────────── */

export interface PlanContext {
  /** Analysed screens in the BA's order. */
  screens: Screen[];
  analyses: readonly ScreenAnalysis[];
  elements: Map<string, UIElement>;
  regions: Map<string, ScreenRegion>;
  /** Use cases carried over unchanged (preserve edited). */
  locked: readonly UseCase[];
  /** Elements owned by locked use cases — never re-planned. */
  lockedElementIds: Set<string>;
}

export function buildPlanContext(
  project: Project,
  analyses: readonly ScreenAnalysis[],
  locked: readonly UseCase[],
): PlanContext {
  const analysed = new Set(analyses.map((a) => a.screenId));
  return {
    screens: sortedScreens(project).filter((s) => analysed.has(s.id)),
    analyses,
    elements: indexElements(analyses),
    regions: indexRegions(analyses),
    locked,
    lockedElementIds: new Set(locked.flatMap((u) => u.elementIds)),
  };
}

/** Element ids in screen order, then region (reading) order, then any element not placed in a region. */
export function elementsInReadingOrder(pc: PlanContext): UIElement[] {
  const out: UIElement[] = [];
  const seen = new Set<string>();
  for (const s of pc.screens) {
    const a = pc.analyses.find((x) => x.screenId === s.id);
    if (!a) continue;
    for (const r of a.regions) {
      for (const id of r.elementIds) {
        const e = pc.elements.get(id);
        if (e && !seen.has(id)) {
          seen.add(id);
          out.push(e);
        }
      }
    }
    for (const e of a.elements) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        out.push(e);
      }
    }
  }
  return out;
}

/* ── Draft plan (keys, not ids yet) ─────────────────────────────────── */

export interface DraftUseCase {
  key: string;
  title: string;
  featureKey: string;
  personaName: string;
  screenIds: string[];
  regionIds: string[];
  elementIds: string[];
  /** Keys of other drafts, or ids of locked use cases. */
  dependsOn: string[];
  size: UseCaseSize;
  scope: string;
  preconditions: string[];
  postconditions: string[];
  /** Position in the planner's answer (repairs and fallbacks come after). */
  planIndex: number;
}

export interface DraftFeature {
  key: string;
  name: string;
  description: string;
}

function kebab(value: string): string {
  return slugify(value, 50);
}

function sizeFor(count: number): UseCaseSize {
  return count <= 4 ? "S" : count <= 9 ? "M" : "L";
}

/**
 * Accumulates the planner's answer (and the coverage repair's) into validated drafts. All validation that
 * does not need the whole plan happens here; `finalisePlan` does the rest.
 */
export class PlanBuilder {
  readonly drafts: DraftUseCase[] = [];
  readonly features: DraftFeature[] = [];
  readonly notes: string[] = [];
  private readonly keys = new Set<string>();
  private readonly featureKeys = new Set<string>();
  /** Model key (raw and slugged) → draft key. */
  private readonly keyMap = new Map<string, string>();
  private readonly featureKeyMap = new Map<string, string>();
  private nextIndex = 0;

  constructor(readonly pc: PlanContext) {}

  draft(key: string): DraftUseCase | undefined {
    return this.drafts.find((d) => d.key === key);
  }

  resolveKey(value: string): string | undefined {
    const v = value.trim();
    if (!v) return undefined;
    return (
      this.keyMap.get(v) ??
      this.keyMap.get(v.toLowerCase()) ??
      this.keyMap.get(kebab(v))
    );
  }

  addFeatures(features: readonly PlanFeature[]): void {
    for (const f of features) this.addFeature(f.key, f.name, f.description);
  }

  /** Registers a feature (merging by key or name) and returns its draft key. */
  addFeature(rawKey: string, rawName: string, description: string): string {
    const name =
      rawName.trim() || titleCase((rawKey || "General").replace(/[-_]+/g, " "));
    const known =
      this.featureKeyMap.get(rawKey.trim()) ??
      this.featureKeyMap.get(kebab(rawKey || name)) ??
      this.features.find((f) => sameText(f.name, name))?.key;
    if (known) {
      if (rawKey.trim()) this.featureKeyMap.set(rawKey.trim(), known);
      return known;
    }
    const key = uniqueKey(kebab(rawKey || name), this.featureKeys, "-");
    this.features.push({ key, name, description: description.trim() });
    if (rawKey.trim()) this.featureKeyMap.set(rawKey.trim(), key);
    this.featureKeyMap.set(kebab(rawKey || name), key);
    return key;
  }

  private resolveFeature(rawKey: string): string {
    const v = rawKey.trim();
    if (v) {
      const known =
        this.featureKeyMap.get(v) ??
        this.featureKeyMap.get(kebab(v)) ??
        this.features.find((f) => sameText(f.name, v))?.key;
      if (known) return known;
      this.notes.push(
        `Use case feature "${v}" was not in the feature list — created it.`,
      );
      return this.addFeature(v, "", "");
    }
    return (
      this.features[0]?.key ??
      this.addFeature(
        "general",
        "General",
        "Functionality that does not belong to a more specific feature.",
      )
    );
  }

  /** Adds planned use cases; dependsOn is resolved after the whole batch is known (forward references). */
  addUseCases(planned: readonly PlannedUseCase[]): DraftUseCase[] {
    const added: { draft: DraftUseCase; rawDepends: string[] }[] = [];
    for (const p of planned) {
      const title = p.title.trim();
      const key = uniqueKey(
        kebab(p.key || title || "use-case"),
        this.keys,
        "-",
      );
      // Models sometimes refer to a use case by its title instead of its key.
      for (const alias of [
        p.key.trim(),
        p.key.trim().toLowerCase(),
        kebab(p.key || title),
        title ? kebab(title) : "",
      ]) {
        if (alias && !this.keyMap.has(alias)) this.keyMap.set(alias, key);
      }

      const unknown: string[] = [];
      const elementIds: string[] = [];
      for (const raw of p.elementIds) {
        const id = raw.trim();
        if (!this.pc.elements.has(id)) {
          if (id) unknown.push(id);
          continue;
        }
        if (this.pc.lockedElementIds.has(id) || elementIds.includes(id))
          continue;
        elementIds.push(id);
      }
      if (unknown.length) {
        this.notes.push(
          `Planned use case "${oneLine(title || key, 60)}" referenced ${unknown.length} unknown element id(s) (${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ", …" : ""}) — dropped them.`,
        );
      }

      const draft: DraftUseCase = {
        key,
        title,
        featureKey: this.resolveFeature(p.featureKey),
        personaName: p.personaName.trim(),
        screenIds: [],
        regionIds: [],
        elementIds,
        dependsOn: [],
        size: p.size,
        scope: p.scope.trim(),
        preconditions: dedupeText(p.preconditions),
        postconditions: dedupeText(p.postconditions),
        planIndex: this.nextIndex++,
      };
      this.syncPlacement(draft, p.screenIds, p.regionIds);
      if (!draft.title)
        draft.title = `Use the ${this.screenName(draft.screenIds[0])} screen`;
      this.drafts.push(draft);
      added.push({ draft, rawDepends: p.dependsOn });
    }

    for (const { draft, rawDepends } of added) {
      for (const raw of rawDepends) this.addDependency(draft, raw);
    }
    return added.map((a) => a.draft);
  }

  private addDependency(draft: DraftUseCase, raw: string): void {
    const value = raw.trim();
    if (!value) return;
    const lockedId = this.pc.locked.find(
      (u) => u.id.toUpperCase() === value.toUpperCase(),
    )?.id;
    const target = lockedId ?? this.resolveKey(value);
    if (!target) {
      this.notes.push(
        `"${oneLine(draft.title, 60)}" depended on unknown use case "${value}" — removed the dependency.`,
      );
      return;
    }
    if (target === draft.key || draft.dependsOn.includes(target)) return;
    draft.dependsOn.push(target);
  }

  private screenName(screenId: string | undefined): string {
    return (
      this.pc.screens.find((s) => s.id === screenId)?.name ?? "application"
    );
  }

  /** screenIds/regionIds = the valid planned ones plus those of the elements, in screen order. */
  syncPlacement(
    draft: DraftUseCase,
    plannedScreens: readonly string[] = draft.screenIds,
    plannedRegions: readonly string[] = draft.regionIds,
  ): void {
    const screenOrder = new Map(this.pc.screens.map((s, i) => [s.id, i]));
    const screens = new Set<string>();
    for (const id of plannedScreens)
      if (screenOrder.has(id.trim())) screens.add(id.trim());
    const regions: string[] = [];
    for (const id of draft.elementIds) {
      const e = this.pc.elements.get(id);
      if (!e) continue;
      screens.add(e.screenId);
      if (this.pc.regions.has(e.regionId) && !regions.includes(e.regionId))
        regions.push(e.regionId);
    }
    for (const raw of plannedRegions) {
      const id = raw.trim();
      const region = this.pc.regions.get(id);
      if (region && screens.has(region.screenId) && !regions.includes(id))
        regions.push(id);
    }
    draft.screenIds = [...screens].sort(
      (a, b) => screenOrder.get(a)! - screenOrder.get(b)!,
    );
    draft.regionIds = regions;
  }

  /** Puts an element into a draft (assignment by the repair call or the deterministic fallback). */
  assign(elementId: string, key: string): boolean {
    const draft = this.draft(key);
    if (
      !draft ||
      !this.pc.elements.has(elementId) ||
      this.pc.lockedElementIds.has(elementId)
    )
      return false;
    if (!draft.elementIds.includes(elementId)) draft.elementIds.push(elementId);
    this.syncPlacement(draft);
    return true;
  }

  /** Removes drafts that cover nothing; their dependents inherit their dependencies so the chain survives. */
  dropEmptyDrafts(): void {
    for (const empty of this.drafts.filter((d) => !d.elementIds.length)) {
      this.notes.push(
        `Planned use case "${oneLine(empty.title, 60)}" covered no known elements — removed it.`,
      );
      const index = this.drafts.indexOf(empty);
      this.drafts.splice(index, 1);
      for (const d of this.drafts) {
        if (!d.dependsOn.includes(empty.key)) continue;
        d.dependsOn = [
          ...new Set(
            d.dependsOn.flatMap((k) =>
              k === empty.key ? empty.dependsOn : [k],
            ),
          ),
        ].filter((k) => k !== d.key);
      }
    }
  }

  coveredElementIds(): Set<string> {
    return new Set(this.drafts.flatMap((d) => d.elementIds));
  }

  uncovered(): UIElement[] {
    const covered = this.coveredElementIds();
    return elementsInReadingOrder(this.pc).filter(
      (e) => !covered.has(e.id) && !this.pc.lockedElementIds.has(e.id),
    );
  }

  /** Applies the coverage repair answer. Returns the number of elements it placed. */
  applyCoverageRepair(repair: CoverageRepairOutput): number {
    const before = this.uncovered().length;
    const uncovered = new Set(this.uncovered().map((e) => e.id));
    this.addFeatures(repair.newFeatures);
    for (const a of repair.assignments) {
      const id = a.elementId.trim();
      if (!uncovered.has(id)) continue;
      const key = this.resolveKey(a.useCaseKey);
      if (!key || !this.assign(id, key)) {
        this.notes.push(
          `Coverage repair assigned ${id} to unknown use case "${a.useCaseKey}" — ignored.`,
        );
      }
    }
    if (repair.newUseCases.length) this.addUseCases(repair.newUseCases);
    this.dropEmptyDrafts();
    return before - this.uncovered().length;
  }

  /**
   * Last resort: each still-uncovered element joins the use case covering most of its region; elements with
   * no such use case go into one generated "View <screen> layout and content" use case per screen.
   */
  applyCoverageFallback(): { assigned: number; created: DraftUseCase[] } {
    let assigned = 0;
    const leftovers = new Map<string, UIElement[]>();
    for (const e of this.uncovered()) {
      let best: DraftUseCase | undefined;
      let bestScore = 0;
      for (const d of this.drafts) {
        const score = d.elementIds.filter(
          (id) => this.pc.elements.get(id)?.regionId === e.regionId,
        ).length;
        if (score > bestScore) {
          best = d;
          bestScore = score;
        }
      }
      if (best && this.assign(e.id, best.key)) {
        assigned += 1;
        continue;
      }
      const list = leftovers.get(e.screenId) ?? [];
      list.push(e);
      leftovers.set(e.screenId, list);
    }

    const created: DraftUseCase[] = [];
    for (const screen of this.pc.screens) {
      const elements = leftovers.get(screen.id);
      if (!elements?.length) continue;
      created.push(this.layoutDraft(screen, elements));
    }
    return { assigned, created };
  }

  private layoutDraft(screen: Screen, elements: UIElement[]): DraftUseCase {
    const onScreen = this.drafts.filter((d) => d.screenIds.includes(screen.id));
    const predecessor =
      onScreen[0] ??
      this.drafts.find((d) =>
        d.elementIds.some(
          (id) => this.pc.elements.get(id)?.navigatesToScreenId === screen.id,
        ),
      );
    const featureCounts = new Map<string, number>();
    for (const d of onScreen)
      featureCounts.set(
        d.featureKey,
        (featureCounts.get(d.featureKey) ?? 0) + 1,
      );
    const featureKey =
      [...featureCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
      this.resolveFeature("");
    const shown = `The ${screen.name} screen is displayed`;
    const regionNames = [
      ...new Set(
        elements
          .map((e) => this.pc.regions.get(e.regionId)?.name)
          .filter(Boolean),
      ),
    ] as string[];
    const draft: DraftUseCase = {
      key: uniqueKey(kebab(`view-${screen.name}-layout`), this.keys, "-"),
      title: `View ${screen.name} layout and content`,
      featureKey,
      personaName: onScreen[0]?.personaName ?? "",
      screenIds: [screen.id],
      regionIds: [],
      elementIds: elements.map((e) => e.id),
      dependsOn: predecessor ? [predecessor.key] : [],
      size: sizeFor(elements.length),
      scope: `Static content and remaining elements of the ${screen.name} screen${regionNames.length ? ` (${regionNames.join(", ")})` : ""} that no other use case covers.`,
      preconditions: predecessor?.postconditions[0]
        ? dedupeText([predecessor.postconditions[0], shown])
        : [ENTRY_PRECONDITION, shown],
      postconditions: [`The ${screen.name} screen content is displayed`],
      planIndex: this.nextIndex++,
    };
    this.syncPlacement(draft);
    this.drafts.push(draft);
    this.notes.push(
      `Created "${draft.title}" for ${elements.length} element(s) no use case covered.`,
    );
    return draft;
  }
}

/* ── Graph helpers (pure) ───────────────────────────────────────────── */

export interface OrderNode {
  key: string;
  dependsOn: string[];
  planIndex: number;
  /** Position of the use case's earliest screen in the BA's order. */
  screenRank: number;
}

/**
 * Removes dependency edges until the graph is acyclic. In every cycle the edge that goes from the
 * latest-planned use case is dropped. Mutates `nodes`; returns plain-language notes.
 */
export function breakCycles(nodes: OrderNode[]): string[] {
  const notes: string[] = [];
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  for (;;) {
    const cycle = findCycle(nodes, byKey);
    if (!cycle) return notes;
    let victimIndex = 0;
    for (let i = 1; i < cycle.length; i += 1) {
      if (
        byKey.get(cycle[i])!.planIndex >
        byKey.get(cycle[victimIndex])!.planIndex
      )
        victimIndex = i;
    }
    const victim = byKey.get(cycle[victimIndex])!;
    const target = cycle[(victimIndex + 1) % cycle.length];
    victim.dependsOn = victim.dependsOn.filter((k) => k !== target);
    notes.push(
      `Removed the dependency of "${victim.key}" on "${target}" to break the cycle ${[...cycle, cycle[0]].join(" → ")}.`,
    );
  }
}

/** A cycle as [a, b, c] meaning a depends on b, b on c, c on a — or undefined. */
function findCycle(
  nodes: readonly OrderNode[],
  byKey: Map<string, OrderNode>,
): string[] | undefined {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (key: string): string[] | undefined => {
    state.set(key, "visiting");
    stack.push(key);
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      if (!byKey.has(dep)) continue;
      const s = state.get(dep);
      if (s === "visiting") return stack.slice(stack.indexOf(dep));
      if (!s) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(key, "done");
    return undefined;
  };
  for (const n of [...nodes].sort((a, b) => a.planIndex - b.planIndex)) {
    if (state.has(n.key)) continue;
    const found = visit(n.key);
    if (found) return found;
  }
  return undefined;
}

/**
 * Topological order (prerequisites first). Among the use cases that are ready, the one on the earliest screen
 * wins, then the earliest planned. Unknown dependencies are ignored; call breakCycles first.
 */
export function topoSort(nodes: readonly OrderNode[]): string[] {
  const keys = new Set(nodes.map((n) => n.key));
  const remaining = new Map(
    nodes.map((n) => [
      n.key,
      new Set(n.dependsOn.filter((d) => keys.has(d) && d !== n.key)),
    ]),
  );
  const placed: string[] = [];
  const done = new Set<string>();
  const compare = (a: OrderNode, b: OrderNode): number =>
    a.screenRank - b.screenRank || a.planIndex - b.planIndex;
  while (placed.length < nodes.length) {
    const ready = nodes.filter(
      (n) =>
        !done.has(n.key) &&
        [...remaining.get(n.key)!].every((d) => done.has(d)),
    );
    // A leftover cycle (breakCycles not called) must not hang the pipeline: take the best remaining node.
    const pool = ready.length ? ready : nodes.filter((n) => !done.has(n.key));
    const next = [...pool].sort(compare)[0];
    placed.push(next.key);
    done.add(next.key);
  }
  return placed;
}

/* ── Finalisation: ids, features, personas, chain ───────────────────── */

export interface FinalisePlanArgs {
  builder: PlanBuilder;
  personas: readonly Persona[];
  /** Features of the previous model that locked use cases point at (they keep their ids). */
  lockedFeatures: readonly FeatureGroup[];
  formatId: string;
  now?: string;
}

export interface PlanResult {
  /** In first-appearance order over the sorted use cases. */
  features: FeatureGroup[];
  /** Locked + newly planned use cases, sorted by `order`. */
  useCases: UseCase[];
  /** Ids of the newly planned stubs (the ones the Writer must fill). */
  newIds: string[];
  /** Plain-language notes about every repair made. */
  notes: string[];
}

function useCaseNumber(id: string): number {
  const m = /^UC-(\d+)$/i.exec(id);
  return m ? Number(m[1]) : 0;
}

function matchPersona(
  name: string,
  personas: readonly Persona[],
): Persona | undefined {
  if (!personas.length) return undefined;
  const n = normText(name);
  if (!n) return personas[0];
  return (
    personas.find((p) => normText(p.name) === n) ??
    personas.find(
      (p) => normText(p.name).includes(n) || n.includes(normText(p.name)),
    ) ??
    personas[0]
  );
}

/** Turns validated drafts into UseCase stubs with ids, order, features and a verified chain. */
export function finalisePlan(args: FinalisePlanArgs): PlanResult {
  const { builder, personas } = args;
  const { pc } = builder;
  const notes = [...builder.notes];
  const now = args.now ?? new Date().toISOString();
  const screenRank = new Map(pc.screens.map((s, i) => [s.id, i]));
  const rankOf = (screenIds: readonly string[]): number =>
    Math.min(
      ...screenIds.map((id) => screenRank.get(id) ?? Number.MAX_SAFE_INTEGER),
      Number.MAX_SAFE_INTEGER,
    );

  // Locked use cases keep their ids; dependencies on use cases that no longer exist are re-pointed to the
  // new use case whose postcondition they copy (the chain is about meaning), else dropped.
  const lockedIds = new Set(pc.locked.map((u) => u.id));
  const locked = pc.locked.map((u) => ({ ...u, dependsOn: [...u.dependsOn] }));
  for (const u of locked) {
    const next: string[] = [];
    for (const dep of u.dependsOn) {
      if (lockedIds.has(dep)) {
        next.push(dep);
        continue;
      }
      const first = u.preconditions[0];
      const replacement = first
        ? builder.drafts.find((d) =>
            d.postconditions.some((p) => sameText(p, first)),
          )
        : undefined;
      if (replacement) {
        next.push(replacement.key);
        notes.push(
          `${u.id} (kept as edited) depended on ${dep}, which was re-planned — it now depends on "${replacement.title}".`,
        );
      } else {
        notes.push(
          `${u.id} (kept as edited) depended on ${dep}, which no longer exists — removed the dependency.`,
        );
      }
    }
    u.dependsOn = [...new Set(next)];
  }

  const nodes: OrderNode[] = [
    ...locked.map((u) => ({
      key: u.id,
      dependsOn: u.dependsOn,
      planIndex: u.order - 1_000_000,
      screenRank: rankOf(u.screenIds),
    })),
    ...builder.drafts.map((d) => ({
      key: d.key,
      dependsOn: d.dependsOn,
      planIndex: d.planIndex,
      screenRank: rankOf(d.screenIds),
    })),
  ];
  notes.push(...breakCycles(nodes));
  const nodeByKey = new Map(nodes.map((n) => [n.key, n]));
  const sorted = topoSort(nodes);

  // Ids: new use cases continue after the highest locked id, in build order.
  let nextNumber = Math.max(0, ...locked.map((u) => useCaseNumber(u.id))) + 1;
  const idOf = new Map<string, string>();
  for (const u of locked) idOf.set(u.id, u.id);
  for (const key of sorted) {
    if (!idOf.has(key)) idOf.set(key, formatUseCaseId(nextNumber++));
  }

  // Features: locked ones keep their ids; planned ones get FEAT-xx in first-appearance order.
  const featureById = new Map<string, FeatureGroup>();
  const lockedFeatureIds = new Set(locked.map((u) => u.featureId));
  for (const f of args.lockedFeatures) {
    if (lockedFeatureIds.has(f.id))
      featureById.set(f.id, {
        id: f.id,
        name: f.name,
        description: f.description,
        useCaseIds: [],
      });
  }
  for (const id of lockedFeatureIds) {
    // A kept use case must never point at a feature that is not in the model.
    if (id && !featureById.has(id))
      featureById.set(id, {
        id,
        name: "Previously specified",
        description: "Use cases kept from an earlier generation.",
        useCaseIds: [],
      });
  }
  const takenFeatureIds = new Set(featureById.keys());
  let nextFeature = 1;
  const newFeatureId = (): string => {
    let id: string;
    do {
      id = `FEAT-${String(nextFeature++).padStart(2, "0")}`;
    } while (takenFeatureIds.has(id));
    takenFeatureIds.add(id);
    return id;
  };
  const featureIdOfKey = new Map<string, string>();
  const featureFor = (key: string): string => {
    const known = featureIdOfKey.get(key);
    if (known) return known;
    const draftFeature = builder.features.find((f) => f.key === key) ?? {
      key,
      name: titleCase(key.replace(/-/g, " ")),
      description: "",
    };
    const same = [...featureById.values()].find((f) =>
      sameText(f.name, draftFeature.name),
    );
    const id = same?.id ?? newFeatureId();
    if (!same)
      featureById.set(id, {
        id,
        name: draftFeature.name,
        description: draftFeature.description,
        useCaseIds: [],
      });
    featureIdOfKey.set(key, id);
    return id;
  };

  const lockedById = new Map(locked.map((u) => [u.id, u]));
  const draftByKey = new Map(builder.drafts.map((d) => [d.key, d]));
  const useCases: UseCase[] = [];
  const newIds: string[] = [];
  sorted.forEach((key, index) => {
    const order = index + 1;
    const dependsOn = (nodeByKey.get(key)?.dependsOn ?? [])
      .map((k) => idOf.get(k))
      .filter((id): id is string => Boolean(id));
    const lockedUc = lockedById.get(key);
    if (lockedUc) {
      useCases.push({ ...lockedUc, order, dependsOn });
      return;
    }
    const d = draftByKey.get(key)!;
    const id = idOf.get(key)!;
    const persona = matchPersona(d.personaName, personas);
    useCases.push({
      id,
      slug: slugify(d.title, 50),
      title: d.title,
      formatId: args.formatId,
      featureId: featureFor(d.featureKey),
      personaId: persona?.id ?? "",
      screenIds: d.screenIds,
      regionIds: d.regionIds,
      elementIds: d.elementIds,
      dependsOn,
      order,
      size: d.size,
      scope:
        d.scope ||
        `${
          d.regionIds
            .map((r) => pc.regions.get(r)?.name)
            .filter(Boolean)
            .join(", ") || "Content"
        } on the ${d.screenIds
          .map((s) => pc.screens.find((x) => x.id === s)?.name)
          .filter(Boolean)
          .join(", ")} screen.`,
      story: {
        asA: persona?.name.toLowerCase() ?? "user",
        iWant: "",
        soThat: "",
      },
      preconditions: d.preconditions,
      postconditions: d.postconditions.length
        ? d.postconditions
        : [`The "${d.title}" step is completed`],
      businessRules: [],
      scenarios: [],
      assumptions: [],
      openQuestions: [],
      notes: "",
      status: "generated",
      revision: 1,
      updatedAt: now,
      external: [],
    });
    newIds.push(id);
  });

  // Chain: every dependent use case's first precondition is a verbatim postcondition of a predecessor.
  const byId = new Map(useCases.map((u) => [u.id, u]));
  for (const uc of useCases) {
    if (lockedIds.has(uc.id)) continue;
    const preds = uc.dependsOn
      .map((id) => byId.get(id))
      .filter((u): u is UseCase => Boolean(u));
    const repaired = repairChain(uc.preconditions, preds);
    if (repaired.change)
      notes.push(`${uc.id} "${oneLine(uc.title, 60)}": ${repaired.change}.`);
    uc.preconditions = repaired.preconditions;
  }

  // Features in first-appearance order; each lists its use cases in build order.
  const features: FeatureGroup[] = [];
  for (const uc of useCases) {
    const f = featureById.get(uc.featureId);
    if (!f) continue;
    if (!features.includes(f)) features.push(f);
    f.useCaseIds.push(uc.id);
  }
  return { features, useCases, newIds, notes };
}

/* ── Agent calls ────────────────────────────────────────────────────── */

export interface PlanUseCasesArgs {
  ctx: JobContext;
  project: Project;
  analyses: readonly ScreenAnalysis[];
  journey: JourneyResult;
  connection: LLMConnection;
  granularity: Granularity;
  locked: readonly UseCase[];
  lockedFeatures: readonly FeatureGroup[];
  formatId: string;
}

function lockedBlock(
  locked: readonly UseCase[],
  features: readonly FeatureGroup[],
): string {
  if (!locked.length) return "";
  const lines = [
    "# Already specified use cases (LOCKED — do not re-plan their elements; new use cases may depend on them by id)",
  ];
  for (const u of locked) {
    const feature =
      features.find((f) => f.id === u.featureId)?.name ?? u.featureId;
    lines.push(
      `- ${u.id} "${u.title}" · feature "${feature}" · elements: ${u.elementIds.join(", ") || "(none)"}`,
    );
    lines.push(
      `  postconditions: ${u.postconditions.map((p) => JSON.stringify(p)).join("; ") || "(none)"}`,
    );
  }
  return lines.join("\n");
}

function dataEntitiesBlock(journey: JourneyResult): string {
  if (!journey.dataEntities.length) return "";
  return [
    "Data entities:",
    ...journey.dataEntities.map(
      (d) =>
        `- ${d.name}${d.description ? `: ${oneLine(d.description, 120)}` : ""}${d.fields.length ? ` Fields: ${d.fields.join(", ")}` : ""}`,
    ),
  ].join("\n");
}

function plannerContent(args: PlanUseCasesArgs, pc: PlanContext): string {
  const toCover = elementsInReadingOrder(pc).filter(
    (e) => !pc.lockedElementIds.has(e.id),
  ).length;
  const order = args.journey.journeyOrder
    .map((id) => pc.screens.find((s) => s.id === id)?.name)
    .filter(Boolean);
  return [
    "# Journey",
    args.journey.summary,
    order.length ? `Journey order: ${order.join(" → ")}` : "",
    "",
    personasBlock(args.journey.personas),
    "",
    flowsBlock(args.journey.flows, pc.screens),
    "",
    dataEntitiesBlock(args.journey),
    "",
    "# Element inventory (screens → regions → elements)",
    compactInventoryBlock(pc.analyses, pc.screens),
    "",
    lockedBlock(args.locked, args.lockedFeatures),
    "",
    `Plan the features and use cases. ${toCover} element ids must be covered (every element id above${pc.lockedElementIds.size ? " that is not owned by a locked use case" : ""}). Use only ids from the inventory; personaName must be one of: ${args.journey.personas.map((p) => `"${p.name}"`).join(", ")}.`,
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}

function repairContent(
  builder: PlanBuilder,
  uncovered: readonly UIElement[],
): string {
  const { pc } = builder;
  const screensById = new Map(pc.screens.map((s) => [s.id, s]));
  return [
    "# Current plan",
    ...builder.drafts.map(
      (d) =>
        `- key=${d.key} · "${d.title}" · screens: ${d.screenIds.map((s) => screensById.get(s)?.name ?? s).join(", ")} · regions: ${d.regionIds.join(", ") || "(none)"} · ${d.elementIds.length} elements · first postcondition: ${JSON.stringify(d.postconditions[0] ?? "")}`,
    ),
    "",
    `Features: ${builder.features.map((f) => `${f.key} ("${f.name}")`).join(", ")}`,
    "",
    `# Uncovered elements (${uncovered.length})`,
    ...uncovered.map(
      (e) =>
        `- ${compactElementLine(e, screensById)} · region ${e.regionId} ("${pc.regions.get(e.regionId)?.name ?? ""}") · screen "${screensById.get(e.screenId)?.name ?? e.screenId}"`,
    ),
    "",
    "Assign every uncovered element to an existing use case key, or create new use cases for elements that form their own user goal.",
  ].join("\n");
}

export async function planUseCases(
  args: PlanUseCasesArgs,
): Promise<PlanResult> {
  const { ctx, project, analyses, connection, granularity } = args;
  const pc = buildPlanContext(project, analyses, args.locked);
  const offlinePlan = (): PlanOutput =>
    mockPlan({
      project,
      analyses,
      personaNames: args.journey.personas.map((p) => p.name),
      granularity,
      locked: args.locked,
    });

  let plan: PlanOutput;
  try {
    const batches = await capacityBatches(
      analyses,
      (subset) =>
        generateStructured({
          ...callBase(ctx, connection, "use-case-plan"),
          system: plannerSystem(project, granularity),
          content: [
            {
              type: "text",
              text: plannerContent(
                { ...args, analyses: subset },
                buildPlanContext(project, subset, args.locked),
              ),
            },
          ],
          schema: PlanOutputSchema,
          schemaName: "use_case_plan",
          mock: offlinePlan,
        }),
      ctx.signal,
      (message) => ctx.warn(message),
    );
    plan =
      batches.length === 1
        ? batches[0]
        : {
            features: batches.flatMap((b, i) =>
              b.features.map((f) => ({ ...f, key: "batch" + i + "_" + f.key })),
            ),
            useCases: batches.flatMap((b, i) =>
              b.useCases.map((u) => ({
                ...u,
                key: "batch" + i + "_" + u.key,
                featureKey: "batch" + i + "_" + u.featureKey,
                dependsOn: u.dependsOn.map((k) =>
                  b.useCases.some((x) => x.key === k)
                    ? "batch" + i + "_" + k
                    : k,
                ),
              })),
            ),
          };
  } catch (err) {
    if (err instanceof CancelledError || ctx.signal.aborted || stopsTheRun(err))
      throw err;
    // The screens are already read (and paid for): a plan from the inventory beats failing the whole run.
    ctx.warn(
      `The Planner agent failed (${errorMessage(err)}) — planned the use cases from the screen inventory instead. Check the plan, or generate again when the AI connection works.`,
    );
    plan = offlinePlan();
  }

  const builder = new PlanBuilder(pc);
  builder.addFeatures(plan.features);
  builder.addUseCases(plan.useCases);
  builder.dropEmptyDrafts();

  const missing = builder.uncovered();
  if (missing.length) {
    ctx.info(
      `The plan left ${missing.length} element(s) uncovered — asking the planner to place them.`,
    );
    try {
      const repair = await generateStructured({
        ...callBase(ctx, connection, "use-case-plan-coverage"),
        system: coverageRepairSystem(project, granularity),
        content: [
          {
            type: "text",
            text: `${plannerContent(args, pc)}\n\n${repairContent(builder, missing)}`,
          },
        ],
        schema: CoverageRepairOutputSchema,
        schemaName: "coverage_repair",
        mock: () => mockCoverageRepair(builder.drafts, missing, pc.elements),
      });
      const placed = builder.applyCoverageRepair(repair);
      if (placed)
        ctx.log("debug", `Coverage repair placed ${placed} element(s).`);
    } catch (err) {
      if (
        err instanceof CancelledError ||
        ctx.signal.aborted ||
        stopsTheRun(err)
      )
        throw err;
      ctx.warn(
        `The coverage repair call failed (${errorMessage(err)}) — placing the remaining elements automatically.`,
      );
    }
    const remaining = builder.uncovered();
    if (remaining.length) {
      const { assigned, created } = builder.applyCoverageFallback();
      ctx.info(
        `Placed ${remaining.length} remaining element(s) automatically (${assigned} into existing use cases${created.length ? `, ${created.length} layout use case(s) created` : ""}).`,
      );
    }
  }

  if (!builder.drafts.length && !args.locked.length) {
    // Nothing usable came back (e.g. screens without elements): fall back to one layout use case per screen.
    builder.applyCoverageFallback();
  }

  const result = finalisePlan({
    builder,
    personas: args.journey.personas,
    lockedFeatures: args.lockedFeatures,
    formatId: args.formatId,
  });
  for (const note of result.notes) ctx.log("debug", note);
  return result;
}
