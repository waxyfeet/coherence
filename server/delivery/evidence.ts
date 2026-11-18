/**
 * Evidence: the parts of a reviewed use case a destination field may be filled from. Values are built
 * deterministically from the BA's reviewed content (loadExportContent); a model may only point at an evidence id,
 * never supply the value itself.
 */
import { createHash } from "node:crypto";
import type { EvidenceId, FieldKind } from "@shared/delivery";
import { STORY_POINTS } from "@shared/types";
import {
  buildDescriptionMarkdown,
  buildScenariosMarkdown,
  literal,
  ruleHeading,
  type ExportContent,
} from "../export/content";

export interface EvidenceText {
  /** Markdown for rich-text fields. */
  markdown: string;
  /** One-line plain text for single-line fields. */
  line: string;
  empty: boolean;
}

function bullets(items: string[]): string {
  return items.map((i) => `- ${i}`).join("\n");
}

function oneLine(text: string): string {
  return text
    .replace(/\s*\n+\s*/g, "; ")
    .replace(/\s+/g, " ")
    .trim();
}

export function storySentence(content: ExportContent): string {
  const s = content.useCase.story;
  return `As a ${s.asA}, I want to ${s.iWant}, so that ${s.soThat}`;
}

export function businessRulesMarkdown(content: ExportContent): string {
  return content.useCase.businessRules
    .map((r) => {
      const lines = [`### ${literal(ruleHeading(r))}`];
      if (r.description.trim()) lines.push(literal(r.description.trim()));
      if (r.rules.length) lines.push(bullets(r.rules.map(literal)));
      return lines.join("\n\n");
    })
    .join("\n\n");
}

/** Requirement title as it travels: "[UC-003] Sign in with email and password" (never truncated here). */
export function itemTitle(content: ExportContent): string {
  return `[${content.useCase.id}] ${content.useCase.title.trim()}`;
}

export function evidenceText(
  content: ExportContent,
  id: EvidenceId,
): EvidenceText {
  const uc = content.useCase;
  const md = (() => {
    switch (id) {
      case "title":
        return itemTitle(content);
      case "specification":
        return buildDescriptionMarkdown(content, {
          includeScenarios: false,
          includeFooter: true,
        });
      case "story":
        return storySentence(content);
      case "story.asA":
        return uc.story.asA;
      case "story.iWant":
        return uc.story.iWant;
      case "story.soThat":
        return uc.story.soThat;
      case "scope":
        return uc.scope;
      case "preconditions":
        return bullets(uc.preconditions);
      case "postconditions":
        return bullets(uc.postconditions);
      case "businessRules":
        return businessRulesMarkdown(content);
      case "scenarios":
        return uc.scenarios.length ? buildScenariosMarkdown(uc, 4) : "";
      case "assumptions":
        return bullets(uc.assumptions);
      case "openQuestions":
        return bullets(uc.openQuestions);
      case "notes":
        return uc.notes;
      case "feature":
        return content.featureName;
      case "persona":
        return content.personaName;
      case "screens":
        return content.screenNames.join(", ");
      case "useCaseId":
        return uc.id;
      case "size":
        return uc.size;
    }
  })().trim();
  return { markdown: md, line: oneLine(md), empty: !md };
}

/** Evidence that can sensibly fill a field of this kind (single-line fields cannot hold lists or scenarios). */
export function evidenceFor(kind: FieldKind): EvidenceId[] {
  switch (kind) {
    case "rich-text":
    case "multi-line":
      return [
        "specification",
        "story",
        "story.asA",
        "story.iWant",
        "story.soThat",
        "scope",
        "preconditions",
        "postconditions",
        "businessRules",
        "scenarios",
        "assumptions",
        "openQuestions",
        "notes",
        "feature",
        "persona",
        "screens",
      ];
    case "single-line":
      return [
        "title",
        "story",
        "story.asA",
        "story.iWant",
        "story.soThat",
        "scope",
        "feature",
        "persona",
        "screens",
        "useCaseId",
      ];
    case "number":
      return ["size"];
    default:
      return [];
  }
}

/** The canonical planned value for an evidence-mapped field; undefined when the evidence cannot fill that kind. */
export function evidenceValue(
  content: ExportContent,
  id: EvidenceId,
  kind: FieldKind,
): string | number | undefined {
  if (!evidenceFor(kind).includes(id)) return undefined;
  if (kind === "number")
    return id === "size" ? STORY_POINTS[content.useCase.size] : undefined;
  const text = evidenceText(content, id);
  if (text.empty) return "";
  return kind === "single-line" ? text.line : text.markdown;
}

/** Fingerprint of exactly what was planned from a use case, for stale-source detection. */
export function contentFingerprint(content: ExportContent): string {
  const uc = content.useCase;
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: uc.id,
        title: uc.title,
        featureId: uc.featureId,
        story: uc.story,
        scope: uc.scope,
        preconditions: uc.preconditions,
        postconditions: uc.postconditions,
        businessRules: uc.businessRules,
        scenarios: uc.scenarios,
        assumptions: uc.assumptions,
        openQuestions: uc.openQuestions,
        notes: uc.notes,
        dependsOn: uc.dependsOn,
        size: uc.size,
        status: uc.status,
        body: content.markdownBody,
      }),
    )
    .digest("hex")
    .slice(0, 32);
}

/** Markdown/plain text that must appear in delivery content for nothing material to be lost. */
export function materialFragments(content: ExportContent): {
  label: string;
  text: string;
}[] {
  const uc = content.useCase;
  const out: { label: string; text: string }[] = [];
  for (const r of uc.businessRules) {
    out.push({ label: `${uc.id} ${r.id}`, text: `${r.id} · ${r.element}` });
    for (const rule of r.rules)
      out.push({ label: `${uc.id} ${r.id}`, text: rule.trim() });
  }
  for (const sc of uc.scenarios) {
    out.push({ label: `${uc.id} ${sc.id}`, text: `${sc.id} · ${sc.title}` });
    for (const step of [...sc.given, ...sc.when, ...sc.then])
      out.push({ label: `${uc.id} ${sc.id}`, text: step.trim() });
  }
  for (const a of uc.assumptions)
    out.push({ label: `${uc.id} assumption`, text: a.trim() });
  return out.filter((f) => f.text);
}
