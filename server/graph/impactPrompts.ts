/**
 * OWNER: graph builder.
 * Prompts for the Impact Analyst agent. The system prompt is static (prompt-cache friendly); everything
 * specific to the project and the change goes into the user turn, built by buildImpactUserPrompt.
 */
import type {
  ChangeRequest,
  DeterministicImpact,
  ImpactRelation,
  Project,
  SolutionModel,
  UIElement,
  UseCase,
} from "@shared/types";
import type { OutputFormat } from "../formats/types";
import { indexModel, type ModelIndex } from "./modelIndex";
import { elementDisplayLabel, elementTypeWords, truncate } from "./text";

export const IMPACT_ANALYST_SYSTEM_PROMPT = `You are a senior business analyst assessing the knock-on effect of ONE change on a chained use-case specification. Developers and coding agents build from this specification in order, so a missed impact becomes a defect.

## How the specification hangs together
- The solution is specified as use cases (UC-001, UC-002, …), each with: a user story; preconditions; postconditions; business rules (BR-01, BR-02, … — one per screen element, describing the element and EVERY rule that governs it: mandatory/optional, validation with concrete limits, all dropdown/radio options verbatim, defaults, enabled/disabled conditions, behaviour, navigation, exact messages); and BDD scenarios (SC-01, SC-02, … in GIVEN / WHEN / AND / THEN form; SC-01 is the happy path).
- Use cases are CHAINED. A use case lists the use cases it depends on; its first precondition is a verbatim copy of a postcondition of one of them, and its happy-path GIVEN starts with its preconditions. The happy path's final THEN lines state the use case's own postconditions verbatim.
  Consequence: when a postcondition changes, every dependent's inherited precondition and the GIVEN lines of its scenarios must change with it — and so on down the chain if the dependent's own postconditions change as a result.
- Screens are broken into elements; several use cases can cover the same element (e.g. a shared navigation bar), and every use case lists the screens it appears on.

## Your input
1. The change: what is changing, in the business analyst's words or derived from a replaced screen image (element added / removed / modified, field by field) or from the BA's edit of a use case file (changed sections and details).
2. A deterministic dependency trace that already buckets the use cases:
   - direct: own or cover the changed thing;
   - downstream: consume (transitively) the postconditions of the direct ones;
   - upstream: establish the preconditions of the direct ones;
   - related: share an element or a screen with the direct ones.
   Plus the shortest dependency path explaining each bucket.
3. The chain (dependencies, preconditions, postconditions), the affected screen elements, and the full content of the impacted use cases.

## What to produce
For EVERY use case in the trace, one item:
- severity:
  - high — the use case is now wrong or incomplete and must be rewritten: a rule, scenario, precondition or postcondition contradicts the change, or the element it describes no longer exists;
  - medium — some sections must be updated, but its goal and flow still hold;
  - low — worth a check; at most a wording or reference update;
  - none — not affected (still give a one-line reason).
- reason: one or two plain-language sentences a product owner understands: what breaks in this use case and why, naming the rule, scenario, precondition or postcondition concerned.
- suggestedChanges: concrete, ready-to-apply edits, each starting with the id or section it touches. Good:
  "BR-02: change the minimum length from 8 to 12 characters and the inline error to 'Use at least 12 characters'"
  "SC-03: change the WHEN value to an 11-character password and keep THEN 'the inline error … is shown'"
  "Preconditions: replace 'The user is signed in' with 'The user is signed in with a verified email address'"
  "Add a scenario: user selects 'Other' in Country and must fill 'Country name'"
  "Remove BR-04 (Remember me) and the AND step that ticks it in SC-01"
  Bad (never write these): "Review the use case", "Update as needed", "Consider the impact".
- affectedSections: the sections that must change (title, story, scope, preconditions, postconditions, rules, scenarios, assumptions, openQuestions, notes, dependencies, elements, status).
- affectedRuleIds / affectedScenarioIds: the EXISTING ids in THAT use case that must change (e.g. "BR-02", "SC-03"). A rule or scenario that has to be added goes into suggestedChanges, not into these lists.

## How to judge
- Walk the chain explicitly. If a direct use case's postconditions change, its immediate dependents are at least medium (their inherited first precondition and SC-01 GIVEN change); go further down only when their own postconditions change as a result.
- Direct use cases are usually high or medium. A purely cosmetic change (colour, spacing, icon) that alters no label, rule, option, message or flow is low.
- Removed elements: their business rules must be deleted and every scenario step using them rewritten — high for the owning use case. Added elements: the owning use case needs a new business rule and at least one scenario — medium or high.
- Upstream use cases change only when the direct use case now needs a different starting state.
- Related use cases are affected only when a shared element's rules, options or messages actually change — then keep both use cases consistent (same wording, same limits).
- Look for second-order effects: messages quoted in several scenarios, options referenced by other rules, navigation targets that move, data captured on one screen and displayed on another.
- When the change leaves a business decision open (e.g. what happens to existing users with an 8-character password), say so in the item's suggestedChanges as an open question to add, and list it as a risk.

## Rules
- Only use use case ids, rule ids, scenario ids and screen ids that appear in the input. Never invent ids in items.
- Genuinely new functionality that no existing use case should absorb goes into suggestedNewUseCases (verb-first title, reason, screen ids from the screen list). Leave it empty when existing use cases can absorb the change.
- risks: specific delivery and quality risks a product owner should know (broken chain, exported work items now out of date, data or migration questions, validation regressions, inconsistent messages across screens, unresolved policy). At most 6. No generic platitudes.
- summary: 2–4 sentences: what changes, how many use cases are affected, and which need the most work.
- Write in the same language as the specification. Be precise and concise.`;

