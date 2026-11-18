/**
 * How Coherence marks what it creates in trackers. The exporters and the delivery planner share these, so a plan shows
 * exactly the labels an export writes. Owner decision (installer Stage 7): the visible name is Coherence. Items
 * exported earlier keep the old label; Coherence still recognises them as its own and never removes it.
 */

/** Jira and GitHub label. */
export const OWN_LABEL = "coherence";
/** Azure DevOps tag. */
export const OWN_TAG = "Coherence";
/** The label and tag written before the rename. */
export const LEGACY_OWN_LABEL = "screenscribe";

/** True for Coherence's own label or tag, old or new (case-insensitive, as the trackers compare them). */
export function isOwnLabel(label: string): boolean {
  const lower = label.trim().toLowerCase();
  return lower === OWN_LABEL || lower === LEGACY_OWN_LABEL;
}
