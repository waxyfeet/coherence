/**
 * OWNER: formats builder.
 * screens/<screenKey>.md — one element inventory per analysed screen: purpose, image, regions with an
 * element table (id, type, label, description, details, covering use cases), navigation, entities, questions.
 */
import type { ScreenAnalysis, UIElement } from "@shared/types";
import {
  bulletList,
  escapeCell,
  inlineCode,
  isoDate,
  mdLink,
  normaliseBlock,
  oneLine,
  orDash,
  plural,
  table,
} from "../markdown";
import { relativeLink, type Lookup } from "./lookup";
import { generatedMarker, ucLinks } from "./shared";
import { elementTypeLabel } from "./vocabulary";

export interface ScreenDoc {
  path: string;
  content: string;
}

export function renderScreenDocs(lookup: Lookup): ScreenDoc[] {
  return lookup.orderedAnalyses.map((analysis) => ({
    path: lookup.screenDocPath(analysis.screenId),
    content: renderScreenDoc(lookup, analysis),
  }));
}

function renderScreenDoc(lookup: Lookup, analysis: ScreenAnalysis): string {
  const docPath = lookup.screenDocPath(analysis.screenId);
  const screen = lookup.projectScreens.get(analysis.screenId);
  const name = lookup.screenName(analysis.screenId);
  const useCases = lookup.orderedUseCases.filter((uc) =>
    uc.screenIds.includes(analysis.screenId),
  );
  const out: string[] = [generatedMarker(), `# ${oneLine(name)}`];

  out.push(
    table(
      [
        "Screen type",
        "Image version",
        "Personas",
        "Elements",
        "Use cases",
        "Analysed",
      ],
      [
        [
          escapeCell(analysis.screenType.replace(/_/g, " ")),
          `v${analysis.screenVersion}`,
          escapeCell(
            orDash(analysis.personas.map(oneLine).filter(Boolean).join(", ")),
          ),
          String(analysis.elements.length),
          orDash(
            ucLinks(
              lookup,
              useCases.map((uc) => uc.id),
              docPath,
            ),
          ),
          escapeCell(orDash(isoDate(analysis.analysedAt))),
        ],
      ],
    ),
  );

  if (screen && screen.version !== analysis.screenVersion) {
    out.push(
      `> **Note:** the screen image was replaced (now v${screen.version}) after this analysis (v${analysis.screenVersion}). ` +
        'Use "Analyse impact" on the Screens page to bring the specs up to date.',
    );
  }

  const purpose = normaliseBlock(analysis.purpose);
  if (purpose) out.push(`**Purpose:** ${oneLine(purpose)}`);
  if (oneLine(analysis.title) && oneLine(analysis.title) !== oneLine(name)) {
    out.push(`**Title on screen:** ${oneLine(analysis.title)}`);
  }

  const image = lookup.screenImagePath(analysis.screenId);
  if (image)
    out.push(
      `![${oneLine(name).replace(/[[\]]/g, "")}](${relativeLink(docPath, image)})`,
    );

  out.push(regionsSection(lookup, analysis, docPath));
  out.push(navigationSection(lookup, analysis, docPath));
  out.push(`## Data entities\n\n${bulletList(analysis.dataEntities)}`);
  out.push(`## Open questions\n\n${bulletList(analysis.openQuestions)}`);
  return `${out.join("\n\n")}\n`;
}

function regionsSection(
  lookup: Lookup,
  analysis: ScreenAnalysis,
  docPath: string,
): string {
  const blocks: string[] = ["## Regions & elements"];
  const byId = new Map(analysis.elements.map((e) => [e.id, e]));
  const placed = new Set<string>();
  for (const region of analysis.regions) {
    const elements = region.elementIds
      .map((id) => byId.get(id))
      .filter((e): e is UIElement => !!e);
    // Elements that name this region but are missing from its list still belong here.
    for (const e of analysis.elements) {
      if (e.regionId === region.id && !region.elementIds.includes(e.id))
        elements.push(e);
    }
    elements.forEach((e) => placed.add(e.id));
    const meta = [
      oneLine(region.purpose) ? `_${oneLine(region.purpose)}_` : "",
      oneLine(region.layout) ? `Layout: ${oneLine(region.layout)}` : "",
      plural(elements.length, "element"),
    ]
      .filter(Boolean)
      .join(" · ");
    blocks.push(
      `### ${oneLine(region.name) || region.key}\n\n${meta}\n\n${elementTable(lookup, elements, docPath)}`,
    );
  }
  const loose = analysis.elements.filter((e) => !placed.has(e.id));
  if (loose.length)
    blocks.push(
      `### Other elements\n\n${elementTable(lookup, loose, docPath)}`,
    );
  if (blocks.length === 1)
    blocks.push("_No elements were identified on this screen._");
  return blocks.join("\n\n");
}

