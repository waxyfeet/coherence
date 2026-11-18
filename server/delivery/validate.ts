/**
 * Deterministic plan validation — the only publish gate. Checks types, required fields, value kinds, permitted
 * values, rendered lengths (no silent truncation), destination paths, hierarchy and link support, duplicate
 * identities, unconfirmed inferences and preservation of every business rule, scenario and assumption.
 * A model never decides whether an invalid mapping is acceptable.
 */
import { createHash } from "node:crypto";
import type {
  DeliveryPlan,
  DestinationSchema,
  PlanIssue,
  PlanSummary,
} from "@shared/delivery";
import { computeReadiness } from "@shared/delivery";
import { unliteral, type ExportContent } from "../export/content";
import { materialFragments } from "./evidence";
import type { DraftPlan } from "./planner";
import { renderedLength } from "./render";
import { valueProblems } from "./values";

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export interface ValidationContext {
  schema: Pick<DestinationSchema, "areas" | "iterations">;
  /** Reviewed content of every included use case, by id. */
  contents: ReadonlyMap<string, ExportContent>;
}

export function validatePlan(
  draft: DraftPlan,
  ctx: ValidationContext,
): DeliveryPlan {
  const issues: PlanIssue[] = [...draft.issues];
  const add = (i: Omit<PlanIssue, "id"> & { id?: string }) => {
    const id =
      i.id ??
      [i.code, i.itemId ?? i.useCaseId ?? "", i.fieldId ?? ""].join(":");
    if (!issues.some((x) => x.id === id)) issues.push({ ...i, id });
  };
  const decisionFor = (typeId: string, fieldId: string) =>
    draft.decisions.find((d) => d.typeId === typeId && d.fieldId === fieldId);

  /* Items and fields */
  const seenKeys = new Map<string, string>();
  for (const item of draft.items) {
    if (item.existing) {
      const other = seenKeys.get(item.existing.key);
      if (other)
        add({
          severity: "blocking",
          code: "duplicate-identity",
          itemId: item.id,
          message: `${other} and ${item.id} both point at ${item.existing.key}; one destination item cannot hold two plan items.`,
        });
      seenKeys.set(item.existing.key, item.id);
    }
    if (!item.typeId) continue;
    const type = draft.destinationTypes.find((t) => t.id === item.typeId);
    if (!type) {
      add({
        severity: "blocking",
        code: "type-unknown",
        itemId: item.id,
        message: `"${item.typeName}" is not available in the destination.`,
      });
      continue;
    }
    if (type.disabled)
      add({
        severity: "blocking",
        code: "type-unknown",
        itemId: item.id,
        message: `"${type.name}" is disabled in the destination.`,
      });
    if (!type.fields) {
      add({
        severity: "blocking",
        code: "discovery-gap",
        itemId: item.id,
        id: `fields-unknown:${type.id}`,
        message: `The fields of "${type.name}" are unknown, so its required fields cannot be checked. Refresh the destination.`,
      });
      continue;
    }
    if (item.operation === "create")
      for (const field of type.fields) {
        if (!field.required || field.hasDefault || field.readOnly) continue;
        if (field.role === "structural" || field.kind === "reference") continue;
        // Labels-as-groups: the only required field is the name, planned as the item title.
        const planned = item.fields.find((f) => f.fieldId === field.id);
        const empty =
          !planned ||
          planned.value === null ||
          planned.value === "" ||
          (Array.isArray(planned.value) && !planned.value.length);
        if (!empty) continue;
        const decision = decisionFor(type.id, field.id);
        add({
          severity: "blocking",
          code: "required-missing",
          itemId: item.id,
          fieldId: field.id,
          id: `required-missing:${type.id}:${field.id}`,
          message: decision
            ? `"${field.name}" is required by "${type.name}". Choose what fills it.`
            : `"${field.name}" is required by "${type.name}" and nothing in the reviewed requirement provides it.`,
          ...(decision && !decision.resolution
            ? { decisionId: decision.id }
            : {}),
        });
      }
    for (const planned of item.fields) {
      const field = type.fields.find((f) => f.id === planned.fieldId);
      if (!field) {
        add({
          severity: "blocking",
          code: "field-unknown",
          itemId: item.id,
          fieldId: planned.fieldId,
          message: `"${planned.fieldName}" is not a field of "${type.name}" any more.`,
        });
        continue;
      }
      if (field.readOnly && planned.value !== null)
        add({
          severity: "blocking",
          code: "field-read-only",
          itemId: item.id,
          fieldId: field.id,
          message: `"${field.name}" is read-only in the destination.`,
        });
      for (const problem of valueProblems(field, planned))
        add({
          severity: "blocking",
          code: problem.startsWith("does not permit")
            ? "value-not-allowed"
            : "value-type",
          itemId: item.id,
          fieldId: field.id,
          id: `value:${item.id}:${field.id}:${problem}`,
          message: `"${field.name}" ${problem}.`,
        });
      if (
        field.allowedValuesTruncated &&
        typeof planned.value === "string" &&
        !field.allowedValues?.includes(planned.value)
      )
        add({
          severity: "warning",
          code: "value-not-allowed",
          itemId: item.id,
          fieldId: field.id,
          message: `"${planned.value}" could not be verified for "${field.name}" because the destination lists more permitted values than Coherence reads.`,
        });
      if (field.maxLength && typeof planned.value === "string") {
        const length =
          field.kind === "rich-text"
            ? renderedLength(draft.destination.textFormat, planned.value)
            : planned.value.length;
        if (length > field.maxLength)
          add({
            severity: "blocking",
            code: "value-too-long",
            itemId: item.id,
            fieldId: field.id,
            message: `"${field.name}" would hold ${length.toLocaleString("en")} characters but the destination allows ${field.maxLength.toLocaleString("en")}. Coherence will not truncate requirements; shorten the use case or split it.`,
          });
      }
      if (field.kind === "tree-path" && typeof planned.value === "string") {
        const list =
          field.role === "area" ? ctx.schema.areas : ctx.schema.iterations;
        if (!list)
          add({
            severity: "warning",
            code: "discovery-gap",
            itemId: item.id,
            fieldId: field.id,
            id: `path-unverified:${field.id}`,
            message: `"${planned.value}" could not be checked because the destination's ${field.role} paths were not read.`,
          });
        else if (!list.some((p) => norm(p) === norm(planned.value as string)))
          add({
            severity: "blocking",
            code: "value-not-allowed",
            itemId: item.id,
            fieldId: field.id,
            id: `path:${field.id}`,
            message: `${field.role === "area" ? "Area" : "Iteration"} path "${planned.value}" from your settings does not exist in the destination.`,
          });
      }
    }
  }
  const ids = new Set<string>();
  for (const item of draft.items) {
    if (ids.has(item.id))
      add({
        severity: "blocking",
        code: "duplicate-identity",
        itemId: item.id,
        id: `duplicate-item:${item.id}`,
        message: `Two plan items share the identity ${item.id}.`,
      });
    ids.add(item.id);
  }

  /* Relationships */
  for (const r of draft.relationships) {
    if (r.status === "unsupported")
      add({
        severity: "warning",
        code:
          r.kind === "parent" ? "hierarchy-unsupported" : "link-unsupported",
        itemId: r.fromItemId,
        id: `relationship:${r.id}`,
        message: `${r.note ?? "This relationship cannot be represented in the destination."} (${r.fromItemId.replace(/^uc:/, "")})`,
      });
    else if (r.status === "unresolved")
      add({
        severity: "warning",
        code: "link-unsupported",
        itemId: r.fromItemId,
        id: `relationship:${r.id}`,
        message: r.note ?? "This relationship cannot be resolved.",
      });
  }

  /* Preservation: every rule, scenario step and assumption of an included use case reaches its items. */
  for (const source of draft.sources.filter((s) => s.included)) {
    const content = ctx.contents.get(source.useCaseId);
    if (!content) continue;
    // Compared as the BA wrote it: rule text travels as escaped (literal) Markdown.
    const delivered = norm(
      unliteral(
        draft.items
          .filter((i) => i.sources.useCaseIds.includes(source.useCaseId))
          .flatMap((i) => i.fields)
          .filter((f) => typeof f.value === "string")
          .map((f) => f.value as string)
          .join("\n"),
      ),
    );
    if (
      !draft.items.some(
        (i) => i.sources.useCaseIds.includes(source.useCaseId) && i.typeId,
      )
    )
      continue; // No type yet: the type decision already blocks the plan.
    const missing = materialFragments(content).filter(
      (f) => !delivered.includes(norm(f.text)),
    );
    if (missing.length)
      add({
        severity: "blocking",
        code: "content-lost",
        useCaseId: source.useCaseId,
        id: `content-lost:${source.useCaseId}:preservation`,
        message: `${missing.length} business rule, scenario or assumption line(s) of ${source.useCaseId} would not reach the destination (for example ${missing
          .slice(0, 2)
          .map((m) => m.label)
          .join(", ")}).`,
        detail: missing
          .slice(0, 5)
          .map((m) => `${m.label}: ${m.text.slice(0, 80)}`)
          .join(" | "),
      });
  }

  /* Suggestions waiting for confirmation; attachments the destination cannot take. */
  for (const d of draft.decisions)
    if (d.suggestion && !d.resolution && !d.blocking)
      add({
        severity: "info",
        code: "inference-unconfirmed",
        id: `inference:${d.id}`,
        message: `A suggestion for "${d.question}" is waiting for your confirmation; it is not used until you confirm it.`,
        decisionId: d.id,
      });
  for (const d of draft.decisions)
    if (d.resolution?.assumed)
      add({
        severity: "info",
        code: "inference-unconfirmed",
        id: `assumed:${d.id}`,
        message: `Assumed "${d.options.find((o) => o.value === d.resolution!.value)?.label ?? d.resolution.value.replace(/^text:/, "")}" for "${d.question}". Change it if it's wrong.`,
        decisionId: d.id,
      });
  for (const a of draft.attachments)
    if (a.include && a.supported === "unsupported")
      add({
        severity: "blocking",
        code: "attachment-unsupported",
        itemId: a.itemId,
        id: `attachment:${a.id}`,
        message: `"${a.screenName}" cannot be attached in this destination.`,
      });

  const decisions = draft.decisions;
  const summary: PlanSummary = {
    items: draft.items.length,
    groups: draft.items.filter((i) => i.role === "group").length,
    requirements: draft.items.filter((i) => i.role !== "group").length,
    creates: draft.items.filter((i) => i.operation === "create").length,
    updates: draft.items.filter((i) => i.operation === "update").length,
    relationships: draft.relationships.filter((r) => r.status === "planned")
      .length,
    // Problems to fix; blocking items that an open decision answers are counted as decisions instead.
    blocking: issues.filter((i) => i.severity === "blocking" && !i.decisionId)
      .length,
    warnings: issues.filter((i) => i.severity === "warning").length,
    openDecisions: decisions.filter((d) => !d.resolution).length,
    inferences: decisions.filter((d) => d.suggestion && !d.resolution).length,
  };
  const readiness = computeReadiness(issues, decisions);
  const plan: DeliveryPlan = { ...draft, issues, readiness, summary };
  // Approval covers exactly the approved content; anything else needs a fresh approval.
  if (plan.approval && plan.approval.fingerprint !== planFingerprint(plan))
    delete plan.approval;
  return plan;
}

/** Fingerprint of what the BA approves: items, values, relationships, attachments and answers. */
export function planFingerprint(plan: DeliveryPlan): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        destination: plan.destination.schemaFingerprint,
        sources: plan.sources.map((s) => [
          s.useCaseId,
          s.fingerprint,
          s.included,
        ]),
        items: plan.items.map((i) => [
          i.id,
          i.typeId,
          i.operation,
          i.parentItemId,
          i.fields.map((f) => [f.fieldId, f.value]),
        ]),
        relationships: plan.relationships.map((r) => [
          r.id,
          r.status,
          r.linkTypeId,
        ]),
        attachments: plan.attachments.map((a) => [a.id, a.include]),
        decisions: plan.decisions.map((d) => [d.id, d.resolution?.value]),
      }),
    )
    .digest("hex")
    .slice(0, 32);
}
