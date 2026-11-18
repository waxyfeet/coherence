/**
 * Reading work items Coherence published earlier, when planning (GET only), so a changed use case can be compared
 * three ways: what Coherence sent, what the destination holds now, what the plan proposes (compare.ts). The result is
 * saved as a snapshot beside the publish record, so answering a question re-plans without new requests.
 */
import type { DeliveryPlan, TextFormat } from "@shared/delivery";
import type { ExternalSystem } from "@shared/types";
import { errorMessage } from "../errors";
import type { JobContext } from "../jobs/jobManager";
import { adfText } from "./adf";
import { DEPENDS_LINE } from "./githubRequests";
import type { Comparable } from "./compare";
import type { TrackerSettings } from "./discovery";
import type { DraftPlan } from "./planner";
import { htmlText } from "./planner";
import { publisherFor } from "./publishers";
import { PUBLISH_TARGETS } from "./publishing";
import type { RemoteSnapshot, SentValue } from "./publishRecord";

/** The text of an option-like value: {value} (Jira options), {name} (priority) or {displayName} (people). */
function optionText(raw: unknown): string {
  if (raw && typeof raw === "object")
    for (const k of ["value", "name", "displayName"])
      if (k in raw) return String((raw as Record<string, unknown>)[k]);
  return String(raw);
}

/**
 * A destination value in the comparable form the planner uses (planner.comparableValue): visible text for rich text
 * (HTML in Azure DevOps, ADF in Jira Cloud; Jira wiki markup is compared as written), a list for tags and labels.
 */
export function remoteComparable(
  kind: DeliveryPlan["items"][number]["fields"][number]["kind"],
  raw: unknown,
  format: TextFormat = "html",
): SentValue {
  if (raw === undefined || raw === null || raw === "") return null;
  if (kind === "rich-text")
    return typeof raw === "object"
      ? adfText(raw as Parameters<typeof adfText>[0])
      : format === "html"
        ? htmlText(String(raw))
        : format === "markdown"
          ? // GitHub: the dependency line is written with the issue, not planned; compare the rest.
            String(raw).replace(DEPENDS_LINE, "")
          : String(raw);
  if (kind === "labels")
    return Array.isArray(raw)
      ? raw.map(String)
      : String(raw)
          .split(";")
          .map((t) => t.trim())
          .filter(Boolean);
  if (kind === "multi-option" && Array.isArray(raw)) return raw.map(optionText);
  if (typeof raw === "number") return raw;
  return optionText(raw);
}

export async function readExistingItems(
  system: ExternalSystem,
  settings: TrackerSettings,
  plan: DraftPlan,
  ctx: Pick<JobContext, "signal" | "warn" | "info">,
): Promise<RemoteSnapshot | undefined> {
  if (!PUBLISH_TARGETS[system]) return undefined;
  const changed = plan.items.filter(
    (i) => i.operation === "update" && i.existing,
  );
  if (!changed.length) return undefined;
  try {
    const current = await publisherFor(
      system,
      settings,
      ctx.signal,
    ).readCurrent(changed.map((i) => i.existing!.key));
    const items: RemoteSnapshot["items"] = {};
    for (const item of changed) {
      const found = current.get(item.existing!.key);
      items[item.id] = found
        ? {
            rev: found.rev,
            values: Object.fromEntries(
              item.fields.map((f) => [
                f.fieldId,
                remoteComparable(
                  f.kind,
                  found.fields[f.fieldId],
                  plan.destination.textFormat,
                ),
              ]),
            ),
          }
        : { missing: true };
    }
    ctx.info(
      `Read ${current.size} published work item(s) to compare them with the changes (read-only).`,
    );
    return { readAt: new Date().toISOString(), items };
  } catch (err) {
    if ((err as Error)?.name === "CancelledError") throw err;
    ctx.warn(
      `Couldn't read the published work items to compare them (${errorMessage(err)}); changed items are not sent until a plan can compare them.`,
    );
    return undefined;
  }
}

export function remoteInputs(snapshot: RemoteSnapshot | undefined): {
  remote?: Map<string, Record<string, Comparable>>;
  remoteRevs?: Map<string, number>;
  missing?: Set<string>;
} {
  if (!snapshot) return {};
  const remote = new Map<string, Record<string, Comparable>>();
  const remoteRevs = new Map<string, number>();
  const missing = new Set<string>();
  for (const [itemId, entry] of Object.entries(snapshot.items))
    if ("missing" in entry) missing.add(itemId);
    else {
      remote.set(itemId, entry.values);
      remoteRevs.set(itemId, entry.rev);
    }
  return { remote, remoteRevs, missing };
}
