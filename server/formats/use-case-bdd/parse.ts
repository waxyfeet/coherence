/**
 * OWNER: formats builder.
 * parseUseCase — reads a `use-case-bdd` markdown file back into use case fields, tolerating the edits a
 * BA makes by hand: keyword variants and casing, missing trailing spaces, bold or plain labels, "- None",
 * reordered or renamed sections, CRLF, BOM, extra blank lines, missing ids. Unknown `##` sections and
 * stray text are kept (appended to notes) rather than silently dropped.
 */
import type {
  BddScenario,
  BusinessRule,
  ExternalLink,
  ExternalSystem,
  ScenarioType,
  UseCase,
  UserStory,
} from "@shared/types";
import { readFrontMatter } from "../frontMatter";
import {
  blocks,
  isBulletLine,
  isVerbatimBlock,
  normaliseBlock,
  oneLine,
  paragraphs,
  parseBulletList,
  splitAtHeadings,
  stepFence,
  trimBlankLines,
  isNoneMarker,
  type FenceState,
} from "../markdown";
import type { ParsedUseCase } from "../types";
import { unescapeParagraphStart } from "./render";
import {
  FORMAT_ID,
  SECTION,
  normaliseItemId,
  normaliseUseCaseId,
  nextItemId,
  parseElementTypeLabel,
  parseScenarioTypeLabel,
  parseSize,
  parseStatus,
  sectionKeyFor,
  type RuleElementType,
  type SectionKey,
} from "./vocabulary";

type ParsedFields = Partial<UseCase> & { id: string };

interface ParseState {
  errors: string[];
  warnings: string[];
  /** Text that has no structured home; appended to notes (after the Notes section itself). */
  extras: string[];
}

export function parseUseCase(markdown: string): ParsedUseCase {
  const state: ParseState = { errors: [], warnings: [], extras: [] };
  const fm = readFrontMatter(markdown);
  const uc: ParsedFields = { id: "" };

  const lines = fm.body.split("\n");
  const { h1, rest } = takeTitle(lines);
  const h1Info = h1 !== null ? parseTitleLine(h1) : null;

  if (fm.data) {
    readFrontMatterFields(fm.data, uc, state);
  } else if (fm.error) {
    // A broken YAML block is fatal (structural fields unknown); a missing one is recoverable from the H1.
    const missing = fm.error.startsWith("The file has no front matter");
    if (missing && h1Info?.id) {
      state.warnings.push(
        `${fm.error} The id ${h1Info.id} was taken from the title; structural fields keep their previous values.`,
      );
    } else {
      state.errors.push(fm.error);
    }
  }

  if (!uc.id && h1Info?.id && !state.errors.length) {
    uc.id = h1Info.id;
    if (fm.data)
      state.warnings.push(
        `The front matter has no id; using ${h1Info.id} from the title.`,
      );
  }
  if (!uc.id && !state.errors.length) {
    state.errors.push(
      'The use case id is missing — add "id: UC-001" (with the right number) to the front matter.',
    );
  }
  if (h1Info?.id && uc.id && h1Info.id !== uc.id) {
    state.warnings.push(
      `The title says ${h1Info.id} but the front matter id is ${uc.id}; the front matter id is used.`,
    );
  }

  if (h1Info) {
    uc.title = h1Info.title;
  } else if (typeof uc.title !== "string") {
    state.warnings.push('No "# UC-xxx · Title" heading was found.');
  }

  parseBody(rest, uc, state, h1 !== null);

  return { useCase: uc, errors: state.errors, warnings: state.warnings };
}

/* ------------------------------------------------------------------ */
/* Front matter                                                        */
/* ------------------------------------------------------------------ */

