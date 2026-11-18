/**
 * Offline Use Case Writer: user story, one business rule per element (built from the inventory facts) and
 * 3–8 BDD scenarios (happy path chained to the preconditions, negatives per validation group, alternates,
 * edge cases). `ruleFromElement` is also used by the real Writer to fill in rules a model omitted.
 */
import type {
  BddScenario,
  BusinessRule,
  Granularity,
  Screen,
  UIElement,
  UseCase,
} from "@shared/types";
import { INPUT_TYPES, OPTION_TYPES } from "../ids";
import type { WriterOutput } from "../schemas";
import {
  dedupeText,
  joinAnd,
  lowerFirst,
  oneLine,
  pluralize,
  sentence,
  singularize,
  toStep,
  upperFirst,
} from "../text";

const typeWords = (type: string): string => upperFirst(type.replace(/_/g, " "));
const q = (s: string): string => `"${s}"`;

const NAVIGATION_TYPES: ReadonlySet<string> = new Set([
  "link",
  "logo",
  "menu",
  "breadcrumb",
  "avatar",
]);

/** Long static text makes a poor rule heading; its key ("tagline", "greeting") names it better. */
const LONG_LABEL = 50;

/** Static text that is a whole sentence ("No orders match your search or filters.") is named by its key too. */
function isSentenceText(e: UIElement): boolean {
  return (
    e.type === "text" &&
    /[.!?]$/.test(e.label.trim()) &&
    e.label.trim().split(/\s+/).length > 3
  );
}

function elementName(e: UIElement): string {
  if (
    e.label &&
    (e.label.length <= LONG_LABEL || INPUT_TYPES.has(e.type)) &&
    !isSentenceText(e)
  )
    return e.label;
  if (e.label) return upperFirst(e.key.replace(/[_-]+/g, " "));
  return e.placeholder || typeWords(e.type);
}

/** "Password reset page (not among the uploaded screens)" → "Password reset page". */
function plainHint(hint: string): string {
  return hint.replace(/\s*\([^)]*\)\s*$/, "").trim() || hint;
}

const OUTCOME_VERB =
  /^(shows|asks|changes|reloads|limits|keeps|copies|duplicates|prints|approves|cancels|opens|filters|sorts|recalculates|updates|displays|hides|selects|submits|saves|clears|resets|navigates|returns|adds|removes|toggles|loads|refreshes|expands|collapses|starts|ends|sends|creates|deletes|marks|applies|exports|downloads|uploads)\b/i;

/**
 * An analyst's behaviour sentence as an observable THEN line: "When checked, the session is kept…" →
 * "the session is kept…"; "Shows only orders…" → "the system shows only orders…".
 */
function outcomeStep(behavior: string): string {
  let text = oneLine(behavior.replace(/\.$/, ""), 160);
  const conditional = /^(?:when|if|once|after)\b[^,]{1,60},\s*(.+)$/i.exec(
    text,
  );
  if (conditional) text = conditional[1];
  const first = text.split(/[;.]/)[0]?.trim() || text;
  // "Changing the period reloads all KPI tiles" → "the system reloads all KPI tiles".
  const gerund =
    /^(?:changing|selecting|clicking|choosing|ticking|entering|typing|toggling)\b.*?\s(\w+s)\s+(.+)$/i.exec(
      first,
    );
  if (gerund && OUTCOME_VERB.test(gerund[1]))
    return `the system ${gerund[1].toLowerCase()} ${gerund[2]}`;
  return OUTCOME_VERB.test(first)
    ? `the system ${lowerFirst(first)}`
    : lowerFirst(first);
}

/** A selector that always holds a value (it has a default) cannot be "left empty". */
function alwaysHasValue(e: UIElement): boolean {
  return Boolean(e.defaultValue) && OPTION_TYPES.has(e.type);
}

/* ── Business rules ──────────────────────────────────────────────────── */

function describe(e: UIElement, regionName: string): string {
  const parts: string[] = [];
  parts.push(
    sentence(e.description || `${typeWords(e.type)} in the ${regionName} area`),
  );
  const lowerDesc = e.description.toLowerCase();
  if (e.label && !lowerDesc.includes(e.label.toLowerCase()))
    parts.push(`Visible text: ${q(oneLine(e.label, 120))}.`);
  if (e.placeholder && !lowerDesc.includes(e.placeholder.toLowerCase()))
    parts.push(`Placeholder: ${q(e.placeholder)}.`);
  if (e.helperText) parts.push(`Helper text: ${q(e.helperText)}.`);
  if (regionName && !lowerDesc.includes(regionName.toLowerCase()))
    parts.push(`Located in the ${regionName} area.`);
  return parts.join(" ");
}

