/**
 * OWNER: graph builder.
 * Deterministic diff between two analyses of the same screen (old image version vs new).
 * Elements match by key first, then by (type, normalised label), then by fuzzy label similarity within
 * the same region. Matched elements keep the OLD id so use case references stay valid.
 */
import type {
  ElementChange,
  ScreenAnalysis,
  ScreenDiff,
  ScreenRegion,
  UIElement,
} from "@shared/types";
import {
  elementName,
  elementTypeWords,
  jaccard,
  joinList,
  labelSimilarity,
  normaliseLabel,
  normaliseText,
  plural,
  stem,
  truncate,
  words,
} from "./text";

export interface ScreenDiffResult {
  diff: ScreenDiff;
  /**
   * The new analysis with element/region ids remapped onto the old ids wherever matched
   * (so it can replace the old analysis in the model without breaking references).
   */
  remapped: ScreenAnalysis;
}

export interface ScreenDiffOptions {
  /** Display name for a screen id (used in "navigates to" change descriptions). */
  screenName?: (screenId: string) => string | undefined;
}

/** Minimum label similarity for the fuzzy (third) matching pass. */
export const FUZZY_LABEL_THRESHOLD = 0.6;

export function diffScreenAnalyses(
  before: ScreenAnalysis,
  after: ScreenAnalysis,
): ScreenDiffResult {
  return diffScreenAnalysesWith(before, after);
}