function readFrontMatterFields(
  data: Record<string, unknown>,
  uc: ParsedFields,
  state: ParseState,
): void {
  const id = scalar(data.id);
  if (scalar(data.internalId)) uc.internalId = scalar(data.internalId);
  if (id) uc.id = normaliseUseCaseId(id);

  const title = scalar(data.title);
  if (title !== undefined) uc.title = oneLine(title);

  const format = scalar(data.format);
  if (format !== undefined && format !== "") {
    uc.formatId = format;
    if (format !== FORMAT_ID)
      state.warnings.push(
        `The front matter says format "${format}"; it was read as "${FORMAT_ID}".`,
      );
  }

  if ("featureId" in data) uc.featureId = scalar(data.featureId) ?? "";
  if ("personaId" in data) uc.personaId = scalar(data.personaId) ?? "";
  if ("screenIds" in data)
    uc.screenIds = idList(data.screenIds, "screenIds", state);
  if ("elements" in data)
    uc.elementIds = idList(data.elements, "elements", state);
  else if ("elementIds" in data)
    uc.elementIds = idList(data.elementIds, "elementIds", state);
  if ("dependsOn" in data)
    uc.dependsOn = idList(data.dependsOn, "dependsOn", state).map(
      normaliseUseCaseId,
    );

  if ("size" in data) {
    const size = parseSize(data.size);
    if (size) uc.size = size;
    else
      state.warnings.push(
        `Unknown size "${String(data.size)}" — use S, M or L.`,
      );
  }
  if ("status" in data) {
    const status = parseStatus(data.status);
    if (status) uc.status = status;
    else
      state.warnings.push(
        `Unknown status "${String(data.status)}" — use generated, edited, stale or approved.`,
      );
  }
  if ("revision" in data) {
    const n = Number(data.revision);
    if (Number.isInteger(n) && n >= 0) uc.revision = n;
    else
      state.warnings.push(
        `Revision "${String(data.revision)}" is not a whole number and was ignored.`,
      );
  }
  const updated = scalar(data.updated);
  if (updated) uc.updatedAt = updated;
  const staleReason = scalar(data.staleReason);
  if (staleReason) uc.staleReason = staleReason;

  // The renderer omits "external" when there are no links, so absence inside a front matter means none.
  uc.external = "external" in data ? externalLinks(data.external, state) : [];
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value instanceof Date) return value.toISOString();
  return undefined;
}

