/**
 * OWNER: formats builder.
 * Derived report files: REVIEW.md, CHANGELOG.md, QUESTIONS.md, TRACEABILITY.md, DATA-DICTIONARY.md and
 * BUILD-PLAN.md. All are rendered from the model on every write and never parsed back.
 */
import type {
  ChangeLogKind,
  ElementType,
  ReviewFinding,
  ReviewSeverity,
  UIElement,
  UseCase,
} from "@shared/types";
import {
  escapeCell,
  inlineCode,
  isoDateTime,
  mdLink,
  normaliseBlock,
  oneLine,
  orDash,
  percent,
  plural,
  table,
  truncate,
} from "../markdown";
import { relativeLink, type Lookup } from "./lookup";
import { featureGroups } from "./readme";
import {
  featureFilePath,
  generatedMarker,
  statusLabel,
  ucLinkLabel,
  ucLinks,
} from "./shared";
import { elementTypeLabel } from "./vocabulary";

const code = (id: string) => inlineCode(id).replace(/\|/g, "\\|");

/* ------------------------------------------------------------------ */
/* REVIEW.md                                                           */
/* ------------------------------------------------------------------ */

const SEVERITY_TITLE: Record<ReviewSeverity, string> = {
  error: "Errors",
  warning: "Warnings",
  info: "Information",
};

export function renderReview(lookup: Lookup): string {
  const file = "REVIEW.md";
  const { review } = lookup.ctx.model;
  const open = review.filter((f) => !f.resolved);
  const resolved = review.filter((f) => f.resolved);
  const out = [generatedMarker(), "# Review findings"];
  if (!review.length) {
    out.push(
      "_The reviewer found nothing to flag: chains, coverage and consistency checks all passed._",
    );
    return `${out.join("\n\n")}\n`;
  }
  const count = (sev: ReviewSeverity) =>
    open.filter((f) => f.severity === sev).length;
  out.push(
    `_${plural(open.length, "open finding")} (${plural(count("error"), "error")} · ${plural(count("warning"), "warning")} · ` +
      `${count("info")} info) · ${resolved.length} resolved. Errors should be fixed before the use cases are exported._`,
  );
  const rows = (items: ReviewFinding[]) =>
    items.map((f) => [
      f.id,
      escapeCell(f.category),
      orDash(ucLinks(lookup, f.useCaseIds, file)),
      escapeCell(f.message),
      escapeCell(orDash(f.suggestion)),
    ]);
  for (const sev of ["error", "warning", "info"] as ReviewSeverity[]) {
    const items = open.filter((f) => f.severity === sev);
    if (items.length)
      out.push(
        `## ${SEVERITY_TITLE[sev]}\n\n${table(["ID", "Category", "Use cases", "Finding", "Suggestion"], rows(items))}`,
      );
  }
  if (resolved.length) {
    out.push(
      `## Resolved\n\n${table(["ID", "Category", "Use cases", "Finding", "Suggestion"], rows(resolved))}`,
    );
  }
  return `${out.join("\n\n")}\n`;
}

/* ------------------------------------------------------------------ */
/* CHANGELOG.md                                                        */
/* ------------------------------------------------------------------ */

const KIND_LABEL: Record<ChangeLogKind, string> = {
  generated: "Generated",
  edited: "Edited",
  synced: "Synced from disk",
  "impact-analysed": "Impact analysed",
  "impact-applied": "Impact applied",
  "screen-replaced": "Screen replaced",
  "screen-reanalysed": "Screen re-analysed",
  exported: "Exported",
  rerendered: "Re-rendered",
};

