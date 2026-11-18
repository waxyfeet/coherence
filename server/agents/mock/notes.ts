/**
 * The offline Screen Analyst cannot see the image, but the BA's screen notes and project context often state
 * facts verbatim ("Period" options: Today, This week, This month (default)…; prices in AUD incl. GST).
 * These helpers fold those facts into the heuristic inventory so the offline spec uses the BA's own data.
 */
import type { Project } from "@shared/types";
import type { ScreenAnalysisOutput } from "../schemas";

const OPTION_ELEMENT_TYPES = new Set([
  "dropdown",
  "multi_select",
  "combobox",
  "radio_group",
  "tabs",
  "menu",
]);
const MAX_OPTIONS = 30;
const MAX_OPTION_LENGTH = 50;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface NotedOptions {
  options: string[];
  defaultValue?: string;
}

/**
 * Options the notes list for a label, e.g. `"Period" options: Today, This week (default), This year — …` or
 * `Country dropdown options, in this order: Australia (default), New Zealand.` Undefined when not stated.
 */
export function optionsFromNotes(
  notes: string,
  label: string,
): NotedOptions | undefined {
  if (!notes.trim() || !label.trim()) return undefined;
  const pattern = new RegExp(
    `"?${escapeRegExp(label.trim())}"?(?:\\s+(?:dropdown|filter|selector|field|menu|tabs?))?(?:\\s+options)?(?:,\\s*in this order)?\\s*:\\s*([^.]+)\\.`,
    "i",
  );
  const match = pattern.exec(notes);
  if (!match) return undefined;
  // The list ends where the sentence turns into an explanation ("… This year — it drives the tiles").
  const list = match[1].split(/\s+[—–]\s+|;/)[0];
  const raw = list
    .split(/,\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (raw.length < 2 || raw.length > MAX_OPTIONS) return undefined;
  let defaultValue: string | undefined;
  const options = raw.map((item) => {
    const m = /^(.*?)\s*\((?:default|selected)\)$/i.exec(item);
    if (m) {
      defaultValue = m[1].trim();
      return defaultValue;
    }
    return item;
  });
  if (options.some((o) => !o || o.length > MAX_OPTION_LENGTH)) return undefined;
  return { options, defaultValue };
}

/** Applies option lists stated in the BA's notes to the matching option elements. Returns what changed. */
export function applyNotedOptions(
  output: ScreenAnalysisOutput,
  notes: string,
): string[] {
  const changed: string[] = [];
  for (const e of output.elements) {
    if (!OPTION_ELEMENT_TYPES.has(e.type) || !e.label) continue;
    const noted = optionsFromNotes(notes, e.label);
    if (!noted) continue;
    e.options = noted.options;
    if (noted.defaultValue) e.defaultValue = noted.defaultValue;
    else if (e.defaultValue && !noted.options.includes(e.defaultValue))
      e.defaultValue = "";
    e.inferred = e.inferred.filter(
      (f) => f !== "options" && f !== "defaultValue",
    );
    changed.push(e.key);
  }
  return changed;
}

const INPUT_TYPES = new Set([
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
]);
/** "Country dropdown options…", "\"Plan\" selector options…" — a control the notes name together with its type. */
const NOTED_CONTROL = /\s(dropdown|selector|tabs)\s+options\b/gi;

function labelBefore(text: string): string | undefined {
  const quoted = /"([^"\n]{2,40})"\s*$/.exec(text);
  if (quoted) return quoted[1].trim();
  // The capitalised word that starts the name: "…then the Country" → "Country", "Payment method" stays whole.
  return /\b([A-Z][A-Za-z]*(?: [a-z][A-Za-z]*){0,2})\s*$/.exec(text)?.[1];
}

/**
 * Option controls the BA's notes describe ("Country dropdown options, in this order: Australia (default), …")
 * but the name-based template does not contain: added to the screen's main form region, so their options
 * reach the business rules. Their position is unknown offline (bounds -1, listed but not drawn by the
 * inspector). Returns the added keys.
 */
