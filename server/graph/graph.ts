/**
 * OWNER: graph builder.
 * The solution knowledge graph is DERIVED from the SolutionModel (never edited directly), so it is always
 * consistent with the .md files once they are synced. Deterministic traversal powers instant impact previews.
 */
import type {
  ChangeRequest,
  DeterministicImpact,
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  SolutionGraph,
  SolutionModel,
} from "@shared/types";
import { ruleNodeId, scenarioNodeId } from "@shared/types";
import { BadRequestError } from "../errors";
import {
  indexModel,
  normaliseChildId,
  normaliseUseCaseId,
  splitNamespacedId,
  type ModelIndex,
} from "./modelIndex";
import {
  elementDisplayLabel,
  elementName,
  keywordTokens,
  truncate,
} from "./text";

/* ------------------------------------------------------------------ */
/* Graph construction                                                  */
/* ------------------------------------------------------------------ */

/**
 * Graph node id of a region. Region and element ids share the "<screenKey>.<key>" namespace, so a region
 * whose id equals an element id (e.g. a "form" region holding a "form" element) gets a suffix to keep
 * node ids unique. Element ids are never altered — they are what change requests and links use.
 */
export function regionNodeId(ix: ModelIndex, regionId: string): string {
  return ix.elementById.has(regionId) ? `${regionId}#region` : regionId;
}

/** Inverse of regionNodeId: accepts either form. */
function regionIdFromNodeId(nodeId: string): string {
  return nodeId.endsWith("#region")
    ? nodeId.slice(0, -"#region".length)
    : nodeId;
}

function edgeId(kind: GraphEdgeKind, from: string, to: string): string {
  return `e-${kind}-${from}-${to}`;
}

