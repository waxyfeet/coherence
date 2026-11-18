/**
 * OWNER: graph builder.
 * Offline Impact Analyst (provider 'mock'): deterministic, plausible output derived from the change and the
 * dependency trace, so the whole impact flow (analyse → stale → apply) works without any AI connection.
 * Also supplies fallback items when a real model skips a direct use case.
 */
import type {
  BddScenario,
  BusinessRule,
  ChangeRequest,
  DeterministicImpact,
  ElementChange,
  ImpactRelation,
  ImpactSeverity,
  SolutionModel,
  UIElement,
  UseCase,
  UseCaseSection,
} from "@shared/types";
import { matchFreeText, ownerForRegion, ownerForScreen } from "./graph";
import type { ImpactAnalystItem, ImpactAnalystOutput } from "./impactSchema";
import { relationOf } from "./impactPrompts";
import { indexModel, type ModelIndex } from "./modelIndex";
import { describeElementShort } from "./screenDiff";
import {
  elementName,
  joinList,
  keywordTokens,
  normaliseText,
  plural,
  stem,
  truncate,
  words,
} from "./text";

export interface MockImpactInput {
  model: SolutionModel;
  change: ChangeRequest;
  trace: DeterministicImpact;
}

export interface MockContext {
  ix: ModelIndex;
  change: ChangeRequest;
  trace: DeterministicImpact;
  relation: Map<string, ImpactRelation>;
  direct: Set<string>;
  /** Elements whose facts changed (affected elements, removed and modified ones). */
  changed: Set<string>;
  removed: Set<string>;
  modified: Map<string, ElementChange>;
  /** Use case id → elements added by a replaced screen that this use case would own. */
  addedByOwner: Map<string, UIElement[]>;
  /** "UC-003/BR-02" keys of rules matched by a free-text change. */
  freeRules: Set<string>;
  /** "from X to Y" extracted from the description, when present. */
  fromTo?: { from: string; to: string };
  /** Meaningful words of the description (stemmed, stop words removed). */
  keywords: Set<string>;
  /**
   * For a change to a whole use case or region (the trace marks all its elements as affected): the elements
   * of the rules the description is about. Undefined when nothing matches, or for other kinds of change.
   */
  focusElements?: Set<string>;
  /** The use case the BA edited (md-edit changes). */
  edited?: string;
  postconditionsChanged: boolean;
  preconditionsChanged: boolean;
}