export function renderChangelog(lookup: Lookup): string {
  const file = "CHANGELOG.md";
  const entries = [...lookup.ctx.model.changeLog]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.at < b.e.at ? 1 : a.e.at > b.e.at ? -1 : b.i - a.i))
    .map((x) => x.e);
  const out = [generatedMarker(), "# Change log"];
  if (!entries.length) {
    out.push("_No changes recorded yet._");
    return `${out.join("\n\n")}\n`;
  }
  const zone =
    /\((UTC[^)]*)\)$/.exec(isoDateTime(entries[0].at))?.[1] ?? "local time";
  out.push(`_Newest first. Times are local (${zone})._`);
  let currentDay = "";
  let lines: string[] = [];
  const flush = () => {
    if (lines.length) out.push(`## ${currentDay}\n\n${lines.join("\n")}`);
    lines = [];
  };
  for (const entry of entries) {
    const stamp = isoDateTime(entry.at);
    const day = stamp.slice(0, 10) || "Undated";
    if (day !== currentDay) {
      flush();
      currentDay = day;
    }
    const time = stamp.slice(11, 16);
    const ids = entry.useCaseIds.slice(0, 12);
    const more = entry.useCaseIds.length - ids.length;
    const ucs = ids.length
      ? ` · ${ucLinks(lookup, ids, file)}${more > 0 ? ` and ${more} more` : ""}`
      : "";
    const report = entry.reportId ? ` · impact report ${entry.reportId}` : "";
    lines.push(
      `- **${time ? `${time} · ` : ""}${KIND_LABEL[entry.kind] ?? entry.kind}** — ${oneLine(entry.summary) || "—"}${ucs}${report}`,
    );
  }
  flush();
  return `${out.join("\n\n")}\n`;
}

/* ------------------------------------------------------------------ */
/* QUESTIONS.md                                                        */
/* ------------------------------------------------------------------ */

export function renderQuestions(lookup: Lookup): string {
  const file = "QUESTIONS.md";
  const { model } = lookup.ctx;
  const ucWith = lookup.orderedUseCases.filter(
    (uc) => uc.openQuestions.length || uc.assumptions.length,
  );
  const screensWith = lookup.orderedAnalyses.filter(
    (a) => a.openQuestions.length,
  );
  const ambiguity = model.review.filter(
    (f) => !f.resolved && f.category === "ambiguity",
  );
  const questionCount =
    model.useCases.reduce((n, uc) => n + uc.openQuestions.length, 0) +
    model.screens.reduce((n, a) => n + a.openQuestions.length, 0);
  const assumptionCount = model.useCases.reduce(
    (n, uc) => n + uc.assumptions.length,
    0,
  );
  const out = [generatedMarker(), "# Open questions & assumptions"];
  out.push(
    `_A checklist for stakeholder review: ${plural(questionCount, "open question")} and ${plural(assumptionCount, "assumption")} ` +
      'to confirm. Answer the questions, then update the use case files (or use "Revise with AI") and tick them off here in your own copy._',
  );
  if (!ucWith.length && !screensWith.length && !ambiguity.length) {
    out.push(
      "_Nothing to confirm — no open questions or assumptions were recorded._",
    );
    return `${out.join("\n\n")}\n`;
  }
  if (ucWith.length) {
    const blocks = ["## By use case"];
    for (const uc of ucWith) {
      const parts = [`### ${ucLinkLabel(lookup, uc, file)}`];
      if (uc.openQuestions.length)
        parts.push(
          `**Open questions**\n\n${uc.openQuestions.map((q) => `- [ ] ${oneLine(q)}`).join("\n")}`,
        );
      if (uc.assumptions.length)
        parts.push(
          `**Assumptions to confirm**\n\n${uc.assumptions.map((a) => `- [ ] ${oneLine(a)}`).join("\n")}`,
        );
      blocks.push(parts.join("\n\n"));
    }
    out.push(blocks.join("\n\n"));
  }
  if (screensWith.length) {
    const blocks = ["## From screen analysis"];
    for (const a of screensWith) {
      blocks.push(
        `### ${mdLink(lookup.screenName(a.screenId), lookup.screenDocPath(a.screenId))}\n\n${a.openQuestions.map((q) => `- [ ] ${oneLine(q)}`).join("\n")}`,
      );
    }
    out.push(blocks.join("\n\n"));
  }
  if (ambiguity.length) {
    const lines = ambiguity.map((f) => {
      const ucs = f.useCaseIds.length
        ? ` (${ucLinks(lookup, f.useCaseIds, file)})`
        : "";
      return `- [ ] ${oneLine(f.message)}${ucs}${f.suggestion ? ` — _${oneLine(f.suggestion)}_` : ""}`;
    });
    out.push(`## Ambiguities flagged by the reviewer\n\n${lines.join("\n")}`);
  }
  return `${out.join("\n\n")}\n`;
}