const RELATION_LABEL: Record<ImpactRelation, string> = {
  direct: "direct",
  downstream: "downstream",
  upstream: "upstream",
  related: "related",
};

const SOURCE_LABEL: Record<ChangeRequest["source"], string> = {
  manual: "Change requested by the business analyst",
  "md-edit": "The business analyst edited a use case file",
  "screen-replace": "A screen image was replaced with a new version",
};

/** Characters of rendered use case content we are willing to send before falling back to summaries. */
const FULL_CONTENT_BUDGET = 150_000;

export interface ImpactPromptInput {
  project: Project;
  model: SolutionModel;
  change: ChangeRequest;
  trace: DeterministicImpact;
  /** Used to render use cases compactly (the BA's own format); falls back to a plain summary. */
  format?: OutputFormat;
}

export function relationOf(
  trace: DeterministicImpact,
): Map<string, ImpactRelation> {
  const map = new Map<string, ImpactRelation>();
  for (const id of trace.directUseCaseIds) map.set(id, "direct");
  for (const id of trace.downstreamUseCaseIds)
    if (!map.has(id)) map.set(id, "downstream");
  for (const id of trace.upstreamUseCaseIds)
    if (!map.has(id)) map.set(id, "upstream");
  for (const id of trace.relatedUseCaseIds)
    if (!map.has(id)) map.set(id, "related");
  return map;
}

/** A plain one-paragraph description of an element with every functional fact the analyst needs. */
export function describeElementForPrompt(
  el: UIElement,
  ix: ModelIndex | undefined,
  extra?: { regionName?: string; screenTitle?: string },
): string {
  const screen =
    extra?.screenTitle ?? ix?.screenById.get(el.screenId)?.title ?? el.screenId;
  const region = extra?.regionName ?? ix?.regionById.get(el.regionId)?.name;
  const facts: string[] = [];
  facts.push(
    `${el.id} — ${elementDisplayLabel(el)} on ${screen}${region ? ` / ${region}` : ""}`,
  );
  if (el.description) facts.push(truncate(el.description, 240));
  if (el.required !== undefined)
    facts.push(el.required ? "required" : "optional");
  if (el.placeholder) facts.push(`placeholder "${el.placeholder}"`);
  if (el.defaultValue) facts.push(`default "${el.defaultValue}"`);
  if (el.helperText) facts.push(`helper text "${el.helperText}"`);
  if (el.options?.length)
    facts.push(`options: ${el.options.map((o) => `"${o}"`).join(", ")}`);
  if (el.validation?.length)
    facts.push(`validation: ${el.validation.join("; ")}`);
  if (el.states?.length) facts.push(`states: ${el.states.join(", ")}`);
  if (el.behavior) facts.push(`behaviour: ${truncate(el.behavior, 240)}`);
  if (el.navigatesToScreenId)
    facts.push(
      `navigates to ${ix?.screenById.get(el.navigatesToScreenId)?.title ?? el.navigatesToScreenId}`,
    );
  else if (el.navigatesToHint) facts.push(`navigates to ${el.navigatesToHint}`);
  if (el.dataBinding) facts.push(`data: ${el.dataBinding}`);
  return facts.join("; ");
}