export function diffScreenAnalysesWith(
  before: ScreenAnalysis,
  after: ScreenAnalysis,
  opts: ScreenDiffOptions = {},
): ScreenDiffResult {
  /* ---- 1. regions: by key, then by name ---- */
  const regionMap = new Map<string, ScreenRegion>(); // after region id → before region
  const usedBeforeRegions = new Set<string>();
  const matchRegion = (a: ScreenRegion, b: ScreenRegion) => {
    regionMap.set(a.id, b);
    usedBeforeRegions.add(b.id);
  };
  for (const a of after.regions) {
    const b = before.regions.find(
      (r) => !usedBeforeRegions.has(r.id) && r.key === a.key,
    );
    if (b) matchRegion(a, b);
  }
  for (const a of after.regions) {
    if (regionMap.has(a.id)) continue;
    const name = normaliseLabel(a.name);
    if (!name) continue;
    const b = before.regions.find(
      (r) => !usedBeforeRegions.has(r.id) && normaliseLabel(r.name) === name,
    );
    if (b) matchRegion(a, b);
  }

  /* ---- 2. elements: by key, then by (type, normalised label) ---- */
  const elMap = new Map<string, UIElement>(); // after element id → before element
  const usedBefore = new Set<string>();
  const matchEl = (a: UIElement, b: UIElement) => {
    elMap.set(a.id, b);
    usedBefore.add(b.id);
  };
  const beforeIndex = new Map(before.elements.map((el, i) => [el.id, i]));
  const afterIndex = new Map(after.elements.map((el, i) => [el.id, i]));
  const relPos = (idx: number | undefined, len: number) =>
    len <= 1 ? 0 : (idx ?? 0) / (len - 1);

  for (const a of after.elements) {
    const b = before.elements.find(
      (el) => !usedBefore.has(el.id) && el.key === a.key,
    );
    if (b) matchEl(a, b);
  }
  for (const a of after.elements) {
    if (elMap.has(a.id)) continue;
    const label = normaliseLabel(a.label);
    if (!label) continue;
    const candidates = before.elements.filter(
      (el) =>
        !usedBefore.has(el.id) &&
        el.type === a.type &&
        normaliseLabel(el.label) === label,
    );
    if (!candidates.length) continue;
    const mappedRegion = regionMap.get(a.regionId)?.id;
    const aPos = relPos(afterIndex.get(a.id), after.elements.length);
    candidates.sort((x, y) => {
      const rx = x.regionId === mappedRegion ? 0 : 1;
      const ry = y.regionId === mappedRegion ? 0 : 1;
      if (rx !== ry) return rx - ry;
      const dx = Math.abs(
        relPos(beforeIndex.get(x.id), before.elements.length) - aPos,
      );
      const dy = Math.abs(
        relPos(beforeIndex.get(y.id), before.elements.length) - aPos,
      );
      return dx - dy;
    });
    matchEl(a, candidates[0]);
  }

  /* ---- 3. remaining regions: by where their matched elements came from, then by fuzzy name ---- */
  for (const a of after.regions) {
    if (regionMap.has(a.id)) continue;
    const members = after.elements.filter(
      (el) => el.regionId === a.id || a.elementIds.includes(el.id),
    );
    const votes = new Map<string, number>();
    let matchedMembers = 0;
    for (const el of members) {
      const b = elMap.get(el.id);
      if (!b) continue;
      matchedMembers += 1;
      if (!usedBeforeRegions.has(b.regionId))
        votes.set(b.regionId, (votes.get(b.regionId) ?? 0) + 1);
    }
    let bestId: string | undefined;
    let bestVotes = 0;
    for (const [rid, n] of votes) {
      if (n > bestVotes) {
        bestId = rid;
        bestVotes = n;
      }
    }
    const b = bestId ? before.regions.find((r) => r.id === bestId) : undefined;
    if (b && bestVotes * 2 >= matchedMembers) matchRegion(a, b);
  }
  {
    const pairs: { a: ScreenRegion; b: ScreenRegion; sim: number }[] = [];
    for (const a of after.regions) {
      if (regionMap.has(a.id)) continue;
      for (const b of before.regions) {
        if (usedBeforeRegions.has(b.id)) continue;
        const sim = labelSimilarity(a.name, b.name);
        if (sim >= FUZZY_LABEL_THRESHOLD) pairs.push({ a, b, sim });
      }
    }
    pairs.sort((x, y) => y.sim - x.sim);
    for (const { a, b } of pairs) {
      if (regionMap.has(a.id) || usedBeforeRegions.has(b.id)) continue;
      matchRegion(a, b);
    }
  }

  /* ---- 4. elements: fuzzy label similarity within the same (mapped) region ---- */
  {
    const pairs: {
      a: UIElement;
      b: UIElement;
      sim: number;
      sameType: boolean;
      dist: number;
    }[] = [];
    for (const a of after.elements) {
      if (elMap.has(a.id) || !normaliseLabel(a.label)) continue;
      const region = regionMap.get(a.regionId)?.id;
      if (!region) continue;
      const aPos = relPos(afterIndex.get(a.id), after.elements.length);
      for (const b of before.elements) {
        if (
          usedBefore.has(b.id) ||
          b.regionId !== region ||
          !normaliseLabel(b.label)
        )
          continue;
        const sim = labelSimilarity(a.label, b.label);
        if (sim < FUZZY_LABEL_THRESHOLD) continue;
        const dist = Math.abs(
          relPos(beforeIndex.get(b.id), before.elements.length) - aPos,
        );
        pairs.push({ a, b, sim, sameType: a.type === b.type, dist });
      }
    }
    pairs.sort(
      (x, y) =>
        y.sim - x.sim ||
        Number(y.sameType) - Number(x.sameType) ||
        x.dist - y.dist,
    );
    for (const { a, b } of pairs) {
      if (elMap.has(a.id) || usedBefore.has(b.id)) continue;
      matchEl(a, b);
    }
  }

  /* ---- 5. remap ids onto the old ones ---- */
  const screenKey = before.screenKey || after.screenKey;
  const takenIds = new Set<string>([
    ...before.elements.map((e) => e.id),
    ...before.regions.map((r) => r.id),
  ]);
  const takenRegionKeys = new Set(before.regions.map((r) => r.key));
  const takenElementKeys = new Set(before.elements.map((e) => e.key));
  const freshKey = (key: string, takenKeys: Set<string>) => {
    const base = key || "item";
    let candidate = base;
    for (
      let n = 2;
      takenKeys.has(candidate) || takenIds.has(`${screenKey}.${candidate}`);
      n++
    )
      candidate = `${base}_${n}`;
    takenKeys.add(candidate);
    takenIds.add(`${screenKey}.${candidate}`);
    return candidate;
  };

  const regionIdMap = new Map<string, { id: string; key: string }>();
  for (const a of after.regions) {
    const b = regionMap.get(a.id);
    if (b) regionIdMap.set(a.id, { id: b.id, key: b.key });
  }
  for (const a of after.regions) {
    if (regionIdMap.has(a.id)) continue;
    const key = freshKey(a.key, takenRegionKeys);
    regionIdMap.set(a.id, { id: `${screenKey}.${key}`, key });
  }
  const elementIdMap = new Map<string, { id: string; key: string }>();
  for (const a of after.elements) {
    const b = elMap.get(a.id);
    if (b) elementIdMap.set(a.id, { id: b.id, key: b.key });
  }
  for (const a of after.elements) {
    if (elementIdMap.has(a.id)) continue;
    const key = freshKey(a.key, takenElementKeys);
    elementIdMap.set(a.id, { id: `${screenKey}.${key}`, key });
  }
  const mapRegionId = (rid: string): string => {
    const mapped = regionIdMap.get(rid);
    if (mapped) return mapped.id;
    if (after.screenKey && rid.startsWith(`${after.screenKey}.`))
      return `${screenKey}.${rid.slice(after.screenKey.length + 1)}`;
    return rid;
  };

  const remappedElements: UIElement[] = after.elements.map((el) => {
    const ids = elementIdMap.get(el.id)!;
    return structuredClone({
      ...el,
      id: ids.id,
      key: ids.key,
      screenId: before.screenId,
      regionId: mapRegionId(el.regionId),
    });
  });
  const remappedRegions: ScreenRegion[] = after.regions.map((r) => {
    const ids = regionIdMap.get(r.id)!;
    return structuredClone({
      ...r,
      id: ids.id,
      key: ids.key,
      screenId: before.screenId,
      elementIds: r.elementIds
        .map((id) => elementIdMap.get(id)?.id)
        .filter((id): id is string => !!id),
    });
  });
  const remapped: ScreenAnalysis = {
    ...structuredClone(after),
    screenId: before.screenId,
    screenKey,
    regions: remappedRegions,
    elements: remappedElements,
  };

  /* ---- 6. the diff ---- */
  const remappedById = new Map(remappedElements.map((el) => [el.id, el]));
  const beforeRegionName = new Map(before.regions.map((r) => [r.id, r.name]));
  const afterRegionName = new Map(remappedRegions.map((r) => [r.id, r.name]));
  const screenName = (id: string | undefined) => {
    if (!id) return "nowhere";
    if (id === before.screenId) return before.title || "this screen";
    return opts.screenName?.(id) ?? id;
  };

  const added = after.elements
    .filter((a) => !elMap.has(a.id))
    .map((a) => remappedById.get(elementIdMap.get(a.id)!.id)!);
  const removed = before.elements
    .filter((b) => !usedBefore.has(b.id))
    .map((b) => structuredClone(b));
  const modified: ElementChange[] = [];
  for (const a of after.elements) {
    const b = elMap.get(a.id);
    if (!b) continue;
    const next = remappedById.get(b.id)!;
    const changes = describeElementChanges(b, next, {
      regionName: (id, side) =>
        (side === "before"
          ? beforeRegionName.get(id)
          : afterRegionName.get(id)) ?? id,
      screenName,
    });
    if (changes.length)
      modified.push({ before: structuredClone(b), after: next, changes });
  }

  const newRegions = remappedRegions.filter(
    (r) => !before.regions.some((b) => b.id === r.id),
  );
  const removedRegions = before.regions.filter(
    (b) => !remappedRegions.some((r) => r.id === b.id),
  );

  const diff: ScreenDiff = {
    screenId: before.screenId,
    fromVersion: before.screenVersion,
    toVersion: after.screenVersion,
    added,
    removed,
    modified,
    summary: summarise(
      before,
      after,
      added,
      removed,
      modified,
      newRegions,
      removedRegions,
    ),
  };
  return { diff, remapped };
}