function idList(value: unknown, field: string, state: ParseState): string[] {
  if (value === null || value === undefined || value === "") return [];
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [value];
  const out: string[] = [];
  for (const item of raw) {
    const s = scalar(item);
    if (s === undefined) {
      state.warnings.push(
        `An entry in "${field}" is not a plain id and was ignored.`,
      );
      continue;
    }
    const clean = s.replace(/^`+|`+$/g, "").trim();
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}

function externalSystem(value: unknown): ExternalSystem | null {
  const s = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (s === "jira") return "jira";
  if (
    s === "azdo" ||
    s === "azuredevops" ||
    s === "ado" ||
    s === "azure" ||
    s === "devops"
  )
    return "azdo";
  if (s === "github" || s === "gh") return "github";
  return null;
}

function externalLinks(value: unknown, state: ParseState): ExternalLink[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    state.warnings.push('"external" must be a list of links; it was ignored.');
    return [];
  }
  const out: ExternalLink[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      state.warnings.push(
        'An "external" entry is not a key/value block and was ignored.',
      );
      continue;
    }
    const rec = item as Record<string, unknown>;
    const system = externalSystem(rec.system);
    const key = scalar(rec.key);
    if (!system || !key) {
      state.warnings.push(
        'An "external" entry needs a system (jira, azdo or github) and a key; it was ignored.',
      );
      continue;
    }
    const revision = Number(rec.revision);
    out.push({
      system,
      key,
      url: scalar(rec.url) ?? "",
      revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
      exportedAt: scalar(rec.exportedAt) ?? "",
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Title                                                               */
/* ------------------------------------------------------------------ */

const H1 = /^ {0,3}#(?!#)(?:[ \t]+(.*?))?[ \t]*$/;
const H2 = /^ {0,3}##(?!#)/;

/** Finds the first H1 before any H2 (outside code fences). */
function takeTitle(lines: string[]): { h1: string | null; rest: string[] } {
  let fence: FenceState | null = null;
  for (let i = 0; i < lines.length; i++) {
    const wasOutside = fence === null;
    const step = stepFence(fence, lines[i]);
    fence = step.state;
    if (!wasOutside || step.inside) continue;
    if (H2.test(lines[i])) break;
    const m = H1.exec(lines[i]);
    if (m)
      return {
        h1: (m[1] ?? "").trim(),
        rest: [...lines.slice(0, i), ...lines.slice(i + 1)],
      };
  }
  return { h1: null, rest: lines };
}

const ID_SEPARATOR = String.raw`\s*(?:[·•:|]|[-–—](?=\s)|\.(?=\s))?\s*`;

function parseTitleLine(text: string): { id?: string; title: string } {
  const m = new RegExp(
    String.raw`^(UC[-_\s]?\d{1,5})\b${ID_SEPARATOR}(.*)$`,
    "i",
  ).exec(text);
  if (m) return { id: normaliseUseCaseId(m[1]), title: oneLine(m[2]) };
  return { title: oneLine(text) };
}

/* ------------------------------------------------------------------ */
/* Body                                                                */
/* ------------------------------------------------------------------ */

const IMAGE_LINE = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/;
const TABLE_LINE = /^\s*\|/;
const COMMENT_LINE = /^\s*<!--.*-->\s*$/;
const SCOPE_LINE =
  /^\s*(?:\*\*|__)?\s*scope\s*(?::\s*(?:\*\*|__)|(?:\*\*|__)\s*:|:)\s*(.*)$/i;

function parseBody(
  lines: string[],
  uc: ParsedFields,
  state: ParseState,
  hasTitle: boolean,
): void {
  const { before, sections } = splitAtHeadings(lines, 2);
  const seen = new Set<SectionKey>();
  let notesText = "";
  let sectionScope: string | null = null;
  const story: UserStory = { asA: "", iWant: "", soThat: "" };
  const lists = {
    preconditions: [] as string[],
    postconditions: [] as string[],
    assumptions: [] as string[],
    openQuestions: [] as string[],
  };
  const rules: BusinessRule[] = [];
  const scenarios: BddScenario[] = [];
  const unknown: string[] = [];

  const preamble = parsePreamble(before);

  for (const section of sections) {
    const key = sectionKeyFor(section.heading);
    if (!key) {
      const block = [
        section.rawHeading.trim(),
        ...trimTrailingBlank(section.lines),
      ].join("\n");
      unknown.push(normaliseBlock(block));
      continue;
    }
    seen.add(key);
    switch (key) {
      case "story": {
        const parsed = parseStory(section.lines, state);
        if (parsed.asA) story.asA = parsed.asA;
        if (parsed.iWant) story.iWant = parsed.iWant;
        if (parsed.soThat) story.soThat = parsed.soThat;
        break;
      }
      case "scope": {
        const text = paragraphs(section.lines)
          .map((p) => oneLine(p.join(" ")))
          .filter(Boolean)
          .join(" ");
        sectionScope = sectionScope ? `${sectionScope} ${text}`.trim() : text;
        break;
      }
      case "preconditions":
      case "postconditions":
      case "assumptions":
      case "openQuestions":
        lists[key].push(
          ...parseListSection(
            trimBlankLines(section.lines),
            SECTION[key],
            state,
          ),
        );
        break;
      case "rules":
        rules.push(...parseRules(section.lines, rules, state));
        break;
      case "scenarios":
        scenarios.push(...parseScenarios(section.lines, scenarios, state));
        break;
      case "notes": {
        const text = normaliseBlock(section.lines.join("\n"));
        notesText =
          notesText && text ? `${notesText}\n\n${text}` : notesText || text;
        break;
      }
    }
  }

  // Content fields are always set: the body is the source of truth, a deleted section means "empty".
  uc.scope = sectionScope ?? preamble.scope;
  uc.story = story;
  uc.preconditions = lists.preconditions;
  uc.postconditions = lists.postconditions;
  uc.businessRules = rules;
  uc.scenarios = scenarios;
  uc.assumptions = lists.assumptions;
  uc.openQuestions = lists.openQuestions;

  if (hasTitle || sections.length) {
    const required: [SectionKey, string][] = [
      ["story", SECTION.story],
      ["preconditions", SECTION.preconditions],
      ["postconditions", SECTION.postconditions],
      ["rules", SECTION.rules],
      ["scenarios", SECTION.scenarios],
    ];
    for (const [key, label] of required) {
      if (!seen.has(key))
        state.warnings.push(
          `The "## ${label}" section is missing; it was treated as empty.`,
        );
    }
  }
  if (seen.has("story") && (!story.asA || !story.iWant || !story.soThat)) {
    const missing = [
      !story.asA && "As a",
      !story.iWant && "I want to",
      !story.soThat && "So that",
    ].filter(Boolean);
    state.warnings.push(`The user story is missing: ${missing.join(", ")}.`);
  }

  if (preamble.stray.length) {
    state.warnings.push(
      "Text under the title that is not the Scope line was moved to Notes.",
    );
  }
  uc.notes = normaliseBlock(
    [notesText, ...preamble.stray, ...state.extras, ...unknown]
      .filter(Boolean)
      .join("\n\n"),
  );
}

function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return lines.slice(0, end);
}

/** Lines between the title and the first section: summary table, scope line, images. */
function parsePreamble(lines: string[]): { scope: string; stray: string[] } {
  let scope: string | null = null;
  const loose: string[] = [];
  for (const para of paragraphs(lines)) {
    const kept = para.filter(
      (l) =>
        !TABLE_LINE.test(l) && !IMAGE_LINE.test(l) && !COMMENT_LINE.test(l),
    );
    if (!kept.length) continue;
    const idx = kept.findIndex((l) => SCOPE_LINE.test(l));
    if (idx >= 0) {
      if (idx > 0) loose.push(oneLine(kept.slice(0, idx).join(" ")));
      const first = SCOPE_LINE.exec(kept[idx])?.[1] ?? "";
      const text = oneLine([first, ...kept.slice(idx + 1)].join(" "));
      scope = scope ? `${scope} ${text}`.trim() : text;
    } else {
      loose.push(oneLine(kept.join(" ")));
    }
  }
  const strayParas = loose.filter(Boolean);
  if (scope === null && strayParas.length) {
    // The BA dropped the "**Scope:**" label — the paragraph under the title is still the scope.
    return { scope: strayParas.join(" "), stray: [] };
  }
  return { scope: scope ?? "", stray: strayParas };
}

/* ── User story ── */

const STORY_LABEL =
  /^\s*(?:[-*+]\s+)?(?:\*\*|__)?\s*(as\s+an?\b|as\b|i\s+(?:want|need|would\s+like|wish)(?:\s+to)?\b|so\s+that\b)\s*:?\s*(?:\*\*|__)?\s*[:,]?\s*(.*)$/i;

function parseStory(lines: string[], state: ParseState): UserStory {
  const story: UserStory = { asA: "", iWant: "", soThat: "" };
  let current: keyof UserStory | null = null;
  const cleaned = lines
    .map((l) => l.replace(/\\$/, "").replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "");

  // A one-line story ("As a user, I want to …, so that …") is split on its keywords first.
  if (cleaned.length === 1) {
    const single = splitSingleLineStory(cleaned[0]);
    if (single) return single;
  }

  for (const line of cleaned) {
    const m = STORY_LABEL.exec(line);
    let part: keyof UserStory | null = null;
    if (m) {
      const label = m[1].toLowerCase().replace(/\s+/g, " ");
      if (label.startsWith("as"))
        part = label === "as" && story.asA ? null : "asA";
      else if (label.startsWith("i ")) part = "iWant";
      else part = "soThat";
    }
    if (part && m) {
      current = part;
      const value = oneLine(`${story[part]} ${stripBold(m[2])}`);
      // "As a user," / "I want to …," — the comma belongs to the sentence, not the value.
      story[part] = part === "soThat" ? value : value.replace(/,$/, "");
    } else if (current) {
      story[current] = oneLine(`${story[current]} ${stripBold(line)}`);
    } else {
      state.warnings.push(
        `A user story line was not recognised and was ignored: "${oneLine(line).slice(0, 80)}".`,
      );
    }
  }
  return story;
}

function splitSingleLineStory(line: string): UserStory | null {
  const text = line.replace(/^\s*[-*+]\s+/, "").replace(/\*\*|__/g, "");
  const m =
    /^\s*as\s+an?\s+(.+?)\s*,?\s+i\s+(?:want|need|would\s+like)(?:\s+to)?\s+(.+?)\s*,?\s+so\s+that\s+(.+?)\s*$/i.exec(
      text,
    );
  if (!m) return null;
  return { asA: oneLine(m[1]), iWant: oneLine(m[2]), soThat: oneLine(m[3]) };
}

/** Bold markers left at the edges of a story value ("**As a registered user**"). */
function stripBold(text: string): string {
  return text
    .replace(/^(?:\*\*|__)\s*/, "")
    .replace(/\s*(?:\*\*|__)$/, "")
    .trim();
}

/** "**Email — Input**" → "Email — Input" (only when the whole text is wrapped). */
function unwrapBold(text: string): string {
  const m = /^(\*\*|__)(.+)\1$/.exec(text);
  return m ? m[2].trim() : text;
}

/* ── Business rules ── */

const ITEM_HEADING = (prefix: "BR" | "SC") =>
  new RegExp(String.raw`^(${prefix}[-_\s]?\d{1,4})\b${ID_SEPARATOR}(.*)$`, "i");
const CODE_LINE =
  /^\s*(?:(?:\*\*|__)?\s*element(?:\s+id)?\s*:?\s*(?:\*\*|__)?\s*:?\s*)?(`+)\s?([^`](?:.*?[^`])?)\s?\1\s*$/i;

function parseRules(
  lines: string[],
  existing: BusinessRule[],
  state: ParseState,
): BusinessRule[] {
  const { before, sections } = splitAtHeadings(lines, 3);
  const stray = strayText(before);
  if (stray) {
    state.extras.push(stray);
    state.warnings.push(
      'Text under "Business rules" before the first rule heading was moved to Notes.',
    );
  }
  const out: BusinessRule[] = [];
  const taken = new Set(existing.map((r) => r.id));
  for (const section of sections) {
    const rule = parseRuleBlock(section.heading, section.lines, state);
    if (!rule.id || taken.has(rule.id)) {
      const fresh = nextItemId("BR", [...taken]);
      state.warnings.push(
        rule.id
          ? `Business rule id ${rule.id} is used twice; the second one was renumbered ${fresh}.`
          : `Business rule "${rule.element || section.heading}" had no BR id; it was numbered ${fresh}.`,
      );
      rule.id = fresh;
    }
    taken.add(rule.id);
    out.push(rule);
  }
  return out;
}

function parseRuleBlock(
  heading: string,
  lines: string[],
  state: ParseState,
): BusinessRule {
  const m = ITEM_HEADING("BR").exec(heading.trim());
  const id = m ? normaliseItemId("BR", m[1]) : "";
  const rest = unwrapBold(oneLine(m ? m[2] : heading));
  let element = rest;
  let typeWords: string | null = null;
  const dash = /^(.*?)\s*[—–]\s*([^—–]*)$/.exec(rest);
  if (dash) {
    element = dash[1].trim();
    typeWords = dash[2].trim();
  } else {
    const hyphen = /^(.*\S)\s+-{1,2}\s+([^-]+)$/.exec(rest);
    if (hyphen && parseElementTypeLabel(hyphen[2])) {
      element = hyphen[1].trim();
      typeWords = hyphen[2].trim();
    }
  }

  // Element id: the first line that is only an inline code span (optionally labelled "Element:").
  const body = [...lines];
  let elementId: string | undefined;
  let fence: FenceState | null = null;
  for (let i = 0; i < body.length; i++) {
    const wasOutside = fence === null;
    const step = stepFence(fence, body[i]);
    fence = step.state;
    if (!wasOutside || step.inside) continue;
    const code = CODE_LINE.exec(body[i]);
    if (code && !isBulletLine(body[i])) {
      elementId = code[2].trim();
      body.splice(i, 1);
      break;
    }
  }

  let elementType: RuleElementType;
  const label = id || element || heading;
  if (typeWords !== null && typeWords !== "") {
    const parsed = parseElementTypeLabel(typeWords);
    if (parsed) {
      elementType = parsed;
    } else {
      elementType = elementId ? "other" : "general";
      state.warnings.push(
        `${label}: unknown element type "${typeWords}"; it was read as "${elementType}".`,
      );
    }
  } else {
    elementType = elementId ? "other" : "general";
    state.warnings.push(
      `${label}: the heading has no element type (e.g. "— Button"); it was read as "${elementType}".`,
    );
  }

  const { description, items, textAfterBullets } =
    splitDescriptionAndBullets(body);
  if (textAfterBullets) {
    state.warnings.push(
      `${label}: text below the rule's bullets was moved above them (a rule has one description, then its bullets).`,
    );
  }
  return {
    id,
    ...(elementId ? { elementId } : {}),
    element,
    elementType,
    description,
    rules: items,
  };
}

/**
 * Blocks before/after the bullet list form the description (tables, quotes and fenced code kept line by line,
 * other paragraphs reflowed); bullets are the rules.
 */
function splitDescriptionAndBullets(lines: string[]): {
  description: string;
  items: string[];
  textAfterBullets: boolean;
} {
  const descParas: string[] = [];
  const listLines: string[] = [];
  let lastWasList = false;
  let textAfterBullets = false;
  for (const block of blocks(lines)) {
    const isList: boolean =
      isBulletLine(block[0]) || (lastWasList && /^\s{2,}\S/.test(block[0]));
    if (isList) {
      if (listLines.length) listLines.push("");
      listLines.push(...block);
    } else {
      const text = isVerbatimBlock(block)
        ? block.join("\n")
        : unescapeParagraphStart(oneLine(block.join(" ")));
      if (text && listLines.length) textAfterBullets = true;
      descParas.push(text);
    }
    lastWasList = isList;
  }
  return {
    description: descParas.filter(Boolean).join("\n\n"),
    items: parseBulletList(listLines),
    textAfterBullets,
  };
}

/**
 * A list section (preconditions, postconditions, assumptions, open questions): tables, quotes and fenced code
 * at its top level are not list items — they move to Notes instead of being flattened into one item.
 */
function parseListSection(
  lines: string[],
  label: string,
  state: ParseState,
): string[] {
  const listLines: string[] = [];
  const moved: string[] = [];
  let afterItem = false;
  for (const block of blocks(lines)) {
    const continuation = afterItem && /^\s{2,}\S/.test(block[0]);
    if (!continuation && isVerbatimBlock(block)) {
      moved.push(block.join("\n"));
      afterItem = false;
      continue;
    }
    if (listLines.length) listLines.push("");
    listLines.push(...block);
    afterItem = true;
  }
  if (moved.length) {
    state.extras.push(...moved);
    state.warnings.push(
      `A table, quote or code block under "${label}" was moved to Notes — that section is a list.`,
    );
  }
  return parseBulletList(listLines);
}

/** Text outside any ### item (ignoring blank lines and a "- None" placeholder). */
function strayText(lines: string[]): string {
  const trimmed = trimBlankLines(lines);
  if (!trimmed.length) return "";
  const meaningful = trimmed.filter((l) => l.trim() !== "");
  if (
    meaningful.length === 1 &&
    isNoneMarker(meaningful[0].replace(/^\s*(?:[-*+]|\d+[.)])\s*/, ""))
  )
    return "";
  if (
    meaningful.every((l) => /^\s*_?no (business rules|scenarios)[^]*$/i.test(l))
  )
    return "";
  return normaliseBlock(trimmed.join("\n"));
}

