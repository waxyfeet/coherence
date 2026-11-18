/**
 * OWNER: formats builder.
 * The fixed words of the use-case-bdd format: section headings, element type labels, scenario type
 * labels, id shapes — and their tolerant reverse mappings used by the parser.
 */
import {
  ELEMENT_TYPES,
  formatUseCaseId,
  type BusinessRule,
  type ElementType,
  type ScenarioType,
  type UseCaseSize,
  type UseCaseStatus,
} from "@shared/types";
import { capitalise } from "../markdown";

export const FORMAT_ID = "use-case-bdd";

/**
 * Every front-matter key the format writes (some only sometimes) or reads. Other keys a BA adds (priority,
 * owner, labels…) are not part of the model and are carried over when the front matter is rewritten.
 */
export const FRONT_MATTER_KEYS = [
  "id",
  "internalId",
  "title",
  "format",
  "featureId",
  "feature",
  "personaId",
  "persona",
  "screenIds",
  "screens",
  "elements",
  "elementIds",
  "dependsOn",
  "leadsTo",
  "size",
  "status",
  "revision",
  "updated",
  "staleReason",
  "external",
] as const;

export type RuleElementType = BusinessRule["elementType"];

export const SECTION = {
  story: "User story",
  preconditions: "Preconditions",
  postconditions: "Postconditions",
  rules: "Business rules",
  scenarios: "BDD scenarios",
  assumptions: "Assumptions",
  openQuestions: "Open questions",
  notes: "Notes",
} as const;

export type SectionKey = keyof typeof SECTION | "scope";

/** Heading → section key, tolerant of wording/casing/punctuation variants the BA may type. */
export function sectionKeyFor(heading: string): SectionKey | null {
  const key = heading.toLowerCase().replace(/[^a-z]/g, "");
  switch (key) {
    case "userstory":
    case "story":
    case "userstories":
      return "story";
    case "scope":
      return "scope";
    case "preconditions":
    case "precondition":
      return "preconditions";
    case "postconditions":
    case "postcondition":
      return "postconditions";
    case "businessrules":
    case "businessrule":
    case "rules":
    case "elementrules":
      return "rules";
    case "bddscenarios":
    case "bddscenario":
    case "scenarios":
    case "acceptancecriteria":
    case "acceptancetests":
    case "bdd":
      return "scenarios";
    case "assumptions":
    case "assumption":
      return "assumptions";
    case "openquestions":
    case "openquestion":
    case "questions":
      return "openQuestions";
    case "notes":
    case "note":
      return "notes";
    default:
      return null;
  }
}

/* ── Element types ── */

/** "email_input" → "Email input"; 'screen' → "Screen"; 'general' → "General". */
export function elementTypeLabel(type: RuleElementType): string {
  return capitalise(type.replace(/_/g, " "));
}

const ELEMENT_TYPE_SET = new Set<string>([
  ...ELEMENT_TYPES,
  "screen",
  "general",
]);

/** Words BAs commonly use instead of the canonical type label. */
const TYPE_SYNONYMS: Record<string, RuleElementType> = {
  text_field: "text_input",
  textbox: "text_input",
  text_box: "text_input",
  input: "text_input",
  field: "text_input",
  input_field: "text_input",
  text: "text",
  email: "email_input",
  email_field: "email_input",
  password: "password_input",
  password_field: "password_input",
  number: "number_input",
  numeric_input: "number_input",
  phone: "phone_input",
  telephone_input: "phone_input",
  currency: "currency_input",
  amount: "currency_input",
  text_area: "textarea",
  multiline_text: "textarea",
  search: "search_input",
  search_box: "search_input",
  search_field: "search_input",
  select: "dropdown",
  drop_down: "dropdown",
  select_list: "dropdown",
  picklist: "dropdown",
  dropdown_list: "dropdown",
  multiselect: "multi_select",
  multi_select_list: "multi_select",
  autocomplete: "combobox",
  combo_box: "combobox",
  check_box: "checkbox",
  radio: "radio_group",
  radio_button: "radio_group",
  radio_buttons: "radio_group",
  switch: "toggle",
  toggle_switch: "toggle",
  date: "date_picker",
  datepicker: "date_picker",
  time: "time_picker",
  date_range: "date_range_picker",
  range_slider: "slider",
  upload: "file_upload",
  file_input: "file_upload",
  editor: "rich_text_editor",
  rich_text: "rich_text_editor",
  grid: "table",
  data_table: "table",
  data_grid: "table",
  tab: "tabs",
  tab_bar: "tabs",
  nav: "navigation_bar",
  navbar: "navigation_bar",
  navigation: "navigation_bar",
  nav_bar: "navigation_bar",
  top_bar: "navigation_bar",
  side_bar: "sidebar",
  side_nav: "sidebar",
  crumbs: "breadcrumb",
  breadcrumbs: "breadcrumb",
  pager: "pagination",
  wizard: "stepper",
  steps: "stepper",
  dialog: "modal",
  popup: "modal",
  snackbar: "toast",
  notification: "toast",
  message: "alert",
  callout: "banner",
  hint: "tooltip",
  pill: "chip",
  picture: "image",
  photo: "image",
  graph: "chart",
  progress: "progress_bar",
  loader: "spinner",
  loading_indicator: "spinner",
  title: "heading",
  header_text: "heading",
  caption: "label",
  paragraph: "text",
  static_text: "text",
  separator: "divider",
  section: "container",
  panel: "container",
  group: "container",
  hyperlink: "link",
  icon_link: "icon_button",
  screen_level: "screen",
  page: "screen",
  screen_rules: "screen",
  whole_screen: "screen",
  general_rules: "general",
  rule: "general",
  rules: "general",
  business_rule: "general",
  cta: "button",
  primary_button: "button",
};