/* ------------------------------------------------------------------ */
/* TRACEABILITY.md                                                     */
/* ------------------------------------------------------------------ */

export function renderTraceability(lookup: Lookup): string {
  const file = "TRACEABILITY.md";
  const all = lookup.orderedAnalyses.flatMap((a) => a.elements);
  const uncovered = all.filter((e) => !lookup.coverage.has(e.id));
  const out = [generatedMarker(), "# Traceability matrix"];
  out.push(
    `_Every UI element × the use cases, business rules and BDD scenarios that cover it. ${all.length - uncovered.length} of ` +
      `${all.length} elements covered (${percent(all.length - uncovered.length, all.length)})._`,
  );
  if (!all.length) {
    out.push("_No screens have been analysed yet._");
    return `${out.join("\n\n")}\n`;
  }

  if (uncovered.length) {
    const rows = uncovered.map((e) => [
      code(e.id),
      mdLink(lookup.screenName(e.screenId), lookup.screenDocPath(e.screenId)),
      escapeCell(elementTypeLabel(e.type)),
      escapeCell(orDash(e.label)),
    ]);
    out.push(
      `## Uncovered elements\n\n**${plural(uncovered.length, "element")} not covered by any use case.** Add them to a use case (front matter \`elements\`) or regenerate.\n\n${table(["Element", "Screen", "Type", "Label"], rows)}`,
    );
  } else {
    out.push(
      "## Uncovered elements\n\nEvery element is covered by at least one use case.",
    );
  }

  // Rule / scenario references per element, keyed "UC-003 BR-02".
  const rulesByElement = new Map<string, string[]>();
  const scenariosByElement = new Map<string, string[]>();
  for (const uc of lookup.orderedUseCases) {
    for (const r of uc.businessRules) {
      if (!r.elementId) continue;
      rulesByElement.set(r.elementId, [
        ...(rulesByElement.get(r.elementId) ?? []),
        `${uc.id} ${r.id}`,
      ]);
    }
    for (const sc of uc.scenarios) {
      for (const el of sc.elementIds) {
        scenariosByElement.set(el, [
          ...(scenariosByElement.get(el) ?? []),
          `${uc.id} ${sc.id}`,
        ]);
      }
    }
  }

  for (const a of lookup.orderedAnalyses) {
    const rows = a.elements.map((e) => {
      const covering = lookup.coverage.get(e.id) ?? [];
      return [
        covering.length ? code(e.id) : `**${code(e.id)}**`,
        escapeCell(elementTypeLabel(e.type)),
        escapeCell(orDash(e.label)),
        covering.length ? ucLinks(lookup, covering, file) : "**Not covered**",
        escapeCell(orDash((rulesByElement.get(e.id) ?? []).join(", "))),
        escapeCell(orDash(compactRefs(scenariosByElement.get(e.id) ?? []))),
      ];
    });
    out.push(
      `## ${mdLink(lookup.screenName(a.screenId), lookup.screenDocPath(a.screenId))}\n\n${
        rows.length
          ? table(
              [
                "Element",
                "Type",
                "Label",
                "Use cases",
                "Business rules",
                "Scenarios",
              ],
              rows,
            )
          : "_No elements._"
      }`,
    );
  }

  const summary = lookup.orderedUseCases.map((uc) => [
    ucLinkLabel(lookup, uc, file),
    orDash(
      uc.screenIds
        .map((id) => mdLink(lookup.screenName(id), lookup.screenDocPath(id)))
        .join(", "),
    ),
    String(uc.elementIds.length),
    String(uc.businessRules.length),
    String(uc.scenarios.length),
  ]);
  if (summary.length) {
    out.push(
      `## Use case summary\n\n${table(["Use case", "Screens", "Elements", "Business rules", "Scenarios"], summary)}`,
    );
  }
  return `${out.join("\n\n")}\n`;
}