/** Compact plain-text version of a use case (used for related use cases and when rendering fails). */
export function compactUseCaseText(uc: UseCase, ix: ModelIndex): string {
  const lines: string[] = [];
  lines.push(
    `${uc.id} · ${uc.title} (status ${uc.status}, size ${uc.size}, revision ${uc.revision})`,
  );
  lines.push(
    `Story: As a ${uc.story.asA}, I want to ${uc.story.iWant}, so that ${uc.story.soThat}`,
  );
  if (uc.scope) lines.push(`Scope: ${uc.scope}`);
  lines.push(
    `Depends on: ${uc.dependsOn.join(", ") || "none"}; leads to: ${(ix.dependents.get(uc.id) ?? []).join(", ") || "none"}`,
  );
  lines.push(
    `Preconditions: ${uc.preconditions.map((p) => `"${p}"`).join("; ") || "none"}`,
  );
  lines.push(
    `Postconditions: ${uc.postconditions.map((p) => `"${p}"`).join("; ") || "none"}`,
  );
  lines.push(`Elements: ${uc.elementIds.join(", ") || "none"}`);
  lines.push("Business rules:");
  for (const r of uc.businessRules) {
    lines.push(
      `- ${r.id} · ${r.element} — ${elementTypeWords(r.elementType)}${r.elementId ? ` [${r.elementId}]` : ""}: ${r.rules.map((x) => truncate(x, 200)).join(" | ")}`,
    );
  }
  lines.push("Scenarios:");
  for (const s of uc.scenarios) {
    lines.push(
      `- ${s.id} · ${s.title} (${s.type}): GIVEN ${s.given.join(" AND ")} WHEN ${s.when.join(" AND ")} THEN ${s.then.join(" THEN ")}`,
    );
  }
  return lines.join("\n");
}

function summaryUseCaseText(uc: UseCase, ix: ModelIndex): string {
  const rules = uc.businessRules.map((r) => `${r.id} ${r.element}`).join(", ");
  const scenarios = uc.scenarios.map((s) => `${s.id} ${s.title}`).join(", ");
  return [
    `${uc.id} · ${uc.title} (status ${uc.status})`,
    `Preconditions: ${uc.preconditions.map((p) => `"${p}"`).join("; ") || "none"}`,
    `Postconditions: ${uc.postconditions.map((p) => `"${p}"`).join("; ") || "none"}`,
    `Elements: ${(ix.useCaseElements.get(uc.id) ?? []).join(", ") || "none"}`,
    `Rules: ${rules || "none"}`,
    `Scenarios: ${scenarios || "none"}`,
  ].join("\n");
}

/** The BA's own markdown for a use case, without YAML front matter (the chain is given separately). */
function renderedUseCase(
  uc: UseCase,
  input: ImpactPromptInput,
  ix: ModelIndex,
): string {
  if (input.format) {
    try {
      const md = input.format.renderUseCase(uc, {
        project: input.project,
        model: input.model,
        embedScreenImages: false,
      });
      return md.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
    } catch {
      // A rendering problem must not block the impact analysis — the compact form carries the same facts.
    }
  }
  return compactUseCaseText(uc, ix);
}

