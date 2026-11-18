/**
 * OWNER: formats builder.
 * renderUseCase — the exact `use-case-bdd` markdown of ARCHITECTURE.md §5.
 * Every free-text value is normalised here (one-line constructs collapsed, list items trimmed, leading
 * markdown-significant characters escaped) so that render(parse(render(uc))) === render(uc).
 */
import { Document, isScalar, isSeq, type YAMLMap } from "yaml";
import type { BddScenario, BusinessRule, UseCase } from "@shared/types";
import type { RenderContext } from "../types";
import { mergeFrontMatter } from "../frontMatter";
import {
  blocks,
  bulletList,
  escapeCell,
  inlineCode,
  isVerbatimBlock,
  mdLink,
  normaliseBlock,
  oneLine,
  orDash,
  table,
} from "../markdown";
import { buildLookup, relativeLink, type Lookup } from "./lookup";
import {
  FORMAT_ID,
  FRONT_MATTER_KEYS,
  SECTION,
  elementTypeLabel,
  normaliseItemId,
  scenarioTypeLabel,
} from "./vocabulary";

/** Flow-style (`[a, b]`) only while the list fits comfortably on one line. */
const FLOW_LIST_MAX_CHARS = 160;
const FLOW_LIST_KEYS = [
  "screenIds",
  "screens",
  "elements",
  "dependsOn",
  "leadsTo",
] as const;
const STATUS_COMMENT = " generated | edited | stale | approved";

export function renderUseCase(uc: UseCase, ctx: RenderContext): string {
  const lookup = buildLookup(ctx);
  const ownPath = lookup.useCaseFile(uc);
  const parts: string[] = [];

  parts.push(renderFrontMatter(uc, lookup));
  parts.push(renderHeading(uc));
  parts.push(renderSummaryTable(uc, lookup, ownPath));
  const scope = oneLine(uc.scope);
  if (scope) parts.push(`**Scope:** ${scope}`);
  if (ctx.embedScreenImages) {
    const images = uc.screenIds
      .map((id) => {
        const img = lookup.screenImagePath(id);
        return img
          ? `![${oneLine(lookup.screenName(id)).replace(/[[\]]/g, "")}](${relativeLink(ownPath, img)})`
          : "";
      })
      .filter(Boolean);
    if (images.length) parts.push(images.join("\n\n"));
  }

  parts.push(`## ${SECTION.story}\n\n${renderStory(uc)}`);
  parts.push(`## ${SECTION.preconditions}\n\n${bulletList(uc.preconditions)}`);
  parts.push(
    `## ${SECTION.postconditions}\n\n${bulletList(uc.postconditions)}`,
  );
  parts.push(`## ${SECTION.rules}\n\n${renderRules(uc.businessRules)}`);
  parts.push(`## ${SECTION.scenarios}\n\n${renderScenarios(uc.scenarios)}`);
  parts.push(`## ${SECTION.assumptions}\n\n${bulletList(uc.assumptions)}`);
  parts.push(`## ${SECTION.openQuestions}\n\n${bulletList(uc.openQuestions)}`);
  const notes = normaliseBlock(uc.notes);
  if (notes) parts.push(`## ${SECTION.notes}\n\n${notes}`);

  return `${parts.join("\n\n")}\n`;
}

/** The `---` YAML block (incl. the fences and a trailing newline). Exposed for front-matter-only rewrites. */
export function renderFrontMatter(uc: UseCase, lookup: Lookup): string {
  const leadsTo = lookup.dependents.get(uc.id) ?? [];
  const data: Record<string, unknown> = {
    id: uc.id,
    title: oneLine(uc.title),
    format: FORMAT_ID,
    featureId: uc.featureId ?? "",
    feature: lookup.featureName(uc.featureId),
    personaId: uc.personaId ?? "",
    persona: lookup.personaName(uc.personaId),
    screenIds: [...uc.screenIds],
    screens: uc.screenIds.map((id) => oneLine(lookup.screenName(id))),
    elements: [...uc.elementIds],
    dependsOn: [...uc.dependsOn],
    leadsTo: [...leadsTo],
    size: uc.size,
    status: uc.status,
    revision: uc.revision,
    updated: uc.updatedAt,
  };
  if (uc.status === "stale" && uc.staleReason)
    data.staleReason = uc.staleReason;
  if (uc.internalId) data.internalId = uc.internalId;
  if (uc.external?.length) {
    data.external = uc.external.map((link) => ({
      system: link.system,
      key: link.key,
      url: link.url,
      revision: link.revision,
      exportedAt: link.exportedAt,
    }));
  }
  const doc = new Document(data);
  const map = doc.contents as YAMLMap;
  for (const key of FLOW_LIST_KEYS) {
    const node = map.get(key, true);
    const values = data[key] as string[];
    if (isSeq(node) && values.join(", ").length <= FLOW_LIST_MAX_CHARS)
      node.flow = true;
  }
  const status = map.get("status", true);
  if (isScalar(status)) status.comment = STATUS_COMMENT;
  const yaml = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  return `---\n${yaml}---`;
}