/* ── BDD scenarios ── */

const SCENARIO_TYPE_SUFFIX = /\s*[([]([^()[\]]*)[)\]]\s*$/;
const STEP_KEYWORD = /^(given|when|then|and|but)\b\s*:?\s*(.*)$/i;
const GHERKIN_STRUCTURE =
  /^(feature|scenario(?:\s+outline|\s+template)?|background|examples|scenarios|rule|example)\s*:/i;

/** A Gherkin "Scenario:" line inside a block — the start of a scenario of its own. */
const SCENARIO_LINE =
  /^(?:scenario(?:\s+outline|\s+template)?|example)\s*:\s*(.*)$/i;

interface ParsedScenario {
  scenario: BddScenario;
  typed: boolean;
}

function parseScenarios(
  lines: string[],
  existing: BddScenario[],
  state: ParseState,
): BddScenario[] {
  const { before, sections } = splitAtHeadings(lines, 3);
  const parsed: { sc: ParsedScenario; heading: string }[] = [];
  if (before.some((l) => SCENARIO_LINE.test(l.trim()))) {
    // Gherkin pasted straight under the section (e.g. from a .feature file or Jira) without "### SC-xx" headings.
    const pasted = parseScenarioBlock("", before, state).filter(
      (sc) => sc.scenario.title || hasSteps(sc.scenario),
    );
    state.warnings.push(
      `Gherkin under "BDD scenarios" without a "### SC-xx · Title (type)" heading was read as ${pasted.length} scenario${pasted.length === 1 ? "" : "s"}.`,
    );
    parsed.push(...pasted.map((sc) => ({ sc, heading: "" })));
  } else {
    const stray = strayText(before);
    if (stray) {
      state.extras.push(stray);
      state.warnings.push(
        'Text under "BDD scenarios" before the first scenario heading was moved to Notes.',
      );
    }
  }
  for (const section of sections) {
    parsed.push(
      ...parseScenarioBlock(section.heading, section.lines, state).map(
        (sc) => ({ sc, heading: section.heading }),
      ),
    );
  }

  const out: BddScenario[] = [];
  const taken = new Set(existing.map((s) => s.id));
  let happySeen = existing.some((s) => s.type === "happy");
  for (const { sc, heading } of parsed) {
    if (!sc.scenario.id || taken.has(sc.scenario.id)) {
      const fresh = nextItemId("SC", [...taken]);
      state.warnings.push(
        sc.scenario.id
          ? `Scenario id ${sc.scenario.id} is used twice; the second one was renumbered ${fresh}.`
          : `Scenario "${sc.scenario.title || heading}" had no SC id; it was numbered ${fresh}.`,
      );
      sc.scenario.id = fresh;
    }
    if (!sc.typed) {
      sc.scenario.type = happySeen ? "alternate" : "happy";
      state.warnings.push(
        `${sc.scenario.id} has no type in its heading — add (happy path), (alternate), (negative) or (edge case); it was read as ${sc.scenario.type === "happy" ? "happy path" : "alternate"}.`,
      );
    }
    if (sc.scenario.type === "happy") happySeen = true;
    taken.add(sc.scenario.id);
    out.push(sc.scenario);
  }
  return out;
}