/* ------------------------------------------------------------------ */
/* Field-level change descriptions                                     */
/* ------------------------------------------------------------------ */

interface DescribeContext {
  regionName: (regionId: string, side: "before" | "after") => string;
  screenName: (screenId: string | undefined) => string;
}

function quote(s: string | undefined, max = 80): string {
  const v = (s ?? "").trim();
  return v ? `'${truncate(v, max)}'` : "(none)";
}

function sameText(a: string | undefined, b: string | undefined): boolean {
  return normaliseText(a) === normaliseText(b);
}

/** Prose written by the analyst varies between runs; only flag it when the wording really moved. */
function sameProse(a: string | undefined, b: string | undefined): boolean {
  const na = normaliseLabel(a);
  const nb = normaliseLabel(b);
  if (na === nb) return true;
  if (!na || !nb) return false;
  return jaccard(words(na).map(stem), words(nb).map(stem)) >= 0.7;
}

/** List diff with fuzzy equality (≥ 0.8 similarity counts as the same entry). */
function listDiff(
  before: string[] = [],
  after: string[] = [],
  fuzzy: boolean,
): { added: string[]; removed: string[] } {
  const same = (x: string, y: string) =>
    normaliseLabel(x) === normaliseLabel(y) ||
    (fuzzy && labelSimilarity(x, y) >= 0.8);
  const usedAfter = new Set<number>();
  const removed: string[] = [];
  for (const b of before) {
    const idx = after.findIndex(
      (a, i) => !usedAfter.has(i) && normaliseLabel(a) === normaliseLabel(b),
    );
    const fuzzyIdx =
      idx >= 0
        ? idx
        : after.findIndex((a, i) => !usedAfter.has(i) && same(a, b));
    if (fuzzyIdx >= 0) usedAfter.add(fuzzyIdx);
    else removed.push(b);
  }
  const added = after.filter((_, i) => !usedAfter.has(i));
  return { added, removed };
}

