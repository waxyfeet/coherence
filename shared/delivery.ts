/**
 * Intelligent Delivery Mapping contracts (docs/ARCHITECTURE.md, "Delivery mapping").
 * Tracker-independent: what a destination is configured to accept (discovered read-only), and a delivery plan
 * built from reviewed use cases. Every proposed value carries provenance; only deterministic validation decides
 * readiness. Pure types and helpers, safe for both the server and the web UI.
 */
import type { ExternalSystem, ISODate, UseCaseStatus } from "./types";

/* ------------------------------------------------------------------ */
/* Destination structure                                               */
/* ------------------------------------------------------------------ */

/** Where an item type sits in the destination's hierarchy. */
export type ItemLevel =
  "portfolio" | "requirement" | "task" | "subtask" | "other";

export type FieldKind =
  | "single-line"
  | "multi-line"
  /** HTML, Jira wiki, ADF or Markdown — see DestinationSchema.textFormat. */
  | "rich-text"
  | "number"
  | "date"
  | "boolean"
  | "option"
  | "multi-option"
  | "labels"
  | "user"
  /** Azure DevOps area / iteration path. */
  | "tree-path"
  /** Parent, epic link, milestone: set through relationships, never as a plain value. */
  | "reference"
  | "unknown";

/** Deterministic semantic role recognised from the destination's own field ids. */
export type FieldRole =
  | "title"
  | "description"
  | "acceptance-criteria"
  | "labels"
  | "estimate"
  | "priority"
  | "area"
  | "iteration"
  | "parent"
  | "epic-name"
  | "milestone"
  | "issue-type"
  /** State, assignee, reporter, dates and similar: owned by the delivery team. */
  | "team"
  /** Project, issue type and other structure: set by Coherence from the plan, never mapped. */
  | "structural"
  | "custom";

export interface DestinationField {
  id: string;
  name: string;
  kind: FieldKind;
  role: FieldRole;
  required: boolean;
  hasDefault: boolean;
  readOnly: boolean;
  custom: boolean;
  /** Labels of permitted values, exactly as the destination spells them. */
  allowedValues?: string[];
  /** More permitted values exist than were read; values outside the list cannot be verified. */
  allowedValuesTruncated?: boolean;
  maxLength?: number;
  /** Sanitised help text from the destination. Untrusted data — shown to people, never followed. */
  help?: string;
  /** The destination's own type name, for diagnostics ("html", "…:textarea", "single_select"). */
  sourceType?: string;
}

export interface DestinationItemType {
  id: string;
  name: string;
  level: ItemLevel;
  /** The destination's default type for its level (ADO category default, configured issue type …). */
  isDefault?: boolean;
  disabled?: boolean;
  /** Undefined when field metadata was not read for this type (only plan-relevant types are expanded). */
  fields?: DestinationField[];
}

export type RelationKind = "parent" | "dependency" | "related";

export interface DestinationLinkType {
  /** ADO relation reference name, Jira link type name, GitHub relationship id. */
  id: string;
  name: string;
  kind: RelationKind;
  /** Human direction wording, e.g. "is blocked by". */
  direction?: string;
}

export type CapabilityState = "supported" | "unsupported" | "unknown";

export interface DestinationCapability {
  /** "acceptance-criteria-field", "issue-types", "issue-fields", "sub-issues", "issue-dependencies", "attachments" … */
  id: string;
  state: CapabilityState;
  note: string;
}

/** Where items land. Secret-free; used for cache keys, profile binding and stale-plan detection. */
export interface DestinationIdentity {
  system: ExternalSystem;
  /** Canonical host/path: "dev.azure.com/acme", "acme.atlassian.net", "github.com". */
  base: string;
  /** Jira project key, ADO project, GitHub "owner/repo" — compared case-insensitively. */
  container: string;
  /** Jira: "cloud" | "server". GitHub: "github.com" | "enterprise". */
  variant?: string;
}

export type HierarchyVia =
  | "relation"
  | "parent-field"
  | "epic-link"
  | "sub-issue"
  | "milestone"
  | "label";