function buildGraphFromIndex(ix: ModelIndex): SolutionGraph {
  const { model } = ix;
  const nodes: GraphNode[] = [];
  const nodeIds = new Set<string>();
  const addNode = (node: GraphNode) => {
    if (nodeIds.has(node.id)) return;
    nodeIds.add(node.id);
    nodes.push(node);
  };
  const candidateEdges: GraphEdge[] = [];
  const addEdge = (
    kind: GraphEdgeKind,
    from: string | undefined,
    to: string | undefined,
    label?: string,
  ) => {
    if (!from || !to || from === to) return;
    candidateEdges.push({
      id: edgeId(kind, from, to),
      from,
      to,
      kind,
      ...(label ? { label } : {}),
    });
  };

  const featureById = new Map(model.features.map((f) => [f.id, f]));
  const screenTitle = (screenId: string) =>
    ix.screenById.get(screenId)?.title ?? screenId;

  // Features
  for (const f of model.features) {
    const ucIds = ix.sortUseCases([
      ...f.useCaseIds.filter((id) => ix.useCaseById.has(id)),
      ...ix.useCases.filter((uc) => uc.featureId === f.id).map((uc) => uc.id),
    ]);
    addNode({
      id: f.id,
      kind: "feature",
      label: f.name || f.id,
      meta: {
        featureId: f.id,
        description: f.description,
        useCaseCount: ucIds.length,
        useCaseIds: ucIds,
      },
    });
    for (const ucId of ucIds) addEdge("groups", f.id, ucId);
  }

  // Personas
  for (const p of model.personas) {
    const ucIds = ix.useCases
      .filter((uc) => uc.personaId === p.id)
      .map((uc) => uc.id);
    addNode({
      id: p.id,
      kind: "persona",
      label: p.name || p.id,
      meta: {
        description: p.description,
        goals: p.goals,
        useCaseCount: ucIds.length,
        useCaseIds: ucIds,
      },
    });
  }

  // Use cases (+ their rules and scenarios)
  for (const uc of ix.useCases) {
    const feature = featureById.get(uc.featureId);
    const persona = ix.personaById.get(uc.personaId);
    const screens = ix.useCaseScreens.get(uc.id) ?? [];
    addNode({
      id: uc.id,
      kind: "usecase",
      label: `${uc.id} · ${uc.title}`,
      meta: {
        title: uc.title,
        status: uc.status,
        size: uc.size,
        order: uc.order,
        revision: uc.revision,
        featureId: uc.featureId,
        feature: feature?.name,
        personaId: uc.personaId,
        persona: persona?.name,
        screenIds: screens,
        screens: screens.map(screenTitle),
        elementCount: uc.elementIds.length,
        ruleCount: uc.businessRules.length,
        scenarioCount: uc.scenarios.length,
        dependsOn: uc.dependsOn.filter((id) => ix.useCaseById.has(id)),
        leadsTo: ix.dependents.get(uc.id) ?? [],
        filePath: uc.filePath,
        staleReason: uc.staleReason,
        exportedTo: uc.external.map((x) => `${x.system}:${x.key}`),
        updatedAt: uc.updatedAt,
      },
    });
    if (feature && !feature.useCaseIds.includes(uc.id))
      addEdge("groups", feature.id, uc.id);
    if (persona) addEdge("performed_by", uc.id, persona.id);
    for (const sid of screens) addEdge("appears_on", uc.id, sid);
    for (const elId of uc.elementIds) addEdge("covers", uc.id, elId);
    for (const dep of uc.dependsOn) addEdge("depends_on", uc.id, dep);

    for (const rule of uc.businessRules) {
      const id = ruleNodeId(uc.id, rule.id);
      addNode({
        id,
        kind: "rule",
        label: `${rule.id} · ${truncate(rule.element || rule.elementType, 80)}`,
        meta: {
          useCaseId: uc.id,
          ruleId: rule.id,
          element: rule.element,
          elementId: rule.elementId,
          elementType: rule.elementType,
          description: rule.description,
          ruleCount: rule.rules.length,
        },
      });
      addEdge("contains", uc.id, id);
      if (rule.elementId) addEdge("governs", id, rule.elementId);
    }
    for (const sc of uc.scenarios) {
      const id = scenarioNodeId(uc.id, sc.id);
      addNode({
        id,
        kind: "scenario",
        label: `${sc.id} · ${truncate(sc.title, 80)}`,
        meta: {
          useCaseId: uc.id,
          scenarioId: sc.id,
          title: sc.title,
          type: sc.type,
          stepCount: sc.given.length + sc.when.length + sc.then.length,
          elementIds: sc.elementIds,
        },
      });
      addEdge("contains", uc.id, id);
      for (const elId of sc.elementIds) addEdge("exercises", id, elId);
    }
  }

  // Screens, regions, elements
  for (const s of ix.screenById.values()) {
    const ucIds = ix.screenUseCases.get(s.screenId) ?? [];
    addNode({
      id: s.screenId,
      kind: "screen",
      label: s.title || s.screenKey || s.screenId,
      meta: {
        screenKey: s.screenKey,
        screenType: s.screenType,
        version: s.screenVersion,
        purpose: s.purpose,
        regionCount: s.regions.length,
        elementCount: s.elements.length,
        useCaseCount: ucIds.length,
        useCaseIds: ucIds,
      },
    });
    for (const r of s.regions) {
      if (ix.regionById.get(r.id) !== r) continue; // duplicate id elsewhere — first wins
      const rid = regionNodeId(ix, r.id);
      const elementCount = new Set([
        ...r.elementIds,
        ...s.elements.filter((el) => el.regionId === r.id).map((el) => el.id),
      ]).size;
      addNode({
        id: rid,
        kind: "region",
        label: r.name || r.key,
        meta: {
          regionId: r.id,
          screenId: s.screenId,
          screen: s.title,
          purpose: r.purpose,
          layout: r.layout,
          elementCount,
        },
      });
      addEdge("contains", s.screenId, rid);
      for (const elId of r.elementIds) addEdge("contains", rid, elId);
    }
    for (const el of s.elements) {
      if (ix.elementById.get(el.id) !== el) continue;
      const covering = ix.coveringUseCases.get(el.id) ?? [];
      const region = ix.regionById.get(el.regionId);
      addNode({
        id: el.id,
        kind: "element",
        label: elementDisplayLabel(el),
        meta: {
          name: elementName(el),
          type: el.type,
          key: el.key,
          screenId: s.screenId,
          screen: s.title,
          regionId: el.regionId,
          region: region?.name,
          required: el.required,
          optionCount: el.options?.length,
          navigatesToScreenId: el.navigatesToScreenId,
          covered: covering.length > 0,
          useCaseIds: covering,
        },
      });
      if (region && region.screenId === s.screenId)
        addEdge("contains", regionNodeId(ix, region.id), el.id);
      else addEdge("contains", s.screenId, el.id); // keep orphan elements attached to their screen
      if (el.navigatesToScreenId && el.navigatesToScreenId !== s.screenId) {
        addEdge(
          "navigates_to",
          el.id,
          el.navigatesToScreenId,
          el.label ? truncate(el.label, 60) : undefined,
        );
      }
    }
  }

  // Screen-to-screen journeys
  for (const flow of model.flows) {
    addEdge(
      "navigates_to",
      flow.fromScreenId,
      flow.toScreenId,
      flow.trigger ? truncate(flow.trigger, 80) : undefined,
    );
  }

  // Only edges whose endpoints exist (no dangling references), first occurrence of each id wins.
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const e of candidateEdges) {
    if (seen.has(e.id) || !nodeIds.has(e.from) || !nodeIds.has(e.to)) continue;
    seen.add(e.id);
    edges.push(e);
  }
  return { nodes, edges };
}

