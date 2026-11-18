/**
 * Deterministic delivery planning: reviewed use cases + discovered destination structure + approved mappings
 * → an inspectable DeliveryPlan. Every value carries provenance. Suggestions (AI or heuristic) never fill a
 * field on their own; they wait in a decision until the BA confirms them or an approved rule exists.
 * Validation and readiness are computed afterwards by validate.ts, never by a model.
 */
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import type {
  AttachmentCandidate,
  DeliveryPlan,
  DeliveryPlanOptions,
  DestinationField,
  DestinationItemType,
  DestinationSchema,
  EvidenceId,
  FieldComparison,
  MappingProfile,
  PlanAiRecord,
  PlanDecision,
  PlanIssue,
  PlannedField,
  PlannedItem,
  PlannedItemRole,
  PlannedRelationship,
  PlanSource,
  Provenance,
  TextFormat,
} from "@shared/delivery";
import { EVIDENCE_LABEL } from "@shared/delivery";
import type {
  AzdoSettings,
  ExternalLink,
  ExternalSystem,
  FeatureGroup,
  GitHubSettings,
  JiraSettings,
  Project,
  SolutionModel,
  UseCase,
} from "@shared/types";
import { EXTERNAL_SYSTEM_LABEL } from "@shared/api";
import {
  footerLine,
  literal,
  uniqueLabels,
  type ExportContent,
} from "../export/content";
import { featureLabelName } from "../export/github";
import { OWN_LABEL, OWN_TAG } from "../export/identity";
import { linkBelongsToTarget, targetBase } from "../export/target";
import type { TrackerSettings } from "./discovery";
import {
  contentFingerprint,
  evidenceFor,
  evidenceText,
  evidenceValue,
  itemTitle,
} from "./evidence";
import { compareField, needsDecision, type Comparable } from "./compare";
import { fieldSignature } from "./profiles";
import type { PublishedRecord } from "./publishRecord";
import { renderRich } from "./render";
import { adfText } from "./adf";
import { checkText } from "./values";

/** A planned value in the comparable form a destination reader produces (rich text as its visible text). */
export function comparableValue(
  format: TextFormat,
  f: PlannedField,
): Comparable {
  if (f.kind !== "rich-text" || typeof f.value !== "string") return f.value;
  const rendered = renderRich(format, f.value);
  if (typeof rendered !== "string")
    return adfText(rendered as Parameters<typeof adfText>[0]);
  return format === "html" ? htmlText(rendered) : rendered;
}

/** Whether a proposed value was already sent: equal text, or (tags) every proposed tag among those sent. */
function sentAlready(proposed: Comparable, sent: Comparable): boolean {
  if (Array.isArray(proposed)) {
    const had = new Set(
      (Array.isArray(sent) ? sent : []).map((t) => t.trim().toLowerCase()),
    );
    return proposed.every((t) => had.has(t.trim().toLowerCase()));
  }
  return (
    compareField("", "", proposed, sent, undefined, false).state === "unchanged"
  );
}

/** Visible text of simple HTML (tags removed, common entities decoded). */
export function htmlText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h\d|li|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export interface MappingSuggestion {
  decisionId: string;
  value: string;
  rationale: string;
  by: "ai" | "heuristic";
}

export interface PlanInputs {
  projectId: string;
  project: Pick<Project, "screens">;
  model: SolutionModel;
  system: ExternalSystem;
  settings: TrackerSettings;
  schema: DestinationSchema;
  /** Reviewed content of each selected use case that still exists, in model order. */
  contents: ExportContent[];
  /** Selected ids that no longer exist in the model. */
  missingIds?: string[];
  options: DeliveryPlanOptions;
  profile?: MappingProfile;
  previous?: DeliveryPlan;
  suggestions?: MappingSuggestion[];
  /** Use cases with an uncertain earlier export to this destination (from the export journal). */
  uncertainUseCaseIds?: ReadonlySet<string>;
  /** Current destination values of existing items (item id → field id → comparable value), read-only. */
  remote?: ReadonlyMap<string, Record<string, Comparable>>;
  /** What Coherence last sent for existing items, when recorded by a publish (otherwise read from `published`). */
  baselines?: ReadonlyMap<string, Record<string, Comparable>>;
  /** The destination revision of each existing item read into `remote`. */
  remoteRevs?: ReadonlyMap<string, number>;
  /** Existing items whose work item could not be found when planning. */
  missing?: ReadonlySet<string>;
  /** Work items Coherence published to this destination (publishRecord.ts). */
  published?: PublishedRecord;
  ai?: PlanAiRecord;
  now?: string;
}

/** What the planner produced; validatePlan adds issues, readiness and the summary. */
export type DraftPlan = Omit<DeliveryPlan, "readiness" | "summary">;

const CONTENT_IGNORED =
  /user story line was not recognised and was ignored|example tables and doc strings are not supported/i;

export function durableKey(projectId: string, itemId: string): string {
  return `coh-${createHash("sha256").update(`${projectId}:${itemId}`).digest("hex").slice(0, 12)}`;
}

/** Feature groups are matched by name, so regenerated FEAT ids never point at another group's work item. */
export function groupDurableKey(
  projectId: string,
  featureName: string,
): string {
  return durableKey(projectId, `group:${featureName.trim().toLowerCase()}`);
}

/** Use cases keep their internal id across regeneration (agents/identity.ts); the display id is the fallback. */
export function requirementDurableKey(
  projectId: string,
  uc: Pick<UseCase, "id" | "internalId">,
): string {
  return durableKey(projectId, `uc:${uc.internalId ?? uc.id}`);
}

/** The identity export journals are created with (server/export/exporter.ts, delivery/publish.ts). */
export function journalIdentity(
  system: ExternalSystem,
  settings: TrackerSettings,
): { base: string | undefined; project: string } {
  const project =
    system === "jira"
      ? (settings as JiraSettings).projectKey
      : system === "azdo"
        ? (settings as AzdoSettings).project
        : (settings as GitHubSettings).repo;
  return { base: targetBase(system, settings), project };
}

/** Same identity the export journal records, so uncertain outcomes are matched. */
export function journalTargetFingerprint(
  system: ExternalSystem,
  settings: TrackerSettings,
): string {
  return createHash("sha256")
    .update(JSON.stringify(journalIdentity(system, settings)))
    .digest("hex");
}