function optionsRule(e: UIElement): string | undefined {
  if (!e.options?.length) return undefined;
  const list = e.options.map(q).join(", ");
  switch (e.type) {
    case "table":
      return `Columns, in this order: ${list}.`;
    case "menu":
      return `Menu items, in this order: ${list}.`;
    case "tabs":
      return `Tabs, in this order: ${list}.`;
    case "breadcrumb":
      return `Breadcrumb trail: ${e.options.map(q).join(" › ")}.`;
    case "stepper":
      return `Steps, in this order: ${list}.`;
    case "badge":
    case "tag":
    case "chip":
      return `Possible values: ${list}.`;
    default:
      return `Options, in this order: ${list}.`;
  }
}

function isTrivialValidation(v: string): boolean {
  return /^(mandatory|required|optional)\.?$/i.test(v.trim());
}

/** Business rule built purely from the analyst's facts about one element. */
export function ruleFromElement(
  e: UIElement,
  regionName: string,
  screens: readonly Screen[],
  id = "BR-01",
): BusinessRule {
  const rules: string[] = [];
  const isInput = INPUT_TYPES.has(e.type);
  // A validation line that already states the obligation ("Mandatory — an active customer…") says it better.
  const statesObligation = (e.validation ?? []).some(
    (v) =>
      (/^(mandatory|required|optional)\b/i.test(v.trim()) &&
        !isTrivialValidation(v)) ||
      /^must be (checked|ticked|accepted)\b/i.test(v.trim()),
  );
  if (isInput && e.type !== "search_input" && !statesObligation) {
    if (e.required === true) {
      if (e.type === "checkbox") rules.push("Must be checked to continue.");
      else if (alwaysHasValue(e))
        rules.push("Always has a value; it cannot be cleared.");
      else if (OPTION_TYPES.has(e.type) || e.type === "radio_group")
        rules.push(
          "Mandatory; a value must be selected before the form can be submitted.",
        );
      else
        rules.push(
          "Mandatory; the form cannot be submitted while it is empty.",
        );
    } else if (e.required === false && !alwaysHasValue(e)) {
      // A selector that starts with a value (page size, sort order) is never "left empty"; "Optional" says nothing.
      rules.push("Optional.");
    }
  }
  for (const v of e.validation ?? [])
    if (!isTrivialValidation(v)) rules.push(sentence(v));
  const opts = optionsRule(e);
  if (opts) rules.push(opts);
  if (
    !e.options?.length &&
    (e.type === "dropdown" ||
      e.type === "multi_select" ||
      e.type === "radio_group")
  ) {
    rules.push(
      "The full list of options is not visible in the design and must be confirmed (see open questions).",
    );
  }
  if (e.defaultValue) {
    if (e.type === "checkbox")
      rules.push(
        /^unchecked|^off|^no$/i.test(e.defaultValue)
          ? "Unchecked by default."
          : "Checked by default.",
      );
    else if (e.type === "tabs" || e.type === "stepper")
      rules.push(`${q(e.defaultValue)} is selected by default.`);
    else if (e.type === "toggle")
      rules.push(
        `${/^on|^yes|^true/i.test(e.defaultValue) ? "On" : "Off"} by default.`,
      );
    else if (e.states?.some((s) => /read-only/i.test(s)))
      rules.push(`Shows the current value (e.g. ${q(e.defaultValue)}).`);
    else rules.push(`Default value: ${q(e.defaultValue)}.`);
  }
  if (e.placeholder && isInput)
    rules.push(`Shows the placeholder ${q(e.placeholder)} while empty.`);
  const shortStates: string[] = [];
  for (const s of e.states ?? []) {
    if (s.split(/\s+/).length <= 2) shortStates.push(s);
    else rules.push(sentence(s));
  }
  if (shortStates.length) rules.push(`States: ${shortStates.join(", ")}.`);
  if (e.behavior) rules.push(sentence(e.behavior));
  if (e.navigatesToScreenId) {
    const target = screens.find((s) => s.id === e.navigatesToScreenId);
    if (target && !(e.behavior ?? "").includes(target.name))
      rules.push(`Selecting it opens the ${target.name} screen.`);
  } else if (e.navigatesToHint) {
    const hint = plainHint(e.navigatesToHint).toLowerCase();
    const behavior = (e.behavior ?? "").toLowerCase();
    const outside = /not among|not uploaded/i.test(e.navigatesToHint);
    // "Opens the sign-in screen." already names the "Sign-in page" — unless the target is outside the uploaded screens.
    const named =
      behavior.includes(hint) ||
      (!outside &&
        behavior.includes(hint.replace(/\s+(page|screen|dialog)$/, "")));
    if (!named)
      rules.push(
        `Leads to the ${lowerFirst(plainHint(e.navigatesToHint))}${outside ? " (not part of the uploaded screens)" : ""}.`,
      );
  }
  if (e.dataBinding)
    rules.push(`Bound to the data field \`${e.dataBinding}\`.`);
  if (!rules.length) {
    if (
      e.type === "logo" ||
      e.type === "image" ||
      e.type === "icon" ||
      e.type === "avatar"
    )
      rules.push("Visual element; not interactive.");
    else if (e.type === "divider")
      rules.push("Visual separator; not interactive.");
    else
      rules.push(
        `Static text${e.label ? ` ${q(oneLine(e.label, 120))}` : ""}; not interactive.`,
      );
  }
  return {
    id,
    elementId: e.id,
    element: elementName(e),
    elementType: e.type,
    description: describe(e, regionName),
    rules: dedupeText(rules),
  };
}

