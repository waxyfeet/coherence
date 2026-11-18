/**
 * OWNER: agents builder.
 * Use Case Writer agent: turns a planned use case (scope + elements + chain links) into full content:
 * user story, business rules per element, BDD scenarios, pre/postconditions, assumptions, open questions.
 * Also used by impact-apply to rewrite an existing use case given revision notes.
 */
import type {
  BddScenario,
  BusinessRule,
  Granularity,
  LLMConnection,
  Project,
  Screen,
  SolutionModel,
  UIElement,
  UseCase,
} from "@shared/types";
import { CancelledError, errorMessage } from "../errors";
import type { OutputFormat } from "../formats/types";
import type { JobContext } from "../jobs/jobManager";
import { prepareImageForLLM } from "../llm/images";
import { connectionSupportsVision } from "../llm/registry";
import { generateStructured } from "../llm/structured";
import type { LLMContentPart, LLMImage } from "../llm/types";
import { screenImagePath } from "../storage/projectStore";
import { enforceHappyPath } from "./chain";
import {
  callBase,
  chainContextBlock,
  detailedElementBlock,
  isMockConnection,
  screenNotesText,
  sortedScreens,
} from "./context";
import { indexElements, indexRegions } from "./ids";
import { mockWriteUseCase, ruleFromElement } from "./mock/writerMock";
import { writerSystem } from "./prompts";
import { WriterOutputSchema, type WriterOutput } from "./schemas";
import {
  dedupeText,
  lowerFirst,
  normText,
  oneLine,
  stripTrailingPeriod,
} from "./text";

export interface WriteUseCaseArgs {
  ctx: JobContext;
  project: Project;
  /** Full model for context: personas, screens/elements, other use cases (for chain consistency). */
  model: SolutionModel;
  /** Planned stub (content fields may be empty) or an existing use case to revise. */
  useCase: UseCase;
  connection: LLMConnection;
  format: OutputFormat;
  /**
   * When revising: what must change and why (impact suggestions, reviewer findings, BA notes).
   * The writer keeps everything else as-is and preserves rule/scenario ids where the item still exists.
   */
  revisionNotes?: string;
  /** Attach the screen image(s) of the use case (vision connection required). */
  includeImages: boolean;
}

/** A use case spanning many screens (the application shell) would otherwise send every image. */
const MAX_IMAGE_SCREENS = 3;
/** Neighbouring elements listed for context; beyond this the prompt grows without helping. */
const MAX_NEIGHBOURS = 40;

/* ── Pure helpers ───────────────────────────────────────────────────── */

/** The use case's elements in reading order (screen order, then region order). */
export function useCaseElements(
  uc: Pick<UseCase, "elementIds">,
  model: Pick<SolutionModel, "screens">,
): UIElement[] {
  const wanted = new Set(uc.elementIds);
  const out: UIElement[] = [];
  const seen = new Set<string>();
  for (const a of model.screens) {
    const byId = new Map(a.elements.map((e) => [e.id, e]));
    const ordered = [
      ...a.regions.flatMap((r) => r.elementIds),
      ...a.elements.map((e) => e.id),
    ];
    for (const id of ordered) {
      if (!wanted.has(id) || seen.has(id)) continue;
      const e = byId.get(id);
      if (e) {
        seen.add(id);
        out.push(e);
      }
    }
  }
  return out;
}

/** Existing content in the Writer's output shape (for revisions and the offline revision fallback). */
export function useCaseToWriterOutput(uc: UseCase): WriterOutput {
  return {
    title: uc.title,
    scope: uc.scope,
    story: { ...uc.story },
    preconditions: [...uc.preconditions],
    postconditions: [...uc.postconditions],
    businessRules: uc.businessRules.map((r) => ({
      id: r.id,
      elementId: r.elementId ?? "",
      element: r.element,
      elementType: r.elementType,
      description: r.description,
      rules: [...r.rules],
    })),
    scenarios: uc.scenarios.map((s) => ({
      id: s.id,
      title: s.title,
      type: s.type,
      given: [...s.given],
      when: [...s.when],
      then: [...s.then],
      elementIds: [...s.elementIds],
    })),
    assumptions: [...uc.assumptions],
    openQuestions: [...uc.openQuestions],
  };
}