function settingsLabel(system: ExternalSystem): string {
  return `Your ${EXTERNAL_SYSTEM_LABEL[system]} settings`;
}

const REQUIREMENT_TYPE_HINT = /story|requirement|backlog item|feature request/i;
const CUSTOM_HINTS: [RegExp, EvidenceId][] = [
  [/acceptance\s*criteria/i, "scenarios"],
  [/business\s*rules?/i, "businessRules"],
  [/assumptions?/i, "assumptions"],
  [/open\s*questions?/i, "openQuestions"],
  [/pre-?conditions?/i, "preconditions"],
  [/post-?conditions?/i, "postconditions"],
  [/user\s*story/i, "story"],
  [/persona|user\s*role/i, "story.asA"],
  [/benefit|business\s*value|value\s*statement|so\s*that/i, "story.soThat"],
  [/scope/i, "scope"],
];

/** Deterministic, name-based suggestion for an unrecognised field (an inference: always needs confirmation). */
export function heuristicEvidence(
  field: DestinationField,
): EvidenceId | undefined {
  const allowed = evidenceFor(field.kind);
  for (const [pattern, evidence] of CUSTOM_HINTS)
    if (pattern.test(field.name) && allowed.includes(evidence)) return evidence;
  return undefined;
}

class Builder {
  readonly issues: PlanIssue[] = [];
  readonly decisions = new Map<string, PlanDecision>();
  readonly appliedRules = new Set<string>();
  readonly invalidRules = new Set<string>();
  private readonly suggestions = new Map<string, MappingSuggestion>();
  private readonly now: string;

  constructor(readonly input: PlanInputs) {
    this.now = input.now ?? new Date().toISOString();
    for (const s of input.suggestions ?? [])
      this.suggestions.set(s.decisionId, s);
  }

  issue(i: Omit<PlanIssue, "id"> & { id?: string }) {
    const id =
      i.id ??
      [i.code, i.itemId ?? i.useCaseId ?? "", i.fieldId ?? ""].join(":");
    if (!this.issues.some((x) => x.id === id)) this.issues.push({ ...i, id });
  }

  private validValue(
    decision: Omit<PlanDecision, "resolution">,
    value: string,
    field?: DestinationField,
  ): boolean {
    if (decision.options.some((o) => o.value === value)) return true;
    if (decision.allowsText && value.startsWith("text:") && field)
      return checkText(field, value.slice(5)).ok;
    return false;
  }

  /**
   * Register a decision and resolve it from (1) the BA's answer in the previous plan, (2) an approved profile rule.
   * Suggestions are attached but never applied.
   */
  decide(
    decision: Omit<PlanDecision, "resolution" | "suggestion">,
    field?: DestinationField,
  ): PlanDecision {
    const existing = this.decisions.get(decision.id);
    if (existing) return existing;
    const result: PlanDecision = { ...decision };
    const fresh = this.suggestions.get(decision.id);
    const carried = this.input.previous?.decisions.find(
      (d) => d.id === decision.id,
    )?.suggestion;
    if (fresh && this.validValue(decision, fresh.value, field))
      result.suggestion = {
        value: fresh.value,
        provenance: {
          kind: "inference",
          by: fresh.by,
          label:
            fresh.by === "ai"
              ? "Suggested by AI — needs your confirmation"
              : "Suggested by Coherence from the field name — needs your confirmation",
          rationale: fresh.rationale,
        },
      };
    else if (carried && this.validValue(decision, carried.value, field))
      result.suggestion = carried;
    // An assumption is recomputed from the current suggestion, never carried as if the BA had answered.
    const answered = this.input.previous?.decisions.find(
      (d) => d.id === decision.id && d.resolution && !d.resolution.assumed,
    )?.resolution;
    if (answered && this.validValue(decision, answered.value, field)) {
      result.resolution = answered;
    } else {
      const rule = this.input.profile?.rules.find((r) => r.id === decision.id);
      if (rule) {
        const signatureOk =
          !rule.signature || !field || rule.signature === fieldSignature(field);
        if (signatureOk && this.validValue(decision, rule.value, field)) {
          result.resolution = {
            value: rule.value,
            at: rule.approvedAt,
            saveAsRule: true,
          };
          this.appliedRules.add(rule.id);
        } else {
          this.invalidRules.add(rule.id);
          this.issue({
            severity: "warning",
            code: "rule-invalid",
            fieldId: decision.fieldId,
            message: `A saved mapping for "${field?.name ?? decision.fieldId ?? decision.id}" no longer fits the destination (its field or permitted values changed), so it was not used.`,
            detail: rule.id,
            id: `rule-invalid:${rule.id}`,
          });
        }
      }
    }
    this.decisions.set(result.id, result);
    return this.assume(result, field);
  }

  /**
   * Publishing is not an approval workflow (owner, 3 Nov 2026): an unanswered question with a valid suggestion is
   * answered with it as an assumption, which the BA can change. Callers that attach a suggestion after decide()
   * call this again.
   */
  assume(decision: PlanDecision, field?: DestinationField): PlanDecision {
    if (
      !decision.resolution &&
      decision.suggestion &&
      this.validValue(decision, decision.suggestion.value, field)
    )
      decision.resolution = {
        value: decision.suggestion.value,
        at: this.now,
        saveAsRule: false,
        assumed: true,
      };
    return decision;
  }

  provenanceFor(decision: PlanDecision): Provenance {
    if (decision.resolution?.assumed)
      return {
        kind: "inference",
        by: decision.suggestion?.provenance.by ?? "heuristic",
        label:
          decision.suggestion?.provenance.by === "ai"
            ? "Assumed from an AI suggestion (change it if it's wrong)"
            : "Assumed by Coherence (change it if it's wrong)",
        ...(decision.suggestion?.provenance.rationale
          ? { rationale: decision.suggestion.provenance.rationale }
          : {}),
      };
    const fromRule = this.appliedRules.has(decision.id);
    return fromRule
      ? {
          kind: "rule",
          by: "ba",
          ruleId: decision.id,
          label: "Your saved mapping",
        }
      : { kind: "rule", by: "ba", label: "Your decision in this plan" };
  }
}

