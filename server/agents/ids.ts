/**
 * Id composition and conversion of raw Screen Analyst output into the domain ScreenAnalysis.
 * The model only ever returns keys; ids ("<screenKey>.<elementKey>") are composed here so they are
 * well-formed, unique and stable across re-generations (screen keys are reused from the previous model).
 */
import type {
  ElementBounds,
  Screen,
  ScreenAnalysis,
  ScreenRegion,
  UIElement,
} from "@shared/types";
import { slugify } from "@shared/types";
import type { z } from "zod";
import type {
  AnalysedElement,
  BoundsSchema,
  ScreenAnalysisOutput,
} from "./schemas";
import { dedupeText, keySlug, uniqueKey } from "./text";

export const FALLBACK_REGION_KEY = "main";

const INFERABLE_FIELDS = new Set([
  "label",
  "placeholder",
  "defaultValue",
  "helperText",
  "options",
  "required",
  "validation",
  "states",
  "behavior",
  "navigation",
  "dataBinding",
  "type",
  "bounds",
]);

/** Screen key: previous key for the same screen (keeps element ids stable), else a unique slug of the name. */
export function screenKeyFor(
  screen: Screen,
  takenScreenKeys: readonly string[],
  previous?: ScreenAnalysis,
): string {
  if (previous && previous.screenId === screen.id && previous.screenKey)
    return previous.screenKey;
  const taken = new Set(takenScreenKeys);
  return uniqueKey(slugify(screen.name, 40), taken, "-");
}

/**
 * Assigns screen keys for a whole project in screen order, reusing previous keys first so that a renamed
 * screen keeps its ids. Returns screenId → key.
 */
export function assignScreenKeys(
  screens: readonly Screen[],
  previous: readonly ScreenAnalysis[],
): Map<string, string> {
  const result = new Map<string, string>();
  const taken = new Set<string>();
  for (const screen of screens) {
    const prev = previous.find((p) => p.screenId === screen.id);
    if (prev?.screenKey && !taken.has(prev.screenKey)) {
      result.set(screen.id, prev.screenKey);
      taken.add(prev.screenKey);
    }
  }
  for (const screen of screens) {
    if (result.has(screen.id)) continue;
    result.set(screen.id, uniqueKey(slugify(screen.name, 40), taken, "-"));
  }
  return result;
}

export function composeId(screenKey: string, key: string): string {
  return `${screenKey}.${key}`;
}