export interface DestinationHierarchy {
  parentTypeId: string;
  childTypeId: string;
  via: HierarchyVia;
}

export type TextFormat = "html" | "adf" | "jira-wiki" | "markdown";

export interface DestinationSchema {
  schemaVersion: 1;
  identity: DestinationIdentity;
  /** Hash of the structure only (types, fields, required, allowed values, links, hierarchy). */
  fingerprint: string;
  discoveredAt: ISODate;
  textFormat: TextFormat;
  itemTypes: DestinationItemType[];
  linkTypes: DestinationLinkType[];
  hierarchy: DestinationHierarchy[];
  areas?: string[];
  iterations?: string[];
  labels?: string[];
  milestones?: string[];
  capabilities: DestinationCapability[];
  /** What could not be read and is therefore Unknown, in BA language. */
  gaps: string[];
  /** Number of read-only requests made by the discovery that produced this snapshot. */
  requestCount: number;
}

/* ------------------------------------------------------------------ */
/* Provenance and evidence                                             */
/* ------------------------------------------------------------------ */

/** Parts of a reviewed use case that a field may be filled from. */
export const EVIDENCE_IDS = [
  "title",
  "specification",
  "story",
  "story.asA",
  "story.iWant",
  "story.soThat",
  "scope",
  "preconditions",
  "postconditions",
  "businessRules",
  "scenarios",
  "assumptions",
  "openQuestions",
  "notes",
  "feature",
  "persona",
  "screens",
  "useCaseId",
  "size",
] as const;
export type EvidenceId = (typeof EVIDENCE_IDS)[number];

export const EVIDENCE_LABEL: Record<EvidenceId, string> = {
  title: "Use case title",
  specification:
    "Full specification (story, scope, rules, conditions, questions)",
  story: "User story (As a / I want to / So that)",
  "story.asA": "Story: As a (persona / role)",
  "story.iWant": "Story: I want to (goal)",
  "story.soThat": "Story: So that (benefit)",
  scope: "Scope statement",
  preconditions: "Preconditions",
  postconditions: "Postconditions",
  businessRules: "Business rules (every element)",
  scenarios: "BDD scenarios (acceptance criteria)",
  assumptions: "Assumptions",
  openQuestions: "Open questions",
  notes: "Notes",
  feature: "Feature group name",
  persona: "Persona name",
  screens: "Screen names",
  useCaseId: "Use case id",
  size: "Coherence size (S / M / L) — an AI-assigned estimate",
};

/**
 * requirement = reviewed Coherence evidence; destination = its metadata or default; rule = an approved mapping or
 * the BA's own configuration; inference = unconfirmed suggestion (AI or heuristic) that needs a decision.
 */
export type ProvenanceKind =
  "requirement" | "destination" | "rule" | "inference";

export interface Provenance {
  kind: ProvenanceKind;
  /** BA-readable source, e.g. "Use case story (So that)", "Azure DevOps default". */
  label: string;
  evidence?: EvidenceId[];
  ruleId?: string;
  by?: "ai" | "heuristic" | "settings" | "ba" | "coherence";
  rationale?: string;
}

/* ------------------------------------------------------------------ */
/* Delivery plan                                                       */
/* ------------------------------------------------------------------ */

export type FieldOwnership = "coherence" | "team";

export interface PlannedField {
  fieldId: string;
  fieldName: string;
  kind: FieldKind;
  /** Canonical value: Markdown for rich text (rendered per destination at preview); null = deliberately unset. */
  value: string | number | string[] | null;
  provenance: Provenance;
  /** Once the item exists, team-owned fields are never updated by Coherence. */
  ownership: FieldOwnership;
  /** A deliberate placement, e.g. scenarios in Description because the type has no Acceptance Criteria field. */
  substitution?: string;
  /**
   * Existing items only, after comparison with the destination: whether this value would be sent. Undefined on
   * new items and on existing items not compared yet (a publish must compare first).
   */
  updateAction?:
    "send" | "unchanged" | "keep-destination" | "awaiting-decision";
}