/* ------------------------------------------------------------------ */
/* Type selection                                                      */
/* ------------------------------------------------------------------ */

function requirementType(b: Builder): {
  type?: DestinationItemType;
  rationale: string;
  provenance: Provenance;
} {
  const { schema, settings, system } = b.input;
  const candidates = schema.itemTypes.filter(
    (t) => t.level === "requirement" && !t.disabled,
  );
  const decision = b.decide({
    id: "item-type:requirement",
    kind: "item-type",
    question: `Which ${EXTERNAL_SYSTEM_LABEL[system]} type should each use case become?`,
    options: candidates.map((t) => ({
      value: `type:${t.id}`,
      label: t.name,
      detail: t.isDefault
        ? "The destination's default requirement type"
        : undefined,
    })),
    blocking: true,
  });
  const decided = () =>
    candidates.find((t) => `type:${t.id}` === decision.resolution?.value);
  // Settings and the destination's default come before an assumption; only the BA's own answer beats them.
  if (decision.resolution && !decision.resolution.assumed) {
    const type = decided();
    if (type) {
      // Kept (resolved) in the plan so the BA's choice survives the next re-plan.
      return {
        type,
        rationale: `Use cases become "${type.name}" because you chose it.`,
        provenance: b.provenanceFor(decision),
      };
    }
  }
  const configuredName =
    system === "azdo"
      ? (settings as AzdoSettings).workItemType?.trim()
      : system === "jira"
        ? (settings as JiraSettings).issueType?.trim()
        : undefined;
  const configured = configuredName
    ? candidates.find(
        (t) => t.name.toLowerCase() === configuredName.toLowerCase(),
      )
    : undefined;
  const chosen =
    configured ??
    candidates.find((t) => t.isDefault) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  if (chosen) {
    b.decisions.delete(decision.id);
    return {
      type: chosen,
      rationale: configured
        ? `Use cases become "${chosen.name}", the type in ${settingsLabel(system).toLowerCase()}.`
        : `Use cases become "${chosen.name}", the destination's ${candidates.length === 1 ? "only" : "default"} requirement-level type.`,
      provenance: configured
        ? { kind: "rule", by: "settings", label: settingsLabel(system) }
        : { kind: "destination", label: "Destination's requirement type" },
    };
  }
  if (!decision.suggestion) {
    const hinted = candidates.find((t) => REQUIREMENT_TYPE_HINT.test(t.name));
    if (hinted)
      decision.suggestion = {
        value: `type:${hinted.id}`,
        provenance: {
          kind: "inference",
          by: "heuristic",
          label:
            "Suggested by Coherence from the type name — needs your confirmation",
          rationale: `"${hinted.name}" reads like a requirement type.`,
        },
      };
  }
  const assumed = b.assume(decision).resolution ? decided() : undefined;
  if (assumed)
    return {
      type: assumed,
      rationale: `Use cases become "${assumed.name}", assumed from a suggestion; change it if it's wrong.`,
      provenance: b.provenanceFor(decision),
    };
  b.issue({
    severity: "blocking",
    code: candidates.length ? "type-ambiguous" : "type-unknown",
    message: candidates.length
      ? `${EXTERNAL_SYSTEM_LABEL[system]} offers several requirement types (${candidates.map((t) => t.name).join(", ")}); choose the one your team uses for user stories.`
      : `${EXTERNAL_SYSTEM_LABEL[system]} has no requirement-level type this account can create.`,
    decisionId: candidates.length ? decision.id : undefined,
  });
  if (!candidates.length) b.decisions.delete(decision.id);
  return {
    rationale: "The type is not decided yet.",
    provenance: { kind: "inference", label: "Not decided" },
  };
}

function groupType(
  b: Builder,
  reqType: DestinationItemType | undefined,
): {
  type?: DestinationItemType;
  via?: string;
  rationale: string;
  provenance: Provenance;
} {
  const { schema, settings, system } = b.input;
  const portfolio = schema.itemTypes.filter(
    (t) => t.level === "portfolio" && !t.disabled,
  );
  const edge = (t: DestinationItemType) =>
    reqType
      ? schema.hierarchy.find(
          (h) => h.parentTypeId === t.id && h.childTypeId === reqType.id,
        )
      : undefined;
  let configured: DestinationItemType | undefined;
  if (system === "github")
    configured = portfolio.find(
      (t) =>
        t.id ===
        ((settings as GitHubSettings).useMilestonesForFeatures
          ? "milestone"
          : "label"),
    );
  else {
    const name =
      system === "azdo"
        ? (settings as AzdoSettings).parentWorkItemType?.trim() || "Feature"
        : (settings as JiraSettings).epicIssueType?.trim() || "Epic";
    configured = portfolio.find(
      (t) => t.name.toLowerCase() === name.toLowerCase(),
    );
  }
  const linked = portfolio.filter((t) => edge(t));
  const chosen =
    (configured && edge(configured) ? configured : undefined) ??
    linked.find((t) => t.isDefault) ??
    linked[0];
  if (!chosen)
    return {
      rationale:
        "The destination offers no parent type that can hold this requirement type.",
      provenance: { kind: "destination", label: "Destination hierarchy" },
    };
  return {
    type: chosen,
    via: edge(chosen)!.via,
    rationale:
      chosen === configured
        ? `Feature groups become "${chosen.name}" from ${settingsLabel(system).toLowerCase()}.`
        : `Feature groups become "${chosen.name}", a parent level that can hold "${reqType!.name}".`,
    provenance:
      chosen === configured
        ? { kind: "rule", by: "settings", label: settingsLabel(system) }
        : { kind: "destination", label: "Destination hierarchy" },
  };
}

/* ------------------------------------------------------------------ */
/* Fields                                                              */
/* ------------------------------------------------------------------ */

interface ItemContext {
  role: PlannedItemRole;
  itemId: string;
  /** Written into the description footer, so a publish can find the work item again. */
  durableKey: string;
  type: DestinationItemType;
  content?: ExportContent;
  feature?: FeatureGroup;
  labels: string[];
}

function configuredLabels(
  system: ExternalSystem,
  settings: TrackerSettings,
): string[] {
  const list =
    system === "azdo"
      ? (settings as AzdoSettings).tags
      : system === "jira"
        ? (settings as JiraSettings).labels
        : (settings as GitHubSettings).labels;
  return Array.isArray(list) ? list : [];
}

