/**
 * The use case chain: a dependent use case's first precondition is a verbatim copy of a postcondition of
 * one of its predecessors, and its happy path starts from its preconditions and ends in its postconditions.
 * These helpers enforce that deterministically so the chain holds even when a model drifts.
 */
import type { BddScenario, UseCase } from "@shared/types";
import { containsText, dedupeText, normText, sameText, toStep } from "./text";

/** Environment precondition for entry points (login, landing, public pages). */
export const ENTRY_PRECONDITION = "The user has opened the application";

export interface ChainRepair {
  preconditions: string[];
  /** Set when the preconditions were changed; describes what was done. */
  change?: string;
}

/**
 * Ensures preconditions[0] is a verbatim postcondition of one of the predecessors.
 * `predecessors` must be in dependsOn order. Entry points (no predecessors) get an environment
 * precondition when they have none.
 */
export function repairChain(
  preconditions: readonly string[],
  predecessors: readonly Pick<UseCase, "id" | "postconditions">[],
): ChainRepair {
  const pre = dedupeText(preconditions);
  const posts = predecessors.flatMap((p) =>
    p.postconditions.map((text) => ({ id: p.id, text })),
  );
  if (!predecessors.length || !posts.length) {
    if (!pre.length && !predecessors.length) {
      return {
        preconditions: [ENTRY_PRECONDITION],
        change: `added the entry precondition "${ENTRY_PRECONDITION}"`,
      };
    }
    return { preconditions: pre };
  }

  const first = pre[0];
  if (first !== undefined) {
    const match = posts.find((p) => sameText(p.text, first));
    if (match) {
      // Same meaning — make it the exact copy so the chain is verbatim.
      if (match.text === first) return { preconditions: pre };
      return {
        preconditions: [match.text, ...pre.slice(1)],
        change: `made the first precondition a verbatim copy of ${match.id}'s postcondition`,
      };
    }
  }

  const laterIndex = pre.findIndex(
    (p, i) => i > 0 && posts.some((post) => sameText(post.text, p)),
  );
  if (laterIndex > 0) {
    const match = posts.find((post) => sameText(post.text, pre[laterIndex]!))!;
    const rest = pre.filter((_, i) => i !== laterIndex);
    return {
      preconditions: [match.text, ...rest],
      change: `moved ${match.id}'s postcondition "${match.text}" to the front of the preconditions`,
    };
  }

  const chosen = posts[0]!;
  return {
    preconditions: [chosen.text, ...pre],
    change: `prepended ${chosen.id}'s postcondition "${chosen.text}" as the first precondition`,
  };
}

/** True when the use case's first precondition is a postcondition of one of its predecessors. */
export function chainHolds(
  uc: Pick<UseCase, "preconditions">,
  predecessors: readonly Pick<UseCase, "postconditions">[],
): boolean {
  const first = uc.preconditions[0];
  if (!first) return false;
  return predecessors.some((p) => containsText(p.postconditions, first));
}

export interface HappyPathRepair {
  scenarios: BddScenario[];
  changed: boolean;
}

/**
 * The happy path's GIVEN lines start with every precondition (in order) and its final THEN lines state every
 * postcondition. Duplicates of those statements elsewhere in the step lists are removed so they appear once.
 */
export function enforceHappyPath(
  scenarios: readonly BddScenario[],
  preconditions: readonly string[],
  postconditions: readonly string[],
): HappyPathRepair {
  const index = scenarios.findIndex((s) => s.type === "happy");
  if (index < 0) return { scenarios: [...scenarios], changed: false };
  const happy = scenarios[index]!;

  const preSteps = preconditions.map(toStep).filter(Boolean);
  const postSteps = postconditions.map(toStep).filter(Boolean);
  const restGiven = happy.given.filter(
    (g) => !preSteps.some((p) => sameText(p, g)),
  );
  const restThen = happy.then.filter(
    (t) => !postSteps.some((p) => sameText(p, t)),
  );
  const given = [...preSteps, ...restGiven];
  const then = [...restThen, ...postSteps];

  const changed = !sameList(given, happy.given) || !sameList(then, happy.then);
  if (!changed) return { scenarios: [...scenarios], changed: false };
  const next = [...scenarios];
  next[index] = { ...happy, given, then };
  return { scenarios: next, changed: true };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Happy path GIVEN contains every precondition (order-insensitive check used by the reviewer). */
export function happyPathCoversPreconditions(
  uc: Pick<UseCase, "scenarios" | "preconditions">,
): boolean {
  const happy = uc.scenarios.find((s) => s.type === "happy");
  if (!happy) return false;
  const given = new Set(happy.given.map(normText));
  return uc.preconditions.every((p) => given.has(normText(p)));
}

/** Happy path THEN contains every postcondition. */
export function happyPathCoversPostconditions(
  uc: Pick<UseCase, "scenarios" | "postconditions">,
): boolean {
  const happy = uc.scenarios.find((s) => s.type === "happy");
  if (!happy) return false;
  const then = new Set(happy.then.map(normText));
  return uc.postconditions.every((p) => then.has(normText(p)));
}