export function addNotedOptionElements(
  output: ScreenAnalysisOutput,
  notes: string,
): string[] {
  if (!notes.trim()) return [];
  const known = new Set(
    output.elements.map((e) => e.label.trim().toLowerCase()).filter(Boolean),
  );
  const keys = new Set(output.elements.map((e) => e.key));
  // The region holding most input controls is where the form lives.
  const inputs = new Map<string, number>();
  for (const e of output.elements)
    if (INPUT_TYPES.has(e.type))
      inputs.set(e.regionKey, (inputs.get(e.regionKey) ?? 0) + 1);
  const formRegion = output.regions
    .filter((r) => inputs.has(r.key))
    .sort((a, b) => inputs.get(b.key)! - inputs.get(a.key)!)[0];
  if (!formRegion) return [];

  const added: string[] = [];
  for (const m of notes.matchAll(NOTED_CONTROL)) {
    const label = labelBefore(notes.slice(Math.max(0, m.index - 60), m.index));
    if (!label || known.has(label.toLowerCase())) continue;
    const noted = optionsFromNotes(notes, label);
    if (!noted) continue;
    const word = m[1].toLowerCase();
    const type = word === "tabs" ? "tabs" : "dropdown";
    const base =
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "option";
    let key = base;
    for (let n = 2; keys.has(key); n++) key = `${base}_${n}`;
    output.elements.push({
      key,
      regionKey: formRegion.key,
      type,
      label,
      description: `${type === "tabs" ? "Tab bar" : "Dropdown"} labelled "${label}" in the ${formRegion.name} section.`,
      placeholder: "",
      defaultValue: noted.defaultValue ?? "",
      helperText: "",
      options: noted.options,
      required: "unknown",
      validation: [],
      states: [],
      behavior: "",
      navigatesToScreenId: "",
      navigatesToHint: "",
      dataBinding: "",
      inferred: [],
      bounds: { x: -1, y: -1, width: -1, height: -1 },
    });
    known.add(label.toLowerCase());
    keys.add(key);
    added.push(key);
  }
  return added;
}

interface Locale {
  symbol: string;
  tax: string;
}

/** Currency symbol and sales-tax name implied by the project description / context, if any. */
export function projectLocale(
  project: Pick<Project, "description" | "additionalContext">,
): Locale | undefined {
  const text = `${project.description} ${project.additionalContext}`;
  if (/\bAUD\b|\bAustralia/i.test(text)) return { symbol: "$", tax: "GST" };
  if (/\bNZD\b|\bNew Zealand/i.test(text)) return { symbol: "$", tax: "GST" };
  if (/\bGBP\b|£|\bUnited Kingdom\b|\bUK\b/.test(text))
    return { symbol: "£", tax: "VAT" };
  if (/\bEUR\b|€/.test(text)) return { symbol: "€", tax: "VAT" };
  if (/\bUSD\b|\bUnited States\b|\bUS\$/.test(text))
    return { symbol: "$", tax: "sales tax" };
  if (/\bZAR\b|\bSouth Africa/i.test(text)) return { symbol: "R", tax: "VAT" };
  return undefined;
}

/** Rewrites the template's sample currency (€) and tax name (VAT) to the project's. */
export function localiseOutput(
  output: ScreenAnalysisOutput,
  project: Pick<Project, "description" | "additionalContext">,
): void {
  const locale = projectLocale(project);
  if (!locale || (locale.symbol === "€" && locale.tax === "VAT")) return;
  const fix = (text: string): string =>
    text.replace(/€/g, locale.symbol).replace(/\bVAT\b/g, locale.tax);
  const fixAll = (list: string[]): string[] => list.map(fix);
  output.title = fix(output.title);
  output.purpose = fix(output.purpose);
  output.openQuestions = fixAll(output.openQuestions);
  for (const r of output.regions) {
    r.name = fix(r.name);
    r.purpose = fix(r.purpose);
  }
  for (const e of output.elements) {
    e.label = fix(e.label);
    e.description = fix(e.description);
    e.placeholder = fix(e.placeholder);
    e.defaultValue = fix(e.defaultValue);
    e.helperText = fix(e.helperText);
    e.behavior = fix(e.behavior);
    e.options = fixAll(e.options);
    e.validation = fixAll(e.validation);
    e.states = fixAll(e.states);
  }
}