export function describeElementChanges(
  before: UIElement,
  after: UIElement,
  ctx: DescribeContext,
): string[] {
  const changes: string[] = [];
  if (!sameText(before.label, after.label))
    changes.push(`label: ${quote(before.label)} → ${quote(after.label)}`);
  if (before.type !== after.type)
    changes.push(
      `type: ${elementTypeWords(before.type)} → ${elementTypeWords(after.type)}`,
    );
  if (before.regionId !== after.regionId) {
    changes.push(
      `moved from region ${quote(ctx.regionName(before.regionId, "before"))} to ${quote(ctx.regionName(after.regionId, "after"))}`,
    );
  }

  const options = listDiff(before.options, after.options, false);
  for (const o of options.added) changes.push(`options: added ${quote(o)}`);
  for (const o of options.removed) changes.push(`options: removed ${quote(o)}`);
  if (
    !options.added.length &&
    !options.removed.length &&
    (before.options?.length ?? 0) > 1
  ) {
    const order = (list: string[] = []) => list.map(normaliseLabel).join("|");
    if (order(before.options) !== order(after.options))
      changes.push("options: reordered");
  }

  const validation = listDiff(before.validation, after.validation, true);
  for (const v of validation.added)
    changes.push(`validation: added ${quote(v, 120)}`);
  for (const v of validation.removed)
    changes.push(`validation: removed ${quote(v, 120)}`);

  const wasRequired = before.required ?? false;
  const isRequired = after.required ?? false;
  if (wasRequired !== isRequired)
    changes.push(
      `required: ${wasRequired ? "yes" : "no"} → ${isRequired ? "yes" : "no"}`,
    );

  if (!sameText(before.placeholder, after.placeholder)) {
    changes.push(
      `placeholder: ${quote(before.placeholder)} → ${quote(after.placeholder)}`,
    );
  }
  if (!sameText(before.defaultValue, after.defaultValue)) {
    changes.push(
      `default value: ${quote(before.defaultValue)} → ${quote(after.defaultValue)}`,
    );
  }
  if (!sameText(before.helperText, after.helperText)) {
    changes.push(
      `helper text: ${quote(before.helperText)} → ${quote(after.helperText)}`,
    );
  }
  if (!sameProse(before.behavior, after.behavior)) {
    changes.push(
      `behaviour: ${quote(before.behavior, 120)} → ${quote(after.behavior, 120)}`,
    );
  }
  if (before.navigatesToScreenId !== after.navigatesToScreenId) {
    const from = before.navigatesToScreenId
      ? ctx.screenName(before.navigatesToScreenId)
      : before.navigatesToHint || "nowhere";
    const to = after.navigatesToScreenId
      ? ctx.screenName(after.navigatesToScreenId)
      : after.navigatesToHint || "nowhere";
    if (normaliseText(from) !== normaliseText(to))
      changes.push(`navigates to: ${from} → ${to}`);
  } else if (
    !before.navigatesToScreenId &&
    !sameProse(before.navigatesToHint, after.navigatesToHint)
  ) {
    changes.push(
      `navigates to: ${before.navigatesToHint || "nowhere"} → ${after.navigatesToHint || "nowhere"}`,
    );
  }
  const states = listDiff(before.states, after.states, false);
  for (const s of states.added) changes.push(`states: added ${quote(s)}`);
  for (const s of states.removed) changes.push(`states: removed ${quote(s)}`);
  if (!sameText(before.dataBinding, after.dataBinding)) {
    changes.push(
      `data: ${quote(before.dataBinding)} → ${quote(after.dataBinding)}`,
    );
  }
  return changes;
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

/** “Remember me” checkbox */
export function describeElementShort(el: UIElement): string {
  return `“${truncate(elementName(el), 60)}” ${elementTypeWords(el.type)}`;
}

/** "label", "options", "validation" — the field names touched by a list of change descriptions. */
function changedFields(changes: string[]): string[] {
  const fields: string[] = [];
  for (const c of changes) {
    const field = c.startsWith("moved from region")
      ? "position"
      : c.split(":")[0].trim();
    if (!fields.includes(field)) fields.push(field);
  }
  return fields;
}

function summarise(
  before: ScreenAnalysis,
  after: ScreenAnalysis,
  added: UIElement[],
  removed: UIElement[],
  modified: ElementChange[],
  newRegions: ScreenRegion[],
  removedRegions: ScreenRegion[],
): string {
  const title = after.title || before.title || before.screenKey;
  const versions = `version ${before.screenVersion} → ${after.screenVersion}`;
  if (
    !added.length &&
    !removed.length &&
    !modified.length &&
    !newRegions.length &&
    !removedRegions.length
  ) {
    return `No functional changes detected on ${title} (${versions}): the same elements, labels, options and rules were found.`;
  }
  const parts: string[] = [];
  if (added.length)
    parts.push(
      `${plural(added.length, "element")} added (${joinList(added.map(describeElementShort))})`,
    );
  if (removed.length)
    parts.push(
      `${removed.length} removed (${joinList(removed.map(describeElementShort))})`,
    );
  if (modified.length) {
    const desc = modified.map(
      (m) =>
        `“${truncate(elementName(m.after), 60)}”: ${changedFields(m.changes).join(", ")}`,
    );
    parts.push(`${modified.length} modified (${joinList(desc)})`);
  }
  let sentence = `${title} (${versions}): ${parts.length ? joinList(parts, parts.length) : "layout regrouped"}.`;
  const regionNotes: string[] = [];
  if (newRegions.length)
    regionNotes.push(
      `new ${newRegions.length === 1 ? "region" : "regions"} ${joinList(newRegions.map((r) => `“${r.name}”`))}`,
    );
  if (removedRegions.length)
    regionNotes.push(
      `${removedRegions.length === 1 ? "region" : "regions"} ${joinList(removedRegions.map((r) => `“${r.name}”`))} removed`,
    );
  if (regionNotes.length) {
    const text = joinList(regionNotes, 2);
    sentence += ` ${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
  }
  return sentence;
}