/* ── Scenarios ───────────────────────────────────────────────────────── */

const SUBMIT =
  /\b(submit|save|create|send|place|sign in|sign up|log in|register|confirm|apply|update|continue|next|finish|request|pay)\b/i;
/** The commitment action outranks secondary saves ("Submit order" over "Save as draft"). */
const PRIMARY_SUBMIT =
  /\b(submit|place|sign in|sign up|log in|register|create|confirm|pay|send|finish|request)\b/i;
const SECONDARY_ACTION = /\b(draft|cancel|back|clear|reset|discard)\b/i;

function pickSubmit(buttons: readonly UIElement[]): UIElement | undefined {
  const candidates = buttons.filter(
    (b) => SUBMIT.test(b.label) && !SECONDARY_ACTION.test(b.label),
  );
  return (
    candidates.find((b) => PRIMARY_SUBMIT.test(b.label)) ??
    candidates[0] ??
    buttons.find((b) => SUBMIT.test(b.label))
  );
}

function sampleValue(e: UIElement): string {
  const label = e.label.toLowerCase();
  switch (e.type) {
    case "email_input":
      return "anna.berg@acme-supplies.com";
    case "phone_input":
      return "+44 20 7946 0123";
    case "number_input":
      return /discount|%/.test(label) ? "10" : "5";
    case "currency_input":
      return "125.00";
    case "textarea":
      return "Deliver to loading dock 3 before 10:00";
    case "search_input":
      return "acme";
    default:
      if (/po|purchase order|reference/.test(label)) return "PO-2026-0142";
      if (/name/.test(label))
        return /company/.test(label) ? "Acme Supplies Ltd" : "Anna Berg";
      if (/city/.test(label)) return "Leeds";
      if (/post ?code|zip/.test(label)) return "LS1 4AP";
      if (/vat/.test(label)) return "GB123456789";
      return "Sample value";
  }
}

/** One WHEN step that fills an input with a valid value. */
function fillStep(e: UIElement): string | undefined {
  const name = q(elementName(e));
  switch (e.type) {
    case "password_input":
      return `the user enters a valid password in ${name}`;
    case "dropdown":
    case "radio_group":
    case "multi_select": {
      const choice =
        e.options?.find((o) => o !== e.defaultValue) ?? e.options?.[0];
      return choice
        ? `the user selects ${q(choice)} in ${name}`
        : `the user selects an option in ${name}`;
    }
    case "combobox":
      return e.options?.length
        ? `the user selects ${q(e.options[0]!)} in ${name}`
        : `the user searches for and selects an existing ${lowerFirst(elementName(e))} in ${name}`;
    case "checkbox":
      return e.required ? `the user ticks ${name}` : undefined;
    case "toggle":
      return undefined;
    case "date_picker":
      return `the user selects a valid date in ${name}`;
    case "time_picker":
      return `the user selects a valid time in ${name}`;
    case "date_range_picker":
      return `the user selects a valid date range in ${name}`;
    case "file_upload":
      return `the user uploads a valid file in ${name}`;
    case "slider":
      return `the user moves ${name} to a valid value`;
    case "search_input":
      return `the user types ${q(sampleValue(e))} in the search box`;
    default:
      if (e.states?.some((s) => /read-only/i.test(s))) return undefined;
      return `the user enters ${q(sampleValue(e))} in ${name}`;
  }
}

function quotedMessage(
  texts: readonly string[] | undefined,
): string | undefined {
  for (const t of texts ?? []) {
    const m = /["“]([^"”]{4,})["”]/.exec(t);
    if (m) return m[1];
  }
  return undefined;
}

interface ScenarioDraft {
  title: string;
  type: BddScenario["type"];
  given: string[];
  when: string[];
  then: string[];
  elementIds: string[];
}

export interface MockWriterArgs {
  useCase: UseCase;
  /** The use case's elements in reading order. */
  elements: readonly UIElement[];
  regionNameOf: (regionId: string) => string;
  screens: readonly Screen[];
  personaName: string;
  granularity: Granularity;
  /** Open questions from the analyses of the use case's screens. */
  screenOpenQuestions: readonly string[];
  revisionNotes?: string;
}

const VERBS =
  /^(sign|create|browse|search|view|review|use|act|enter|add|request|update|edit|find|manage|pay|check|place|submit|filter|track|export|import|approve|reset|register|record|send|cancel|configure|change|select|upload|download|navigate|open|complete)\b/i;