/**
 * For a BA-owned file kept during re-generation: new front matter and a new summary table (ids, feature and
 * Depends on / Leads to links may have changed), every other line untouched. The table is only replaced when
 * it is still the generated one right below the H1 — anything else is the BA's and stays as it is.
 */
export function refreshGeneratedParts(
  markdown: string,
  uc: UseCase,
  ctx: RenderContext,
): string {
  const lookup = buildLookup(ctx);
  const withFrontMatter = mergeFrontMatter(
    markdown,
    renderFrontMatter(uc, lookup),
    FRONT_MATTER_KEYS,
  );
  const eol = withFrontMatter.includes("\r\n") ? "\r\n" : "\n";
  const lines = withFrontMatter.split(/\r?\n/);
  const fresh = renderSummaryTable(uc, lookup, lookup.useCaseFile(uc)).split(
    "\n",
  );
  const body = lines.findIndex((l, i) => i > 0 && CLOSE_FENCE.test(l));
  const h1 = lines.findIndex((l, i) => i > body && /^#\s/.test(l));
  if (h1 < 0) return withFrontMatter;
  let start = h1 + 1;
  while (start < lines.length && lines[start].trim() === "") start++;
  if (lines[start]?.trim() !== fresh[0]) return withFrontMatter;
  let end = start;
  while (end < lines.length && lines[end].trimStart().startsWith("|")) end++;
  lines.splice(start, end - start, ...fresh);
  return lines.join(eol);
}

const CLOSE_FENCE = /^(?:---|\.\.\.)[ \t]*$/;

function renderHeading(uc: UseCase): string {
  const title = oneLine(uc.title);
  return title ? `# ${uc.id} · ${title}` : `# ${uc.id}`;
}

function renderSummaryTable(
  uc: UseCase,
  lookup: Lookup,
  ownPath: string,
): string {
  const screens = uc.screenIds
    .map((id) =>
      mdLink(
        lookup.screenName(id),
        relativeLink(ownPath, lookup.screenDocPath(id)),
      ),
    )
    .join(", ");
  const ucLinks = (ids: string[]) =>
    ids
      .map((id) => {
        const other = lookup.useCases.get(id);
        return other
          ? mdLink(id, relativeLink(ownPath, lookup.useCaseFile(other)))
          : escapeCell(id);
      })
      .join(", ");
  const row = [
    escapeCell(orDash(lookup.featureName(uc.featureId))),
    escapeCell(orDash(lookup.personaName(uc.personaId))),
    orDash(screens),
    escapeCell(orDash(uc.size)),
    orDash(ucLinks(uc.dependsOn)),
    orDash(ucLinks(lookup.dependents.get(uc.id) ?? [])),
  ];
  return table(
    ["Feature", "Persona", "Screens", "Size", "Depends on", "Leads to"],
    [row],
  );
}

/** Strips prefixes a writer may have included despite the guidance ("As a", "I want to", "so that"). */
export function storyParts(uc: UseCase): {
  asA: string;
  iWant: string;
  soThat: string;
} {
  return {
    asA: oneLine(uc.story?.asA).replace(/^as\s+an?\s+/i, ""),
    iWant: oneLine(uc.story?.iWant).replace(/^i\s+want(?:\s+to)?\s+/i, ""),
    soThat: oneLine(uc.story?.soThat).replace(/^so\s+that\s+/i, ""),
  };
}

function renderStory(uc: UseCase): string {
  const s = storyParts(uc);
  // Two trailing spaces = markdown hard line break (keeps the three lines visually separate).
  return [
    `**As a** ${s.asA}  `,
    `**I want to** ${s.iWant}  `,
    `**So that** ${s.soThat}`,
  ].join("\n");
}

const ORDERED_START = /^(\d{1,9})([.)])(?=\s|$)/;
const ESCAPED_START =
  /^(?:[-*+](?:\s|$)|([-*_])(?:[ \t]*\1){2,}[ \t]*$|[>#|~`])/;

/**
 * A one-line description paragraph must not be mistaken for a list item, rule, heading, fence, table, quote or
 * element-id line by markdown or by our parser: escape its start ("\- x", "1\. x", "\# x"). Bold or italic
 * text ("**Validation**") needs no escape and gets none.
 */
export function escapeParagraphStart(text: string): string {
  if (ORDERED_START.test(text)) return text.replace(ORDERED_START, "$1\\$2");
  // A leading backslash is doubled only where the parser would otherwise read it as one of these escapes.
  if (
    ESCAPED_START.test(text) ||
    (text.startsWith("\\") && unescapeParagraphStart(text) !== text)
  )
    return `\\${text}`;
  return text;
}

/** Inverse of escapeParagraphStart (also reads the "\1." escape that files written before "1\." carry). */
export function unescapeParagraphStart(text: string): string {
  const candidate = text.startsWith("\\")
    ? text.slice(1)
    : text.replace(/^(\d{1,9})\\([.)])/, "$1$2");
  if (candidate !== text && escapeParagraphStart(candidate) === text)
    return candidate;
  return /^\\\d{1,9}[.)](?:\s|$)/.test(text) ? text.slice(1) : text;
}