export type ComparisonState =
  | "new"
  | "unchanged"
  | "coherence-update"
  | "team-modified"
  | "conflict"
  | "unknown-origin";

export interface FieldComparison {
  fieldId: string;
  state: ComparisonState;
  message: string;
}

export type PlannedItemRole = "group" | "requirement" | "child";
export type PlannedOperation = "create" | "update" | "keep";

export interface PlannedItem {
  /** Durable identity within the project: "group:FEAT-01", "uc:UC-003", "uc:UC-003#2". */
  id: string;
  /** Short project-scoped key for future idempotent publishing and duplicate searches. */
  durableKey: string;
  role: PlannedItemRole;
  typeId: string;
  typeName: string;
  title: string;
  sources: {
    useCaseIds: string[];
    featureId?: string;
    ruleIds?: string[];
    scenarioIds?: string[];
  };
  parentItemId?: string;
  fields: PlannedField[];
  operation: PlannedOperation;
  existing?: {
    key: string;
    url: string;
    exportedRevision: number;
    currentRevision: number;
    /**
     * The destination's revision of the work item when the plan read it; an update is sent only if it is still the
     * same (Azure DevOps `test /rev`), so an edit made in between is never overwritten.
     */
    remoteRev?: number;
  };
  /** Why this item has this type and shape. */
  rationale: string;
  typeProvenance: Provenance;
  comparisons?: FieldComparison[];
}

export interface PlannedRelationship {
  id: string;
  kind: "parent" | "dependency";
  /** Child or dependent item. */
  fromItemId: string;
  /** Parent or prerequisite inside this plan. */
  toItemId?: string;
  /** Prerequisite exported earlier and not part of this plan. */
  toExternal?: { key: string; url: string; useCaseId: string };
  via: HierarchyVia | "link" | "body-line";
  linkTypeId?: string;
  status: "planned" | "unsupported" | "unresolved";
  provenance: Provenance;
  note?: string;
}

export interface AttachmentCandidate {
  id: string;
  itemId: string;
  screenId: string;
  screenName: string;
  /** Only the current version is ever a candidate. */
  version: number;
  bytes: number;
  mimeType: string;
  include: boolean;
  supported: CapabilityState;
  note: string;
}

export type IssueSeverity = "blocking" | "warning" | "info";

export type PlanIssueCode =
  | "required-missing"
  | "value-not-allowed"
  | "value-type"
  | "value-too-long"
  | "field-read-only"
  | "field-unknown"
  | "type-unknown"
  | "type-ambiguous"
  | "hierarchy-unsupported"
  | "link-unsupported"
  | "content-lost"
  | "inference-unconfirmed"
  | "source-not-approved"
  | "source-stale"
  | "source-unreadable"
  | "source-incomplete"
  | "source-changed"
  | "source-missing"
  | "open-questions"
  | "duplicate-identity"
  | "existing-other-destination"
  | "existing-uncertain"
  | "existing-missing"
  | "update-conflict"
  | "schema-changed"
  | "destination-changed"
  | "rule-invalid"
  | "discovery-gap"
  | "attachment-unsupported"
  | "ai-suggestion-rejected"
  | "ai-unavailable";

export interface PlanIssue {
  /** Deterministic: the same problem keeps the same id across re-validation. */
  id: string;
  severity: IssueSeverity;
  code: PlanIssueCode;
  /** BA language. */
  message: string;
  itemId?: string;
  fieldId?: string;
  useCaseId?: string;
  /** Technical detail for the diagnostic view. */
  detail?: string;
  decisionId?: string;
}

export type DecisionKind =
  | "field-value"
  | "field-mapping"
  | "item-type"
  | "link-type"
  | "update-conflict";

export interface DecisionOption {
  value: string;
  label: string;
  detail?: string;
}

