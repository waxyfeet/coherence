/** Deterministic checks of a value against a destination field's kind and limits. */
import type { DestinationField, PlannedField } from "@shared/delivery";

export type TextCheck =
  | { ok: true; value: string | number | string[] }
  | { ok: false; reason: string };

/** A value the BA typed for a field. */
export function checkText(
  field: Pick<DestinationField, "kind" | "maxLength">,
  raw: string,
): TextCheck {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "The value is empty." };
  switch (field.kind) {
    case "single-line":
      if (/[\r\n]/.test(text))
        return { ok: false, reason: "This field holds a single line." };
      if (field.maxLength && text.length > field.maxLength)
        return {
          ok: false,
          reason: `This field holds ${field.maxLength} characters.`,
        };
      return { ok: true, value: text };
    case "multi-line":
    case "rich-text":
      return { ok: true, value: text };
    case "number": {
      const n = Number(text);
      return Number.isFinite(n)
        ? { ok: true, value: n }
        : { ok: false, reason: "This field holds a number." };
    }
    case "date":
      return isIsoDate(text)
        ? { ok: true, value: text }
        : { ok: false, reason: "Use a date like 2026-12-31." };
    case "labels": {
      const labels = text
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean);
      return labels.length
        ? { ok: true, value: labels }
        : { ok: false, reason: "Enter one or more labels." };
    }
    default:
      return {
        ok: false,
        reason: "Coherence cannot fill this kind of field with typed text.",
      };
  }
}

export function isIsoDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(text);
}

/** Problems with a planned value for its field, in BA language (empty when valid). */
export function valueProblems(
  field: DestinationField,
  planned: PlannedField,
): string[] {
  const v = planned.value;
  if (v === null) return [];
  const problems: string[] = [];
  const allowed = field.allowedValues;
  const inAllowed = (x: string) =>
    !allowed ||
    allowed.includes(x) ||
    // A truncated list cannot prove a value is wrong; validation reports it as unverifiable instead.
    !!field.allowedValuesTruncated;
  switch (field.kind) {
    case "single-line":
      if (typeof v !== "string") problems.push("expects text");
      else if (/[\r\n]/.test(v)) problems.push("holds a single line");
      break;
    case "multi-line":
    case "rich-text":
      if (typeof v !== "string") problems.push("expects text");
      break;
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v))
        problems.push("expects a number");
      break;
    case "date":
      if (typeof v !== "string" || !isIsoDate(v))
        problems.push("expects a date (YYYY-MM-DD)");
      break;
    case "boolean":
      if (v !== "true" && v !== "false") problems.push("expects true or false");
      break;
    case "option":
      if (typeof v !== "string") problems.push("expects one permitted value");
      else if (!inAllowed(v)) problems.push(`does not permit "${v}"`);
      break;
    case "multi-option":
      if (!Array.isArray(v)) problems.push("expects permitted values");
      else
        for (const x of v)
          if (!inAllowed(x)) problems.push(`does not permit "${x}"`);
      break;
    case "labels":
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
        problems.push("expects a list of labels");
      break;
    case "user":
    case "tree-path":
    case "reference":
    case "unknown":
      if (field.kind === "tree-path" && typeof v === "string") break;
      problems.push(`cannot be set by Coherence (${field.kind})`);
      break;
  }
  return problems;
}