function unquote(s: string): string {
  return s
    .trim()
    .replace(/^["'“‘`]+|["'”’`]+$/g, "")
    .trim();
}

/** "Change the minimum length from 8 to 12" / "'Login' → 'Sign in'" → { from, to }. */
export function extractFromTo(
  description: string,
): { from: string; to: string } | undefined {
  const m =
    /\bfrom\s+(.{1,80}?)\s+to\s+(.{1,80}?)(?:[.;!?\n]|,\s|$)/i.exec(
      description,
    ) ??
    /(["'“‘][^"'”’]{1,80}["'”’]|\S{1,40})\s*(?:→|->|=>)\s*(["'“‘][^"'”’]{1,80}["'”’]|\S{1,40})/.exec(
      description,
    );
  if (!m) return undefined;
  const from = unquote(m[1]);
  const to = unquote(m[2]);
  return from && to && from !== to ? { from, to } : undefined;
}

export function buildMockContext(input: MockImpactInput): MockContext {
  const { model, change, trace } = input;
  const ix = indexModel(model);
  const relation = relationOf(trace);
  const removed = new Set<string>();
  const modified = new Map<string, ElementChange>();
  const addedByOwner = new Map<string, UIElement[]>();
  if (change.screenDiff) {
    for (const el of change.screenDiff.removed) removed.add(el.id);
    for (const m of change.screenDiff.modified) modified.set(m.before.id, m);
    for (const el of change.screenDiff.added) {
      const owner =
        ownerForRegion(ix, el.regionId) ??
        ownerForScreen(ix, change.screenDiff.screenId);
      if (!owner) continue;
      const list = addedByOwner.get(owner) ?? [];
      list.push(el);
      addedByOwner.set(owner, list);
    }
  }
  const freeRules = new Set<string>();
  if (change.targetKind === "free") {
    for (const [uc, r] of matchFreeText(ix, change.description).rules)
      freeRules.add(`${uc}/${r}`);
  }
  const sections = change.useCaseDiff?.changedSections ?? [];
  const ctx: MockContext = {
    ix,
    change,
    trace,
    relation,
    direct: new Set(trace.directUseCaseIds),
    changed: new Set([
      ...trace.affectedElementIds,
      ...removed,
      ...modified.keys(),
    ]),
    removed,
    modified,
    addedByOwner,
    freeRules,
    fromTo: extractFromTo(change.description),
    keywords: new Set(keywordTokens(change.description)),
    edited: change.useCaseDiff?.useCaseId,
    postconditionsChanged: sections.includes("postconditions"),
    preconditionsChanged: sections.includes("preconditions"),
  };
  if (isBroadChange(change)) {
    const focus = new Set<string>();
    for (const id of trace.directUseCaseIds) {
      const uc = ix.useCaseById.get(id);
      for (const rule of uc ? focusRules(ctx, uc) : [])
        if (rule.elementId) focus.add(rule.elementId);
    }
    if (focus.size) ctx.focusElements = focus;
  }
  return ctx;
}

/** A change to a whole use case or region: the trace marks every element of it as affected. */
function isBroadChange(change: ChangeRequest): boolean {
  return (
    (change.targetKind === "usecase" && !change.useCaseDiff) ||
    change.targetKind === "region"
  );
}

const MAX_FOCUS_RULES = 3;
const MAX_FOCUS_SCENARIOS = 3;

/**
 * The items whose text shares meaningful words with `keywords`, best first: words weighted by how rare they
 * are among the items, numbers only supporting a word match, and only items close to the best score kept.
 */
export function relevantByKeywords<T>(
  items: readonly T[],
  text: (item: T) => string,
  keywords: ReadonlySet<string>,
  max: number,
): T[] {
  if (!keywords.size || !items.length) return [];
  const tokens = items.map((item) => new Set(keywordTokens(text(item))));
  const df = new Map<string, number>();
  for (const set of tokens)
    for (const t of set) if (keywords.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const scored = items
    .map((item, i) => {
      let wordScore = 0;
      let numbers = 0;
      for (const t of tokens[i]) {
        if (!keywords.has(t)) continue;
        const weight = Math.log(1 + items.length / (df.get(t) ?? 1));
        if (/^\d+$/.test(t)) numbers += weight / 2;
        else wordScore += weight;
      }
      return { item, i, score: wordScore > 0 ? wordScore + numbers : 0 };
    })
    .filter((s) => s.score > 0);
  const best = Math.max(0, ...scored.map((s) => s.score));
  return scored
    .filter((s) => s.score >= 0.5 * best)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .map((s) => s.item);
}

function ruleText(rule: BusinessRule): string {
  return [rule.element, rule.description, ...rule.rules].join(" ");
}

function scenarioText(sc: BddScenario): string {
  return [sc.title, ...sc.given, ...sc.when, ...sc.then].join(" ");
}

/** For a broad change: the few rules of `uc` its description is about (none when no rule matches). */
function focusRules(ctx: MockContext, uc: UseCase): BusinessRule[] {
  const candidates = uc.businessRules.filter((r) =>
    r.elementId
      ? ctx.changed.has(r.elementId)
      : ctx.change.targetKind === "usecase",
  );
  return relevantByKeywords(
    candidates,
    ruleText,
    ctx.keywords,
    MAX_FOCUS_RULES,
  );
}

const SEVERITY_RANK: Record<ImpactSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

function maxSeverity(a: ImpactSeverity, b: ImpactSeverity): ImpactSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

function happyPath(uc: UseCase): BddScenario | undefined {
  return uc.scenarios.find((s) => s.type === "happy") ?? uc.scenarios[0];
}

function scenarioLabel(sc: BddScenario): string {
  return `${sc.id} (${truncate(sc.title, 60)})`;
}

function ruleLabel(r: BusinessRule): string {
  return `${r.id} (${truncate(r.element, 60)})`;
}

function elementLabel(ix: ModelIndex, id: string): string {
  const el = ix.elementById.get(id);
  return el ? `“${truncate(elementName(el), 60)}”` : id;
}

class ItemBuilder {
  severity: ImpactSeverity = "none";
  readonly suggestions: string[] = [];
  readonly sections = new Set<UseCaseSection>();
  readonly rules = new Set<string>();
  readonly scenarios = new Set<string>();
  reasons: string[] = [];

  constructor(readonly uc: UseCase) {}

  raise(severity: ImpactSeverity) {
    this.severity = maxSeverity(this.severity, severity);
  }

  suggest(text: string, ...sections: UseCaseSection[]) {
    if (!this.suggestions.includes(text)) this.suggestions.push(text);
    for (const s of sections) this.sections.add(s);
  }

  build(): ImpactAnalystItem {
    return {
      useCaseId: this.uc.id,
      severity: this.severity,
      reason:
        this.reasons.join(" ") ||
        `${this.uc.id} is not affected by this change.`,
      suggestedChanges: this.suggestions,
      affectedSections: [...this.sections],
      affectedRuleIds: [...this.rules],
      affectedScenarioIds: [...this.scenarios],
    };
  }
}

function changeInstruction(ctx: MockContext): string {
  if (ctx.fromTo) return `change “${ctx.fromTo.from}” to “${ctx.fromTo.to}”`;
  const desc = ctx.change.description.trim();
  return desc
    ? `update to reflect: ${truncate(desc, 160)}`
    : "update to match the changed design";
}

function phraseRegExp(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
}

/**
 * The line of the rule the change is about: the one holding the "from" text, else the best keyword match,
 * else the one sharing most longer words ("minimum", "characters" — too common for keyword matching), else the first.
 */
function currentRuleLine(
  ctx: MockContext,
  rule: BusinessRule,
): string | undefined {
  const from = ctx.fromTo ? phraseRegExp(ctx.fromTo.from) : undefined;
  const byFrom = from && rule.rules.find((line) => from.test(line));
  if (byFrom) return byFrom;
  const byKeyword = relevantByKeywords(
    rule.rules,
    (line) => line,
    ctx.keywords,
    1,
  )[0];
  if (byKeyword) return byKeyword;
  const described = new Set(
    words(ctx.change.description)
      .filter((w) => w.length > 3)
      .map(stem),
  );
  let best = rule.rules[0];
  let bestShared = 0;
  for (const line of rule.rules) {
    const shared = new Set(
      words(line)
        .map(stem)
        .filter((w) => described.has(w)),
    ).size;
    if (shared > bestShared) [best, bestShared] = [line, shared];
  }
  return best;
}

/** "BR-02 (Password): currently “Minimum 8 characters” — change “8” to “12” (“Minimum 12 characters”)" */
function ruleChange(ctx: MockContext, rule: BusinessRule): string {
  const line = currentRuleLine(ctx, rule);
  const current = line ? `currently “${truncate(line, 120)}” — ` : "";
  if (ctx.fromTo) {
    const { from, to } = ctx.fromTo;
    const after = line?.replace(phraseRegExp(from), () => to);
    return `${ruleLabel(rule)}: ${current}change “${from}” to “${to}”${after && after !== line ? ` (“${truncate(after, 120)}”)` : ""}`;
  }
  const desc = ctx.change.description.trim();
  return `${ruleLabel(rule)}: ${current}${desc ? `rewrite it for the change “${truncate(desc, 160)}”` : "update it to match the changed design"}`;
}

function directItem(ctx: MockContext, uc: UseCase): ImpactAnalystItem {
  const { ix, change } = ctx;
  const b = new ItemBuilder(uc);

  // The BA's own edit: it is the new truth; only check it is internally consistent.
  if (ctx.edited === uc.id) {
    const d = change.useCaseDiff!;
    b.raise("low");
    b.reasons.push(
      `${uc.id} is the use case you edited${d.summary ? ` (${truncate(d.summary, 160)})` : ""}; its new content is the source of this change.`,
    );
    const happy = happyPath(uc);
    const sections = d.changedSections;
    if (sections.includes("rules") && !sections.includes("scenarios")) {
      const sc = uc.scenarios.filter((s) => s.type === "negative");
      const targets = sc.length ? sc : uc.scenarios;
      for (const s of targets.slice(0, 4)) b.scenarios.add(s.id);
      b.suggest(
        `Scenarios: make ${
          targets
            .slice(0, 4)
            .map((s) => s.id)
            .join(", ") || "the scenarios"
        } use the limits and messages of the edited business rules`,
        "scenarios",
      );
    }
    if (ctx.postconditionsChanged && happy) {
      b.scenarios.add(happy.id);
      b.suggest(
        `${scenarioLabel(happy)}: end with THEN lines that state the new postconditions verbatim (${uc.postconditions.map((p) => `“${p}”`).join(", ")})`,
        "scenarios",
      );
    }
    if (ctx.preconditionsChanged && happy) {
      b.scenarios.add(happy.id);
      b.suggest(
        `${scenarioLabel(happy)}: start the GIVEN with the new preconditions verbatim`,
        "scenarios",
      );
    }
    return b.build();
  }

  const instruction = changeInstruction(ctx);
  const touched = (ix.useCaseElements.get(uc.id) ?? []).filter((id) =>
    ctx.changed.has(id),
  );
  // A broad change only reaches the rules (and their elements) its description is about.
  const broad = isBroadChange(change);
  const focus = broad ? focusRules(ctx, uc) : [];
  const focusIds = new Set(focus.map((r) => r.id));
  const touchedSet = new Set(
    broad
      ? focus.map((r) => r.elementId).filter((id): id is string => !!id)
      : touched,
  );

  // Rules governing changed elements
  for (const rule of uc.businessRules) {
    if (
      broad
        ? !focusIds.has(rule.id)
        : !rule.elementId || !touchedSet.has(rule.elementId)
    )
      continue;
    b.rules.add(rule.id);
    if (rule.elementId && ctx.removed.has(rule.elementId)) {
      b.raise("high");
      b.suggest(
        `${ruleLabel(rule)}: remove this rule — the element is no longer on the screen`,
        "rules",
        "elements",
      );
    } else if (rule.elementId && ctx.modified.has(rule.elementId)) {
      b.raise("high");
      b.suggest(
        `${ruleLabel(rule)}: update for the new design — ${ctx.modified.get(rule.elementId)!.changes.join("; ")}`,
        "rules",
      );
    } else {
      b.raise(
        change.targetKind === "usecase" || change.targetKind === "free"
          ? "medium"
          : "high",
      );
      b.suggest(ruleChange(ctx, rule), "rules");
    }
  }

  // The targeted rule / scenario itself
  const targetPart = change.targetId?.split("/") ?? [];
  if (change.targetKind === "rule" && targetPart[0] === uc.id) {
    const rule = uc.businessRules.find((r) => r.id === targetPart[1]);
    if (rule) {
      b.raise("high");
      b.rules.add(rule.id);
      b.suggest(ruleChange(ctx, rule), "rules");
      if (rule.elementId) touchedSet.add(rule.elementId);
    }
  }
  if (change.targetKind === "scenario" && targetPart[0] === uc.id) {
    const sc = uc.scenarios.find((s) => s.id === targetPart[1]);
    if (sc) {
      b.raise("high");
      b.scenarios.add(sc.id);
      b.suggest(`${scenarioLabel(sc)}: ${instruction}`, "scenarios");
    }
  }
  for (const rule of uc.businessRules) {
    if (!ctx.freeRules.has(`${uc.id}/${rule.id}`) || b.rules.has(rule.id))
      continue;
    b.raise("medium");
    b.rules.add(rule.id);
    b.suggest(ruleChange(ctx, rule), "rules");
    if (rule.elementId) touchedSet.add(rule.elementId);
  }

  // Scenarios exercising changed elements (for a broad change: the few it is about, best match first)
  const inScope = uc.scenarios.filter(
    (sc) =>
      change.targetKind === "usecase" ||
      sc.elementIds.some((id) => ctx.changed.has(id)),
  );
  const scenarios = broad
    ? [
        ...new Set([
          ...relevantByKeywords(
            inScope,
            scenarioText,
            ctx.keywords,
            MAX_FOCUS_SCENARIOS,
          ),
          ...inScope.filter((sc) =>
            sc.elementIds.some((id) => touchedSet.has(id)),
          ),
        ]),
      ].slice(0, MAX_FOCUS_SCENARIOS)
    : uc.scenarios;
  for (const sc of scenarios) {
    const hits = sc.elementIds.filter((id) => touchedSet.has(id));
    if (!hits.length) {
      if (!broad) continue;
      b.raise("medium");
      b.scenarios.add(sc.id);
      b.suggest(
        `${scenarioLabel(sc)}: update the steps and expected outcomes for the change “${truncate(change.description.trim(), 160)}”`,
        "scenarios",
      );
      continue;
    }
    b.scenarios.add(sc.id);
    const names = joinList(hits.map((id) => elementLabel(ix, id)));
    if (hits.some((id) => ctx.removed.has(id))) {
      b.raise("high");
      b.suggest(
        `${scenarioLabel(sc)}: remove or rewrite the steps that use ${names}`,
        "scenarios",
      );
    } else {
      b.raise("medium");
      b.suggest(
        `${scenarioLabel(sc)}: align the steps and expected outcomes with the changed ${names}`,
        "scenarios",
      );
    }
  }

  // Elements added by a replaced screen that land in this use case
  const added = ctx.addedByOwner.get(uc.id) ?? [];
  if (added.length) {
    b.raise("medium");
    for (const el of added) {
      b.suggest(
        `Add a business rule for the new ${describeElementShort(el)}${el.behavior ? ` — ${truncate(el.behavior, 120)}` : ""}`,
        "rules",
        "elements",
      );
    }
    b.suggest(
      `Add a scenario that exercises ${joinList(added.map((el) => `“${truncate(elementName(el), 60)}”`))}`,
      "scenarios",
    );
  }

  // Reason + kind-specific fallbacks
  const screenTitle = (id: string | undefined) =>
    id ? (ix.screenById.get(id)?.title ?? id) : "";
  switch (change.targetKind) {
    case "element": {
      b.raise("high");
      const ruleIds = [...b.rules];
      b.reasons.push(
        `${uc.id} covers ${elementLabel(ix, change.targetId ?? "")}, the element being changed${ruleIds.length ? ` (described in ${ruleIds.join(", ")})` : ""}.`,
      );
      break;
    }
    case "region": {
      b.raise("high");
      const region = ix.regionById.get(
        (change.targetId ?? "").replace(/#region$/, ""),
      );
      b.reasons.push(
        `${uc.id} covers ${plural(touched.length, "element")} of the ${region ? `“${region.name}”` : ""} region being changed.`,
      );
      break;
    }
    case "screen": {
      if (change.screenDiff) {
        const removedHere = touched.filter((id) => ctx.removed.has(id));
        const modifiedHere = touched.filter((id) => ctx.modified.has(id));
        const parts: string[] = [];
        if (removedHere.length)
          parts.push(
            `uses removed ${joinList(removedHere.map((id) => elementLabel(ix, id)))}`,
          );
        if (modifiedHere.length)
          parts.push(
            `covers changed ${joinList(modifiedHere.map((id) => elementLabel(ix, id)))}`,
          );
        if (added.length)
          parts.push(
            `should own the new ${joinList(added.map((el) => `“${truncate(elementName(el), 60)}”`))}`,
          );
        b.reasons.push(
          `On the new version of ${screenTitle(change.screenDiff.screenId)}, ${uc.id} ${joinList(parts, parts.length) || "is affected"}.`,
        );
      } else {
        b.raise("medium");
        b.reasons.push(
          `${uc.id} appears on ${screenTitle(change.targetId)}, the screen being changed.`,
        );
      }
      break;
    }
    case "usecase":
      b.raise("high");
      b.reasons.push(
        `${uc.id} is the use case being changed${focus.length ? `; the change concerns ${joinList(focus.map(ruleLabel))}` : ""}.`,
      );
      break;
    case "rule":
      b.reasons.push(`${change.targetId} is the business rule being changed.`);
      break;
    case "scenario":
      b.reasons.push(`${change.targetId} is the scenario being changed.`);
      break;
    case "feature": {
      b.raise("medium");
      b.reasons.push(`${uc.id} belongs to the feature being changed.`);
      b.suggest(
        `Review this use case against the feature change: ${truncate(change.description, 120)}`,
        "rules",
      );
      break;
    }
    case "persona": {
      b.raise("medium");
      const persona = ix.personaById.get(change.targetId ?? "");
      b.reasons.push(
        `${uc.id} is performed by ${persona ? persona.name : "the persona"} being changed.`,
      );
      b.suggest(
        `Story: update “As a ${uc.story.asA}” to reflect the persona change — ${truncate(change.description, 120)}`,
        "story",
      );
      break;
    }
    case "free": {
      b.raise("medium");
      const hits = [...touched.map((id) => elementLabel(ix, id)), ...b.rules];
      b.reasons.push(
        `${uc.id} matches the change${hits.length ? ` through ${joinList([...new Set(hits)])}` : " by its title"}.`,
      );
      break;
    }
  }

  const happy = happyPath(uc);
  if (!b.suggestions.length) {
    b.suggest(`Business rules: ${instruction}`, "rules");
    if (happy) {
      b.scenarios.add(happy.id);
      b.suggest(
        `${scenarioLabel(happy)}: adjust the steps and outcomes affected by the change`,
        "scenarios",
      );
    }
  } else if (broad && focus.length && !b.scenarios.size && happy) {
    b.scenarios.add(happy.id);
    b.suggest(
      `${scenarioLabel(happy)}: re-check the steps and outcomes against the revised ${joinList(focus.map((r) => r.id))}`,
      "scenarios",
    );
  }
  if (b.severity === "none") b.raise("medium");
  return b.build();
}

function downstreamItem(ctx: MockContext, uc: UseCase): ImpactAnalystItem {
  const { ix } = ctx;
  const b = new ItemBuilder(uc);
  const preds = uc.dependsOn.filter((d) => ctx.direct.has(d));
  const inherited = uc.preconditions[0];
  const happy = happyPath(uc);
  if (preds.length) {
    const p = ix.useCaseById.get(ix.sortUseCases(preds)[0])!;
    if (ctx.edited === p.id && ctx.postconditionsChanged) {
      const stillMatches =
        !!inherited &&
        p.postconditions.some(
          (x) => normaliseText(x) === normaliseText(inherited),
        );
      if (!stillMatches) {
        b.raise("high");
        b.reasons.push(
          `${uc.id} inherits ${inherited ? `“${inherited}”` : "its starting state"} from ${p.id}, whose postconditions were edited — the chain is broken until the precondition is updated.`,
        );
        if (p.postconditions[0]) {
          b.suggest(
            `Preconditions: replace ${inherited ? `“${inherited}”` : "the first precondition"} with ${p.id}'s new postcondition “${p.postconditions[0]}”`,
            "preconditions",
          );
        }
      } else {
        b.raise("medium");
        b.reasons.push(
          `${p.id}'s postconditions were edited; ${uc.id}'s inherited precondition “${inherited}” still matches, but its scenarios may rely on the changed outcomes.`,
        );
      }
      if (happy) {
        b.scenarios.add(happy.id);
        b.suggest(
          `${scenarioLabel(happy)}: start the GIVEN with the updated precondition and re-check steps that rely on ${p.id}'s outcome`,
          "scenarios",
        );
      }
    } else {
      b.raise("low");
      b.reasons.push(
        `${uc.id} depends on ${p.id}${inherited ? ` and inherits “${inherited}”` : ""}; it only changes if ${p.id}'s postconditions change.`,
      );
      if (inherited)
        b.suggest(
          `Preconditions: confirm “${inherited}” still matches a postcondition of ${p.id} after the change`,
          "preconditions",
        );
    }
  } else {
    b.raise("low");
    const path =
      ctx.trace.paths
        .find((x) => x.useCaseId === uc.id)
        ?.path.filter((id) => ix.useCaseById.has(id)) ?? [];
    b.reasons.push(
      `${uc.id} is further down the chain${path.length > 1 ? ` (${path.join(" → ")})` : ""}; it is affected only if the use cases in between change their postconditions.`,
    );
    if (inherited)
      b.suggest(
        `Preconditions: keep “${inherited}” in step with ${uc.dependsOn.join(", ")}`,
        "preconditions",
      );
  }
  return b.build();
}

function upstreamItem(ctx: MockContext, uc: UseCase): ImpactAnalystItem {
  const { ix } = ctx;
  const b = new ItemBuilder(uc);
  const dependents = ix.sortUseCases(
    (ix.dependents.get(uc.id) ?? []).filter((id) => ctx.direct.has(id)),
  );
  const d = dependents[0] ? ix.useCaseById.get(dependents[0]) : undefined;
  if (d && ctx.edited === d.id && ctx.preconditionsChanged) {
    b.raise("medium");
    b.reasons.push(
      `${d.id}'s preconditions were edited, and ${uc.id} must still establish them.`,
    );
    if (d.preconditions[0]) {
      b.suggest(
        `Postconditions: make sure one postcondition reads exactly “${d.preconditions[0]}”`,
        "postconditions",
      );
      const happy = happyPath(uc);
      if (happy) {
        b.scenarios.add(happy.id);
        b.suggest(
          `${scenarioLabel(happy)}: end with THEN “${d.preconditions[0]}”`,
          "scenarios",
        );
      }
    }
  } else {
    b.reasons.push(
      `${uc.id} establishes the starting state of ${d?.id ?? "the changed use case"}; the change does not need a different starting state.`,
    );
  }
  return b.build();
}

function relatedItem(
  ctx: MockContext,
  uc: UseCase,
): ImpactAnalystItem | undefined {
  const { ix } = ctx;
  const shared = (ix.useCaseElements.get(uc.id) ?? []).filter(
    (id) =>
      ctx.changed.has(id) && (!ctx.focusElements || ctx.focusElements.has(id)),
  );
  if (!shared.length) return undefined; // only shares a screen (or elements the change is not about) — nothing to check
  const b = new ItemBuilder(uc);
  const names = joinList(shared.map((id) => elementLabel(ix, id)));
  b.raise(shared.some((id) => ctx.removed.has(id)) ? "medium" : "low");
  b.reasons.push(
    `${uc.id} also covers ${names}; its description must stay consistent with the change.`,
  );
  for (const rule of uc.businessRules) {
    if (!rule.elementId || !shared.includes(rule.elementId)) continue;
    b.rules.add(rule.id);
    b.suggest(
      ctx.removed.has(rule.elementId)
        ? `${ruleLabel(rule)}: remove — the element is no longer on the screen`
        : `${ruleLabel(rule)}: apply the same change so both use cases describe ${elementLabel(ix, rule.elementId)} identically`,
      "rules",
    );
  }
  return b.build();
}

/** Deterministic item for one use case of the trace (undefined when there is nothing worth saying). */
export function mockItemFor(
  ctx: MockContext,
  useCaseId: string,
  relation: ImpactRelation,
): ImpactAnalystItem | undefined {
  const uc = ctx.ix.useCaseById.get(useCaseId);
  if (!uc) return undefined;
  switch (relation) {
    case "direct":
      return directItem(ctx, uc);
    case "downstream":
      return downstreamItem(ctx, uc);
    case "upstream":
      return upstreamItem(ctx, uc);
    case "related":
      return relatedItem(ctx, uc);
  }
}

function mockRisks(ctx: MockContext, items: ImpactAnalystItem[]): string[] {
  const { ix, change, trace } = ctx;
  const risks: string[] = [];
  const affected = items
    .filter((i) => i.severity !== "none")
    .map((i) => ix.useCaseById.get(i.useCaseId)!)
    .filter(Boolean);

  if (!trace.directUseCaseIds.length) {
    risks.push(
      "The change could not be linked to any existing use case — check the wording, or pick the element or use case in the graph so the trace is precise.",
    );
  }
  const exported = affected.filter((uc) => uc.external.length);
  if (exported.length) {
    const refs = exported.flatMap((uc) =>
      uc.external.map((x) => `${uc.id} → ${x.key}`),
    );
    risks.push(
      `Already exported work items will be out of date until you export again: ${joinList(refs, 5)}.`,
    );
  }
  if (ctx.postconditionsChanged && trace.downstreamUseCaseIds.length) {
    risks.push(
      `${plural(trace.downstreamUseCaseIds.length, "use case")} further down the chain (${joinList(trace.downstreamUseCaseIds, 5)}) inherit the edited postconditions; a missed precondition update breaks the build order.`,
    );
  }
  if (change.screenDiff?.removed.length) {
    risks.push(
      `Removing ${joinList(change.screenDiff.removed.map(describeElementShort))} drops behaviour developers may already have built — confirm with the product owner before applying.`,
    );
  }
  if (change.screenDiff?.added.length) {
    risks.push(
      `New ${change.screenDiff.added.length === 1 ? "element" : "elements"} on the screen (${joinList(change.screenDiff.added.map(describeElementShort))}) ${change.screenDiff.added.length === 1 ? "has" : "have"} no business rules until the impact is applied.`,
    );
  }
  const approved = affected.filter((uc) => uc.status === "approved");
  if (approved.length)
    risks.push(
      `${joinList(
        approved.map((uc) => uc.id),
        5,
      )} ${approved.length === 1 ? "was" : "were"} approved and will need to be reviewed and approved again.`,
    );
  const edited = items
    .filter(
      (i) =>
        (i.severity === "high" || i.severity === "medium") &&
        i.useCaseId !== ctx.edited,
    )
    .map((i) => ix.useCaseById.get(i.useCaseId))
    .filter((uc): uc is UseCase => uc?.status === "edited");
  if (edited.length)
    risks.push(
      `${joinList(
        edited.map((uc) => uc.id),
        5,
      )} ${edited.length === 1 ? "contains" : "contain"} manual edits; applying the impact rewrites ${edited.length === 1 ? "it" : "them"} — review the result.`,
    );
  return risks.slice(0, 6);
}

function mockSuggestedUseCases(
  ctx: MockContext,
): ImpactAnalystOutput["suggestedNewUseCases"] {
  const { ix, change, trace } = ctx;
  const out: ImpactAnalystOutput["suggestedNewUseCases"] = [];
  if (change.screenDiff) {
    // Added elements sitting in a region the model has never seen: likely new functionality.
    const byRegion = new Map<string, UIElement[]>();
    for (const el of change.screenDiff.added) {
      if (ix.regionById.has(el.regionId)) continue;
      const list = byRegion.get(el.regionId) ?? [];
      list.push(el);
      byRegion.set(el.regionId, list);
    }
    const screenTitle =
      ix.screenById.get(change.screenDiff.screenId)?.title ?? "the screen";
    for (const [regionId, els] of byRegion) {
      const regionName =
        regionId.split(".").pop()?.replace(/[_-]+/g, " ") ?? "new section";
      out.push({
        title: `Use the ${regionName} section on ${screenTitle}`,
        reason: `The new version adds ${plural(els.length, "element")} in a section no use case covers yet (${joinList(els.map(describeElementShort))}).`,
        screenIds: [change.screenDiff.screenId],
      });
    }
  } else if (!trace.directUseCaseIds.length && change.description.trim()) {
    const desc = change.description.trim().replace(/\s+/g, " ");
    out.push({
      title: truncate(desc.charAt(0).toUpperCase() + desc.slice(1), 80),
      reason:
        "No existing use case covers this — it looks like new functionality that deserves its own use case.",
      screenIds: trace.affectedScreenIds,
    });
  }
  return out;
}

export function mockSummary(
  ctx: MockContext,
  items: ImpactAnalystItem[],
): string {
  const { trace, change } = ctx;
  const subject = change.screenDiff
    ? change.screenDiff.summary.replace(/\.$/, "")
    : change.useCaseDiff
      ? `The edit of ${change.useCaseDiff.useCaseId}`
      : `The change “${truncate(change.description.trim() || "as described", 120)}”`;
  if (
    change.screenDiff &&
    !change.screenDiff.added.length &&
    !change.screenDiff.removed.length &&
    !change.screenDiff.modified.length
  ) {
    return `${subject}. The specs remain valid; applying this report records the new image as analysed.`;
  }
  if (!trace.directUseCaseIds.length && !items.length) {
    return `${subject} could not be traced to any existing use case. Pick the element or use case it concerns, or add a new use case for it.`;
  }
  const worst = items
    .filter((i) => i.severity === "high")
    .map((i) => i.useCaseId);
  const sentences = [
    `${subject} directly affects ${plural(trace.directUseCaseIds.length, "use case")}${trace.directUseCaseIds.length ? ` (${joinList(trace.directUseCaseIds, 5)})` : ""}.`,
  ];
  if (trace.downstreamUseCaseIds.length) {
    sentences.push(
      `${plural(trace.downstreamUseCaseIds.length, "use case")} further down the chain ${trace.downstreamUseCaseIds.length === 1 ? "depends" : "depend"} on ${trace.directUseCaseIds.length === 1 ? "it" : "them"}.`,
    );
  }
  sentences.push(
    worst.length
      ? `Most work: ${joinList(worst, 5)}.`
      : "No use case needs a full rewrite.",
  );
  return sentences.join(" ");
}

/** The offline Impact Analyst. Output satisfies impactAnalystSchema. */
export function mockImpactAnalysis(
  input: MockImpactInput,
): ImpactAnalystOutput {
  const ctx = buildMockContext(input);
  const items: ImpactAnalystItem[] = [];
  for (const [ucId, relation] of ctx.relation) {
    const item = mockItemFor(ctx, ucId, relation);
    if (item) items.push(item);
  }
  return {
    summary: mockSummary(ctx, items),
    items,
    risks: mockRisks(ctx, items),
    suggestedNewUseCases: mockSuggestedUseCases(ctx),
  };
}
