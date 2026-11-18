/**
 * OWNER: graph builder.
 * Small, dependency-free text helpers shared by the impact trace (free-text keyword matching) and the
 * screen diff (fuzzy label matching). Everything here is deterministic and cheap.
 */
import type { ElementType, UIElement } from "@shared/types";

/**
 * Words that carry no meaning for matching a change description against element labels, use case titles
 * and rule text: English function words, change verbs ("rename", "update") and words that appear in
 * nearly every spec ("user", "screen", "field").
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  // function words
  "a",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "each",
  "either",
  "else",
  "even",
  "every",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "here",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "let",
  "like",
  "may",
  "me",
  "might",
  "more",
  "most",
  "much",
  "must",
  "my",
  "no",
  "nor",
  "not",
  "now",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "our",
  "out",
  "over",
  "own",
  "per",
  "same",
  "shall",
  "she",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "though",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "upon",
  "us",
  "very",
  "via",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "whether",
  "which",
  "while",
  "who",
  "whom",
  "whose",
  "why",
  "will",
  "with",
  "within",
  "without",
  "would",
  "yet",
  "you",
  "your",
  "also",
  "instead",
  "again",
  "all",
  "about",
  "after",
  "before",
  "between",
  "during",
  "above",
  "below",
  "onto",
  "etc",
  "eg",
  "ie",
  "e",
  "g",
  // change verbs and request phrasing
  "change",
  "changes",
  "changed",
  "changing",
  "update",
  "updates",
  "updated",
  "updating",
  "add",
  "adds",
  "added",
  "adding",
  "remove",
  "removes",
  "removed",
  "removing",
  "delete",
  "deleted",
  "rename",
  "renamed",
  "replace",
  "replaced",
  "make",
  "makes",
  "made",
  "want",
  "wants",
  "need",
  "needs",
  "needed",
  "new",
  "old",
  "now",
  "please",
  "currently",
  "current",
  "going",
  "become",
  "becomes",
  "set",
  "use",
  "used",
  "using",
  "allow",
  "allowed",
  "show",
  "shown",
  "display",
  "displayed",
  "move",
  "moved",
  "instead",
  // spec-wide words that match almost everything
  "user",
  "users",
  "screen",
  "screens",
  "page",
  "pages",
  "field",
  "fields",
  "button",
  "buttons",
  "element",
  "elements",
  "case",
  "cases",
  "rule",
  "rules",
  "scenario",
  "scenarios",
  "app",
  "application",
  "system",
  // generic validation vocabulary ("at least 12 characters") that would match every limit in the spec
  "least",
  "character",
  "characters",
  "length",
  "minimum",
  "maximum",
  "min",
  "max",
  "number",
  "numbers",
  "value",
  "values",
]);

/** Lowercase, strip accents, collapse whitespace. */
export function normaliseText(input: string | undefined | null): string {
  return (input ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalised text with punctuation removed — for label equality ("Sign in" == "Sign in:" == "SIGN IN"). */
export function normaliseLabel(input: string | undefined | null): string {
  return normaliseText(input)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Very light English stemming (plurals only) so "passwords" matches "password". */
export function stem(token: string): string {
  if (/^\d+$/.test(token)) return token;
  if (token.length > 4 && token.endsWith("ies"))
    return `${token.slice(0, -3)}y`;
  if (token.length > 4 && /(sses|tuses|xes|ches|shes)$/.test(token))
    return token.slice(0, -2);
  if (
    token.length > 3 &&
    token.endsWith("s") &&
    !token.endsWith("ss") &&
    !token.endsWith("us")
  ) {
    return token.slice(0, -1);
  }
  return token;
}

/** Raw word tokens (normalised, no stemming, stop words kept). */
export function words(input: string | undefined | null): string[] {
  return normaliseText(input)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Meaningful tokens for keyword matching: normalised, stop words removed, stemmed, de-duplicated.
 * Single letters are dropped; numbers are kept (a "minimum 8 characters" rule is matched by "8").
 */
export function keywordTokens(input: string | undefined | null): string[] {
  const out = new Set<string>();
  for (const w of words(input)) {
    if (STOP_WORDS.has(w)) continue;
    if (w.length < 2 && !/^\d+$/.test(w)) continue;
    out.add(stem(w));
  }
  return [...out];
}

/** Token set similarity |A∩B| / |A∪B| (0 when both are empty). */
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  return inter / (setA.size + setB.size - inter);
}

/** Classic edit distance (two-row DP). Inputs are capped at 200 chars to bound the cost. */
export function levenshtein(a: string, b: string): number {
  const s = a.slice(0, 200);
  const t = b.slice(0, 200);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  let curr = new Array<number>(t.length + 1);
  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s.charCodeAt(i - 1) === t.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[t.length];
}

/** 1 − distance / longer length, on normalised labels (1 = identical, 0 = nothing in common). */
export function levenshteinRatio(a: string, b: string): number {
  const s = normaliseLabel(a);
  const t = normaliseLabel(b);
  const longest = Math.max(s.length, t.length);
  if (longest === 0) return 0;
  return 1 - levenshtein(s, t) / Math.min(longest, 200);
}

/**
 * Similarity of two short labels: the better of word-set overlap (robust to re-ordering: "Email address"
 * vs "Address (email)") and character edit ratio (robust to typos/pluralisation: "Sign in" vs "Sign-in").
 */
export function labelSimilarity(a: string, b: string): number {
  const ta = words(a).map(stem);
  const tb = words(b).map(stem);
  return Math.max(jaccard(ta, tb), levenshteinRatio(a, b));
}

/** "sign_in_button" → "Sign in button" */
export function humaniseKey(key: string): string {
  const spaced = key
    .replace(/[_\-.]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

/** "email_input" → "email input" */
export function elementTypeWords(
  type: ElementType | "screen" | "general",
): string {
  return type.replace(/_/g, " ");
}

/** The element's visible name, falling back to its humanised key for unlabeled elements (icons). */
export function elementName(el: Pick<UIElement, "label" | "key">): string {
  const label = el.label.replace(/\s+/g, " ").trim();
  return label || humaniseKey(el.key);
}

/** "Email address (email input)" — used for graph labels and change descriptions. */
export function elementDisplayLabel(
  el: Pick<UIElement, "label" | "key" | "type">,
): string {
  return `${truncate(elementName(el), 80)} (${elementTypeWords(el.type)})`;
}

/** Shorten long free text for one-line display. */
export function truncate(input: string, max: number): string {
  const s = input.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** "a", "a and b", "a, b and c", "a, b, c and 2 more" */
export function joinList(items: string[], max = 3): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length <= max)
    return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

/** "1 element" / "3 elements" */
export function plural(
  n: number,
  singular: string,
  pluralForm = `${singular}s`,
): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}