function hasSteps(sc: BddScenario): boolean {
  return sc.given.length + sc.when.length + sc.then.length > 0;
}

/** Id, title and type from a Gherkin "Scenario: SC-02 Wrong password" line and the tags above it (@SC-02 @negative). */
function scenarioLineInfo(
  text: string,
  tags: string[],
): { id: string; title: string; type: ScenarioType | null } {
  let title = oneLine(text);
  let id = "";
  const m = ITEM_HEADING("SC").exec(title);
  if (m) {
    id = normaliseItemId("SC", m[1]);
    title = oneLine(m[2]);
  }
  let type: ScenarioType | null = null;
  const suffix = SCENARIO_TYPE_SUFFIX.exec(title);
  if (suffix && parseScenarioTypeLabel(suffix[1])) {
    type = parseScenarioTypeLabel(suffix[1]);
    title = title.slice(0, suffix.index).trim();
  }
  for (const tag of tags.map((t) => t.replace(/^@/, ""))) {
    if (!id && /^SC[-_]?\d{1,4}$/i.test(tag)) id = normaliseItemId("SC", tag);
    type ??= parseScenarioTypeLabel(tag);
  }
  return { id, title, type };
}

/**
 * One "### SC-xx" block. Usually one scenario; a block holding several Gherkin "Scenario:" lines (pasted from a
 * .feature file) yields one scenario per "Scenario:" line instead of one scenario with all their steps merged.
 */