/** Evidence for a feature-group item: its name and description only. */
function groupEvidence(feature: FeatureGroup, id: EvidenceId, kind: string) {
  if (id === "feature" || id === "title") return feature.name.trim();
  if (id === "specification" && kind !== "single-line")
    return feature.description.trim() || feature.name.trim();
  return "";
}

function applyDecisionValue(
  b: Builder,
  ctx: ItemContext,
  field: DestinationField,
  decision: PlanDecision,
): PlannedField | undefined {
  const value = decision.resolution?.value;
  if (!value || value === "skip") return undefined;
  const base = {
    fieldId: field.id,
    fieldName: field.name,
    kind: field.kind,
  };
  if (value.startsWith("evidence:")) {
    const evidence = value.slice(9) as EvidenceId;
    const planned = ctx.content
      ? evidenceValue(ctx.content, evidence, field.kind)
      : ctx.feature
        ? groupEvidence(ctx.feature, evidence, field.kind)
        : undefined;
    if (planned === undefined) return undefined;
    return {
      ...base,
      value: planned,
      provenance: {
        ...b.provenanceFor(decision),
        evidence: [evidence],
        label: `${b.provenanceFor(decision).label}: ${EVIDENCE_LABEL[evidence]}`,
      },
      ownership: evidence === "size" ? "team" : "coherence",
    };
  }
  if (value.startsWith("value:"))
    return {
      ...base,
      value: field.kind === "multi-option" ? [value.slice(6)] : value.slice(6),
      provenance: b.provenanceFor(decision),
      ownership: "team",
    };
  if (value.startsWith("text:")) {
    const parsed = checkText(field, value.slice(5));
    if (!parsed.ok) return undefined;
    return {
      ...base,
      value: parsed.value,
      provenance: b.provenanceFor(decision),
      ownership: "team",
    };
  }
  return undefined;
}

function decisionOptionsFor(field: DestinationField) {
  const options: PlanDecision["options"] = [];
  for (const id of evidenceFor(field.kind))
    options.push({
      value: `evidence:${id}`,
      label: EVIDENCE_LABEL[id],
      detail:
        id === "size"
          ? "Coherence's size is an AI-assigned estimate (S=3, M=5, L=8)."
          : undefined,
    });
  if (field.kind === "boolean")
    for (const v of ["true", "false"])
      options.push({ value: `value:${v}`, label: v });
  for (const v of field.allowedValues ?? [])
    options.push({ value: `value:${v}`, label: v });
  if (!field.required || field.hasDefault)
    options.push({ value: "skip", label: "Leave empty" });
  const allowsText =
    !field.allowedValues?.length &&
    [
      "single-line",
      "multi-line",
      "rich-text",
      "number",
      "date",
      "labels",
    ].includes(field.kind);
  return { options, allowsText };
}

/** A field Coherence cannot fill from its own standard rules: required, suggested or previously mapped. */
function mappedField(
  b: Builder,
  ctx: ItemContext,
  field: DestinationField,
): PlannedField | undefined {
  const id = `field:${ctx.type.id}:${field.id}`;
  const mustAnswer = field.required && !field.hasDefault && !field.readOnly;
  const known =
    b.decisions.has(id) ||
    b.input.profile?.rules.some((r) => r.id === id) ||
    b.input.previous?.decisions.some((d) => d.id === id) ||
    b.input.suggestions?.some((s) => s.decisionId === id);
  const hint = heuristicEvidence(field);
  if (
    !mustAnswer &&
    !known &&
    !hint &&
    field.role !== "estimate" &&
    field.role !== "issue-type"
  )
    return undefined;
  const { options, allowsText } = decisionOptionsFor(field);
  if (!options.length && !allowsText) {
    if (mustAnswer)
      b.issue({
        severity: "blocking",
        code: "required-missing",
        itemId: ctx.itemId,
        fieldId: field.id,
        id: `required-missing:${ctx.type.id}:${field.id}`,
        message: `"${field.name}" is required by "${ctx.type.name}", but Coherence cannot fill this kind of field (${field.kind}). Ask the destination's administrator to give it a default or make it optional.`,
      });
    return undefined;
  }
  const decision = b.decide(
    {
      id,
      kind:
        field.allowedValues?.length && !evidenceFor(field.kind).length
          ? "field-value"
          : "field-mapping",
      question:
        field.role === "estimate"
          ? `Should "${field.name}" be filled from Coherence's size? Size is an AI-assigned estimate, not your team's.`
          : field.allowedValues?.length
            ? `Which "${field.name}" value should "${ctx.type.name}" items get?`
            : `What should fill "${field.name}" on "${ctx.type.name}" items?`,
      typeId: ctx.type.id,
      fieldId: field.id,
      options,
      allowsText,
      blocking: mustAnswer,
    },
    field,
  );
  if (
    !decision.suggestion &&
    hint &&
    options.some((o) => o.value === `evidence:${hint}`)
  )
    decision.suggestion = {
      value: `evidence:${hint}`,
      provenance: {
        kind: "inference",
        by: "heuristic",
        label:
          "Suggested by Coherence from the field name — needs your confirmation",
        rationale: `The field name "${field.name}" matches ${EVIDENCE_LABEL[hint]}.`,
      },
    };
  if (!decision.suggestion && field.role === "issue-type") {
    const v = field.allowedValues?.find(
      (x) => REQUIREMENT_TYPE_HINT.test(x) || /^feature$/i.test(x),
    );
    if (v)
      decision.suggestion = {
        value: `value:${v}`,
        provenance: {
          kind: "inference",
          by: "heuristic",
          label:
            "Suggested by Coherence from the type name — needs your confirmation",
          rationale: `"${v}" reads like a requirement type.`,
        },
      };
  }
  return applyDecisionValue(b, ctx, field, b.assume(decision, field));
}

