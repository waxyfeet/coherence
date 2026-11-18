/**
 * Three-way comparison for items that already exist in the destination: what Coherence last sent (baseline),
 * what the destination holds now (remote) and what the plan proposes. Team edits are never overwritten
 * silently: a field the team changed is kept, and a field both sides changed needs the BA's decision.
 * Without a baseline the origin of a difference cannot be known, so it also needs a decision.
 */
import type { ComparisonState, FieldComparison } from "@shared/delivery";

export type Comparable = string | number | string[] | null | undefined;

const normalise = (v: Comparable): string =>
  v === null || v === undefined
    ? ""
    : Array.isArray(v)
      ? [...v]
          .map((x) => x.trim().toLowerCase())
          .sort()
          .join("\u0001")
      : String(v)
          .replace(/\r\n/g, "\n")
          .replace(/[ \t]+\n/g, "\n")
          .trim();

export function compareField(
  fieldId: string,
  fieldName: string,
  proposed: Comparable,
  remote: Comparable,
  baseline?: Comparable,
  hasBaseline = baseline !== undefined,
): FieldComparison {
  const p = normalise(proposed);
  const r = normalise(remote);
  const state: ComparisonState = (() => {
    if (p === r) return "unchanged";
    if (!hasBaseline) return "unknown-origin";
    const b = normalise(baseline);
    if (r === b) return "coherence-update";
    if (p === b) return "team-modified";
    return "conflict";
  })();
  const message = {
    new: `${fieldName} is new.`,
    unchanged: `${fieldName} already matches.`,
    "coherence-update": `${fieldName} changed in Coherence since the last export and was not edited in the destination; it can be updated.`,
    "team-modified": `${fieldName} was edited in the destination since the last export; the team's value is kept.`,
    conflict: `${fieldName} was edited both in Coherence and in the destination; choose which to keep.`,
    "unknown-origin": `${fieldName} differs from the destination, and there is no record of what Coherence sent before; choose which to keep.`,
  }[state];
  return { fieldId, state, message };
}

/** States that must not proceed without the BA. */
export function needsDecision(state: ComparisonState): boolean {
  return state === "conflict" || state === "unknown-origin";
}