/** ["UC-001 SC-01", "UC-001 SC-02", "UC-004 SC-03"] → "UC-001 SC-01, SC-02; UC-004 SC-03" */
function compactRefs(refs: string[]): string {
  const byUc = new Map<string, string[]>();
  for (const ref of refs) {
    const [uc, item] = ref.split(" ");
    byUc.set(uc, [...(byUc.get(uc) ?? []), item]);
  }
  return [...byUc]
    .map(([uc, items]) => `${uc} ${[...new Set(items)].join(", ")}`)
    .join("; ");
}

/* ------------------------------------------------------------------ */
/* DATA-DICTIONARY.md                                                  */
/* ------------------------------------------------------------------ */

const INPUT_TYPES = new Set<ElementType>([
  "text_input",
  "email_input",
  "password_input",
  "number_input",
  "phone_input",
  "currency_input",
  "textarea",
  "dropdown",
  "multi_select",
  "combobox",
  "checkbox",
  "radio_group",
  "toggle",
  "date_picker",
  "time_picker",
  "date_range_picker",
  "slider",
  "file_upload",
  "rich_text_editor",
]);

/** Business data type implied by the element that captures or shows a field. */
export function dataTypeFor(e: UIElement): string {
  switch (e.type) {
    case "email_input":
      return "Email address";
    case "password_input":
      return "Password (secret)";
    case "number_input":
      return "Number";
    case "currency_input":
      return "Currency amount";
    case "phone_input":
      return "Phone number";
    case "date_picker":
      return "Date";
    case "time_picker":
      return "Time";
    case "date_range_picker":
      return "Date range";
    case "checkbox":
    case "toggle":
      return "Yes / No";
    case "dropdown":
    case "radio_group":
    case "combobox":
    case "tabs":
      return "One of a list";
    case "multi_select":
      return "Several of a list";
    case "file_upload":
      return "File";
    case "textarea":
    case "rich_text_editor":
      return "Text (multi-line)";
    case "slider":
      return "Number (range)";
    case "table":
    case "list":
      return "Collection";
    case "text_input":
    case "search_input":
      return "Text";
    default:
      return `Displayed (${elementTypeLabel(e.type).toLowerCase()})`;
  }
}

interface Field {
  name: string;
  elements: UIElement[];
}

