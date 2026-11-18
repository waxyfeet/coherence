/**
 * Small, pure text helpers shared by the agents, the deterministic checks and the offline mock.
 * Comparisons of pre/postconditions and BDD steps go through `normText` so that "The user is signed in."
 * and "the user is signed in" count as the same statement (the chain is about meaning, not capitalisation).
 */

const STEP_KEYWORD = /^\s*(?:given|when|then|and|but)\b[\s:,-]*/i;

/** Canonical form for comparing statements: case-, whitespace-, quote- and trailing-punctuation-insensitive. */
export function normText(input: string): string {
  return stripStepKeyword(input)
    .replace(/[“”«»„]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!;:,\s]+$/g, "")
    .toLowerCase();
}

export function sameText(a: string, b: string): boolean {
  return normText(a) === normText(b);
}

export function containsText(list: readonly string[], value: string): boolean {
  const n = normText(value);
  return list.some((item) => normText(item) === n);
}

/** Trim, drop empties and case-insensitive duplicates (first occurrence wins). */
export function dedupeText(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const value = (raw ?? "").replace(/\s+/g, " ").trim();
    if (!value) continue;
    const key = normText(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Models sometimes prefix steps with the keyword ("Given the user…"); the renderer adds keywords itself. */
export function stripStepKeyword(line: string): string {
  return (line ?? "").replace(STEP_KEYWORD, "").trim();
}

export function stripTrailingPeriod(text: string): string {
  return text.trim().replace(/[.;\s]+$/g, "");
}

/** Lower-cases the first letter unless the first word is an acronym or a quoted literal ("PO number…"). */
export function lowerFirst(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const firstWord = t.split(/\s+/)[0] ?? "";
  if (
    firstWord.length > 1 &&
    firstWord === firstWord.toUpperCase() &&
    /[A-Z]/.test(firstWord)
  )
    return t;
  return t.charAt(0).toLowerCase() + t.slice(1);
}

export function upperFirst(text: string): string {
  const t = text.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/** Statement → BDD step text: "The user is signed in." → "the user is signed in". */
export function toStep(statement: string): string {
  return lowerFirst(stripTrailingPeriod(stripStepKeyword(statement)));
}

/** Ensures a sentence ends with terminal punctuation. */
export function sentence(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return t;
  const capped = upperFirst(t);
  return /[.!?:)"”…]$/.test(capped) ? capped : `${capped}.`;
}

/** snake_case key: "Sign in button" → "sign_in_button". */
export function keySlug(input: string, maxLength = 40): string {
  const slug = (input ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength)
    .replace(/_+$/g, "");
  return slug;
}

/** base, base_2, base_3 … — registers the chosen key in `taken`. */
export function uniqueKey(
  base: string,
  taken: Set<string>,
  separator = "_",
): string {
  let key = base;
  let n = 2;
  while (taken.has(key)) {
    key = `${base}${separator}${n}`;
    n += 1;
  }
  taken.add(key);
  return key;
}

export function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) =>
      w.length > 1 && w === w.toUpperCase()
        ? w
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join(" ");
}

/** One line, at most `max` characters, with an ellipsis when cut. */
export function oneLine(text: string, max = 160): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * Whole sentences from the start of `text`, at most `max` characters — for summaries that must not stop
 * mid-word. A first sentence longer than `max` is cut at a word boundary with an ellipsis.
 */
export function leadSentences(text: string, max = 240): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  let out = "";
  for (const part of t.match(/[^.!?]+(?:[.!?]+["”')]?|$)\s*/g) ?? []) {
    if ((out + part).trim().length > max) break;
    out += part;
  }
  if (out.trim()) return out.trim();
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:—–-]+$/, "")}…`;
}

export function quote(text: string): string {
  return `"${text.replace(/"/g, "'")}"`;
}

/** "a", "a and b", "a, b and c" */
export function joinAnd(items: readonly string[]): string {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

const IRREGULAR_PLURALS: Record<string, string> = {
  person: "people",
  child: "children",
  analysis: "analyses",
  status: "statuses",
  address: "addresses",
  entry: "entries",
  category: "categories",
  company: "companies",
  inventory: "inventories",
  activity: "activities",
};

export function pluralize(word: string): string {
  const w = word.trim();
  if (!w) return w;
  const lower = w.toLowerCase();
  if (IRREGULAR_PLURALS[lower]) return matchCase(IRREGULAR_PLURALS[lower]!, w);
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(w)) return `${w}es`;
  return `${w}s`;
}

export function singularize(word: string): string {
  const w = word.trim();
  const lower = w.toLowerCase();
  for (const [single, plural] of Object.entries(IRREGULAR_PLURALS)) {
    if (plural === lower) return matchCase(single, w);
  }
  if (/ies$/i.test(w) && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(ss|us|is)$/i.test(w)) return w;
  if (/(xes|ches|shes|sses|zes)$/i.test(w)) return w.slice(0, -2);
  if (/s$/i.test(w) && w.length > 3) return w.slice(0, -1);
  return w;
}

function matchCase(target: string, sample: string): string {
  return sample.charAt(0) === sample.charAt(0).toUpperCase()
    ? upperFirst(target)
    : target;
}

/** Stable small hash (FNV-1a) — used by the offline mock to vary sample values deterministically. */
export function stableHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