/** Percent bounds → ElementBounds, or undefined when unknown (-1) / nonsensical. Clamped to the image. */
export function toBounds(
  b: z.infer<typeof BoundsSchema> | undefined,
): ElementBounds | undefined {
  if (!b) return undefined;
  const values = [b.x, b.y, b.width, b.height];
  if (values.some((v) => typeof v !== "number" || !Number.isFinite(v)))
    return undefined;
  // -1 is the "unknown" sentinel; any other negative number is equally unusable.
  if (values.some((v) => v < 0)) return undefined;
  const x = clamp(b.x, 0, 100);
  const y = clamp(b.y, 0, 100);
  const width = clamp(b.width, 0, 100 - x);
  const height = clamp(b.height, 0, 100 - y);
  if (width <= 0 || height <= 0) return undefined;
  return {
    x: round1(x),
    y: round1(y),
    width: round1(width),
    height: round1(height),
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function nonEmpty(value: string | undefined): string | undefined {
  const t = (value ?? "").trim();
  return t ? t : undefined;
}

function nonEmptyList(
  list: readonly string[] | undefined,
): string[] | undefined {
  const cleaned = dedupeText(list ?? []);
  return cleaned.length ? cleaned : undefined;
}

/** Options are verbatim and may legitimately repeat-differ only by case, so only trim + drop empties. */
function cleanOptions(
  list: readonly string[] | undefined,
): string[] | undefined {
  const out = (list ?? []).map((o) => o.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

function elementBaseKey(
  el: Pick<AnalysedElement, "key" | "label" | "type">,
): string {
  return keySlug(el.key) || keySlug(el.label) || keySlug(el.type) || "element";
}

export interface ConvertAnalysisArgs {
  raw: ScreenAnalysisOutput;
  screen: Screen;
  version: number;
  screenKey: string;
  /** Ids of all uploaded screens (navigation targets are validated against them). */
  validScreenIds: readonly string[];
  /** Screen name → id, to rescue navigation targets given as a name instead of an id. */
  screenIdByName?: ReadonlyMap<string, string>;
  analysedAt?: string;
}

export interface ConvertAnalysisResult {
  analysis: ScreenAnalysis;
  /** Plain-language notes about repairs (renamed duplicate keys, unknown references…). */
  repairs: string[];
}

/** Raw model output → ScreenAnalysis with composed, de-duplicated ids and validated references. */
export function toScreenAnalysis(
  args: ConvertAnalysisArgs,
): ConvertAnalysisResult {
  const { raw, screen, screenKey } = args;
  const repairs: string[] = [];
  const validScreens = new Set(args.validScreenIds);

  // Regions first: keys slugified + de-duplicated; remember the model's key → our key.
  const regionKeys = new Set<string>();
  const regionKeyMap = new Map<string, string>();
  const regions: ScreenRegion[] = [];
  for (const r of raw.regions) {
    const base = keySlug(r.key) || keySlug(r.name) || "region";
    const key = uniqueKey(base, regionKeys);
    if (!regionKeyMap.has(r.key)) regionKeyMap.set(r.key, key);
    if (!regionKeyMap.has(base)) regionKeyMap.set(base, key);
    regions.push({
      id: composeId(screenKey, key),
      key,
      screenId: screen.id,
      name: r.name.trim() || key.replace(/_/g, " "),
      purpose: r.purpose.trim(),
      layout: r.layout.trim(),
      elementIds: [],
    });
  }

  const ensureFallbackRegion = (): ScreenRegion => {
    const existing = regions.find((r) => r.key === FALLBACK_REGION_KEY);
    if (existing) return existing;
    const key = uniqueKey(FALLBACK_REGION_KEY, regionKeys);
    const region: ScreenRegion = {
      id: composeId(screenKey, key),
      key,
      screenId: screen.id,
      name: "Main content",
      purpose:
        "Elements that were not assigned to a specific area of the screen.",
      layout: "main content area",
      elementIds: [],
    };
    regions.push(region);
    return region;
  };

  const elementKeys = new Set<string>();
  const elements: UIElement[] = [];
  for (const el of raw.elements) {
    const base = elementBaseKey(el);
    const key = uniqueKey(base, elementKeys);
    if (key !== base)
      repairs.push(
        `Element key "${base}" was used twice on "${screen.name}" — renamed to "${key}".`,
      );

    const regionKey =
      regionKeyMap.get(el.regionKey) ?? regionKeyMap.get(keySlug(el.regionKey));
    let region = regionKey
      ? regions.find((r) => r.key === regionKey)
      : undefined;
    if (!region) {
      region = ensureFallbackRegion();
      if (el.regionKey)
        repairs.push(
          `Element "${key}" referenced unknown region "${el.regionKey}" — placed in "${region.name}".`,
        );
    }

    let navigatesToScreenId: string | undefined;
    const navRaw = el.navigatesToScreenId.trim();
    let navigatesToHint = nonEmpty(el.navigatesToHint);
    if (navRaw) {
      if (validScreens.has(navRaw)) {
        navigatesToScreenId = navRaw;
      } else {
        const byName = args.screenIdByName?.get(navRaw.toLowerCase());
        if (byName) {
          navigatesToScreenId = byName;
        } else {
          navigatesToHint = navigatesToHint ?? navRaw;
          repairs.push(
            `Element "${key}" pointed at unknown screen "${navRaw}" — kept as a navigation hint.`,
          );
        }
      }
    }

    const required =
      el.required === "yes" ? true : el.required === "no" ? false : undefined;
    const id = composeId(screenKey, key);
    const element: UIElement = {
      id,
      key,
      screenId: screen.id,
      regionId: region.id,
      type: el.type,
      label: el.label.trim(),
      description: el.description.trim(),
      inferred: dedupeText(el.inferred).filter(
        (f) => INFERABLE_FIELDS.has(f) || f.length < 40,
      ),
    };
    const placeholder = nonEmpty(el.placeholder);
    if (placeholder) element.placeholder = placeholder;
    const defaultValue = nonEmpty(el.defaultValue);
    if (defaultValue) element.defaultValue = defaultValue;
    const helperText = nonEmpty(el.helperText);
    if (helperText) element.helperText = helperText;
    const options = cleanOptions(el.options);
    if (options) element.options = options;
    if (required !== undefined) element.required = required;
    const validation = nonEmptyList(el.validation);
    if (validation) element.validation = validation;
    const states = nonEmptyList(el.states);
    if (states) element.states = states;
    const behavior = nonEmpty(el.behavior);
    if (behavior) element.behavior = behavior;
    if (navigatesToScreenId && navigatesToScreenId !== screen.id)
      element.navigatesToScreenId = navigatesToScreenId;
    if (navigatesToHint) element.navigatesToHint = navigatesToHint;
    const dataBinding = nonEmpty(el.dataBinding);
    if (dataBinding) element.dataBinding = dataBinding;
    const bounds = toBounds(el.bounds);
    if (bounds) element.bounds = bounds;

    elements.push(element);
    region.elementIds.push(id);
  }

  const analysis: ScreenAnalysis = {
    screenId: screen.id,
    screenVersion: args.version,
    screenKey,
    title: raw.title.trim() || screen.name,
    purpose: raw.purpose.trim(),
    screenType: raw.screenType,
    personas: dedupeText(raw.personas),
    // Regions without elements carry no requirement; dropping them keeps the graph and inventory clean.
    regions: regions.filter((r) => r.elementIds.length > 0),
    elements,
    dataEntities: dedupeText(raw.dataEntities),
    openQuestions: dedupeText(raw.openQuestions),
    analysedAt: args.analysedAt ?? new Date().toISOString(),
  };
  return { analysis, repairs };
}

/** ScreenAnalysis → the raw schema shape (used to show the Inspector the first-pass inventory). */
export function analysisToOutput(
  analysis: ScreenAnalysis,
): ScreenAnalysisOutput {
  const regionKeyById = new Map(analysis.regions.map((r) => [r.id, r.key]));
  return {
    title: analysis.title,
    purpose: analysis.purpose,
    screenType: analysis.screenType,
    personas: [...analysis.personas],
    regions: analysis.regions.map((r) => ({
      key: r.key,
      name: r.name,
      purpose: r.purpose,
      layout: r.layout,
    })),
    elements: analysis.elements.map((e) => ({
      key: e.key,
      regionKey: regionKeyById.get(e.regionId) ?? FALLBACK_REGION_KEY,
      type: e.type,
      label: e.label,
      description: e.description,
      placeholder: e.placeholder ?? "",
      defaultValue: e.defaultValue ?? "",
      helperText: e.helperText ?? "",
      options: e.options ?? [],
      required:
        e.required === true ? "yes" : e.required === false ? "no" : "unknown",
      validation: e.validation ?? [],
      states: e.states ?? [],
      behavior: e.behavior ?? "",
      navigatesToScreenId: e.navigatesToScreenId ?? "",
      navigatesToHint: e.navigatesToHint ?? "",
      dataBinding: e.dataBinding ?? "",
      inferred: e.inferred,
      bounds: e.bounds ?? { x: -1, y: -1, width: -1, height: -1 },
    })),
    dataEntities: [...analysis.dataEntities],
    openQuestions: [...analysis.openQuestions],
  };
}

const SHELL_PATTERN =
  /\b(header|top ?bar|app ?bar|nav|navigation|navbar|menu ?bar|side ?bar|sidebar|side ?nav|footer|masthead|shell|global)\b/i;
/** Headers that belong to the page content (title rows, card/section/table headers), not to the app shell. */
const CONTENT_HEADER_PATTERN =
  /\b(page|content|section|card|form|table|panel|modal|dialog|list|column|step|summary|order|detail|details)s? ?(header|heading|title|toolbar)\b/i;

/** Regions that look like the repeated application shell (header / navigation / sidebar / footer). */
export function isShellRegion(
  region: Pick<ScreenRegion, "key" | "name">,
): boolean {
  const texts = [region.key.replace(/_/g, " "), region.name];
  if (texts.some((t) => CONTENT_HEADER_PATTERN.test(t))) return false;
  return texts.some((t) => SHELL_PATTERN.test(t));
}

/** Element lookup across all analyses. */
export function indexElements(
  analyses: readonly ScreenAnalysis[],
): Map<string, UIElement> {
  const map = new Map<string, UIElement>();
  for (const a of analyses) for (const e of a.elements) map.set(e.id, e);
  return map;
}

export function indexRegions(
  analyses: readonly ScreenAnalysis[],
): Map<string, ScreenRegion> {
  const map = new Map<string, ScreenRegion>();
  for (const a of analyses) for (const r of a.regions) map.set(r.id, r);
  return map;
}

/** Element types that a user interacts with (as opposed to static content). */
export const INTERACTIVE_TYPES = new Set<string>([
  "button",
  "icon_button",
  "link",
  "text_input",
  "email_input",
  "password_input",
  "number_input",
  "phone_input",
  "currency_input",
  "textarea",
  "search_input",
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
  "tabs",
  "accordion",
  "menu",
  "pagination",
  "stepper",
  "breadcrumb",
  "table",
  "list",
]);

export const INPUT_TYPES = new Set<string>([
  "text_input",
  "email_input",
  "password_input",
  "number_input",
  "phone_input",
  "currency_input",
  "textarea",
  "search_input",
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

export const OPTION_TYPES = new Set<string>([
  "dropdown",
  "multi_select",
  "combobox",
  "radio_group",
  "tabs",
  "menu",
  "stepper",
  "breadcrumb",
]);

export const STATIC_TYPES = new Set<string>([
  "heading",
  "label",
  "text",
  "divider",
  "image",
  "icon",
  "logo",
  "container",
  "badge",
  "tag",
  "avatar",
]);