export function renderDataDictionary(lookup: Lookup): string {
  const file = "DATA-DICTIONARY.md";
  const entityNames = new Map<string, string>(); // lower-case key → display name
  const entityScreens = new Map<string, Set<string>>();
  for (const a of lookup.orderedAnalyses) {
    for (const raw of a.dataEntities) {
      const name = oneLine(raw);
      if (!name) continue;
      const key = name.toLowerCase();
      if (!entityNames.has(key)) entityNames.set(key, name);
      entityScreens.set(
        key,
        (entityScreens.get(key) ?? new Set()).add(a.screenId),
      );
    }
  }

  const fields = new Map<string, Map<string, Field>>(); // entity key → field key → field
  const unbound: UIElement[] = [];
  for (const a of lookup.orderedAnalyses) {
    for (const e of a.elements) {
      const binding = oneLine(e.dataBinding);
      if (!binding) {
        if (INPUT_TYPES.has(e.type)) unbound.push(e);
        continue;
      }
      const { entity, field } = splitBinding(binding, entityNames);
      const key = entity.toLowerCase();
      if (!entityNames.has(key)) entityNames.set(key, entity);
      entityScreens.set(
        key,
        (entityScreens.get(key) ?? new Set()).add(a.screenId),
      );
      const byField = fields.get(key) ?? new Map<string, Field>();
      const fieldKey = field.toLowerCase();
      const f = byField.get(fieldKey) ?? { name: field, elements: [] };
      f.elements.push(e);
      byField.set(fieldKey, f);
      fields.set(key, byField);
    }
  }

  const out = [generatedMarker(), "# Data dictionary"];
  out.push(
    "_Business entities seen on the screens and the fields each screen captures or displays (from the element data " +
      "bindings). Types and validation are taken from the UI design — confirm them with the data owner._",
  );
  if (!entityNames.size && !unbound.length) {
    out.push("_No business entities or data fields were identified._");
    return `${out.join("\n\n")}\n`;
  }

  const keys = [...entityNames.keys()].sort((a, b) =>
    entityNames.get(a)!.localeCompare(entityNames.get(b)!),
  );
  if (keys.length) {
    const overview = keys.map((k) => [
      escapeCell(entityNames.get(k)!),
      String(fields.get(k)?.size ?? 0),
      orDash(
        [...(entityScreens.get(k) ?? [])]
          .map((id) => mdLink(lookup.screenName(id), lookup.screenDocPath(id)))
          .join(", "),
      ),
    ]);
    out.push(
      `## Entities\n\n${table(["Entity", "Fields", "Screens"], overview)}`,
    );
  }

  for (const k of keys) {
    const byField = fields.get(k);
    const heading = `## ${oneLine(entityNames.get(k)!)}`;
    if (!byField?.size) {
      out.push(
        `${heading}\n\n_Shown on the screens, but no individual fields are captured or displayed._`,
      );
      continue;
    }
    out.push(
      `${heading}\n\n${fieldTable(lookup, [...byField.values()], file)}`,
    );
  }

  if (unbound.length) {
    out.push(
      "## Input fields without a data binding\n\n_These inputs capture data but the analysis could not tell which entity " +
        `it belongs to._\n\n${fieldTable(
          lookup,
          unbound.map((e) => ({ name: e.label || e.key, elements: [e] })),
          file,
        )}`,
    );
  }
  return `${out.join("\n\n")}\n`;
}

function fieldTable(lookup: Lookup, fieldList: Field[], file: string): string {
  const rows = fieldList.map((f) => {
    const first = f.elements[0];
    const validation = [
      ...new Set(
        f.elements.flatMap((e) => [
          ...(e.required ? ["Required"] : []),
          ...(e.validation ?? []).map(oneLine),
          ...(e.options?.length
            ? [`Options: ${e.options.map((o) => `"${oneLine(o)}"`).join(", ")}`]
            : []),
        ]),
      ),
    ];
    const screens = [...new Set(f.elements.map((e) => e.screenId))];
    return [
      escapeCell(f.name),
      escapeCell(dataTypeFor(first)),
      f.elements.map((e) => code(e.id)).join(", "),
      escapeCell(orDash(validation.join("; "))),
      orDash(
        screens
          .map((id) =>
            mdLink(
              lookup.screenName(id),
              relativeLink(file, lookup.screenDocPath(id)),
            ),
          )
          .join(", "),
      ),
    ];
  });
  return table(
    ["Field", "Type", "Source elements", "Validation & options", "Screens"],
    rows,
  );
}