export interface PlanDecision {
  /** Deterministic: "<kind>:<typeId>:<fieldId>" or "<kind>:<itemId>:<fieldId>". */
  id: string;
  kind: DecisionKind;
  question: string;
  typeId?: string;
  fieldId?: string;
  itemId?: string;
  /**
   * Only destination-permitted values ("value:<v>"), enumerated evidence ("evidence:<id>"), types ("type:<id>")
   * or explicit choices ("skip", "keep", "replace").
   */
  options: DecisionOption[];
  /** The BA may type a value instead ("text:<value>"), validated against the field's kind and limits. */
  allowsText?: boolean;
  suggestion?: { value: string; provenance: Provenance };
  /** True when the plan cannot become ready without an answer. */
  blocking: boolean;
  /**
   * `assumed`: nobody answered, so the suggestion is used as an assumption (owner, 3 Nov 2026: "allow publishing with
   * open assumptions"). The BA can change it; it is never remembered as a rule.
   */
  resolution?: {
    value: string;
    at: ISODate;
    saveAsRule: boolean;
    assumed?: boolean;
  };
}

export interface PlanSource {
  useCaseId: string;
  title: string;
  revision: number;
  status: UseCaseStatus;
  /** sha256 of the reviewed content that was planned. */
  fingerprint: string;
  origin: "file" | "model";
  included: boolean;
  /** Why a selected use case was left out, or a caveat about it. */
  note?: string;
}

export interface DeliveryPlanOptions {
  /** Explicit selection; when omitted every approved use case is planned. */
  useCaseIds?: string[];
  /** Plan selected draft use cases too (they stay flagged). */
  includeUnapproved: boolean;
  groupByFeature: boolean;
  linkDependencies: boolean;
  useAi: boolean;
}

export type AiOutcome =
  | "not-requested"
  | "not-needed"
  | "used"
  | "offline-simulation"
  | "failed"
  | "unavailable";

export interface PlanAiRecord {
  requested: boolean;
  outcome: AiOutcome;
  /** Connection and model label only — never a credential. */
  connection?: string;
  questions: number;
  accepted: number;
  rejected: number;
  message?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
}

export type PlanReadiness = "blocked" | "needs-decisions" | "ready";

export interface PlanSummary {
  items: number;
  groups: number;
  requirements: number;
  creates: number;
  updates: number;
  relationships: number;
  blocking: number;
  warnings: number;
  openDecisions: number;
  inferences: number;
}

export interface DeliveryPlan {
  schemaVersion: 1;
  id: string;
  projectId: string;
  system: ExternalSystem;
  /** Increments whenever the plan's content or decisions change. */
  revision: number;
  createdAt: ISODate;
  updatedAt: ISODate;
  destination: {
    identity: DestinationIdentity;
    label: string;
    schemaFingerprint: string;
    discoveredAt: ISODate;
    textFormat: TextFormat;
    capabilities: DestinationCapability[];
  };
  /** The destination types this plan references — portable, secret-free. */
  destinationTypes: DestinationItemType[];
  options: DeliveryPlanOptions;
  sources: PlanSource[];
  items: PlannedItem[];
  relationships: PlannedRelationship[];
  attachments: AttachmentCandidate[];
  decisions: PlanDecision[];
  issues: PlanIssue[];
  readiness: PlanReadiness;
  ai: PlanAiRecord;
  profile?: {
    id: string;
    revision: number;
    appliedRules: string[];
    invalidRules: string[];
  };
  /** Approval covers exactly the content with this fingerprint; any later change needs a fresh approval. */
  approval?: { approvedAt: ISODate; revision: number; fingerprint: string };
  summary: PlanSummary;
}

/* ------------------------------------------------------------------ */
/* Reusable mapping profiles                                           */
/* ------------------------------------------------------------------ */

export type MappingRuleKind =
  | "item-type"
  | "field-evidence"
  | "field-constant"
  | "field-skip"
  | "link-type";

export interface MappingRule {
  /** Deterministic: "<kind>:<role|typeId>:<fieldId>". */
  id: string;
  kind: MappingRuleKind;
  role?: PlannedItemRole;
  typeId?: string;
  fieldId?: string;
  /** Evidence id, permitted value, type id or link type id. */
  value: string;
  /** Field signature at approval (kind + permitted values); a change makes the rule invalid. */
  signature?: string;
  approvedAt: ISODate;
}