function renderRules(rules: BusinessRule[]): string {
  if (!rules.length) return "- None";
  return rules.map(renderRule).join("\n\n");
}

export function ruleHeading(rule: BusinessRule): string {
  const id = normaliseItemId("BR", rule.id);
  return `### ${id} · ${oneLine(rule.element)} — ${elementTypeLabel(rule.elementType)}`.replace(
    / {2,}/g,
    " ",
  );
}

function renderRule(rule: BusinessRule): string {
  const lines: string[] = [ruleHeading(rule)];
  const elementId = oneLine(rule.elementId);
  if (elementId) lines.push(inlineCode(elementId));
  const description = descriptionParagraphs(rule.description);
  const rules = rule.rules.map(oneLine).filter(Boolean);
  const blocks: string[] = [lines.join("\n")];
  if (description.length) blocks.push(description.join("\n\n"));
  if (rules.length) blocks.push(rules.map((r) => `- ${r}`).join("\n"));
  return blocks.join("\n\n");
}

/**
 * Description blocks: tables, blockquotes and fenced code a BA added are kept line by line; every other
 * paragraph is collapsed to one line and start-escaped (unless that one line is itself a quote or table row,
 * which the parser reads back as the same block).
 */
export function descriptionParagraphs(text: string | undefined): string[] {
  return blocks(normaliseBlock(text).split("\n"))
    .map((block) => {
      if (isVerbatimBlock(block)) return block.join("\n");
      const line = oneLine(block.join(" "));
      return isVerbatimBlock([line]) ? line : escapeParagraphStart(line);
    })
    .filter(Boolean);
}

function renderScenarios(scenarios: BddScenario[]): string {
  if (!scenarios.length) return "- None";
  return scenarios.map(renderScenario).join("\n\n");
}

export function scenarioHeading(sc: BddScenario): string {
  const id = normaliseItemId("SC", sc.id);
  const title = oneLine(sc.title);
  const type = `(${scenarioTypeLabel(sc.type)})`;
  return title ? `### ${id} · ${title} ${type}` : `### ${id} ${type}`;
}

/** GIVEN/AND, WHEN/AND, THEN on every then-line — the product owner's template. */
export function gherkinSteps(sc: BddScenario): string[] {
  const out: string[] = [];
  sc.given
    .map(oneLine)
    .filter(Boolean)
    .forEach((s, i) => out.push(`${i === 0 ? "GIVEN" : "AND"} ${s}`));
  sc.when
    .map(oneLine)
    .filter(Boolean)
    .forEach((s, i) => out.push(`${i === 0 ? "WHEN" : "AND"} ${s}`));
  sc.then
    .map(oneLine)
    .filter(Boolean)
    .forEach((s) => out.push(`THEN ${s}`));
  return out;
}

function renderScenario(sc: BddScenario): string {
  // Step lines always start with a keyword, so a plain ``` fence can never be closed early by step text.
  const steps = gherkinSteps(sc);
  const body = steps.length ? `${steps.join("\n")}\n` : "";
  return `${scenarioHeading(sc)}\n\n\`\`\`gherkin\n${body}\`\`\``;
}