/** "customer.email" → Customer / email; "order total" → Order / total (when Order is a known entity). */
export function splitBinding(
  binding: string,
  known: Map<string, string>,
): { entity: string; field: string } {
  // "order[]" — the element shows the whole list of an entity (a table or list).
  const list = /^([A-Za-z][\w-]*)\[\]$/.exec(binding.trim());
  if (list) return { entity: resolveEntity(list[1], known), field: "(list)" };
  const dot = binding.indexOf(".");
  if (dot > 0 && dot < binding.length - 1) {
    const entityRaw = binding.slice(0, dot).trim();
    return {
      entity: resolveEntity(entityRaw, known),
      field: binding.slice(dot + 1).trim(),
    };
  }
  const lower = binding.toLowerCase();
  const match = [...known.keys()]
    .filter((k) => lower === k || lower.startsWith(`${k} `))
    .sort((a, b) => b.length - a.length)[0];
  if (match && lower !== match)
    return {
      entity: known.get(match)!,
      field: binding.slice(match.length).trim(),
    };
  return { entity: "Other data", field: binding };
}

const compactName = (text: string): string =>
  text.toLowerCase().replace(/[\s_-]+/g, "");

/**
 * A binding prefix → the entity the screens named: "orderLine" → "Order line", "orders" → "Order", "user" →
 * "User account" (when that is the only entity starting with it); otherwise the prefix in Title Case.
 */
function resolveEntity(raw: string, known: Map<string, string>): string {
  const exact = compactName(raw);
  const singular =
    exact.length > 3 && exact.endsWith("s") && !exact.endsWith("ss")
      ? exact.slice(0, -1)
      : exact;
  for (const [key, name] of known)
    if (compactName(key) === exact || compactName(key) === singular)
      return name;
  const extended = [...known].filter(([key]) =>
    compactName(key).startsWith(singular),
  );
  if (extended.length === 1) return extended[0][1];
  return titleCase(raw);
}

function titleCase(text: string): string {
  return text
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/* ------------------------------------------------------------------ */
/* BUILD-PLAN.md                                                       */
/* ------------------------------------------------------------------ */

/** Build waves: wave n = use cases whose dependencies are all in earlier waves (parallelisable). */
export function buildWaves(useCases: UseCase[]): UseCase[][] {
  const ids = new Set(useCases.map((uc) => uc.id));
  const level = new Map<string, number>();
  const byId = new Map(useCases.map((uc) => [uc.id, uc]));
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const known = level.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // cycle guard — the planner removes cycles, hand edits might not
    visiting.add(id);
    const uc = byId.get(id);
    const deps = (uc?.dependsOn ?? []).filter((d) => ids.has(d) && d !== id);
    const value = deps.length ? Math.max(...deps.map(depth)) + 1 : 0;
    visiting.delete(id);
    level.set(id, value);
    return value;
  };
  const waves: UseCase[][] = [];
  for (const uc of useCases) {
    const d = depth(uc.id);
    (waves[d] ??= []).push(uc);
  }
  return waves.filter(Boolean);
}