function elementTable(
  lookup: Lookup,
  elements: UIElement[],
  docPath: string,
): string {
  if (!elements.length) return "_No elements._";
  const rows = elements.map((e) => {
    const covering = lookup.coverage.get(e.id) ?? [];
    return [
      inlineCode(e.id).replace(/\|/g, "\\|"),
      escapeCell(elementTypeLabel(e.type)),
      escapeCell(orDash(e.label)),
      escapeCell(orDash(e.description)),
      orDash(elementDetails(lookup, e, docPath).join("<br>")),
      covering.length ? ucLinks(lookup, covering, docPath) : "**Not covered**",
    ];
  });
  return table(
    ["ID", "Type", "Label", "Description", "Details", "Used by"],
    rows,
  );
}

/** Placeholder, default, options, required, validation, states, behaviour, navigation, data, inferred. */
export function elementDetails(
  lookup: Lookup,
  e: UIElement,
  fromFile: string,
): string[] {
  const q = (s: string) => `"${escapeCell(oneLine(s))}"`;
  const details: string[] = [];
  if (e.placeholder) details.push(`Placeholder: ${q(e.placeholder)}`);
  if (e.defaultValue) details.push(`Default: ${q(e.defaultValue)}`);
  if (e.helperText) details.push(`Helper text: ${q(e.helperText)}`);
  if (e.options?.length)
    details.push(`Options: ${e.options.map(q).join(", ")}`);
  if (e.required === true) details.push("Required");
  else if (e.required === false) details.push("Optional");
  if (e.validation?.length)
    details.push(
      `Validation: ${e.validation.map((v) => escapeCell(oneLine(v))).join("; ")}`,
    );
  if (e.states?.length)
    details.push(
      `States: ${e.states.map((s) => escapeCell(oneLine(s))).join(", ")}`,
    );
  if (e.behavior) details.push(`Behaviour: ${escapeCell(oneLine(e.behavior))}`);
  if (e.navigatesToScreenId) {
    const target =
      lookup.analyses.has(e.navigatesToScreenId) ||
      lookup.projectScreens.has(e.navigatesToScreenId)
        ? mdLink(
            lookup.screenName(e.navigatesToScreenId),
            relativeLink(fromFile, lookup.screenDocPath(e.navigatesToScreenId)),
          )
        : escapeCell(e.navigatesToScreenId);
    details.push(`Navigates to: ${target}`);
  } else if (e.navigatesToHint) {
    details.push(`Navigates to: ${escapeCell(oneLine(e.navigatesToHint))}`);
  }
  if (e.dataBinding)
    details.push(`Data: ${escapeCell(oneLine(e.dataBinding))}`);
  if (e.inferred?.length)
    details.push(
      `_Inferred: ${e.inferred.map((s) => escapeCell(oneLine(s))).join(", ")}_`,
    );
  return details;
}

function navigationSection(
  lookup: Lookup,
  analysis: ScreenAnalysis,
  docPath: string,
): string {
  const { model } = lookup.ctx;
  const link = (screenId: string) =>
    lookup.analyses.has(screenId) || lookup.projectScreens.has(screenId)
      ? mdLink(
          lookup.screenName(screenId),
          relativeLink(docPath, lookup.screenDocPath(screenId)),
        )
      : screenId;
  const describe = (
    trigger: string,
    condition?: string,
    elementId?: string,
  ) => {
    const parts = [oneLine(trigger) || "navigation"];
    if (elementId) parts.push(`via ${inlineCode(elementId)}`);
    if (condition) parts.push(`when ${oneLine(condition)}`);
    return parts.join(" ");
  };
  const outgoing = model.flows
    .filter(
      (f) =>
        f.fromScreenId === analysis.screenId &&
        f.toScreenId !== analysis.screenId,
    )
    .map(
      (f) =>
        `- To ${link(f.toScreenId)}: ${describe(f.trigger, f.condition, f.elementId)}`,
    );
  const incoming = model.flows
    .filter(
      (f) =>
        f.toScreenId === analysis.screenId &&
        f.fromScreenId !== analysis.screenId,
    )
    .map(
      (f) =>
        `- From ${link(f.fromScreenId)}: ${describe(f.trigger, f.condition, f.elementId)}`,
    );
  const external = analysis.elements
    .filter((e) => !e.navigatesToScreenId && e.navigatesToHint)
    .map(
      (e) =>
        `- ${inlineCode(e.id)} ${oneLine(e.label) ? `"${oneLine(e.label)}" ` : ""}leads to ${oneLine(e.navigatesToHint)}`,
    );
  const lines = [...outgoing, ...incoming, ...external];
  return `## Navigation\n\n${lines.length ? lines.join("\n") : "_No navigation to or from this screen was identified._"}`;
}