/** The business benefit, chosen by what the use case is about (topic first, then its leading verb). */
function soThatFor(title: string, entityWord: string): string {
  const t = title.toLowerCase();
  const verb = t.split(/\s+/)[0] ?? "";
  if (/sign in|log in|single sign-on/.test(t))
    return "I can access my work securely";
  if (/create an account|sign up|register/.test(t))
    return "I can start using the application";
  if (/password/.test(t))
    return "I can regain access to my account without contacting support";
  if (/shell|navigation/.test(t))
    return "I can move between the main areas of the application quickly";
  if (/^(search|filter|find)$/.test(verb) || /search|filter/.test(t))
    return `I can find the ${entityWord} I need quickly`;
  if (
    /^(submit|create|enter|add|place|pay|save|record|capture|request)$/.test(
      verb,
    ) ||
    /\b(submit|place|pay for)\b/.test(t)
  ) {
    return /submit|place|pay/.test(t)
      ? `the ${entityWord.replace(/s$/, "")} reaches the team that processes it without phone calls or emails`
      : "the information is captured accurately and can be processed without rework";
  }
  if (/^(update|edit|change|manage|configure)$/.test(verb))
    return /settings|preferences|profile/.test(t)
      ? "the application works the way I need it to"
      : `my ${entityWord} stay accurate and up to date`;
  if (/metric|dashboard|chart|recent|insight/.test(t))
    return "I can spot what needs my attention without opening each record";
  if (/act on|quick action|bulk/.test(t))
    return "I can complete routine tasks with fewer clicks";
  if (/^(browse|view|review|see|open|check|track)$/.test(verb))
    return `I can see the status of my ${entityWord} at a glance`;
  return "I can complete my work efficiently";
}