export function renderBuildPlan(lookup: Lookup): string {
  const file = "BUILD-PLAN.md";
  const { project } = lookup.ctx;
  const useCases = lookup.orderedUseCases;
  const out = [generatedMarker(), "# Build plan"];
  out.push(
    `_${oneLine(project.name)} — ${plural(useCases.length, "use case")} in build order._`,
  );
  out.push(
    [
      "## How to use these specs",
      "",
      "- **One use case = one unit of work.** Each use case is small enough to build, review and test on its own. Build them in the order below.",
      "- **Dependencies first.** A use case's preconditions are the postconditions of the use cases it depends on — finish those first.",
      '- **Business rules are the requirements.** Every rule under "Business rules" is a testable statement about one UI element (labels, validation, options, states, messages, navigation).',
      "- **BDD scenarios are the acceptance tests.** They are also available as Gherkin in `features/` for Cucumber, SpecFlow or playwright-bdd; a use case is done when all its scenarios pass.",
      "- **Screens show the layout.** Each use case links to its screen documents (element inventory + image) in `screens/`.",
      "- **Open questions block nothing but must be answered.** See QUESTIONS.md; assumptions are marked so they can be confirmed later.",
      "",
      "**For coding agents:** for each step, read the use case file, the linked screen documents and the feature file; implement only that use case; make its scenarios pass; then continue with the next step. Do not re-implement elements owned by earlier use cases — extend them.",
    ].join("\n"),
  );

  if (!useCases.length) {
    out.push("_No use cases yet — run Generate._");
    return `${out.join("\n\n")}\n`;
  }

  const waves = buildWaves(useCases);
  if (waves.length) {
    const rows = waves.map((wave, i) => [
      String(i + 1),
      wave.map((uc) => ucLinks(lookup, [uc.id], file)).join(", "),
      wave.length > 1 ? "Yes" : "—",
    ]);
    out.push(
      `## Parallel waves\n\n_Use cases in the same wave do not depend on each other and can be built in parallel._\n\n${table(["Wave", "Use cases", "Parallel"], rows)}`,
    );
  }

  const steps: string[] = ["## Build order"];
  useCases.forEach((uc, i) => {
    const ucFile = lookup.useCaseFile(uc);
    const deps = uc.dependsOn.filter((d) => lookup.useCases.has(d));
    const screens = uc.screenIds.map((id) =>
      mdLink(lookup.screenName(id), lookup.screenDocPath(id)),
    );
    const types = uc.scenarios.reduce<Record<string, number>>(
      (acc, sc) => ({ ...acc, [sc.type]: (acc[sc.type] ?? 0) + 1 }),
      {},
    );
    const scenarioSummary = Object.entries(types)
      .map(
        ([t, n]) =>
          `${n} ${t === "happy" ? "happy path" : t === "edge" ? "edge case" : t}`,
      )
      .join(", ");
    const feature = lookup.featureName(uc.featureId);
    const lines = [
      `### Step ${i + 1} · ${ucLinkLabel(lookup, uc, file)}`,
      "",
      `- **Feature:** ${orDash(feature)} · **Persona:** ${orDash(lookup.personaName(uc.personaId))} · **Size:** ${uc.size} · **Status:** ${statusLabel(uc.status)}`,
      `- **Depends on:** ${deps.length ? ucLinks(lookup, deps, file) : "nothing — an entry point"}`,
      `- **Scope:** ${orDash(oneLine(uc.scope))}`,
      `- **Read:** ${[mdLink(ucFile, ucFile), ...screens, mdLink(featureFilePath(ucFile), featureFilePath(ucFile))].join(", ")}`,
      `- **Delivers:** ${uc.postconditions.length ? uc.postconditions.map(oneLine).join("; ") : "—"}`,
      `- **Acceptance:** ${plural(uc.scenarios.length, "scenario")}${scenarioSummary ? ` (${scenarioSummary})` : ""} · ${plural(uc.businessRules.length, "business rule")} · ${plural(uc.elementIds.length, "UI element")}`,
    ];
    if (uc.openQuestions.length)
      lines.push(
        `- **Open questions:** ${uc.openQuestions.length} — ${truncate(uc.openQuestions[0], 120)}${uc.openQuestions.length > 1 ? " …" : ""}`,
      );
    steps.push(lines.join("\n"));
  });
  out.push(steps.join("\n\n"));

  const groups = featureGroups(lookup);
  if (groups.length) {
    const rows = groups.map((g) => [
      escapeCell(g.feature ? `${g.feature.id} · ${g.feature.name}` : "Other"),
      g.useCases.map((uc) => ucLinks(lookup, [uc.id], file)).join(", "),
      escapeCell(
        orDash(g.feature ? normaliseBlock(g.feature.description) : ""),
      ),
    ]);
    out.push(
      `## By feature\n\n${table(["Feature", "Use cases (build order)", "Description"], rows)}`,
    );
  }
  return `${out.join("\n\n")}\n`;
}
