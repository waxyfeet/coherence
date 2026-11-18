/**
 * OWNER: export builder.
 * CSV (RFC 4180, UTF-8 with BOM so Excel opens it correctly) for bulk import into any tracker.
 * Columns: ID, Title, Feature, Persona, Screens, Size, Story Points, Status, Depends On, User Story,
 * Preconditions, Postconditions, Business Rules, Acceptance Criteria (BDD), Assumptions, Open Questions,
 * Spec File, Jira, Azure DevOps, GitHub. Multi-line cells use \n.
 */
import { STORY_POINTS, type ExternalSystem } from "@shared/types";
import { BadRequestError } from "../errors";
import { getFormat } from "../formats/registry";
import { getProject, loadModel } from "../storage/projectStore";
import {
  loadExportContent,
  ruleHeading,
  scenarioHeading,
  scenarioLines,
  type ExportContent,
} from "./content";

export const CSV_COLUMNS = [
  "ID",
  "Title",
  "Feature",
  "Persona",
  "Screens",
  "Size",
  "Story Points",
  "Status",
  "Depends On",
  "User Story",
  "Preconditions",
  "Postconditions",
  "Business Rules",
  "Acceptance Criteria (BDD)",
  "Assumptions",
  "Open Questions",
  "Spec File",
  "Jira",
  "Azure DevOps",
  "GitHub",
] as const;

/**
 * One RFC 4180 field. Cells that a spreadsheet would run as a formula (=, +, -, @, tab, CR, LF) are prefixed
 * with an apostrophe — exported specs are opened in Excel and must never execute anything.
 */
export function csvField(value: string | number | undefined | null): string {
  let text = value === undefined || value === null ? "" : String(value);
  text = text.replace(/\r\n?/g, "\n");
  // Line breaks are normalised to LF first, so LF must be guarded too (S09).
  if (/^[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: (string | number | undefined | null)[]): string {
  return values.map(csvField).join(",");
}

/** Bullets as "• item" — a leading "-" would trip the formula guard and look odd. */
function lines(items: string[]): string {
  return items.map((i) => `• ${i}`).join("\n");
}

function externalKey(content: ExportContent, system: ExternalSystem): string {
  return content.useCase.external.find((l) => l.system === system)?.key ?? "";
}

export function useCaseCsvRow(content: ExportContent): string {
  const uc = content.useCase;
  const story = `As a ${uc.story.asA}, I want to ${uc.story.iWant}, so that ${uc.story.soThat}`;
  const rules = uc.businessRules
    .map((r) => {
      const head = `${ruleHeading(r)}${r.elementId ? ` [${r.elementId}]` : ""}`;
      const parts = [head];
      if (r.description.trim()) parts.push(r.description.trim());
      for (const rule of r.rules) parts.push(`  • ${rule}`);
      return parts.join("\n");
    })
    .join("\n\n");
  const scenarios = uc.scenarios
    .map((sc) => [scenarioHeading(sc), ...scenarioLines(sc)].join("\n"))
    .join("\n\n");
  return csvRow([
    uc.id,
    uc.title,
    content.featureName,
    content.personaName,
    content.screenNames.join("; "),
    uc.size,
    STORY_POINTS[uc.size] ?? "",
    uc.status,
    uc.dependsOn.join(", "),
    story,
    lines(uc.preconditions),
    lines(uc.postconditions),
    rules,
    scenarios,
    lines(uc.assumptions),
    lines(uc.openQuestions),
    uc.filePath ?? "",
    externalKey(content, "jira"),
    externalKey(content, "azdo"),
    externalKey(content, "github"),
  ]);
}

/** Content from the reviewed .md files (fallback: model). Default: all use cases in build order. */
export async function exportCsv(
  projectId: string,
  useCaseIds?: string[],
): Promise<{ fileName: string; csv: string }> {
  const project = await getProject(projectId);
  const model = await loadModel(projectId);
  if (!model || !model.useCases.length) {
    throw new BadRequestError(
      "This project has no use cases yet — generate the specs before downloading a CSV.",
    );
  }
  let selected = model.useCases;
  if (useCaseIds?.length) {
    const wanted = new Set(useCaseIds.map((id) => id.trim()).filter(Boolean));
    const unknown = [...wanted].filter(
      (id) => !model.useCases.some((uc) => uc.id === id),
    );
    if (unknown.length)
      throw new BadRequestError(
        `Unknown use case id(s): ${unknown.join(", ")}.`,
      );
    selected = model.useCases.filter((uc) => wanted.has(uc.id));
  }
  const format = getFormat(model.formatId || project.formatId);
  const rows: string[] = [csvRow([...CSV_COLUMNS])];
  for (const uc of selected)
    rows.push(
      useCaseCsvRow(await loadExportContent(project, model, uc, format)),
    );
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    fileName: `${project.id}-use-cases-${stamp}.csv`,
    csv: `﻿${rows.join("\r\n")}\r\n`,
  };
}