function parseScenarioBlock(
  heading: string,
  lines: string[],
  state: ParseState,
): ParsedScenario[] {
  const m = ITEM_HEADING("SC").exec(heading.trim());
  const id = m ? normaliseItemId("SC", m[1]) : "";
  let title = unwrapBold(oneLine(m ? m[2] : heading));
  let type: ScenarioType = "alternate";
  let typed = false;
  const suffix = SCENARIO_TYPE_SUFFIX.exec(title);
  if (suffix) {
    const parsed = parseScenarioTypeLabel(suffix[1]);
    if (parsed) {
      type = parsed;
      typed = true;
      title = title.slice(0, suffix.index).trim();
    }
  }
  title = title.replace(/^scenario\s*:\s*/i, "");

  // Steps live in fenced blocks; without any fence the whole block is read as steps.
  const fenced: string[] = [];
  const outside: string[] = [];
  let fence: FenceState | null = null;
  let sawFence = false;
  for (const line of lines) {
    const wasInside = fence !== null;
    const step = stepFence(fence, line);
    fence = step.state;
    if (!wasInside && step.inside) {
      sawFence = true;
      continue; // opening marker
    }
    if (wasInside && fence === null) continue; // closing marker
    if (wasInside) fenced.push(line);
    else outside.push(line);
  }
  const label = id || title || heading || SECTION.scenarios;
  let stepLines = fenced;
  if (sawFence) {
    const stray = strayText(outside);
    if (stray) {
      state.extras.push(stray);
      state.warnings.push(
        `${label}: text outside the gherkin block was moved to Notes.`,
      );
    }
  } else {
    stepLines = outside;
  }

  const out: ParsedScenario[] = [
    {
      scenario: {
        id,
        title,
        type,
        given: [],
        when: [],
        then: [],
        elementIds: [],
      },
      typed,
    },
  ];
  let scenario = out[0].scenario;
  let phase: "given" | "when" | "then" | null = null;
  let warnedTable = false;
  let tags: string[] = [];
  // Gherkin "Background:" steps are given steps of every scenario that follows them.
  let background: string[] | null = null;
  const sharedGiven: string[] = [];
  for (const raw of stepLines) {
    let line = raw.trim();
    if (!line) continue;
    if (line.startsWith("@")) {
      tags.push(...line.split(/\s+/));
      continue;
    }
    const scenarioLine = SCENARIO_LINE.exec(line);
    if (scenarioLine) {
      const info = scenarioLineInfo(scenarioLine[1], tags);
      tags = [];
      background = null;
      const current = out[out.length - 1];
      if (hasSteps(scenario)) {
        out.push({
          scenario: {
            id: info.id,
            title: info.title,
            type: info.type ?? "alternate",
            given: [],
            when: [],
            then: [],
            elementIds: [],
          },
          typed: info.type !== null,
        });
        scenario = out[out.length - 1].scenario;
        phase = null;
      } else {
        // The block's first "Scenario:" line names the scenario its heading already describes.
        if (!scenario.title) scenario.title = info.title;
        if (!scenario.id) scenario.id = info.id;
        if (!current.typed && info.type) {
          scenario.type = info.type;
          current.typed = true;
        }
      }
      continue;
    }
    if (/^background\s*:/i.test(line)) {
      background = sharedGiven;
      continue;
    }
    if (line.startsWith("#") || GHERKIN_STRUCTURE.test(line)) continue;
    if (
      line.startsWith("|") ||
      line.startsWith('"""') ||
      line.startsWith("```")
    ) {
      if (!warnedTable) {
        state.warnings.push(
          `${label}: example tables and doc strings are not supported in this format and were ignored.`,
        );
        warnedTable = true;
      }
      continue;
    }
    line = line.replace(/^>\s*/, "").replace(/^(?:[-+]|\d{1,3}[.)])\s+/, "");
    let star = false;
    if (/^\*\s+/.test(line) && !/^\*\*/.test(line)) {
      star = true;
      line = line.replace(/^\*\s+/, "");
    }
    line = line.replace(
      /^(\*\*|__)\s*(given|when|then|and|but)\s*:?\s*\1\s*:?/i,
      "$2 ",
    );
    const kw = STEP_KEYWORD.exec(line);
    let keyword: string;
    let text: string;
    if (kw) {
      keyword = kw[1].toLowerCase();
      text = oneLine(kw[2]);
    } else {
      keyword = "and";
      text = oneLine(line);
      if (!star) {
        state.warnings.push(
          `${label}: the line "${truncateForMessage(text)}" has no GIVEN/WHEN/THEN/AND keyword; it was added to the ${phase ?? "given"} steps.`,
        );
      }
    }
    if (background) {
      if (text) background.push(text);
      continue;
    }
    if (keyword === "given" || keyword === "when" || keyword === "then")
      phase = keyword;
    else if (!phase) phase = "given";
    if (text) scenario[phase].push(text);
  }
  if (sharedGiven.length) {
    for (const { scenario: sc } of out)
      sc.given = [
        ...sharedGiven,
        ...sc.given.filter((g) => !sharedGiven.includes(g)),
      ];
  }
  if (out.length > 1) {
    state.warnings.push(
      `${label}: its gherkin block held ${out.length} scenarios ("Scenario:" lines); they were split into separate scenarios.`,
    );
  }
  return out;
}

function truncateForMessage(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}
