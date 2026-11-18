/**
 * The one place GitHub requests are built from a delivery plan: the payload preview and the real publish both come
 * from here, so what the BA previews is what is sent (only issue and milestone numbers differ). REST API 2022-11-28.
 * Feature groups are milestones or "feature: …" labels; dependencies are a "**Depends on:** #12 (UC-001)" line at
 * the top of the body, built when the issue is written (prerequisites are created first). Pure: no request is made.
 */
import type {
  DeliveryPlan,
  PlannedItem,
  PlannedRelationship,
} from "@shared/delivery";
import type { KeyOf } from "./azdoRequests";

export interface GitHubTarget {
  /** "https://api.github.com" or a GitHub Enterprise API root. */
  apiBase: string;
  /** "/repos/<owner>/<repo>" */
  repoPath: string;
}

export interface GitHubRequest {
  method: "POST" | "PATCH";
  url: string;
  body: unknown;
}

/** The dependency line GitHub shows at the top of an issue, and how a comparison recognises it again. */
export const DEPENDS_LINE = /^\*\*Depends on:\*\* [^\n]*\n\n/;

const isIssueField = (fieldId: string) => fieldId.startsWith("issue-field:");

function dependencies(
  plan: DeliveryPlan,
  item: PlannedItem,
): PlannedRelationship[] {
  return plan.relationships.filter(
    (r) =>
      r.fromItemId === item.id &&
      r.kind === "dependency" &&
      r.status === "planned" &&
      r.via === "body-line",
  );
}

/** "**Depends on:** #12 (UC-001), UC-004": a prerequisite without an issue yet is named by its use case. */
export function dependsLine(
  plan: DeliveryPlan,
  item: PlannedItem,
  keyOf: KeyOf,
): string | undefined {
  const deps = dependencies(plan, item);
  if (!deps.length) return undefined;
  return `**Depends on:** ${deps
    .map((r) => {
      const key = r.toItemId ? keyOf(r.toItemId) : r.toExternal?.key;
      const uc = r.toExternal?.useCaseId ?? r.toItemId?.replace(/^uc:/, "");
      return key ? `${key} (${uc})` : `${uc}`;
    })
    .join(", ")}`;
}

function withDepends(
  plan: DeliveryPlan,
  item: PlannedItem,
  keyOf: KeyOf,
  body: string,
): string {
  const line = dependsLine(plan, item, keyOf);
  return line ? `${line}\n\n${body}` : body;
}

/** The issue's milestone number, when its feature group is a milestone. */
function milestone(
  plan: DeliveryPlan,
  item: PlannedItem,
  keyOf: KeyOf,
): number | string | undefined {
  const r = plan.relationships.find(
    (x) =>
      x.fromItemId === item.id &&
      x.kind === "parent" &&
      x.status === "planned" &&
      x.via === "milestone",
  );
  if (!r?.toItemId) return undefined;
  const key = keyOf(r.toItemId);
  if (!key)
    throw new Error(
      `${item.id}: its milestone ${r.toItemId} has no number yet.`,
    );
  return /^\d+$/.test(key) ? Number(key) : key;
}

/** Fields GitHub can't take in an issue request (organisation issue fields): listed, never silently dropped. */
export function unsentFields(item: PlannedItem): string[] {
  return item.fields
    .filter((f) => f.value !== null && isIssueField(f.fieldId))
    .map((f) => f.fieldName);
}

/** Create a feature group: a label or a milestone. */
export function githubGroupRequest(
  item: PlannedItem,
  site: GitHubTarget,
): GitHubRequest {
  const value = (id: string) =>
    item.fields.find((f) => f.fieldId === id)?.value;
  if (item.typeId === "label")
    return {
      method: "POST",
      url: `${site.apiBase}${site.repoPath}/labels`,
      body: {
        name: String(value("name") ?? item.title),
        color: "5319e7",
      },
    };
  return {
    method: "POST",
    url: `${site.apiBase}${site.repoPath}/milestones`,
    body: {
      title: String(value("title") ?? item.title),
      ...(typeof value("description") === "string"
        ? { description: value("description") }
        : {}),
    },
  };
}

/** Create one issue, with its milestone, labels, type and dependency line in the same request. */
export function githubCreateRequest(
  plan: DeliveryPlan,
  item: PlannedItem,
  site: GitHubTarget,
  keyOf: KeyOf,
): GitHubRequest {
  if (item.role === "group") return githubGroupRequest(item, site);
  const body: Record<string, unknown> = {};
  for (const f of item.fields) {
    if (f.value === null || isIssueField(f.fieldId)) continue;
    body[f.fieldId] =
      f.fieldId === "body" && typeof f.value === "string"
        ? withDepends(plan, item, keyOf, f.value)
        : f.value;
  }
  const m = milestone(plan, item, keyOf);
  if (m !== undefined) body.milestone = m;
  return {
    method: "POST",
    url: `${site.apiBase}${site.repoPath}/issues`,
    body,
  };
}

/**
 * Update an existing issue: only the fields the comparison says to send. Labels are added with their own request
 * (githubAddLabelsRequest), so a label the team adds in the meantime is never removed.
 */
export function githubUpdateRequest(
  plan: DeliveryPlan,
  item: PlannedItem,
  site: GitHubTarget,
  keyOf: KeyOf,
): GitHubRequest {
  const body: Record<string, unknown> = {};
  for (const f of item.fields) {
    if (f.value === null || f.updateAction !== "send") continue;
    if (f.kind === "labels" || isIssueField(f.fieldId)) continue;
    body[f.fieldId] =
      f.fieldId === "body" && typeof f.value === "string"
        ? withDepends(plan, item, keyOf, f.value)
        : f.value;
  }
  return {
    method: "PATCH",
    url: `${site.apiBase}${site.repoPath}/issues/${(item.existing?.key ?? "").replace(/^#/, "")}`,
    body,
  };
}

/** Labels to add to an existing issue (POST adds; it never removes). */
export function githubAddLabelsRequest(
  item: PlannedItem,
  site: GitHubTarget,
): GitHubRequest | undefined {
  const labels = item.fields.find(
    (f) => f.kind === "labels" && f.updateAction === "send",
  );
  if (!labels || !Array.isArray(labels.value)) return undefined;
  return {
    method: "POST",
    url: `${site.apiBase}${site.repoPath}/issues/${(item.existing?.key ?? "").replace(/^#/, "")}/labels`,
    body: { labels: labels.value },
  };
}