function describeTarget(change: ChangeRequest, ix: ModelIndex): string {
  const id = change.targetId ?? "";
  switch (change.targetKind) {
    case "element": {
      const el = ix.elementById.get(id);
      return el
        ? `element ${describeElementForPrompt(el, ix)}`
        : `element ${id}`;
    }
    case "screen": {
      const s = ix.screenById.get(id) ?? ix.screenByKey.get(id);
      return s
        ? `screen ${s.screenId} — ${s.title} (${s.elements.length} elements)`
        : `screen ${id}`;
    }
    case "region": {
      const r = ix.regionById.get(id.replace(/#region$/, ""));
      return r
        ? `region ${r.id} — ${r.name} on ${ix.screenById.get(r.screenId)?.title ?? r.screenId}`
        : `region ${id}`;
    }
    case "usecase": {
      const uc = ix.useCaseById.get(id);
      return uc ? `use case ${uc.id} · ${uc.title}` : `use case ${id}`;
    }
    case "rule":
      return `business rule ${id}`;
    case "scenario":
      return `scenario ${id}`;
    case "persona": {
      const p = ix.personaById.get(id);
      return p ? `persona ${p.id} — ${p.name}` : `persona ${id}`;
    }
    case "free":
      return "not pinned to one item (free-text change)";
    default:
      return id;
  }
}

export function buildImpactUserPrompt(input: ImpactPromptInput): string {
  const { project, model, change, trace } = input;
  const ix = indexModel(model);
  const relation = relationOf(trace);
  const out: string[] = [];

  out.push("# Project");
  out.push(`Name: ${project.name}`);
  if (project.description) out.push(`Description: ${project.description}`);
  if (project.additionalContext)
    out.push(`Additional context: ${project.additionalContext}`);
  if (model.summary) out.push(`Solution summary: ${model.summary}`);
  if (model.personas.length)
    out.push(
      `Personas: ${model.personas.map((p) => `${p.id} (${p.name})`).join(", ")}`,
    );

  out.push("", "# Screens");
  for (const s of model.screens) {
    out.push(
      `- ${s.screenId} · ${s.title} (key ${s.screenKey}, ${s.screenType}, version ${s.screenVersion}, ${s.elements.length} elements)`,
    );
  }

  out.push("", "# The change");
  out.push(`Source: ${SOURCE_LABEL[change.source]}`);
  out.push(`Target: ${describeTarget(change, ix)}`);
  out.push(
    `Description: ${change.description.trim() || "(none given — derive it from the details below)"}`,
  );

  if (change.screenDiff) {
    const d = change.screenDiff;
    const screenTitle = ix.screenById.get(d.screenId)?.title ?? d.screenId;
    out.push(
      "",
      `## Screen diff — ${screenTitle}, version ${d.fromVersion} → ${d.toVersion}`,
    );
    out.push(d.summary);
    const pending = change.screenDiff;
    if (pending.added.length) {
      out.push("Added elements (not yet in any use case):");
      for (const el of pending.added)
        out.push(`- ${describeElementForPrompt(el, ix, { screenTitle })}`);
    }
    if (pending.removed.length) {
      out.push("Removed elements (no longer on the screen):");
      for (const el of pending.removed)
        out.push(`- ${describeElementForPrompt(el, ix, { screenTitle })}`);
    }
    if (pending.modified.length) {
      out.push("Modified elements (same id, new facts):");
      for (const m of pending.modified)
        out.push(
          `- ${m.before.id} “${m.after.label || m.before.label}”: ${m.changes.join("; ")}`,
        );
    }
  }

  if (change.useCaseDiff) {
    const d = change.useCaseDiff;
    out.push("", `## Use case edit — ${d.useCaseId}`);
    out.push(`Changed sections: ${d.changedSections.join(", ") || "none"}`);
    if (d.summary) out.push(`Summary: ${d.summary}`);
    if (d.details.length) {
      out.push("Details:");
      for (const line of d.details.slice(0, 80))
        out.push(`- ${truncate(line, 400)}`);
    }
    if (d.changedSections.includes("postconditions")) {
      out.push(
        `Note: ${d.useCaseId}'s postconditions changed — its dependents inherit them as their first precondition.`,
      );
    }
    out.push(
      `The content of ${d.useCaseId} below is the BA's NEW version; it is the source of truth for this change.`,
    );
  }

  out.push("", "# Deterministic dependency trace");
  const list = (ids: string[]) =>
    ids.length
      ? ids
          .map((id) => `${id} (${ix.useCaseById.get(id)?.title ?? "?"})`)
          .join(", ")
      : "none";
  out.push(
    `Direct (own or cover the changed thing): ${list(trace.directUseCaseIds)}`,
  );
  out.push(
    `Downstream (consume their postconditions, transitively): ${list(trace.downstreamUseCaseIds)}`,
  );
  out.push(
    `Upstream (the direct ones depend on them): ${list(trace.upstreamUseCaseIds)}`,
  );
  out.push(
    `Related (share elements or screens): ${list(trace.relatedUseCaseIds)}`,
  );
  if (trace.paths.length) {
    out.push("Why (shortest dependency paths, seed → … → use case):");
    for (const p of trace.paths)
      out.push(`- ${p.useCaseId}: ${p.path.join(" → ")}`);
  }

  const impacted = [
    ...trace.directUseCaseIds,
    ...trace.downstreamUseCaseIds,
    ...trace.upstreamUseCaseIds,
    ...trace.relatedUseCaseIds,
  ]
    .map((id) => ix.useCaseById.get(id))
    .filter((uc): uc is UseCase => !!uc);

  if (impacted.length) {
    out.push("", "# Chain");
    for (const uc of impacted) {
      out.push(
        `- ${uc.id} · ${uc.title} [${RELATION_LABEL[relation.get(uc.id) ?? "related"]}] depends on ${uc.dependsOn.join(", ") || "nothing"}; leads to ${(ix.dependents.get(uc.id) ?? []).join(", ") || "nothing"}`,
      );
      out.push(
        `  Preconditions: ${uc.preconditions.map((p) => `"${p}"`).join("; ") || "none"}`,
      );
      out.push(
        `  Postconditions: ${uc.postconditions.map((p) => `"${p}"`).join("; ") || "none"}`,
      );
    }
  }

  if (trace.affectedElementIds.length) {
    out.push("", "# Affected elements (current specification)");
    for (const id of trace.affectedElementIds.slice(0, 60)) {
      const el = ix.elementById.get(id);
      if (!el) continue;
      const covering = ix.coveringUseCases.get(id) ?? [];
      out.push(
        `- ${describeElementForPrompt(el, ix)}; covered by ${covering.join(", ") || "no use case"}`,
      );
    }
    if (trace.affectedElementIds.length > 60)
      out.push(`- … and ${trace.affectedElementIds.length - 60} more elements`);
  }

  const fullIds = [
    ...trace.directUseCaseIds,
    ...trace.downstreamUseCaseIds,
    ...trace.upstreamUseCaseIds,
  ];
  let budget = FULL_CONTENT_BUDGET;
  const fullSections: string[] = [];
  const summarySections: string[] = [];
  for (const id of fullIds) {
    const uc = ix.useCaseById.get(id);
    if (!uc) continue;
    const isDirect = relation.get(id) === "direct";
    const text = renderedUseCase(uc, input, ix);
    if (isDirect || text.length <= budget) {
      budget -= text.length;
      fullSections.push(
        `## ${uc.id} [${RELATION_LABEL[relation.get(id) ?? "related"]}]\n\n${text}`,
      );
    } else {
      summarySections.push(
        `## ${uc.id} [${RELATION_LABEL[relation.get(id) ?? "related"]}]\n${summaryUseCaseText(uc, ix)}`,
      );
    }
  }
  for (const id of trace.relatedUseCaseIds) {
    const uc = ix.useCaseById.get(id);
    if (uc)
      summarySections.push(
        `## ${uc.id} [related]\n${summaryUseCaseText(uc, ix)}`,
      );
  }
  if (fullSections.length)
    out.push(
      "",
      "# Impacted use cases — full content",
      "",
      fullSections.join("\n\n"),
    );
  if (summarySections.length)
    out.push(
      "",
      "# Further use cases in the trace — summary",
      "",
      summarySections.join("\n\n"),
    );

  out.push("", "# Your task");
  if (impacted.length) {
    out.push(
      `Return exactly one item for each of these use cases: ${impacted.map((uc) => uc.id).join(", ")}. You may add an item for another existing use case only if the trace missed a real impact.`,
    );
  } else {
    out.push(
      "The trace found no use case linked to this change. Decide whether any of these existing use cases is affected (use only these ids), and propose new use cases if the change introduces new functionality:",
    );
    for (const uc of ix.useCases)
      out.push(
        `- ${uc.id} · ${uc.title} (screens: ${(ix.useCaseScreens.get(uc.id) ?? []).map((s) => ix.screenById.get(s)?.title ?? s).join(", ") || "none"})`,
      );
  }
  out.push(
    "Use concrete suggested changes that reference BR-/SC- ids, then the risks, suggested new use cases and the summary.",
  );
  return out.join("\n");
}