export function buildGraph(model: SolutionModel): SolutionGraph {
  return buildGraphFromIndex(indexModel(model));
}

/* ------------------------------------------------------------------ */
/* Impact trace                                                        */
/* ------------------------------------------------------------------ */

interface Seeds {
  /** Graph node ids, in display order. */
  seedNodeIds: string[];
  /** BFS start order (most specific first, so paths prefer element-level explanations). */
  bfsOrder: string[];
  direct: string[];
  affectedElementIds: string[];
  affectedScreenIds: string[];
}

function notInModel(what: string): BadRequestError {
  return new BadRequestError(
    `${what} is not part of the current specification. Refresh the page (the specs may have been regenerated) and pick it again.`,
  );
}

function requireTarget(change: ChangeRequest): string {
  const id = change.targetId?.trim();
  if (!id) {
    throw new BadRequestError(
      `Choose the ${change.targetKind === "usecase" ? "use case" : change.targetKind} that is changing, or describe the change as free text.`,
    );
  }
  return id;
}

function uniq<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

/**
 * Picks the use case that should own an element newly added to a region: the one covering most of the
 * region's existing elements (ties → build order), else one that lists the region. Shared with apply.
 */
export function ownerForRegion(
  ix: ModelIndex,
  regionId: string | undefined,
): string | undefined {
  if (!regionId) return undefined;
  const region = ix.regionById.get(regionId);
  const regionEls = new Set([
    ...(region?.elementIds ?? []),
    ...[...ix.elementById.values()]
      .filter((el) => el.regionId === regionId)
      .map((el) => el.id),
  ]);
  let best: string | undefined;
  let bestCount = 0;
  for (const uc of ix.useCases) {
    const els = ix.useCaseElements.get(uc.id) ?? [];
    const count = els.filter((id) => regionEls.has(id)).length;
    if (count > bestCount) {
      best = uc.id;
      bestCount = count;
    }
  }
  if (best) return best;
  return ix.useCases.find((uc) => uc.regionIds.includes(regionId))?.id;
}

/** The use case covering most elements of a screen (ties → build order), else the first appearing on it. */
export function ownerForScreen(
  ix: ModelIndex,
  screenId: string,
): string | undefined {
  const screen = ix.screenById.get(screenId);
  const screenEls = new Set(screen?.elements.map((el) => el.id) ?? []);
  let best: string | undefined;
  let bestCount = 0;
  for (const uc of ix.useCases) {
    const count = (ix.useCaseElements.get(uc.id) ?? []).filter((id) =>
      screenEls.has(id),
    ).length;
    if (count > bestCount) {
      best = uc.id;
      bestCount = count;
    }
  }
  return best ?? ix.screenUseCases.get(screenId)?.[0];
}

interface FreeTextMatch {
  elementIds: string[];
  useCaseIds: string[];
  /** [useCaseId, ruleId] */
  rules: [string, string][];
}

/**
 * Keyword match of a free-text change over element labels (+ keys and options), use case titles and
 * business rule text. Tokens are weighted by rarity (idf) so "password" outranks "email" in a spec where
 * every form has an email field; only candidates close to the best score per kind are kept.
 */
