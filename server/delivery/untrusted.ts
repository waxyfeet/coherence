/**
 * Destination metadata (field names, help text, permitted values) is written by whoever administers the tracker.
 * It is untrusted data: shown to people and passed to a model only inside a delimited data block, never followed.
 */

/** Control, bidi-override and zero-width characters that can hide or reorder text. */
const HIDDEN =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb]/g;

/** Display text: hidden characters removed, whitespace collapsed, capped. */
export function untrustedText(value: unknown, max: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value)
    .normalize("NFKC")
    .replace(HIDDEN, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** A permitted value must be sent back exactly as spelled, so it is kept verbatim or rejected — never rewritten. */
export function permittedValue(value: unknown, max = 255): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value);
  if (!text.trim() || text.length > max) return undefined;
  HIDDEN.lastIndex = 0;
  if (HIDDEN.test(text)) return undefined;
  return text;
}

export const LIMITS = {
  name: 120,
  help: 300,
  allowedValues: 250,
  paths: 2000,
  labels: 500,
  milestones: 200,
} as const;

/** Permitted values, verbatim, de-duplicated, capped; reports when more existed than were kept. */
export function permittedValues(values: unknown[] | undefined): {
  values?: string[];
  truncated?: boolean;
} {
  if (!Array.isArray(values)) return {};
  const out: string[] = [];
  const seen = new Set<string>();
  let dropped = false;
  for (const raw of values) {
    const value = permittedValue(raw);
    if (value === undefined) {
      dropped = true;
      continue;
    }
    if (seen.has(value)) continue;
    if (out.length >= LIMITS.allowedValues) {
      dropped = true;
      break;
    }
    seen.add(value);
    out.push(value);
  }
  return dropped ? { values: out, truncated: true } : { values: out };
}