function planFields(
  b: Builder,
  ctx: ItemContext,
  scenariosElsewhere: boolean,
): PlannedField[] {
  const { system, settings } = b.input;
  const out: PlannedField[] = [];
  const push = (
    f: DestinationField,
    p: Omit<PlannedField, "fieldId" | "fieldName" | "kind">,
  ) => out.push({ fieldId: f.id, fieldName: f.name, kind: f.kind, ...p });
  const requirementEvidence = (
    evidence: EvidenceId[],
    label: string,
  ): Provenance => ({
    kind: "requirement",
    evidence,
    label,
  });
  for (const field of ctx.type.fields ?? []) {
    switch (field.role) {
      case "title":
        push(field, {
          value: ctx.content
            ? itemTitle(ctx.content)
            : ctx.feature!.name.trim(),
          provenance: requirementEvidence(
            [ctx.content ? "title" : "feature"],
            ctx.content ? "Use case id and title" : "Feature group name",
          ),
          ownership: "coherence",
        });
        break;
      case "description": {
        if (!ctx.content) {
          push(field, {
            value: `${literal(ctx.feature!.description.trim() || ctx.feature!.name.trim())}\n\n_Feature group ${ctx.feature!.id} from Coherence · ${ctx.durableKey}_`,
            provenance: requirementEvidence(
              ["feature"],
              "Feature group description",
            ),
            ownership: "coherence",
          });
          break;
        }
        // The durable key in the footer lets a future publish find this item again after an uncertain outcome
        // without adding one label per item to the team's tracker.
        const footer = footerLine(ctx.content.useCase);
        const spec = evidenceText(
          ctx.content,
          "specification",
        ).markdown.replace(
          footer,
          `${footer.slice(0, -1)} · ${ctx.durableKey}_`,
        );
        const scenarios = evidenceText(ctx.content, "scenarios").markdown;
        const withScenarios = !scenariosElsewhere && scenarios;
        push(field, {
          value: withScenarios
            ? `${spec}\n\n## Acceptance criteria\n\n${scenarios}`
            : spec,
          provenance: requirementEvidence(
            withScenarios ? ["specification", "scenarios"] : ["specification"],
            withScenarios
              ? "Full specification with BDD scenarios"
              : "Full specification (story, scope, rules, conditions, questions)",
          ),
          ownership: "coherence",
          ...(withScenarios && system !== "github"
            ? {
                substitution: `BDD scenarios are placed in ${field.name} because "${ctx.type.name}" has no acceptance criteria field mapped.`,
              }
            : {}),
        });
        break;
      }
      case "acceptance-criteria":
        if (ctx.content && !ctx.content.useCase.scenarios.length) break;
        if (ctx.content)
          push(field, {
            value: evidenceText(ctx.content, "scenarios").markdown,
            provenance: requirementEvidence(["scenarios"], "BDD scenarios"),
            ownership: "coherence",
          });
        break;
      case "labels": {
        // The same identity labels the existing exporter writes (server/export/identity.ts).
        const own = ctx.content ? ctx.content.useCase.id : ctx.feature!.id;
        const configured = configuredLabels(system, settings);
        const value =
          system === "jira"
            ? uniqueLabels(
                [...configured, OWN_LABEL, own.toLowerCase(), ...ctx.labels],
                true,
              )
            : system === "azdo"
              ? uniqueLabels(
                  [...configured, OWN_TAG, own, ...ctx.labels],
                  false,
                )
              : uniqueLabels([...configured, OWN_LABEL, ...ctx.labels], false);
        push(field, {
          value,
          provenance: {
            kind: "rule",
            by: "settings",
            label: `${settingsLabel(system)} plus Coherence's identity labels`,
          },
          ownership: "coherence",
        });
        break;
      }
      case "epic-name":
        if (ctx.feature)
          push(field, {
            value: ctx.feature.name.trim(),
            provenance: requirementEvidence(["feature"], "Feature group name"),
            ownership: "coherence",
          });
        break;
      case "area":
      case "iteration": {
        const configured =
          system === "azdo"
            ? field.role === "area"
              ? (settings as AzdoSettings).areaPath?.trim()
              : (settings as AzdoSettings).iterationPath?.trim()
            : undefined;
        if (configured)
          push(field, {
            value: configured,
            provenance: {
              kind: "rule",
              by: "settings",
              label: settingsLabel(system),
            },
            ownership: "team",
          });
        break;
      }
      case "estimate":
      case "issue-type":
      case "custom": {
        if (ctx.role === "group" && !(field.required && !field.hasDefault))
          break;
        const planned = mappedField(b, ctx, field);
        if (planned) out.push(planned);
        break;
      }
      case "priority":
      case "team": {
        if (field.required && !field.hasDefault && !field.readOnly) {
          const planned = mappedField(b, ctx, field);
          if (planned) out.push(planned);
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Does any field on this type take the scenarios (standard field, or a confirmed mapping)? */
function scenariosMapped(b: Builder, type: DestinationItemType): boolean {
  if (type.fields?.some((f) => f.role === "acceptance-criteria")) return true;
  return [...b.decisions.values()].some(
    (d) => d.typeId === type.id && d.resolution?.value === "evidence:scenarios",
  );
}

/* ------------------------------------------------------------------ */
/* Plan                                                                */
/* ------------------------------------------------------------------ */

export function buildPlan(input: PlanInputs): DraftPlan {
  const b = new Builder(input);
  const { schema, model, system, settings, options } = input;
  const now = input.now ?? new Date().toISOString();

  for (const gap of schema.gaps)
    b.issue({
      severity: "warning",
      code: "discovery-gap",
      message: gap,
      id: `discovery-gap:${createHash("sha256").update(gap).digest("hex").slice(0, 8)}`,
    });
  const issuesCap = schema.capabilities.find((c) => c.id === "issues-enabled");
  if (issuesCap?.state === "unsupported")
    b.issue({
      severity: "blocking",
      code: "type-unknown",
      message: issuesCap.note,
    });
  for (const id of input.missingIds ?? [])
    b.issue({
      severity: "warning",
      code: "source-missing",
      useCaseId: id,
      message: `${id} no longer exists in this project and was left out.`,
    });

  /* Sources */
  const sources: PlanSource[] = [];
  const included: ExportContent[] = [];
  for (const content of input.contents) {
    const uc = content.useCase;
    const approved = uc.status === "approved";
    const include = approved || options.includeUnapproved;
    sources.push({
      useCaseId: uc.id,
      title: uc.title,
      revision: uc.revision,
      status: uc.status,
      fingerprint: contentFingerprint(content),
      origin: content.source,
      included: include,
      ...(include
        ? {}
        : {
            note: "Not approved — left out. Approve it or include drafts to plan it.",
          }),
    });
    if (!include) continue;
    included.push(content);
    if (uc.status === "stale")
      b.issue({
        severity: "blocking",
        code: "source-stale",
        useCaseId: uc.id,
        message: `${uc.id} is marked stale by a change review${uc.staleReason ? ` (${uc.staleReason})` : ""}. Review and approve it before delivery.`,
      });
    else if (!approved)
      b.issue({
        severity: "warning",
        code: "source-not-approved",
        useCaseId: uc.id,
        message: `${uc.id} is a ${uc.status} draft, not an approved requirement.`,
      });
    if (content.source === "model")
      b.issue({
        severity: "blocking",
        code: "source-unreadable",
        useCaseId: uc.id,
        message: `${uc.id}'s reviewed Markdown file could not be used, so the plan would not match what was reviewed. Fix or re-render the file.`,
        detail: content.warnings.join(" "),
      });
    for (const w of content.warnings) {
      if (content.source === "model") break;
      if (CONTENT_IGNORED.test(w))
        b.issue({
          severity: "blocking",
          code: "content-lost",
          useCaseId: uc.id,
          message: `Part of ${uc.id}'s Markdown cannot be read and would be left out: ${w.replace(/^UC-\d+:\s*/, "")}`,
          id: `content-lost:${uc.id}:${createHash("sha256").update(w).digest("hex").slice(0, 8)}`,
        });
      else
        // Incomplete or repaired Markdown (missing story part, renumbered ids, text moved to Notes) is shown, not hidden.
        b.issue({
          severity: /moved to Notes/i.test(w) ? "info" : "warning",
          code: "source-incomplete",
          useCaseId: uc.id,
          message: `${uc.id}: ${w.replace(/^UC-\d+:\s*/, "")}`,
          id: `source-incomplete:${uc.id}:${createHash("sha256").update(w).digest("hex").slice(0, 8)}`,
        });
    }
    if (uc.openQuestions.length)
      b.issue({
        severity: "info",
        code: "open-questions",
        useCaseId: uc.id,
        message: `${uc.id} still has ${uc.openQuestions.length} open question(s); they travel in the description.`,
      });
    if (input.uncertainUseCaseIds?.has(uc.id))
      b.issue({
        severity: "blocking",
        code: "existing-uncertain",
        useCaseId: uc.id,
        message: `An earlier export of ${uc.id} to this destination has an uncertain outcome. Reconcile it before planning delivery, so no duplicate is created.`,
      });
  }

  /* Types */
  const req = requirementType(b);
  const group =
    options.groupByFeature && included.some((c) => c.useCase.featureId)
      ? groupType(b, req.type)
      : undefined;
  if (options.groupByFeature && group && !group.type)
    b.issue({
      severity: "warning",
      code: "hierarchy-unsupported",
      message: `${group.rationale} Use cases will not be grouped under feature parents.`,
    });

  const items: PlannedItem[] = [];
  const relationships: PlannedRelationship[] = [];
  const attachments: AttachmentCandidate[] = [];

  /* Feature groups */
  const groupIds = new Map<string, string>();
  if (group?.type) {
    const featureIds = [
      ...new Set(included.map((c) => c.useCase.featureId).filter(Boolean)),
    ];
    for (const featureId of featureIds) {
      const feature = model.features.find((f) => f.id === featureId);
      if (!feature) continue;
      const itemId = `group:${feature.id}`;
      groupIds.set(feature.id, itemId);
      const key = groupDurableKey(input.projectId, feature.name);
      const recorded = input.published?.entries.find(
        (e) => e.durableKey === key,
      );
      const ctx: ItemContext = {
        role: "group",
        itemId,
        durableKey: key,
        type: group.type,
        feature,
        labels: [],
      };
      if (system === "github" && group.type.id === "label") {
        const name = featureLabelName(feature.name);
        items.push({
          id: itemId,
          durableKey: key,
          role: "group",
          typeId: group.type.id,
          typeName: group.type.name,
          title: name,
          sources: {
            useCaseIds: feature.useCaseIds.filter((id) =>
              included.some((c) => c.useCase.id === id),
            ),
            featureId: feature.id,
          },
          fields: [
            {
              fieldId: "name",
              fieldName: "Name",
              kind: "single-line",
              value: name,
              provenance: {
                kind: "requirement",
                evidence: ["feature"],
                label: "Feature group name",
              },
              ownership: "coherence",
              ...(name !== `feature: ${feature.name.trim()}`
                ? {
                    substitution:
                      "GitHub label names hold 50 characters; the feature name was shortened in the label only.",
                  }
                : {}),
            },
          ],
          operation: (input.schema.labels ?? []).some(
            (l) => l.toLowerCase() === name.toLowerCase(),
          )
            ? "keep"
            : "create",
          rationale: `${group.rationale} Issues carry the label "${name}".`,
          typeProvenance: group.provenance,
        });
        continue;
      }
      const fields = planFields(b, ctx, false);
      const existingMilestone =
        system === "github" && group.type.id === "milestone"
          ? (input.schema.milestones ?? []).some(
              (m) => m.toLowerCase() === feature.name.trim().toLowerCase(),
            )
          : false;
      items.push({
        id: itemId,
        durableKey: key,
        role: "group",
        typeId: group.type.id,
        typeName: group.type.name,
        title: feature.name.trim(),
        sources: {
          useCaseIds: feature.useCaseIds.filter((id) =>
            included.some((c) => c.useCase.id === id),
          ),
          featureId: feature.id,
        },
        fields,
        operation: existingMilestone || recorded ? "keep" : "create",
        ...(recorded
          ? {
              existing: {
                key: recorded.key,
                url: recorded.url,
                exportedRevision: 0,
                currentRevision: 0,
              },
            }
          : {}),
        rationale: `${group.rationale}${
          existingMilestone
            ? " A milestone with this name already exists and is reused."
            : recorded
              ? ` ${group.type.name} ${recorded.key}, published by Coherence for this group, is reused.`
              : " A new one is created when you publish."
        }`,
        typeProvenance: group.provenance,
      });
    }
  }

  /* Requirements */
  for (const content of included) {
    const uc = content.useCase;
    const itemId = `uc:${uc.id}`;
    const key = requirementDurableKey(input.projectId, uc);
    const stored = uc.external.find((l) => l.system === system);
    const recorded = input.published?.entries.find((e) => e.durableKey === key);
    // The use case's own link first; the publish record covers a link that could not be saved on the use case.
    const current: ExternalLink | undefined =
      stored && linkBelongsToTarget(system, settings, stored)
        ? stored
        : recorded
          ? {
              system,
              key: recorded.key,
              url: recorded.url,
              exportedAt: recorded.publishedAt,
              revision: recorded.revision ?? 0,
            }
          : undefined;
    if (stored && !current)
      b.issue({
        severity: "warning",
        code: "existing-other-destination",
        useCaseId: uc.id,
        itemId,
        message: `${uc.id} was exported before to ${stored.key} in another ${EXTERNAL_SYSTEM_LABEL[system]} destination; a new item is planned here.`,
      });
    const groupItemId = group?.type ? groupIds.get(uc.featureId) : undefined;
    const groupLabels =
      group?.type?.id === "label" && groupIds.has(uc.featureId)
        ? [items.find((i) => i.id === groupIds.get(uc.featureId))!.title]
        : [];
    let fields: PlannedField[] = [];
    if (req.type) {
      const ctx: ItemContext = {
        role: "requirement",
        itemId,
        durableKey: key,
        type: req.type,
        content,
        labels: groupLabels,
      };
      // Decisions for this type exist after the first pass, so resolve them before checking where scenarios go.
      planFields(b, ctx, true);
      fields = planFields(b, ctx, scenariosMapped(b, req.type));
    }
    const baseline =
      input.baselines?.get(itemId) ??
      (recorded && current && recorded.key === current.key
        ? recorded.sent
        : undefined);
    let operation: PlannedItem["operation"] = current
      ? current.revision === uc.revision
        ? "keep"
        : "update"
      : "create";
    // Same revision, but Coherence would now send something else (a setting, a mapping or a converter changed).
    if (
      operation === "keep" &&
      baseline &&
      fields.some(
        (f) =>
          f.ownership === "coherence" &&
          !sentAlready(
            comparableValue(schema.textFormat, f),
            baseline[f.fieldId],
          ),
      )
    )
      operation = "update";
    const teamKept =
      operation !== "create" && fields.some((f) => f.ownership === "team");
    if (operation !== "create")
      fields = fields.filter((f) => f.ownership === "coherence");
    let comparisons: FieldComparison[] | undefined;
    if (operation === "update") {
      const remote = input.remote?.get(itemId);
      if (input.missing?.has(itemId))
        b.issue({
          severity: "warning",
          code: "existing-missing",
          itemId,
          useCaseId: uc.id,
          message: `Work item ${current!.key} for ${uc.id} wasn't found in ${EXTERNAL_SYSTEM_LABEL[system]} (deleted, or moved to another project), so it isn't updated.`,
        });
      else if (!remote)
        b.issue({
          severity: "warning",
          code: "update-conflict",
          itemId,
          useCaseId: uc.id,
          id: `not-compared:${itemId}`,
          message: `${current!.key} has not been compared with the destination yet. Before anything is updated, its current content is compared and team edits are kept.`,
        });
      else {
        // The full proposal stays on the item (preservation is judged on it); updateAction says what is sent.
        comparisons = [];
        for (const f of fields) {
          if (f.kind === "labels" && Array.isArray(f.value)) {
            // Tags are only ever added: the team's stay, Coherence's are added when missing.
            const theirs = Array.isArray(remote[f.fieldId])
              ? (remote[f.fieldId] as string[])
              : [];
            const merged = uniqueLabels([...theirs, ...f.value], false);
            const adds = merged.length > uniqueLabels(theirs, false).length;
            f.value = merged;
            f.updateAction = adds ? "send" : "unchanged";
            comparisons.push({
              fieldId: f.fieldId,
              state: adds ? "coherence-update" : "unchanged",
              message: adds
                ? `${f.fieldName}: Coherence's tags are added; the team's are kept.`
                : `${f.fieldName} already has Coherence's tags.`,
            });
            continue;
          }
          const cmp = compareField(
            f.fieldId,
            f.fieldName,
            comparableValue(schema.textFormat, f),
            remote[f.fieldId],
            baseline?.[f.fieldId],
            !!baseline,
          );
          comparisons.push(cmp);
          f.updateAction =
            cmp.state === "coherence-update"
              ? "send"
              : cmp.state === "unchanged"
                ? "unchanged"
                : cmp.state === "team-modified"
                  ? "keep-destination"
                  : "awaiting-decision";
          if (needsDecision(cmp.state)) {
            const d = b.decide({
              id: `conflict:${itemId}:${f.fieldId}`,
              kind: "update-conflict",
              question: `${current!.key}: ${cmp.message}`,
              itemId,
              fieldId: f.fieldId,
              options: [
                { value: "keep", label: "Keep the destination's value" },
                {
                  value: "replace",
                  label: "Replace it with Coherence's reviewed content",
                },
              ],
              blocking: true,
            });
            if (d.resolution)
              f.updateAction =
                d.resolution.value === "replace" ? "send" : "keep-destination";
          }
        }
      }
    }
    // Compared and nothing to send or decide: the work item already holds Coherence's version, or the team's (kept).
    const matches =
      operation === "update" &&
      !!comparisons &&
      !fields.some(
        (f) =>
          f.updateAction === "send" || f.updateAction === "awaiting-decision",
      );
    if (matches) operation = "keep";
    items.push({
      id: itemId,
      durableKey: key,
      role: "requirement",
      typeId: req.type?.id ?? "",
      typeName: req.type?.name ?? "(type to be decided)",
      title: itemTitle(content),
      sources: {
        useCaseIds: [uc.id],
        featureId: uc.featureId || undefined,
        ruleIds: uc.businessRules.map((r) => r.id),
        scenarioIds: uc.scenarios.map((s) => s.id),
      },
      ...(groupItemId ? { parentItemId: groupItemId } : {}),
      fields,
      operation,
      ...(current
        ? {
            existing: {
              key: current.key,
              url: current.url,
              exportedRevision: current.revision,
              currentRevision: uc.revision,
              ...(input.remoteRevs?.has(itemId)
                ? { remoteRev: input.remoteRevs.get(itemId)! }
                : {}),
            },
          }
        : {}),
      ...(comparisons ? { comparisons } : {}),
      rationale: [
        req.rationale,
        current
          ? matches
            ? `${current.key} already holds this content (any edits the team made there are kept); nothing needs updating.`
            : operation === "keep"
              ? `${current.key} already holds revision ${uc.revision}; nothing needs updating.`
              : `${current.key} was exported at revision ${current.revision}; Coherence-owned fields are proposed for update to revision ${uc.revision}.`
          : "",
        teamKept
          ? "Team-managed fields (state, people, planning and estimates) are left as they are."
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      typeProvenance: req.provenance,
    });

    /* Parent relationship */
    if (groupItemId && group?.via) {
      relationships.push({
        id: `parent:${itemId}`,
        kind: "parent",
        fromItemId: itemId,
        toItemId: groupItemId,
        via: group.via as PlannedRelationship["via"],
        status: "planned",
        provenance: {
          kind: "requirement",
          evidence: ["feature"],
          label: "Use case's feature group",
        },
      });
    }

    /* Attachments: current screenshots only, never included by default. */
    const attachState =
      schema.capabilities.find((c) => c.id === "attachments")?.state ??
      "unknown";
    for (const screenId of uc.screenIds) {
      const screen = input.project.screens.find((s) => s.id === screenId);
      if (!screen) continue;
      const previous = input.previous?.attachments.find(
        (a) =>
          a.itemId === itemId &&
          a.screenId === screenId &&
          a.version === screen.version,
      );
      attachments.push({
        id: `${itemId}:${screenId}`,
        itemId,
        screenId,
        screenName: screen.name,
        version: screen.version,
        bytes: screen.sizeBytes,
        mimeType: screen.mimeType,
        include: !!previous?.include,
        supported: attachState,
        note:
          attachState === "unsupported"
            ? "This destination's API cannot receive attachments."
            : "Not shared unless you include it. Only the current version is ever offered.",
      });
    }
  }

  /* Dependencies */
  if (options.linkDependencies) {
    let linkTypeId: string | undefined;
    let via: PlannedRelationship["via"] = "link";
    if (system === "azdo") {
      linkTypeId = schema.linkTypes.find(
        (l) => l.id === "System.LinkTypes.Dependency-Reverse",
      )?.id;
    } else if (system === "jira") {
      const configured =
        (settings as JiraSettings).linkType?.trim() || "Blocks";
      linkTypeId = schema.linkTypes.find(
        (l) => l.id.toLowerCase() === configured.toLowerCase(),
      )?.id;
      if (!linkTypeId && schema.linkTypes.length) {
        const candidates = [...schema.linkTypes].sort(
          (a, b) =>
            (a.kind === "dependency" ? -1 : 0) -
            (b.kind === "dependency" ? -1 : 0),
        );
        const d = b.decide({
          id: "link-type:dependency",
          kind: "link-type",
          question: `"${configured}" is not a link type in this Jira. Which link type should show that one use case depends on another?`,
          options: [
            ...candidates.map((l) => ({
              value: `type:${l.id}`,
              label: l.name,
              detail: l.direction,
            })),
            { value: "skip", label: "Do not link dependencies" },
          ],
          blocking: false,
        });
        if (d.resolution?.value.startsWith("type:"))
          linkTypeId = d.resolution.value.slice(5);
      }
    } else {
      via = "body-line";
    }
    for (const content of included) {
      const uc = content.useCase;
      for (const depId of uc.dependsOn) {
        const inPlan = items.find((i) => i.id === `uc:${depId}`);
        const depUc = model.useCases.find((u) => u.id === depId);
        const depLink = depUc?.external.find(
          (l) =>
            l.system === system && linkBelongsToTarget(system, settings, l),
        );
        const rel: PlannedRelationship = {
          id: `dependency:uc:${uc.id}:${depId}`,
          kind: "dependency",
          fromItemId: `uc:${uc.id}`,
          via,
          ...(linkTypeId ? { linkTypeId } : {}),
          status: "planned",
          provenance: {
            kind: "requirement",
            label: `${uc.id} depends on ${depId} (use case chain)`,
          },
          ...(inPlan
            ? { toItemId: inPlan.id }
            : depLink
              ? {
                  toExternal: {
                    key: depLink.key,
                    url: depLink.url,
                    useCaseId: depId,
                  },
                }
              : {}),
        };
        if (!inPlan && !depLink) {
          rel.status = "unresolved";
          rel.note = `${depId} is not in this plan and has not been delivered to this destination.`;
        } else if (via === "link" && !linkTypeId) {
          rel.status = "unsupported";
          rel.note =
            "No suitable dependency link type is available in this destination.";
        }
        relationships.push(rel);
      }
    }
  }

  const previous = input.previous;
  const destinationTypes = schema.itemTypes.filter((t) =>
    items.some((i) => i.typeId === t.id),
  );
  return {
    schemaVersion: 1,
    id: previous?.id ?? `dp_${nanoid(12)}`,
    projectId: input.projectId,
    system,
    revision: (previous?.revision ?? 0) + 1,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    destination: {
      identity: schema.identity,
      label: `${EXTERNAL_SYSTEM_LABEL[system]} · ${schema.identity.container}`,
      schemaFingerprint: schema.fingerprint,
      discoveredAt: schema.discoveredAt,
      textFormat: schema.textFormat,
      capabilities: schema.capabilities,
    },
    destinationTypes,
    options,
    sources,
    items,
    relationships,
    attachments,
    decisions: [...b.decisions.values()],
    issues: b.issues,
    ai: input.ai ?? {
      requested: options.useAi,
      outcome: options.useAi ? "not-needed" : "not-requested",
      questions: 0,
      accepted: 0,
      rejected: 0,
    },
    ...(input.profile
      ? {
          profile: {
            id: input.profile.id,
            revision: input.profile.revision,
            appliedRules: [...b.appliedRules],
            invalidRules: [...b.invalidRules],
          },
        }
      : {}),
    ...(previous?.approval ? { approval: previous.approval } : {}),
  };
}