export function matchFreeText(ix: ModelIndex, text: string): FreeTextMatch {
  const result: FreeTextMatch = { elementIds: [], useCaseIds: [], rules: [] };

  // Explicit references win: "UC-003", "UC-003/BR-02", "login.email". They are cut out of the text so
  // their parts ("orders" in "orders.status") do not count again as keywords.
  let rest = text.replace(
    /\bUC[-_ ]?\d{1,4}(?:\/(?:BR|SC)[-_ ]?\d{1,3})?\b/gi,
    (ref) => {
      const ucId = normaliseUseCaseId(ref);
      if (!ucId || !ix.useCaseById.has(ucId)) return ref;
      const ruleId = /\/BR/i.test(ref)
        ? normaliseChildId(ref.split("/")[1], "BR")
        : undefined;
      if (ruleId && ix.rule(ucId, ruleId)) result.rules.push([ucId, ruleId]);
      else result.useCaseIds.push(ucId);
      return " ";
    },
  );
  rest = rest.replace(/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/g, (ref) => {
    const found = ix.elementById.has(ref)
      ? ref
      : ix.elementById.has(ref.toLowerCase())
        ? ref.toLowerCase()
        : undefined;
    if (!found) return ref;
    result.elementIds.push(found);
    return " ";
  });

  const query = new Set(keywordTokens(rest));
  if (query.size > 0) {
    type Candidate = {
      kind: "element" | "usecase" | "rule";
      ref: string | [string, string];
      tokens: Set<string>;
    };
    const candidates: Candidate[] = [];
    for (const el of ix.elementById.values()) {
      const elText = [
        el.label,
        el.key.replace(/[_-]+/g, " "),
        ...(el.options ?? []),
      ].join(" ");
      candidates.push({
        kind: "element",
        ref: el.id,
        tokens: new Set(keywordTokens(elText)),
      });
    }
    for (const uc of ix.useCases) {
      candidates.push({
        kind: "usecase",
        ref: uc.id,
        tokens: new Set(keywordTokens(uc.title)),
      });
      for (const r of uc.businessRules) {
        const ruleText = [r.element, r.description, ...r.rules].join(" ");
        candidates.push({
          kind: "rule",
          ref: [uc.id, r.id],
          tokens: new Set(keywordTokens(ruleText)),
        });
      }
    }
    const df = new Map<string, number>();
    for (const c of candidates)
      for (const t of c.tokens)
        if (query.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
    const n = Math.max(1, candidates.length);
    // Numbers ("12") only support a match made by a word — on their own they would match any limit.
    const scored = candidates
      .map((c, i) => {
        let words = 0;
        let numbers = 0;
        for (const t of c.tokens) {
          if (!query.has(t)) continue;
          const idf = Math.log(1 + n / (df.get(t) ?? 1));
          if (/^\d+$/.test(t)) numbers += idf / 2;
          else words += idf;
        }
        return { c, i, score: words > 0 ? words + numbers : 0 };
      })
      .filter((s) => s.score > 0);
    const globalBest = Math.max(0, ...scored.map((s) => s.score));
    const caps = { element: 12, usecase: 8, rule: 12 } as const;
    for (const kind of ["element", "usecase", "rule"] as const) {
      const ofKind = scored.filter((s) => s.c.kind === kind);
      const best = Math.max(0, ...ofKind.map((s) => s.score));
      const kept = ofKind
        .filter((s) => s.score >= 0.6 * best && s.score >= 0.35 * globalBest)
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .slice(0, caps[kind]);
      for (const s of kept) {
        if (kind === "element") result.elementIds.push(s.c.ref as string);
        else if (kind === "usecase") result.useCaseIds.push(s.c.ref as string);
        else result.rules.push(s.c.ref as [string, string]);
      }
    }
  }

  result.elementIds = ix.sortElements(result.elementIds);
  result.useCaseIds = ix.sortUseCases(result.useCaseIds);
  const seenRules = new Set<string>();
  result.rules = result.rules
    .filter(([uc, r]) => {
      const key = `${uc}/${r}`;
      if (seenRules.has(key)) return false;
      seenRules.add(key);
      return true;
    })
    .sort((a, b) => ix.compareUseCases(a[0], b[0]) || a[1].localeCompare(b[1]));
  return result;
}

function resolveSeeds(ix: ModelIndex, change: ChangeRequest): Seeds {
  const covering = (ids: Iterable<string>) =>
    ix.sortUseCases(
      [...ids].flatMap((id) => ix.coveringUseCases.get(id) ?? []),
    );
  const screensOfElements = (ids: Iterable<string>) =>
    [...ids]
      .map((id) => ix.elementById.get(id)?.screenId)
      .filter((s): s is string => !!s);

  switch (change.targetKind) {
    case "element": {
      const id = requireTarget(change);
      const el = ix.elementById.get(id);
      if (!el) throw notInModel(`The element "${id}"`);
      return {
        seedNodeIds: [el.id],
        bfsOrder: [el.id],
        direct: covering([el.id]),
        affectedElementIds: [el.id],
        affectedScreenIds: [el.screenId],
      };
    }
    case "screen": {
      const id = requireTarget(change);
      const screen = ix.screenById.get(id) ?? ix.screenByKey.get(id);
      if (!screen) throw notInModel(`The screen "${id}"`);
      const diff = change.screenDiff;
      if (!diff) {
        return {
          seedNodeIds: [screen.screenId],
          bfsOrder: [screen.screenId],
          direct: ix.screenUseCases.get(screen.screenId) ?? [],
          affectedElementIds: [],
          affectedScreenIds: [screen.screenId],
        };
      }
      // A replaced image: only use cases touching what actually changed are direct; the rest of the
      // screen's use cases become 'related' (they share the screen).
      const changed = ix.sortElements(
        [
          ...diff.removed.map((e) => e.id),
          ...diff.modified.map((m) => m.before.id),
        ].filter((id) => ix.elementById.has(id)),
      );
      const direct = new Set(covering(changed));
      for (const added of diff.added) {
        const owner =
          ownerForRegion(ix, added.regionId) ??
          ownerForScreen(ix, screen.screenId);
        if (owner) direct.add(owner);
      }
      return {
        seedNodeIds: [screen.screenId, ...changed],
        bfsOrder: [...changed, screen.screenId],
        direct: ix.sortUseCases(direct),
        affectedElementIds: changed,
        affectedScreenIds: [screen.screenId],
      };
    }
    case "region": {
      const raw = requireTarget(change);
      const region = ix.regionById.get(regionIdFromNodeId(raw));
      if (!region) throw notInModel(`The region "${raw}"`);
      const els = ix.sortElements([
        ...region.elementIds.filter((id) => ix.elementById.has(id)),
        ...[...ix.elementById.values()]
          .filter((el) => el.regionId === region.id)
          .map((el) => el.id),
      ]);
      const direct = ix.sortUseCases([
        ...ix.useCases
          .filter((uc) => uc.regionIds.includes(region.id))
          .map((uc) => uc.id),
        ...covering(els),
      ]);
      const nodeId = regionNodeId(ix, region.id);
      return {
        seedNodeIds: [nodeId],
        bfsOrder: [nodeId],
        direct,
        affectedElementIds: els,
        affectedScreenIds: [region.screenId],
      };
    }
    case "usecase": {
      const raw = requireTarget(change);
      const id = ix.useCaseById.has(raw) ? raw : normaliseUseCaseId(raw);
      const uc = id ? ix.useCaseById.get(id) : undefined;
      if (!uc) throw notInModel(`Use case "${raw}"`);
      return {
        seedNodeIds: [uc.id],
        bfsOrder: [uc.id],
        direct: [uc.id],
        affectedElementIds: ix.sortElements(
          (ix.useCaseElements.get(uc.id) ?? []).filter((e) =>
            ix.elementById.has(e),
          ),
        ),
        affectedScreenIds: ix.useCaseScreens.get(uc.id) ?? [],
      };
    }
    case "rule":
    case "scenario": {
      const raw = requireTarget(change);
      const parts = splitNamespacedId(raw);
      const prefix = change.targetKind === "rule" ? "BR" : "SC";
      const example =
        change.targetKind === "rule" ? "UC-003/BR-02" : "UC-003/SC-01";
      if (!parts)
        throw new BadRequestError(
          `"${raw}" is not a ${change.targetKind} id — expected something like ${example}.`,
        );
      const ucId = ix.useCaseById.has(parts.useCaseId)
        ? parts.useCaseId
        : normaliseUseCaseId(parts.useCaseId);
      const uc = ucId ? ix.useCaseById.get(ucId) : undefined;
      if (!uc) throw notInModel(`Use case "${parts.useCaseId}"`);
      const childNorm = normaliseChildId(parts.childId, prefix);
      if (change.targetKind === "rule") {
        const rule =
          uc.businessRules.find((r) => r.id === parts.childId) ??
          uc.businessRules.find(
            (r) => normaliseChildId(r.id, "BR") === childNorm,
          );
        if (!rule)
          throw notInModel(`Business rule ${parts.childId} of ${uc.id}`);
        const els =
          rule.elementId && ix.elementById.has(rule.elementId)
            ? [rule.elementId]
            : [];
        const nodeId = ruleNodeId(uc.id, rule.id);
        return {
          seedNodeIds: [nodeId],
          bfsOrder: [nodeId],
          direct: [uc.id],
          affectedElementIds: els,
          affectedScreenIds: els.length
            ? screensOfElements(els)
            : (ix.useCaseScreens.get(uc.id) ?? []),
        };
      }
      const sc =
        uc.scenarios.find((s) => s.id === parts.childId) ??
        uc.scenarios.find((s) => normaliseChildId(s.id, "SC") === childNorm);
      if (!sc) throw notInModel(`Scenario ${parts.childId} of ${uc.id}`);
      const els = ix.sortElements(
        sc.elementIds.filter((id) => ix.elementById.has(id)),
      );
      const nodeId = scenarioNodeId(uc.id, sc.id);
      return {
        seedNodeIds: [nodeId],
        bfsOrder: [nodeId],
        direct: [uc.id],
        affectedElementIds: els,
        affectedScreenIds: els.length
          ? screensOfElements(els)
          : (ix.useCaseScreens.get(uc.id) ?? []),
      };
    }
    case "feature": {
      const id = requireTarget(change);
      const feature = ix.model.features.find((f) => f.id === id);
      if (!feature) throw notInModel(`The feature "${id}"`);
      const direct = ix.sortUseCases(
        ix.useCases.filter((u) => u.featureId === id).map((u) => u.id),
      );
      return {
        seedNodeIds: [id],
        bfsOrder: [id],
        direct,
        affectedElementIds: [],
        affectedScreenIds: direct.flatMap(
          (ucId) => ix.useCaseScreens.get(ucId) ?? [],
        ),
      };
    }
    case "persona": {
      const raw = requireTarget(change);
      const persona =
        ix.personaById.get(raw) ??
        ix.model.personas.find(
          (p) => p.name.trim().toLowerCase() === raw.toLowerCase(),
        );
      if (!persona) throw notInModel(`The persona "${raw}"`);
      const direct = ix.useCases
        .filter((uc) => uc.personaId === persona.id)
        .map((uc) => uc.id);
      return {
        seedNodeIds: [persona.id],
        bfsOrder: [persona.id],
        direct,
        affectedElementIds: [],
        affectedScreenIds: direct.flatMap(
          (id) => ix.useCaseScreens.get(id) ?? [],
        ),
      };
    }
    case "free": {
      const match = matchFreeText(ix, change.description);
      const ruleNodes = match.rules.map(([uc, r]) => ruleNodeId(uc, r));
      const ruleEls = match.rules
        .map(([uc, r]) => ix.rule(uc, r)?.elementId)
        .filter((id): id is string => !!id && ix.elementById.has(id));
      const affected = ix.sortElements([...match.elementIds, ...ruleEls]);
      const direct = ix.sortUseCases([
        ...match.useCaseIds,
        ...match.rules.map(([uc]) => uc),
        ...covering(match.elementIds),
      ]);
      const seeds = [...match.elementIds, ...ruleNodes, ...match.useCaseIds];
      return {
        seedNodeIds: seeds,
        bfsOrder: seeds,
        direct,
        affectedElementIds: affected,
        affectedScreenIds: affected.length
          ? screensOfElements(affected)
          : direct.flatMap((id) => ix.useCaseScreens.get(id) ?? []),
      };
    }
    default: {
      const kind: never = change.targetKind;
      throw new BadRequestError(`Unknown change target "${String(kind)}".`);
    }
  }
}

type Adjacency = Map<string, string[]>;

/** Undirected adjacency over the graph, leaving out edge kinds that would explain nothing about ownership. */
function adjacency(
  graph: SolutionGraph,
  exclude: ReadonlySet<GraphEdgeKind>,
): Adjacency {
  const adj: Adjacency = new Map();
  const link = (a: string, b: string) => {
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  };
  for (const e of graph.edges) {
    if (exclude.has(e.kind)) continue;
    link(e.from, e.to);
    link(e.to, e.from);
  }
  return adj;
}

/** Multi-source BFS; returns parent pointers (seed → null). */
function bfs(adj: Adjacency, sources: string[]): Map<string, string | null> {
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const s of sources) {
    if (parent.has(s)) continue;
    parent.set(s, null);
    queue.push(s);
  }
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    for (const next of adj.get(node) ?? []) {
      if (parent.has(next)) continue;
      parent.set(next, node);
      queue.push(next);
    }
  }
  return parent;
}