export interface MappingProfile {
  schemaVersion: 1;
  /** Secret-free destination key. */
  id: string;
  identity: DestinationIdentity;
  revision: number;
  /** Destination structure the rules were last approved against. */
  schemaFingerprint: string;
  rules: MappingRule[];
  updatedAt: ISODate;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export const READINESS_LABEL: Record<PlanReadiness, string> = {
  blocked: "Blocked — problems must be fixed",
  "needs-decisions": "Needs your decisions",
  ready: "Ready",
};

export const PROVENANCE_LABEL: Record<ProvenanceKind, string> = {
  requirement: "From the reviewed requirement",
  destination: "From the destination",
  rule: "Approved mapping",
  inference: "Suggestion — needs confirmation",
};

export function isOpenDecision(decision: PlanDecision): boolean {
  return !decision.resolution;
}

/* ------------------------------------------------------------------ */
/* Publishing (docs/ARCHITECTURE.md, "Publishing")            */
/* ------------------------------------------------------------------ */

/** What happened to one planned item in a publish run. */
export type PublishItemOutcome =
  /** Created in this run. */
  | "created"
  /** Existing work item updated in this run (only the fields Coherence owns and the team did not change). */
  | "updated"
  /** Found in the destination (made by Coherence earlier, record lost) and recorded instead of created again. */
  | "reused"
  /** Already published; nothing needed sending. */
  | "unchanged"
  /** The destination refused it; nothing was saved there. */
  | "refused"
  /** The outcome is unknown; check the destination before publishing it again. */
  | "uncertain"
  /** Left out of this run, with the reason. */
  | "not-sent";

export interface PublishItemResult {
  itemId: string;
  title: string;
  typeName: string;
  outcome: PublishItemOutcome;
  key?: string;
  url?: string;
  message?: string;
}

export interface PublishLinkResult {
  relationshipId: string;
  fromItemId: string;
  outcome: "added" | "already" | "refused" | "uncertain" | "not-sent";
  message?: string;
}

export interface PublishRunSummary {
  jobId: string;
  startedAt: ISODate;
  finishedAt: ISODate;
  /** completed: every item was dealt with; stopped: the run ended early (see message); refused: nothing was sent. */
  status: "completed" | "stopped" | "refused";
  message?: string;
  /** "Azure DevOps · Portal" */
  destination: string;
  items: PublishItemResult[];
  links: PublishLinkResult[];
}

export interface PublishScope {
  /** Items a publish would create or update (Features first). */
  send: string[];
  /** Items already in the destination with nothing to send. */
  unchanged: string[];
  notSent: { itemId: string; reason: string }[];
  /** Answers Coherence assumed from suggestions. */
  assumptions: number;
}

export interface PublishingState {
  /** Whether this build can publish to this destination at all. */
  enabled: boolean;
  /** Why publishing is unavailable right now, in BA language. */
  blockedReason?: string;
  scope: PublishScope;
  /** Writes with an unknown outcome, waiting for "Check …". */
  needsCheck: number;
  lastRun?: PublishRunSummary;
}

/** Item ids an issue stops: the item, every item of its type (type-level problems) or every item of a use case. */
function issueTargets(plan: DeliveryPlan, issue: PlanIssue): string[] {
  const items = plan.items;
  if (issue.itemId) {
    if (issue.id.includes(issue.itemId)) return [issue.itemId];
    const anchor = items.find((i) => i.id === issue.itemId);
    // Deduplicated per type or per field ("required-missing:<type>:<field>", "path:<field>").
    return items
      .filter(
        (i) =>
          (anchor && i.typeId === anchor.typeId) ||
          (issue.fieldId &&
            i.fields.some(
              (f) => f.fieldId === issue.fieldId && f.value !== null,
            )),
      )
      .map((i) => i.id);
  }
  if (issue.useCaseId)
    return items
      .filter(
        (i) =>
          i.role !== "group" && i.sources.useCaseIds.includes(issue.useCaseId!),
      )
      .map((i) => i.id);
  return items.map((i) => i.id);
}

/**
 * What a publish would send (pure; the server is authoritative). Nothing waits for approval: everything that can be
 * sent goes, and everything else is listed with its reason. A Feature goes only with at least one of its use cases,
 * and a use case whose new Feature can't be created stays behind rather than arriving without its parent.
 */
export function publishScope(plan: DeliveryPlan): PublishScope {
  const reasons = new Map<string, string>();
  const stop = (itemId: string, reason: string) => {
    if (!reasons.has(itemId)) reasons.set(itemId, reason);
  };
  for (const issue of plan.issues)
    if (issue.severity === "blocking")
      for (const id of issueTargets(plan, issue)) stop(id, issue.message);
  for (const d of plan.decisions)
    if (d.blocking && !d.resolution)
      for (const item of plan.items)
        if (d.itemId === item.id || (d.typeId && d.typeId === item.typeId))
          stop(item.id, `Answer "${d.question}"`);
  const send: string[] = [];
  const unchanged: string[] = [];
  const notSent: PublishScope["notSent"] = [];
  const groups = plan.items.filter((i) => i.role === "group");
  const others = plan.items.filter((i) => i.role !== "group");
  const groupOk = new Map<string, boolean>();
  for (const g of groups)
    groupOk.set(
      g.id,
      g.operation !== "create" || (!!g.typeId && !reasons.has(g.id)),
    );
  for (const item of others) {
    const parent = item.parentItemId
      ? plan.items.find((i) => i.id === item.parentItemId)
      : undefined;
    if (item.operation === "keep") unchanged.push(item.id);
    else if (item.operation === "update") {
      // Only what the comparison says to send; team edits and fields waiting for an answer are not.
      if (reasons.has(item.id))
        notSent.push({ itemId: item.id, reason: reasons.get(item.id)! });
      else if (!item.comparisons || item.existing?.remoteRev === undefined)
        notSent.push({
          itemId: item.id,
          reason:
            "Its work item couldn't be read from the destination, so it can't be compared yet. Plan again.",
        });
      else if (item.fields.some((f) => f.updateAction === "send"))
        send.push(item.id);
      else unchanged.push(item.id);
    } else if (!item.typeId)
      notSent.push({
        itemId: item.id,
        reason: reasons.get(item.id) ?? "Its type isn't decided yet.",
      });
    else if (reasons.has(item.id))
      notSent.push({ itemId: item.id, reason: reasons.get(item.id)! });
    else if (parent && !groupOk.get(parent.id))
      notSent.push({
        itemId: item.id,
        reason: `Its parent "${parent.title}" can't be created: ${reasons.get(parent.id) ?? "its type isn't decided yet."}`,
      });
    else send.push(item.id);
  }
  for (const g of groups) {
    if (g.operation !== "create") {
      unchanged.push(g.id);
      continue;
    }
    const children = others.filter((i) => i.parentItemId === g.id);
    if (!groupOk.get(g.id))
      notSent.push({
        itemId: g.id,
        reason: reasons.get(g.id) ?? "Its type isn't decided yet.",
      });
    else if (!children.some((c) => send.includes(c.id)))
      notSent.push({
        itemId: g.id,
        reason: "None of its use cases can be sent in this run.",
      });
    else send.unshift(g.id);
  }
  return {
    send,
    unchanged,
    notSent,
    assumptions: plan.decisions.filter((d) => d.resolution?.assumed).length,
  };
}

/** Readiness is a pure function of issues and decisions; the model never decides it. */
export function computeReadiness(
  issues: readonly PlanIssue[],
  decisions: readonly PlanDecision[],
): PlanReadiness {
  if (issues.some((i) => i.severity === "blocking" && !i.decisionId))
    return "blocked";
  if (
    decisions.some((d) => d.blocking && !d.resolution) ||
    issues.some((i) => i.severity === "blocking")
  )
    return "needs-decisions";
  return "ready";
}