function hasContent(uc: UseCase): boolean {
  return uc.businessRules.length > 0 || uc.scenarios.length > 0;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * BR-xx / SC-xx ids. New content is numbered 1..n in order; revised content keeps every valid, unique id
 * and gives the rest the next free numbers.
 */
export function assignItemIds<T extends { id: string }>(
  items: readonly T[],
  prefix: "BR" | "SC",
  keepExisting: boolean,
): T[] {
  if (!keepExisting)
    return items.map((item, i) => ({ ...item, id: `${prefix}-${pad(i + 1)}` }));
  const pattern = new RegExp(`^${prefix}[-_ ]?0*(\\d+)$`, "i");
  const used = new Set<number>();
  const kept = items.map((item) => {
    const m = pattern.exec(item.id.trim());
    const n = m ? Number(m[1]) : NaN;
    if (Number.isInteger(n) && n > 0 && !used.has(n)) {
      used.add(n);
      return n;
    }
    return undefined;
  });
  let next = Math.max(0, ...used) + 1;
  return items.map((item, i) => {
    const n = kept[i] ?? next++;
    return { ...item, id: `${prefix}-${pad(n)}` };
  });
}

function cleanStoryPart(value: string, prefix: RegExp): string {
  return stripTrailingPeriod(
    value.replace(prefix, "").replace(/\*\*/g, "").trim(),
  );
}

function typeWords(type: string): string {
  const t = type.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/*
 * The renderer adds GIVEN/WHEN/THEN itself, so a keyword the model typed must go — but only the keyword of
 * that list: "When checked, the session is kept…" is a legitimate THEN line and must keep its "When".
 */
const GIVEN_KEYWORD = /^\s*(?:given|and|but)\b[\s:,-]*/i;
const WHEN_KEYWORD = /^\s*(?:when|and|but)\b[\s:,-]*/i;
const THEN_KEYWORD = /^\s*(?:then|and|but)\b[\s:,-]*/i;

/**
 * Strips bullets and the list's keyword. GIVEN and THEN lines are states, so a repeated one is noise and is
 * dropped (`dedupe`); WHEN lines are actions in order, and repeating one ("selects \"Next\"" in a stepper, five
 * failed sign-in attempts) is often the point of the scenario, so they must all be kept.
 */
export function cleanSteps(
  lines: readonly string[],
  keyword: RegExp,
  dedupe = true,
): string[] {
  const cleaned = lines.map((line) =>
    (line ?? "")
      .replace(/^\s*[-*•]\s*/, "")
      .replace(keyword, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return dedupe ? dedupeText(cleaned) : cleaned.filter(Boolean);
}

const REFERENCE_RULE = /^\s*identical to (BR-\d+)\b/i;

function isPointerRule(rule: Pick<BusinessRule, "rules">): boolean {
  return REFERENCE_RULE.test(rule.rules[0] ?? "");
}

/** The same element repeated on another screen: same type and the same visible label. */
function sameKindOfElement(a: UIElement, b: UIElement): boolean {
  return a.type === b.type && normText(a.label) === normText(b.label);
}

function pointerRule(
  rule: BusinessRule,
  target: BusinessRule,
  element: UIElement,
  screenName: (screenId: string) => string,
  extra: readonly string[] = [],
): BusinessRule {
  return {
    ...rule,
    description: `Same ${typeWords(element.type).toLowerCase()} as ${target.id}, shown on the ${screenName(element.screenId)} screen.`,
    rules: [`Identical to ${target.id}.`, ...extra],
  };
}

/**
 * The shared application shell repeats the same element on several screens. Each instance keeps its own
 * rule (every element is governed), but an instance identical to one already described points at it
 * instead of repeating it — the use case stays readable and its real size visible.
 * A pointer that does not name a rule for the same element (type + label) is re-pointed at one that does,
 * else replaced by `rebuild` (a rule from the inventory) — a wrong pointer would make a developer build one
 * link like another.
 */
export function compactRepeatedRules(
  rules: readonly BusinessRule[],
  elements: ReadonlyMap<string, UIElement>,
  screenName: (screenId: string) => string,
  rebuild?: (rule: BusinessRule, element: UIElement) => BusinessRule,
): BusinessRule[] {
  const elementOf = (r: BusinessRule): UIElement | undefined =>
    r.elementId ? elements.get(r.elementId) : undefined;

  // 1. Full descriptions: an instance identical to one already described on another screen points at it.
  const firstByKey = new Map<
    string,
    { rule: BusinessRule; element: UIElement }
  >();
  const compacted = rules.map((rule) => {
    const element = elementOf(rule);
    if (!element || rule.rules.length === 0 || isPointerRule(rule)) return rule;
    const key = `${element.type}|${normText(rule.element)}|${rule.rules.map(normText).join("|")}`;
    const first = firstByKey.get(key);
    if (!first) {
      firstByKey.set(key, { rule, element });
      return rule;
    }
    // Two identical elements on the SAME screen (e.g. two "Edit" buttons) are different things.
    if (first.element.screenId === element.screenId) return rule;
    return pointerRule(rule, first.rule, element, screenName);
  });

  // 2. Pointers that were already there ("Identical to BR-04.", from a revision or the model) are kept only
  // when they name a full description (never another pointer — that would chain "Same as BR-09" → "Same
  // as BR-04") of the same kind of element.
  const byId = new Map(compacted.map((r) => [r.id, r]));
  const described = compacted.filter((r) => !isPointerRule(r));
  return compacted.map((rule, i) => {
    const element = elementOf(rule);
    if (!element || rule !== rules[i] || !isPointerRule(rule)) return rule;
    const targetRule = byId.get(
      REFERENCE_RULE.exec(rule.rules[0]!)![1]!.toUpperCase(),
    );
    const targetElement = targetRule ? elementOf(targetRule) : undefined;
    if (
      targetRule &&
      targetRule !== rule &&
      targetElement &&
      !isPointerRule(targetRule) &&
      sameKindOfElement(targetElement, element)
    )
      return rule;
    const extra = rule.rules.slice(1);
    const replacement = described.find((r) => {
      const e = elementOf(r);
      return (
        e !== undefined &&
        e.screenId !== element.screenId &&
        sameKindOfElement(e, element)
      );
    });
    if (replacement)
      return pointerRule(rule, replacement, element, screenName, extra);
    if (rebuild) {
      const rebuilt = rebuild(rule, element);
      return {
        ...rule,
        description: rebuilt.description,
        rules: dedupeText([...rebuilt.rules, ...extra]),
      };
    }
    return extra.length ? { ...rule, rules: extra } : rule;
  });
}

/*
 * BR-xx / SC-xx references in text the model wrote use the model's own numbering. One that names another
 * use case's item ("UC-003 BR-02", "UC-003's BR-02") is not this use case's and stays as written.
 */
const ITEM_REFERENCE = /(?<!\bUC-\d+(?:['’]s)?\W{1,3})\b(BR|SC)-(\d+)\b/g;

/**
 * Model number → final id, for every model id that names exactly one item (an ambiguous number is left
 * alone). `rawIds[i]` are the model's ids behind `finalIds[i]` (several when rules were merged).
 */
export function itemIdMap(
  rawIds: readonly (readonly string[])[],
  finalIds: readonly string[],
  prefix: "BR" | "SC",
): Map<number, string> {
  const pattern = new RegExp(`^${prefix}[-_ ]?0*(\\d+)$`, "i");
  const owners = new Map<number, Set<string>>();
  rawIds.forEach((ids, i) => {
    for (const raw of ids) {
      const m = pattern.exec((raw ?? "").trim());
      if (!m) continue;
      const n = Number(m[1]);
      const set = owners.get(n) ?? new Set<string>();
      set.add(finalIds[i]!);
      owners.set(n, set);
    }
  });
  const map = new Map<number, string>();
  for (const [n, set] of owners) if (set.size === 1) map.set(n, [...set][0]!);
  return map;
}

/** Rewrites "BR-04" / "SC-02" in model text to the final ids in one pass (no cascading replacements). */
export function remapItemReferences(
  text: string,
  rules: ReadonlyMap<number, string>,
  scenarios: ReadonlyMap<number, string>,
): string {
  if (!rules.size && !scenarios.size) return text;
  return text.replace(
    ITEM_REFERENCE,
    (whole, prefix: string, num: string) =>
      (prefix === "BR" ? rules : scenarios).get(Number(num)) ?? whole,
  );
}

export interface FinaliseWriterArgs {
  useCase: UseCase;
  output: WriterOutput;
  /** The use case's elements in reading order. */
  elements: readonly UIElement[];
  /** Every element of the model (to tell a neighbour's element from an invented id). */
  allElements: ReadonlyMap<string, UIElement>;
  regionNameOf: (regionId: string) => string;
  screens: readonly Screen[];
  revising: boolean;
  /** Deterministic scenarios used when the model returned none. */
  fallbackScenarios?: () => BddScenario[];
  now?: string;
}

export interface FinaliseWriterResult {
  useCase: UseCase;
  /** Elements that got a rule built from the inventory because the model omitted them. */
  addedRulesFor: string[];
  notes: string[];
  /** Repairs the BA should check (e.g. a happy path the model did not write). */
  warnings: string[];
}

/** Last resort when the model wrote no happy path and no inventory scenarios are available. */
function synthesisedHappyPath(title: string): BddScenario {
  return {
    id: "",
    title,
    type: "happy",
    given: [],
    when: [`the user completes ${lowerFirst(title)}`],
    then: [],
    elementIds: [],
  };
}

/**
 * Validates and completes the Writer's answer (pure): planned pre/postconditions verbatim, one rule per
 * element (rules for other use cases' elements dropped, missing ones built from the inventory), clean
 * Gherkin steps, exactly one happy path that starts from the preconditions and ends in the postconditions,
 * stable BR/SC ids. Returns a NEW use case.
 */
export function finaliseWriterOutput(
  args: FinaliseWriterArgs,
): FinaliseWriterResult {
  const { useCase: uc, output, elements, revising } = args;
  const notes: string[] = [];
  const warnings: string[] = [];
  const own = new Map(elements.map((e) => [e.id, e]));
  const order = new Map(elements.map((e, i) => [e.id, i]));
  const byLabel = new Map<string, UIElement>();
  for (const e of elements)
    if (e.label && !byLabel.has(normText(e.label)))
      byLabel.set(normText(e.label), e);

  // Story, title, scope.
  const title =
    (revising ? output.title.trim() : "") || uc.title || output.title.trim();
  const scope = output.scope.trim() || uc.scope;
  const story = {
    asA:
      lowerFirst(cleanStoryPart(output.story.asA, /^\s*as\s+an?\s+/i)) ||
      uc.story.asA ||
      "user",
    iWant:
      cleanStoryPart(output.story.iWant, /^\s*i\s+want\s+(to\s+)?/i) ||
      uc.story.iWant ||
      lowerFirst(title),
    soThat:
      cleanStoryPart(output.story.soThat, /^\s*so\s+that\s+/i) ||
      uc.story.soThat ||
      "I can complete my work without help",
  };

  // Pre/postconditions: the planned ones are chained to other use cases, so they stay verbatim and first.
  const merge = (
    planned: readonly string[],
    written: readonly string[],
  ): string[] => {
    const writtenClean = cleanSteps(written, GIVEN_KEYWORD);
    if (revising)
      return writtenClean.length ? writtenClean : dedupeText(planned);
    if (!planned.length) return writtenClean;
    return dedupeText([...planned, ...writtenClean]);
  };
  const preconditions = merge(uc.preconditions, output.preconditions);
  const postconditions = merge(uc.postconditions, output.postconditions);

  // Business rules.
  const rules: BusinessRule[] = [];
  const ruleByElement = new Map<string, BusinessRule>();
  /** Model ids of rules merged into another rule (references to them follow the merged rule). */
  const mergedIds = new Map<BusinessRule, string[]>();
  for (const raw of output.businessRules) {
    let element: UIElement | undefined;
    const id = raw.elementId.trim();
    if (id) {
      element = own.get(id);
      if (!element && args.allElements.has(id)) {
        notes.push(
          `Dropped ${raw.id || "a rule"} for ${id}: that element belongs to another use case.`,
        );
        continue;
      }
    }
    const isGeneral =
      raw.elementType === "general" || raw.elementType === "screen";
    if (!element && !isGeneral) element = byLabel.get(normText(raw.element));
    const bullets = dedupeText(
      raw.rules.map((r) => r.replace(/^\s*[-*•]\s*/, "")),
    );

    if (element) {
      const existing = ruleByElement.get(element.id);
      if (existing) {
        // One rule per element: merge a second rule for the same element into the first.
        existing.rules = dedupeText([...existing.rules, ...bullets]);
        mergedIds.set(existing, [...(mergedIds.get(existing) ?? []), raw.id]);
        continue;
      }
      const fromInventory =
        bullets.length && raw.description.trim()
          ? undefined
          : ruleFromElement(
              element,
              args.regionNameOf(element.regionId),
              args.screens,
            );
      const rule: BusinessRule = {
        id: raw.id,
        elementId: element.id,
        element:
          raw.element.trim() ||
          element.label ||
          element.placeholder ||
          typeWords(element.type),
        elementType: element.type,
        description: raw.description.trim() || fromInventory!.description,
        rules: bullets.length ? bullets : fromInventory!.rules,
      };
      rules.push(rule);
      ruleByElement.set(element.id, rule);
      continue;
    }
    if (!bullets.length) continue;
    rules.push({
      id: raw.id,
      element: raw.element.trim() || "Screen-level rules",
      elementType: isGeneral ? raw.elementType : "general",
      description: raw.description.trim(),
      rules: bullets,
    });
  }

  const addedRulesFor: string[] = [];
  for (const e of elements) {
    if (ruleByElement.has(e.id)) continue;
    const rule = ruleFromElement(
      e,
      args.regionNameOf(e.regionId),
      args.screens,
      "",
    );
    rules.push(rule);
    ruleByElement.set(e.id, rule);
    addedRulesFor.push(e.id);
  }

  let orderedRules = rules;
  if (!revising) {
    // Reading order, screen-level rules last.
    const rank = (r: BusinessRule): number =>
      r.elementId !== undefined && order.has(r.elementId)
        ? order.get(r.elementId)!
        : Number.MAX_SAFE_INTEGER;
    orderedRules = rules
      .map((r, i) => ({ r, i }))
      .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
      .map((x) => x.r);
  }
  const numberedRules = assignItemIds(orderedRules, "BR", revising);

  // Scenarios.
  let scenarios: BddScenario[] = [];
  for (const raw of output.scenarios) {
    const given = cleanSteps(raw.given, GIVEN_KEYWORD);
    const when = cleanSteps(raw.when, WHEN_KEYWORD, false);
    const then = cleanSteps(raw.then, THEN_KEYWORD);
    if (!when.length && !then.length) {
      notes.push(
        `Dropped scenario ${raw.id || `"${oneLine(raw.title, 40)}"`}: it had no WHEN or THEN steps.`,
      );
      continue;
    }
    scenarios.push({
      id: raw.id,
      title: raw.title.trim() || `Scenario ${scenarios.length + 1}`,
      type: raw.type,
      given,
      when,
      then,
      elementIds: [
        ...new Set(
          raw.elementIds
            .map((id) => id.trim())
            .filter((id) => args.allElements.has(id)),
        ),
      ],
    });
  }
  const modelScenarios = scenarios.length > 0;
  if (!scenarios.length && args.fallbackScenarios) {
    scenarios = args.fallbackScenarios();
    notes.push(
      "The writer returned no usable scenarios — generated them from the screen inventory.",
    );
  }
  // Exactly one happy path, first. A negative or edge scenario is never promoted: it would get the
  // postconditions as THEN lines and contradict itself ("the inline error is shown" … "the user is signed in").
  let happyIndex = scenarios.findIndex((s) => s.type === "happy");
  if (happyIndex < 0 && scenarios.length) {
    const alternate = scenarios.findIndex((s) => s.type === "alternate");
    if (alternate >= 0) {
      scenarios[alternate] = { ...scenarios[alternate]!, type: "happy" };
      happyIndex = alternate;
      warnings.push(
        `No happy path was marked — treated the alternate scenario "${oneLine(scenarios[alternate]!.title, 50)}" as the happy path; check it.`,
      );
    } else {
      const fromInventory = args
        .fallbackScenarios?.()
        .find((s) => s.type === "happy");
      scenarios.unshift({
        ...(fromInventory ?? synthesisedHappyPath(title)),
        id: "",
      });
      happyIndex = 0;
      warnings.push(
        `The writer wrote no happy path (only negative/edge scenarios) — added one ${fromInventory ? "generated from the screen inventory" : "from the pre- and postconditions"}; check it.`,
      );
    }
  }
  if (happyIndex > 0 && !revising) {
    const [happy] = scenarios.splice(happyIndex, 1);
    scenarios.unshift(happy);
  }
  let seenHappy = false;
  scenarios = scenarios.map((s) => {
    if (s.type !== "happy") return s;
    if (!seenHappy) {
      seenHappy = true;
      return s;
    }
    return { ...s, type: "alternate" as const };
  });
  const chained = enforceHappyPath(scenarios, preconditions, postconditions);
  if (chained.changed)
    notes.push(
      "Aligned the happy path with the preconditions (GIVEN) and postconditions (final THEN).",
    );
  const numberedScenarios = assignItemIds(chained.scenarios, "SC", revising);

  // The model wrote "Identical to BR-02" / "see SC-03" with its own numbering; the ids above may differ
  // (omitted elements added, reading order, general rules last), so every reference follows its item.
  const ruleIds = itemIdMap(
    orderedRules.map((r) => [r.id, ...(mergedIds.get(r) ?? [])]),
    numberedRules.map((r) => r.id),
    "BR",
  );
  const scenarioIds = modelScenarios
    ? itemIdMap(
        chained.scenarios.map((s) => [s.id]),
        numberedScenarios.map((s) => s.id),
        "SC",
      )
    : new Map<number, string>();
  const remap = (text: string): string =>
    remapItemReferences(text, ruleIds, scenarioIds);
  const screenName = (screenId: string): string =>
    args.screens.find((s) => s.id === screenId)?.name ?? screenId;
  const businessRules = compactRepeatedRules(
    numberedRules.map((r) => ({
      ...r,
      description: remap(r.description),
      rules: r.rules.map(remap),
    })),
    own,
    screenName,
    (_rule, element) =>
      ruleFromElement(
        element,
        args.regionNameOf(element.regionId),
        args.screens,
      ),
  );
  const finalScenarios = numberedScenarios.map((s) => ({
    ...s,
    title: remap(s.title),
    given: s.given.map(remap),
    when: s.when.map(remap),
    then: s.then.map(remap),
  }));

  return {
    useCase: {
      ...uc,
      title,
      scope,
      story,
      preconditions,
      postconditions,
      businessRules,
      scenarios: finalScenarios,
      assumptions: dedupeText(output.assumptions.map(remap)),
      openQuestions: dedupeText(output.openQuestions.map(remap)),
      updatedAt: args.now ?? new Date().toISOString(),
    },
    addedRulesFor,
    notes,
    warnings,
  };
}

/* ── Prompt content ─────────────────────────────────────────────────── */

function neighbourBlock(uc: UseCase, model: SolutionModel): string {
  const own = new Set(uc.elementIds);
  const regions = new Set<string>();
  const elements = indexElements(model.screens);
  for (const id of uc.elementIds) {
    const e = elements.get(id);
    if (e) regions.add(e.regionId);
  }
  const owner = (id: string): UseCase | undefined =>
    model.useCases.find((u) => u.id !== uc.id && u.elementIds.includes(id));
  const lines: string[] = [];
  for (const e of elements.values()) {
    if (own.has(e.id) || !regions.has(e.regionId)) continue;
    const o = owner(e.id);
    lines.push(
      `- ${e.id} · ${e.type} · "${oneLine(e.label, 60)}"${o ? ` — owned by ${o.id} "${oneLine(o.title, 60)}"` : ""}`,
    );
    if (lines.length >= MAX_NEIGHBOURS) break;
  }
  if (!lines.length) return "";
  return [
    "# Neighbouring elements owned by other use cases (no rules for these; you may mention them in scenarios)",
    ...lines,
  ].join("\n");
}

function writerContent(
  args: WriteUseCaseArgs,
  elements: readonly UIElement[],
  screensById: Map<string, Screen>,
  revising: boolean,
): string {
  const { useCase: uc, model } = args;
  const regions = indexRegions(model.screens);
  const feature = model.features.find((f) => f.id === uc.featureId);
  const persona = model.personas.find((p) => p.id === uc.personaId);
  const screenNames = uc.screenIds.map(
    (id) =>
      `"${screensById.get(id)?.name ?? model.screens.find((a) => a.screenId === id)?.title ?? id}" (${id})`,
  );
  const openQuestions = dedupeText(
    model.screens
      .filter((a) => uc.screenIds.includes(a.screenId))
      .flatMap((a) => a.openQuestions),
  );
  // Screen-level facts (draft/cancel behaviour, page sizes, tax rules) often belong to no single element.
  const screenNotes = uc.screenIds
    .map((id) => screensById.get(id))
    .filter((s): s is Screen => Boolean(s?.notes.trim()))
    .map((s) => `- "${s.name}": ${screenNotesText(s.notes, "  ")}`);

  const lines = [
    `# Use case to write: ${uc.id}`,
    `Title: ${uc.title}`,
    feature
      ? `Feature: ${feature.name}${feature.description ? ` — ${feature.description}` : ""}`
      : "",
    persona
      ? `Persona: ${persona.name}${persona.description ? ` — ${oneLine(persona.description, 200)}` : ""}`
      : `Persona: ${uc.story.asA || "user"}`,
    `Screens: ${screenNames.join(", ")}`,
    `Regions: ${uc.regionIds.map((r) => regions.get(r)?.name ?? r).join(", ") || "(none)"}`,
    `Size: ${uc.size}`,
    `Scope: ${uc.scope}`,
    "",
    "Preconditions (copy verbatim, in this order):",
    ...uc.preconditions.map((p, i) => `${i + 1}. ${p}`),
    "Postconditions (copy verbatim, in this order):",
    ...uc.postconditions.map((p, i) => `${i + 1}. ${p}`),
    "",
    chainContextBlock(uc, model.useCases),
    "",
    `# Elements this use case is responsible for (${elements.length}) — exactly one business rule each`,
    ...elements.map((e) =>
      detailedElementBlock(e, regions.get(e.regionId)?.name ?? "", screensById),
    ),
    "",
    neighbourBlock(uc, model),
    screenNotes.length
      ? [
          "",
          "# BA notes for the screens of this use case (facts from the product owner — apply every one that concerns your elements or scenarios)",
          ...screenNotes,
        ].join("\n")
      : "",
    openQuestions.length
      ? [
          "",
          "# Open questions the screen analyst raised for these screens",
          ...openQuestions.map((q) => `- ${q}`),
        ].join("\n")
      : "",
  ];
  if (revising) {
    lines.push(
      "",
      "# Current content of this use case (revise it)",
      JSON.stringify(useCaseToWriterOutput(uc)),
      "",
      "# Revision notes — apply these precisely and keep everything else unchanged",
      args.revisionNotes?.trim() ?? "",
    );
  } else if (args.revisionNotes?.trim()) {
    lines.push("", "# Additional instructions", args.revisionNotes.trim());
  }
  return lines
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}

async function imagesFor(
  args: WriteUseCaseArgs,
  screensById: Map<string, Screen>,
): Promise<LLMImage[]> {
  const out: LLMImage[] = [];
  for (const screenId of args.useCase.screenIds.slice(0, MAX_IMAGE_SCREENS)) {
    const screen = screensById.get(screenId);
    if (!screen) continue;
    const version =
      args.model.screens.find((a) => a.screenId === screenId)?.screenVersion ??
      screen.version;
    try {
      out.push(
        ...(await prepareImageForLLM(
          screenImagePath(args.project.id, screen, version),
          { name: screen.name, maxTiles: 4 },
        )),
      );
    } catch (err) {
      if (err instanceof CancelledError || args.ctx.signal.aborted) throw err;
      args.ctx.log(
        "debug",
        `${args.useCase.id}: the image of "${screen.name}" could not be attached (${errorMessage(err)}) — writing from the inventory.`,
      );
    }
  }
  return out;
}

interface WriterSetup {
  revising: boolean;
  screens: Screen[];
  screensById: Map<string, Screen>;
  elements: UIElement[];
  allElements: Map<string, UIElement>;
  regionNameOf: (regionId: string) => string;
  granularity: Granularity;
  /** Deterministic content from the inventory alone. */
  offline: () => WriterOutput;
}

function setupWriter(
  args: Pick<
    WriteUseCaseArgs,
    "project" | "model" | "useCase" | "revisionNotes"
  >,
): WriterSetup {
  const { project, model, useCase: uc } = args;
  const screens = sortedScreens(project);
  const elements = useCaseElements(uc, model);
  const regions = indexRegions(model.screens);
  const regionNameOf = (regionId: string): string =>
    regions.get(regionId)?.name ?? "main";
  const granularity = model.options?.granularity ?? "balanced";
  const personaName =
    model.personas.find((p) => p.id === uc.personaId)?.name ??
    (uc.story.asA || "user");
  const screenOpenQuestions = model.screens
    .filter((a) => uc.screenIds.includes(a.screenId))
    .flatMap((a) => a.openQuestions);
  return {
    revising: Boolean(args.revisionNotes?.trim()) && hasContent(uc),
    screens,
    screensById: new Map(screens.map((s) => [s.id, s])),
    elements,
    allElements: indexElements(model.screens),
    regionNameOf,
    granularity,
    offline: () =>
      mockWriteUseCase({
        useCase: uc,
        elements,
        regionNameOf,
        screens,
        personaName,
        granularity,
        screenOpenQuestions,
        revisionNotes: args.revisionNotes,
      }),
  };
}

/**
 * Deterministic content built from the screen inventory alone — the fallback when the AI call for a use case
 * fails, so one failed call does not sink a whole generation. `reason` is recorded as an assumption.
 */
export function writeUseCaseFromInventory(
  args: Pick<WriteUseCaseArgs, "project" | "model" | "useCase">,
  reason: string,
): UseCase {
  const setup = setupWriter(args);
  const output = setup.offline();
  output.assumptions = dedupeText([
    `This use case was generated from the screen inventory only because the AI call failed (${oneLine(reason, 200)}). Revise it with AI or review it carefully.`,
    ...output.assumptions,
  ]);
  return finaliseWriterOutput({
    useCase: args.useCase,
    output,
    elements: setup.elements,
    allElements: setup.allElements,
    regionNameOf: setup.regionNameOf,
    screens: setup.screens,
    revising: false,
  }).useCase;
}

/**
 * Returns a NEW UseCase object (input not mutated) with content fields filled. Keeps id, slug, order,
 * featureId, personaId, screenIds, elementIds, dependsOn, external; sets updatedAt; does NOT bump revision
 * or status (callers decide). Does not persist.
 */
export async function writeUseCaseContent(
  args: WriteUseCaseArgs,
): Promise<UseCase> {
  const { ctx, project, useCase: uc, connection } = args;
  ctx.throwIfCancelled();
  const setup = setupWriter(args);
  const { revising, elements } = setup;

  const content: LLMContentPart[] = [
    {
      type: "text",
      text: writerContent(args, elements, setup.screensById, revising),
    },
  ];
  const useImages =
    args.includeImages &&
    !isMockConnection(connection) &&
    connectionSupportsVision(connection);
  if (useImages) {
    const images = await imagesFor(args, setup.screensById);
    if (images.length) {
      content.push({
        type: "text",
        text: "Screen image(s) of this use case (for layout, visible text and states; the inventory above lists the elements you own):",
      });
      for (const image of images) content.push({ type: "image", image });
    }
  }
  content.push({
    type: "text",
    text: revising
      ? `Revise ${uc.id} "${uc.title}" according to the revision notes. Keep the ids of rules and scenarios that still exist.`
      : `Write ${uc.id} "${uc.title}": user story, the planned pre/postconditions verbatim, one business rule per element listed (${elements.length}), and the BDD scenarios.`,
  });

  const output = await generateStructured({
    ...callBase(ctx, connection, `use-case-writer:${uc.id}`),
    system: writerSystem(
      project,
      args.format.writerGuidance,
      setup.granularity,
    ),
    content,
    schema: WriterOutputSchema,
    schemaName: "use_case",
    mock: () => {
      if (!revising) return setup.offline();
      // Offline mode cannot follow instructions: keep the current content and record what was asked.
      const current = useCaseToWriterOutput(uc);
      const note = `Offline demo mode recorded these revision instructions but cannot apply them: "${oneLine(args.revisionNotes ?? "", 200)}". Connect an AI model and revise again.`;
      return {
        ...current,
        assumptions: dedupeText([...current.assumptions, note]),
      };
    },
  });

  const result = finaliseWriterOutput({
    useCase: uc,
    output,
    elements,
    allElements: setup.allElements,
    regionNameOf: setup.regionNameOf,
    screens: setup.screens,
    revising,
    fallbackScenarios: () => setup.offline().scenarios.map((s) => ({ ...s })),
  });
  for (const note of result.notes) ctx.log("debug", `${uc.id}: ${note}`);
  for (const warning of result.warnings) ctx.warn(`${uc.id}: ${warning}`);
  if (result.addedRulesFor.length && !isMockConnection(connection)) {
    ctx.warn(
      `${uc.id}: the writer gave no business rule for ${result.addedRulesFor.length} element(s) (${result.addedRulesFor.slice(0, 6).join(", ")}${result.addedRulesFor.length > 6 ? ", …" : ""}) — added rules from the screen inventory.`,
    );
  }
  return result.useCase;
}