/** Human type words → ElementType ('screen'/'general' included). null when not recognisable. */
export function parseElementTypeLabel(label: string): RuleElementType | null {
  const key = label
    .trim()
    .toLowerCase()
    .replace(/[`*_]+/g, " ")
    .trim()
    .replace(/[\s\-/]+/g, "_");
  if (!key) return null;
  if (ELEMENT_TYPE_SET.has(key)) return key as RuleElementType;
  if (TYPE_SYNONYMS[key]) return TYPE_SYNONYMS[key];
  const singular = key.replace(/s$/, "");
  if (ELEMENT_TYPE_SET.has(singular)) return singular as RuleElementType;
  if (TYPE_SYNONYMS[singular]) return TYPE_SYNONYMS[singular];
  return null;
}

export function isElementType(value: string): value is ElementType {
  return (ELEMENT_TYPES as readonly string[]).includes(value);
}

/* ── Scenario types ── */

const SCENARIO_TYPE_LABEL: Record<ScenarioType, string> = {
  happy: "happy path",
  alternate: "alternate",
  negative: "negative",
  edge: "edge case",
};

export function scenarioTypeLabel(type: ScenarioType): string {
  return SCENARIO_TYPE_LABEL[type] ?? "alternate";
}

/** "(happy path)", "(Negative)", "(edge)", "(alternative flow)" … → ScenarioType. */
export function parseScenarioTypeLabel(label: string): ScenarioType | null {
  const key = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
  switch (key) {
    case "happy path":
    case "happy":
    case "happy flow":
    case "main flow":
    case "main success scenario":
    case "main":
    case "success":
    case "basic flow":
    case "primary":
      return "happy";
    case "alternate":
    case "alternate path":
    case "alternate flow":
    case "alternative":
    case "alternative path":
    case "alternative flow":
    case "alt":
      return "alternate";
    case "negative":
    case "negative path":
    case "error":
    case "error path":
    case "failure":
    case "exception":
    case "unhappy path":
    case "sad path":
    case "validation":
      return "negative";
    case "edge case":
    case "edge":
    case "edge cases":
    case "boundary":
    case "corner case":
      return "edge";
    default:
      return null;
  }
}

/* ── Ids ── */

/** "BR-1", "br 01", "BR01" → "BR-01"; anything else is returned trimmed and unchanged. */
export function normaliseItemId(prefix: "BR" | "SC", id: string): string {
  const m = new RegExp(`^${prefix}[-_\\s]?0*(\\d{1,4})$`, "i").exec(id.trim());
  return m ? `${prefix}-${m[1].padStart(2, "0")}` : id.trim();
}

/** "uc-3", "UC 003", "UC003", "3" → "UC-003"; anything else is returned trimmed. */
export function normaliseUseCaseId(id: string): string {
  const m = /^(?:UC[-_\s]?)?0*(\d{1,5})$/i.exec(id.trim());
  return m ? formatUseCaseId(Number(m[1])) : id.trim();
}

export function nextItemId(
  prefix: "BR" | "SC",
  taken: Iterable<string>,
): string {
  let max = 0;
  for (const id of taken) {
    const m = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(2, "0")}`;
}

/* ── Front matter enums ── */

export function parseSize(value: unknown): UseCaseSize | null {
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  if (s === "s" || s === "small") return "S";
  if (s === "m" || s === "medium") return "M";
  if (s === "l" || s === "large") return "L";
  return null;
}

export const USE_CASE_STATUSES: readonly UseCaseStatus[] = [
  "generated",
  "edited",
  "stale",
  "approved",
];

export function parseStatus(value: unknown): UseCaseStatus | null {
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  return (USE_CASE_STATUSES as readonly string[]).includes(s)
    ? (s as UseCaseStatus)
    : null;
}

export const STATUS_LABEL: Record<UseCaseStatus, string> = {
  generated: "Generated",
  edited: "Edited",
  stale: "Stale",
  approved: "Approved",
};