function pathTo(
  parent: Map<string, string | null>,
  target: string,
): string[] | undefined {
  if (!parent.has(target)) return undefined;
  const path: string[] = [];
  let cur: string | null | undefined = target;
  while (cur != null) {
    path.push(cur);
    cur = parent.get(cur);
  }
  return path.reverse();
}

/**
 * Seeds from the change target (element / screen / region / use case / rule / scenario / persona; for
 * 'free' changes: keyword match over labels), then:
 *  direct     = use cases that cover/own the seed (rule → its use case; element → covering use cases + rules governing it; screen → use cases appearing on it)
 *  downstream = transitive dependents via depends_on (consumers of postconditions)
 *  upstream   = direct dependencies of the direct use cases
 *  related    = other use cases sharing elements/screens with direct ones
 * Each use case appears in exactly one bucket (direct > downstream > upstream > related). Includes shortest paths.
 */
export function traceImpact(
  model: SolutionModel,
  change: ChangeRequest,
): DeterministicImpact {
  const ix = indexModel(model);
  const graph = buildGraphFromIndex(ix);
  const seeds = resolveSeeds(ix, change);

  // A BA edit of one use case: that use case is the (only) direct one; its dependents inherit the change.
  let direct = seeds.direct.filter((id) => ix.useCaseById.has(id));
  let affectedElementIds = seeds.affectedElementIds;
  let affectedScreens = seeds.affectedScreenIds;
  const seedNodeIds = [...seeds.seedNodeIds];
  const bfsOrder = [...seeds.bfsOrder];
  if (change.useCaseDiff) {
    const raw = change.useCaseDiff.useCaseId;
    const ucId = ix.useCaseById.has(raw) ? raw : normaliseUseCaseId(raw);
    const uc = ucId ? ix.useCaseById.get(ucId) : undefined;
    if (!uc) throw notInModel(`Use case "${raw}"`);
    direct = [uc.id];
    if (!seedNodeIds.includes(uc.id)) seedNodeIds.unshift(uc.id);
    if (!bfsOrder.includes(uc.id)) bfsOrder.unshift(uc.id);
    const content = change.useCaseDiff.changedSections.some(
      (s) => s === "rules" || s === "scenarios" || s === "elements",
    );
    affectedElementIds = content
      ? ix.sortElements(
          (ix.useCaseElements.get(uc.id) ?? []).filter((id) =>
            ix.elementById.has(id),
          ),
        )
      : [];
    affectedScreens = ix.useCaseScreens.get(uc.id) ?? [];
  }

  const directSet = new Set(direct);

  // downstream: everything that (transitively) consumes a direct use case's postconditions
  const downstreamSet = new Set<string>();
  const queue = [...direct];
  for (let i = 0; i < queue.length; i++) {
    for (const dep of ix.dependents.get(queue[i]) ?? []) {
      if (directSet.has(dep) || downstreamSet.has(dep)) continue;
      downstreamSet.add(dep);
      queue.push(dep);
    }
  }

  // upstream: what the direct use cases stand on
  const upstreamSet = new Set<string>();
  for (const id of direct) {
    for (const dep of ix.useCaseById.get(id)?.dependsOn ?? []) {
      if (
        ix.useCaseById.has(dep) &&
        !directSet.has(dep) &&
        !downstreamSet.has(dep)
      )
        upstreamSet.add(dep);
    }
  }

  // related: shares an element with a direct use case, or appears on an affected screen
  const affectedScreenIds = ix.sortScreens(
    [
      ...affectedScreens,
      ...affectedElementIds
        .map((id) => ix.elementById.get(id)?.screenId)
        .filter((s): s is string => !!s),
    ].filter((sid) => ix.screenById.has(sid)),
  );
  const sharedElements = new Set<string>(
    direct.length
      ? direct.flatMap((id) => ix.useCaseElements.get(id) ?? [])
      : affectedElementIds,
  );
  const relatedSet = new Set<string>();
  const taken = (id: string) =>
    directSet.has(id) || downstreamSet.has(id) || upstreamSet.has(id);
  for (const elId of sharedElements)
    for (const uc of ix.coveringUseCases.get(elId) ?? [])
      if (!taken(uc)) relatedSet.add(uc);
  for (const sid of affectedScreenIds)
    for (const uc of ix.screenUseCases.get(sid) ?? [])
      if (!taken(uc)) relatedSet.add(uc);

  const downstream = ix.sortUseCases(downstreamSet);
  const upstream = ix.sortUseCases(upstreamSet);
  const related = ix.sortUseCases(relatedSet);

  /* ---- shortest explanatory paths ---- */
  const nodeSet = new Set(graph.nodes.map((n) => n.id));
  const ownership = adjacency(
    graph,
    new Set<GraphEdgeKind>(["depends_on", "navigates_to", "groups"]),
  );
  const seedParents = bfs(
    ownership,
    bfsOrder.filter((id) => nodeSet.has(id)),
  );
  const directPath = new Map<string, string[]>();
  for (const id of direct) directPath.set(id, pathTo(seedParents, id) ?? [id]);

  const paths: DeterministicImpact["paths"] = direct.map((id) => ({
    useCaseId: id,
    path: directPath.get(id)!,
  }));

  // downstream: seed → direct use case → … dependents chain
  const chainParents = direct.map((d) => {
    const parent = new Map<string, string | null>([[d, null]]);
    const q = [d];
    for (let i = 0; i < q.length; i++) {
      for (const next of ix.dependents.get(q[i]) ?? []) {
        if (parent.has(next) || directSet.has(next)) continue;
        parent.set(next, q[i]);
        q.push(next);
      }
    }
    return { d, parent };
  });
  for (const id of downstream) {
    let best: string[] | undefined;
    for (const { d, parent } of chainParents) {
      const chain = pathTo(parent, id);
      if (!chain) continue;
      const full = [...directPath.get(d)!, ...chain.slice(1)];
      if (!best || full.length < best.length) best = full;
    }
    paths.push({ useCaseId: id, path: best ?? [id] });
  }

  for (const id of upstream) {
    let best: string[] | undefined;
    for (const d of direct) {
      if (!ix.useCaseById.get(d)?.dependsOn.includes(id)) continue;
      const full = [...directPath.get(d)!, id];
      if (!best || full.length < best.length) best = full;
    }
    paths.push({ useCaseId: id, path: best ?? [id] });
  }

  for (const id of related) {
    let best: string[] | undefined;
    const theirs = new Set(ix.useCaseElements.get(id) ?? []);
    for (const d of direct) {
      const shared = ix.sortElements(
        (ix.useCaseElements.get(d) ?? []).filter(
          (e) => theirs.has(e) && nodeSet.has(e),
        ),
      )[0];
      if (!shared) continue;
      const full = [...directPath.get(d)!, shared, id];
      if (!best || full.length < best.length) best = full;
    }
    paths.push({
      useCaseId: id,
      path: best ?? pathTo(seedParents, id) ?? [id],
    });
  }

  return {
    seedNodeIds: uniq(seedNodeIds.filter((id) => nodeSet.has(id))),
    directUseCaseIds: direct,
    downstreamUseCaseIds: downstream,
    upstreamUseCaseIds: upstream,
    relatedUseCaseIds: related,
    affectedElementIds,
    affectedScreenIds,
    paths,
  };
}