export function mockWriteUseCase(args: MockWriterArgs): WriterOutput {
  const { useCase: uc, elements, screens } = args;
  const pre = uc.preconditions;
  const post = uc.postconditions;
  const firstScreen = screens.find((s) => s.id === uc.screenIds[0]);
  const entityWord =
    /\b(order|customer|product|invoice|ticket|user|item)s?\b/i
      .exec(`${uc.title} ${uc.scope}`)?.[0]
      ?.toLowerCase()
      .replace(/s$/, "") ?? "record";
  const entityPlural = `${entityWord}s`;

  const businessRules = elements.map((e, i) =>
    ruleFromElement(
      e,
      args.regionNameOf(e.regionId),
      screens,
      `BR-${String(i + 1).padStart(2, "0")}`,
    ),
  );

  const inputs = elements.filter(
    (e) =>
      INPUT_TYPES.has(e.type) &&
      e.type !== "search_input" &&
      !e.states?.some((s) => /read-only/i.test(s)),
  );
  const buttons = elements.filter(
    (e) => e.type === "button" || e.type === "icon_button",
  );
  const submit = pickSubmit(buttons);
  const table = elements.find((e) => e.type === "table" || e.type === "list");
  // Rows are named after the table ('Order lines' → 'order line'), not after the use case.
  const tableWords = table?.label.trim().split(/ +/) ?? [];
  const rowWord =
    table && table.label && tableWords.length <= 3
      ? lowerFirst(
          [
            ...tableWords.slice(0, -1),
            singularize(tableWords[tableWords.length - 1]),
          ].join(" "),
        )
      : entityWord;
  const rowPlural = rowWord === entityWord ? entityPlural : pluralize(rowWord);
  const search = elements.find((e) => e.type === "search_input");
  const tiles = elements.filter(
    (e) => e.type === "tile" || e.type === "card" || e.type === "chart",
  );
  const navigators = elements.filter(
    (e) =>
      (e.type === "link" || e.type === "button" || e.type === "menu") &&
      (e.navigatesToScreenId || e.navigatesToHint),
  );
  const alert = elements.find((e) => e.type === "alert" || e.type === "banner");
  const context = pre.slice(0, 2).map(toStep);
  const screenLabel = firstScreen?.name ?? "current";

  // Happy path.
  const isFilter = Boolean(search) || /\b(search|filter)/i.test(uc.title);
  const happy: ScenarioDraft = {
    title: uc.title,
    type: "happy",
    given: pre.map(toStep),
    when: [],
    then: [],
    elementIds: [],
  };
  if (isFilter && (search || inputs.length)) {
    if (search) {
      happy.when.push(fillStep(search)!);
      happy.elementIds.push(search.id);
    }
    const filter = inputs.find((e) => e.options?.length) ?? inputs[0];
    if (filter) {
      happy.when.push(
        fillStep(filter) ?? `the user changes ${q(elementName(filter))}`,
      );
      happy.elementIds.push(filter.id);
    }
    happy.then.push("the results update without reloading the page");
  } else if (inputs.length && (submit || inputs.length >= 2)) {
    for (const e of inputs.slice(0, 6)) {
      const step = fillStep(e);
      if (step) {
        happy.when.push(step);
        happy.elementIds.push(e.id);
      }
    }
    if (submit) {
      happy.when.push(`the user selects ${q(submit.label)}`);
      happy.elementIds.push(submit.id);
    } else {
      happy.then.push(
        "every entered value is kept and shown without validation errors",
      );
    }
  } else if (table) {
    // Viewing comes first; a lone selector (page size, period) is exercised by an alternate scenario.
    happy.given.push(`at least one ${entityWord} exists`);
    happy.when.push(`the ${screenLabel} screen finishes loading`);
    happy.then.push(
      `${q(elementName(table))} shows ${table.options?.length ? `the columns ${joinAnd(table.options.map(q))}` : "one row per record"}`,
    );
    happy.elementIds.push(table.id);
  } else if (tiles.length) {
    happy.when.push(`the ${screenLabel} screen finishes loading`);
    happy.then.push(
      `${joinAnd(tiles.slice(0, 4).map((t) => q(elementName(t))))} show their current values`,
    );
    happy.elementIds.push(...tiles.slice(0, 4).map((t) => t.id));
  } else if (inputs.length) {
    happy.when.push(
      fillStep(inputs[0]) ?? `the user changes ${q(elementName(inputs[0]))}`,
    );
    happy.elementIds.push(inputs[0].id);
    if (inputs[0].behavior) happy.then.push(outcomeStep(inputs[0].behavior));
  } else if (navigators.length || buttons.length) {
    const target =
      navigators.find((n) => n.navigatesToScreenId) ??
      navigators[0] ??
      buttons[0]!;
    happy.when.push(`the user selects ${q(elementName(target))}`);
    const screen = screens.find((s) => s.id === target.navigatesToScreenId);
    if (screen) happy.then.push(`the ${screen.name} screen is displayed`);
    else if (target.behavior) happy.then.push(outcomeStep(target.behavior));
    happy.elementIds.push(target.id);
  } else {
    happy.when.push(`the user opens the ${screenLabel} screen`);
    happy.then.push("all content is displayed as designed");
    happy.elementIds.push(...elements.slice(0, 3).map((e) => e.id));
  }
  happy.then.push(...post.map(toStep));

  // Candidate variations.
  const negatives: ScenarioDraft[] = [];
  const alternates: ScenarioDraft[] = [];
  const edges: ScenarioDraft[] = [];
  let inferredMessages = false;

  const requiredInputs = inputs.filter(
    (e) =>
      e.required &&
      e.type !== "checkbox" &&
      e.type !== "toggle" &&
      !alwaysHasValue(e),
  );
  // A submit button that stays disabled until the form is valid cannot be selected with a field empty, and a
  // scenario that submits must first fill in what is mandatory — or it contradicts the rules it tests.
  const submitWaitsForInput = Boolean(
    submit?.states?.some((s) => /\bdisabled until\b/i.test(s)),
  );
  const fillMandatory =
    submit && requiredInputs.length
      ? ["the user enters valid values in every mandatory field"]
      : [];
  for (const e of requiredInputs.slice(0, 3)) {
    const name = elementName(e);
    // Only a message the analyst tied to the empty case fits; a format message would be wrong here.
    const emptyMessage = quotedMessage(
      (e.validation ?? []).filter((v) =>
        /\b(empty|required|mandatory|missing|blank)\b/i.test(v),
      ),
    );
    const msg = emptyMessage ?? `${name} is required`;
    if (!emptyMessage) inferredMessages = true;
    if (submit && submitWaitsForInput) {
      negatives.push({
        title: `${name} left empty`,
        type: "negative",
        given: context,
        when: [
          ...(requiredInputs.length > 1
            ? ["the user enters valid values in every other mandatory field"]
            : []),
          `the user moves focus out of ${q(name)} without entering a value`,
        ],
        then: [
          `the inline error ${q(msg)} is shown below ${q(name)}`,
          `${q(submit.label)} stays disabled`,
        ],
        elementIds: [e.id, submit.id],
      });
      continue;
    }
    negatives.push({
      title: `${name} left empty`,
      type: "negative",
      given: context,
      when: [
        `the user leaves ${q(name)} empty`,
        ...(submit
          ? [`the user selects ${q(submit.label)}`]
          : [`the user moves focus out of ${q(name)}`]),
      ],
      then: [
        `the inline error ${q(msg)} is shown below ${q(name)}`,
        submit
          ? "the form is not submitted"
          : `the user cannot continue until ${q(name)} has a value`,
      ],
      elementIds: [e.id, ...(submit ? [submit.id] : [])],
    });
  }
  for (const e of inputs.filter((x) => x.type === "email_input").slice(0, 1)) {
    const msg = quotedMessage(e.validation) ?? "Enter a valid email address";
    negatives.push({
      title: "Invalid email format",
      type: "negative",
      given: context,
      when: [
        `the user enters ${q("not-an-email")} in ${q(elementName(e))}`,
        `the user moves focus out of ${q(elementName(e))}`,
      ],
      then: [
        `the inline error ${q(msg)} is shown below ${q(elementName(e))}`,
        ...(submit && submitWaitsForInput
          ? [`${q(submit.label)} stays disabled`]
          : []),
      ],
      elementIds: [e.id, ...(submit ? [submit.id] : [])],
    });
  }
  for (const e of inputs
    .filter((x) => x.type === "number_input" || x.type === "currency_input")
    .slice(0, 1)) {
    const msg = quotedMessage(e.validation);
    if (!msg) inferredMessages = true;
    negatives.push({
      title: `${elementName(e)} out of range`,
      type: "negative",
      given: context,
      when: [
        `the user enters ${q(e.type === "currency_input" ? "-1" : "0")} in ${q(elementName(e))}`,
      ],
      then: [
        `the inline error ${q(msg ?? "Enter a value within the allowed range")} is shown below ${q(elementName(e))}`,
        ...(submit ? [`the ${entityWord} cannot be submitted`] : []),
      ],
      elementIds: [e.id],
    });
  }
  for (const e of inputs
    .filter(
      (x) =>
        x.type === "text_input" &&
        x.validation?.some((v) => /\bunique\b/i.test(v)),
    )
    .slice(0, 1)) {
    const msg = quotedMessage(
      e.validation?.filter((v) => /\bunique|already\b/i.test(v)),
    );
    if (!msg) inferredMessages = true;
    negatives.push({
      title: `Duplicate ${elementName(e)}`,
      type: "negative",
      given: context,
      when: [
        `the user enters a ${lowerFirst(elementName(e))} that is already used`,
        `the user moves focus out of ${q(elementName(e))}`,
      ],
      then: [
        `the inline error ${q(msg ?? `This ${lowerFirst(elementName(e))} is already used`)} is shown below ${q(elementName(e))}`,
      ],
      elementIds: [e.id],
    });
  }
  if (inputs.some((e) => e.type === "password_input") && alert) {
    negatives.push({
      title: "Wrong credentials",
      type: "negative",
      given: context,
      when: [
        "the user enters a registered email address with a wrong password",
        ...(submit ? [`the user selects ${q(submit.label)}`] : []),
      ],
      then: [
        `the error banner ${q(alert.label)} is shown`,
        `the user stays on the ${screenLabel} screen`,
        "the password field is cleared",
      ],
      elementIds: [alert.id, ...(submit ? [submit.id] : [])],
    });
  }
  for (const e of elements
    .filter(
      (x) =>
        (x.type === "dropdown" ||
          x.type === "tabs" ||
          x.type === "radio_group") &&
        (x.options?.length ?? 0) >= 2,
    )
    .slice(0, 2)) {
    const choice =
      e.options!.find((o) => o !== e.defaultValue && o !== e.options![0]) ??
      e.options![1]!;
    alternates.push({
      title: `Change ${elementName(e)}`,
      type: "alternate",
      given: pre.map(toStep),
      when: [`the user selects ${q(choice)} in ${q(elementName(e))}`],
      then: [
        `${q(elementName(e))} shows ${q(choice)}`,
        ...(e.behavior ? [outcomeStep(e.behavior)] : []),
      ],
      elementIds: [e.id],
    });
  }
  for (const e of inputs
    .filter((x) => x.type === "checkbox" && !x.required)
    .slice(0, 1)) {
    alternates.push({
      title: `With ${q(elementName(e))} ticked`,
      type: "alternate",
      given: pre.map(toStep),
      when: [
        ...fillMandatory,
        `the user ticks ${q(elementName(e))}`,
        ...(submit ? [`the user selects ${q(submit.label)}`] : []),
      ],
      then: [
        e.behavior
          ? outcomeStep(e.behavior)
          : `${q(elementName(e))} is remembered`,
      ],
      elementIds: [e.id],
    });
  }
  for (const b of buttons
    .filter(
      (x) => x !== submit && /cancel|draft|back|clear|reset/i.test(x.label),
    )
    .slice(0, 2)) {
    alternates.push({
      title: `${b.label} instead of ${submit ? "submitting" : "continuing"}`,
      type: "alternate",
      given: pre.map(toStep),
      when: [`the user selects ${q(b.label)}`],
      then: [
        b.behavior
          ? outcomeStep(b.behavior)
          : /clear|reset/i.test(b.label)
            ? "every filter returns to its default value"
            : "no changes are saved",
      ],
      elementIds: [b.id],
    });
  }
  // One alternate per navigation target not already exercised by the happy path.
  const happyTargets = new Set(
    happy.elementIds
      .map((id) => elements.find((e) => e.id === id)?.navigatesToScreenId)
      .filter(Boolean),
  );
  const seenTargets = new Set<string>();
  for (const n of navigators) {
    if (
      happy.elementIds.includes(n.id) ||
      alternates.some((alt) => alt.elementIds.includes(n.id))
    )
      continue;
    const signOut =
      n.type === "menu"
        ? n.options?.find((o) => /\b(sign|log) ?out\b/i.test(o))
        : undefined;
    const target = screens.find((s) => s.id === n.navigatesToScreenId);
    const key = signOut
      ? "sign-out"
      : (target?.id ??
        plainHint(n.navigatesToHint ?? elementName(n)).toLowerCase());
    if (
      seenTargets.has(key) ||
      (target && happyTargets.has(target.id) && !signOut)
    )
      continue;
    seenTargets.add(key);
    if (signOut) {
      alternates.push({
        title: signOut,
        type: "alternate",
        given: pre.map(toStep),
        when: [
          `the user opens ${q(elementName(n))}`,
          `the user selects ${q(signOut)}`,
        ],
        then: [
          "the user is signed out",
          ...(target ? [`the ${target.name} screen is displayed`] : []),
        ],
        elementIds: [n.id],
      });
    } else {
      const where = target
        ? `the ${target.name} screen`
        : `the ${lowerFirst(plainHint(n.navigatesToHint ?? "linked page"))}`;
      alternates.push({
        title: `Go to ${target?.name ?? plainHint(n.navigatesToHint ?? elementName(n))}`,
        type: "alternate",
        given: pre.map(toStep),
        when: [`the user selects ${q(elementName(n))}`],
        then: [
          target ? `${where} is displayed` : `the user is taken to ${where}`,
        ],
        elementIds: [n.id],
      });
    }
    if (seenTargets.size >= 3) break;
  }
  if (isFilter) {
    const emptyText =
      quotedMessage(elements.flatMap((e) => e.states ?? [])) ??
      `No ${entityPlural} match your search`;
    edges.push({
      title: "No matching results",
      type: "edge",
      given: context,
      when: [
        search
          ? `the user types ${q("zzzz")} in the search box`
          : "the user chooses filters that no record matches",
      ],
      then: [
        `the message ${q(emptyText)} is shown`,
        "the active filters stay visible so they can be changed",
      ],
      elementIds: search ? [search.id] : inputs.slice(0, 1).map((e) => e.id),
    });
  }
  if (table) {
    const emptyText =
      elements.find((e) => e.type === "text" && /^no .*/i.test(e.label))
        ?.label ??
      quotedMessage(
        table.states?.map((s) =>
          s
            .replace(/^empty:\s*/i, '"')
            .replace(/$/, s.includes('"') ? "" : '"'),
        ),
      ) ??
      `No ${entityPlural} found`;
    edges.push({
      title: `No ${rowPlural} to show`,
      type: "edge",
      given: [...context, `no ${rowWord} matches the current view`],
      when: [`the ${screenLabel} screen finishes loading`],
      then: [`the message ${q(emptyText)} is shown instead of table rows`],
      elementIds: [table.id],
    });
    if (table.options && table.options.length > 1) {
      alternates.push({
        title: "Sort by a column",
        type: "alternate",
        given: [...context, `more than one ${rowWord} is listed`],
        when: [`the user selects the column header ${q(table.options[1]!)}`],
        then: [
          `the rows are sorted by ${q(table.options[1]!)} in ascending order`,
          "selecting the header again reverses the order",
        ],
        elementIds: [table.id],
      });
    }
  }
  const pager = elements.find((e) => e.type === "pagination");
  if (pager) {
    alternates.push({
      title: "Go to the next page",
      type: "alternate",
      given: [...context, `more ${entityPlural} exist than fit on one page`],
      when: ['the user selects "Next" in the pagination control'],
      then: [
        "the next page of results is displayed",
        '"Previous" becomes enabled',
      ],
      elementIds: [pager.id],
    });
  }
  const textarea = inputs.find((e) => e.type === "textarea");
  if (textarea) {
    const limit =
      /(\d[\d,]*)\s*characters/i.exec(
        (textarea.validation ?? []).join(" "),
      )?.[1] ?? "500";
    edges.push({
      title: `${elementName(textarea)} at its maximum length`,
      type: "edge",
      given: context,
      when: [
        `the user types more than ${limit} characters in ${q(elementName(textarea))}`,
      ],
      then: [
        `no more than ${limit} characters are accepted`,
        "the character counter shows the limit has been reached",
      ],
      elementIds: [textarea.id],
    });
  }
  if (submit) {
    edges.push({
      title: "Double submission is prevented",
      type: "edge",
      given: context,
      when: [
        ...fillMandatory,
        `the user selects ${q(submit.label)} twice in quick succession`,
      ],
      then: [
        `${q(submit.label)} shows a loading state and is disabled after the first selection`,
        "the action is performed only once",
      ],
      elementIds: [submit.id],
    });
  }
  if (tiles.length) {
    edges.push({
      title: "Figures are still loading",
      type: "edge",
      given: context,
      when: [`the ${screenLabel} screen is opened on a slow connection`],
      then: [
        "each tile shows a loading skeleton until its figure arrives",
        "no stale or zero values are shown in the meantime",
      ],
      elementIds: tiles.slice(0, 4).map((t) => t.id),
    });
  }
  edges.push(
    submit
      ? {
          title: "Server error while saving",
          type: "edge",
          given: context,
          when: [
            ...fillMandatory,
            `the user selects ${q(submit.label)}`,
            "the server does not respond",
          ],
          then: [
            `the message ${q("Something went wrong. Please try again.")} is shown`,
            "everything the user entered is kept so they can try again",
          ],
          elementIds: [submit.id],
        }
      : {
          title: "Content cannot be loaded",
          type: "edge",
          given: context,
          when: [
            `the ${screenLabel} screen loads`,
            "the server does not respond",
          ],
          then: [
            `the message ${q("Something went wrong. Please try again.")} is shown instead of the content`,
            "the rest of the screen stays usable",
          ],
          elementIds: [],
        },
  );

  // Interleave negative → alternate → edge so every use case gets a varied set, then cap by granularity.
  const cap =
    args.granularity === "fine" ? 4 : args.granularity === "coarse" ? 9 : 6;
  const others: ScenarioDraft[] = [];
  const pools = [negatives, alternates, edges];
  for (
    let i = 0;
    others.length < cap - 1 && pools.some((p) => p.length > i);
    i += 1
  ) {
    for (const pool of pools)
      if (pool[i] && others.length < cap - 1) others.push(pool[i]!);
  }
  const scenarios = [happy, ...others].map((s, i) => ({
    id: `SC-${String(i + 1).padStart(2, "0")}`,
    title: s.title,
    type: s.type,
    given: dedupeText(s.given),
    // Actions in order: a repeated step is a repeated action, not a duplicate.
    when: s.when.filter(Boolean),
    then: dedupeText(s.then),
    elementIds: [...new Set(s.elementIds)],
  }));

  const assumptions: string[] = [];
  for (const e of elements.filter((x) => x.inferred.length).slice(0, 4)) {
    assumptions.push(
      `${q(elementName(e))}: ${joinAnd(e.inferred)} inferred from the design rather than shown explicitly.`,
    );
  }
  if (inferredMessages)
    assumptions.push(
      "Inline error message wording is inferred; confirm it with UX.",
    );
  if (args.revisionNotes?.trim()) {
    assumptions.push(
      `Offline demo mode recorded these revision instructions but cannot apply them: ${q(oneLine(args.revisionNotes, 200))}. Connect an AI model and revise again.`,
    );
  }

  const openQuestions: string[] = [];
  for (const e of elements) {
    if (
      (e.type === "dropdown" ||
        e.type === "multi_select" ||
        e.type === "radio_group") &&
      !e.options?.length
    )
      openQuestions.push(`What are the options for ${q(elementName(e))}?`);
    if (
      INPUT_TYPES.has(e.type) &&
      e.required === undefined &&
      !e.states?.some((s) => /read-only/i.test(s)) &&
      e.type !== "search_input" &&
      e.type !== "checkbox" &&
      e.type !== "toggle"
    )
      openQuestions.push(`Is ${q(elementName(e))} mandatory?`);
  }
  // A screen question concerns this use case when it names one of its elements as a whole word. Navigation
  // labels ("Orders", "Dashboard") name other screens, not this use case's concerns.
  const labels = elements
    .filter((e) => !NAVIGATION_TYPES.has(e.type) && !e.navigatesToScreenId)
    .map((e) => e.label.trim())
    .filter((l) => l.length >= 4)
    .map(
      (l) =>
        new RegExp(
          `(?<![\\p{L}\\p{N}])${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
          "iu",
        ),
    );
  for (const question of args.screenOpenQuestions) {
    const lq = question.toLowerCase();
    if (
      labels.some((l) => l.test(question)) ||
      (lq.includes(entityWord) &&
        /list|show|select|draft|saved/.test(lq) &&
        openQuestions.length < 2)
    )
      openQuestions.push(question);
  }

  const asA = lowerFirst(args.personaName || "user");
  const iWant = VERBS.test(uc.title)
    ? lowerFirst(uc.title)
    : `use the ${lowerFirst(uc.title)}`;
  return {
    title: uc.title,
    scope: uc.scope,
    story: { asA, iWant, soThat: soThatFor(uc.title, entityPlural) },
    preconditions: [...pre],
    postconditions: [...post],
    businessRules: businessRules.map((r) => ({
      id: r.id,
      elementId: r.elementId ?? "",
      element: r.element,
      elementType: r.elementType,
      description: r.description,
      rules: r.rules,
    })),
    scenarios,
    assumptions: dedupeText(assumptions),
    openQuestions: dedupeText(openQuestions).slice(0, 5),
  };
}
