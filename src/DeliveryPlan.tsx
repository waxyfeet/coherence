/**
 * Intelligent Delivery Mapping on the Export page: plan with AI, see a short summary, answer only the exceptions,
 * check the assumptions, open the rationale or exact payload on demand, and publish. Publishing is not an approval
 * workflow (owner, 3 Nov 2026): everything the plan can send is sent after one confirmation, and everything else is
 * listed with its reason. Only destinations unlocked on the server can be published to.
 */
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileCode2,
  RefreshCw,
  SearchCheck,
  Sparkles,
  Upload,
} from "lucide-react";
import type {
  DeliveryDecisionRequest,
  DeliveryPayloadPreview,
  DeliveryPlanRequest,
  DeliveryPlanView,
  DeliveryPublishRequest,
} from "../shared/api";
import type {
  DeliveryPlan,
  PlanDecision,
  PlannedItem,
  PublishItemResult,
  PublishRunSummary,
} from "../shared/delivery";
import { PROVENANCE_LABEL, READINESS_LABEL } from "../shared/delivery";
import type { ExternalSystem, Job, Project } from "../shared/types";
import { api, ApiError } from "./api";
import type { Attempt } from "./RealScreens";
import { Badge, Button, Modal, Toggle } from "./ui";

const SYSTEM_LABEL: Record<ExternalSystem, string> = {
  jira: "Jira",
  azdo: "Azure DevOps",
  github: "GitHub",
};

const OPERATION_LABEL: Record<PlannedItem["operation"], string> = {
  create: "New",
  update: "Update",
  keep: "No change",
};

const READINESS_TONE = {
  ready: "green",
  "needs-decisions": "amber",
  blocked: "red",
} as const;

const OUTCOME: Record<
  PublishItemResult["outcome"],
  { label: string; tone: "green" | "blue" | "amber" | "red" | "neutral" }
> = {
  created: { label: "Created", tone: "green" },
  updated: { label: "Updated", tone: "green" },
  reused: { label: "Found and recorded", tone: "green" },
  unchanged: { label: "Already there", tone: "neutral" },
  refused: { label: "Refused", tone: "red" },
  uncertain: { label: "Needs checking", tone: "amber" },
  "not-sent": { label: "Not sent", tone: "neutral" },
};

function excerpt(value: unknown, max = 140): string {
  const text = Array.isArray(value)
    ? value.join(", ")
    : value === null
      ? "—"
      : String(value);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function planHeadline(plan: DeliveryPlan): string {
  const types = new Map<string, number>();
  for (const item of plan.items)
    types.set(item.typeName, (types.get(item.typeName) ?? 0) + 1);
  const parts = [...types].map(([name, n]) => `${n} ${name}`);
  return parts.length
    ? parts.join(" · ")
    : "No items — select use cases to plan";
}

function answerLabel(decision: PlanDecision): string {
  const value = decision.resolution?.value ?? "";
  return (
    decision.options.find((o) => o.value === value)?.label ??
    value.replace(/^text:/, "")
  );
}

function DecisionCard({
  decision,
  onAnswer,
}: {
  decision: PlanDecision;
  onAnswer: (request: DeliveryDecisionRequest) => void;
}) {
  const [choice, setChoice] = useState(
    decision.resolution?.value ?? decision.suggestion?.value ?? "",
  );
  const [text, setText] = useState("");
  // Remembering an answer for every later plan is a deliberate choice, never the default.
  const [remember, setRemember] = useState(false);
  const suggested = decision.options.find(
    (o) => o.value === decision.suggestion?.value,
  );
  return (
    <div className="delivery-decision">
      <strong>{decision.question}</strong>
      {decision.suggestion && (
        <small className="field-hint">
          <Sparkles size={12} /> {suggested?.label ?? decision.suggestion.value}{" "}
          — {decision.suggestion.provenance.label}
          {decision.suggestion.provenance.rationale
            ? `: ${decision.suggestion.provenance.rationale}`
            : ""}
        </small>
      )}
      <div className="delivery-decision-controls">
        <select
          aria-label={decision.question}
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
        >
          <option value="">Choose…</option>
          {decision.options.map((o) => (
            <option key={o.value} value={o.value} title={o.detail}>
              {o.label}
            </option>
          ))}
          {decision.allowsText && <option value="text">Type a value…</option>}
        </select>
        {choice === "text" && (
          <input
            aria-label="Value"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Value"
          />
        )}
        <Button
          compact
          disabled={!choice || (choice === "text" && !text.trim())}
          onClick={() =>
            onAnswer({
              decisionId: decision.id,
              value: choice === "text" ? `text:${text.trim()}` : choice,
              saveAsRule: remember,
            })
          }
        >
          Confirm
        </Button>
      </div>
      {!decision.itemId && (
        <label className="delivery-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Remember for future plans to this destination
        </label>
      )}
    </div>
  );
}

function ItemRow({
  item,
  status,
  onPreview,
}: {
  item: PlannedItem;
  status?: { label: string; tone: "neutral" | "amber"; detail?: string };
  onPreview: (item: PlannedItem) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`delivery-item ${item.role}`}>
      <div className="inline-between">
        <span>
          <small>
            {item.typeName || "Type to be decided"}
            {item.existing ? ` · ${item.existing.key}` : ""}
          </small>
          <strong>{item.title}</strong>
          {status?.detail && (
            <span className="delivery-item-reason">{status.detail}</span>
          )}
        </span>
        <span className="delivery-item-actions">
          <Badge
            tone={
              status?.tone ??
              (item.operation === "create"
                ? "blue"
                : item.operation === "update"
                  ? "amber"
                  : "neutral")
            }
          >
            {status?.label ?? OPERATION_LABEL[item.operation]}
          </Badge>
          <Button
            compact
            variant="ghost"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            Why?
          </Button>
          <button
            className="icon-button"
            aria-label={`Preview ${item.title} payload`}
            onClick={() => onPreview(item)}
            disabled={!item.typeId}
          >
            <FileCode2 size={15} />
          </button>
        </span>
      </div>
      {open && (
        <div className="delivery-item-details">
          <p>{item.rationale}</p>
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>Value</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {item.fields.map((f) => (
                <tr key={f.fieldId}>
                  <td>{f.fieldName}</td>
                  <td>
                    {excerpt(f.value)}
                    {f.substitution && (
                      <small className="field-hint">{f.substitution}</small>
                    )}
                    {f.updateAction && f.updateAction !== "send" && (
                      <small className="field-hint">
                        {f.updateAction === "unchanged"
                          ? "Already matches — not sent"
                          : f.updateAction === "keep-destination"
                            ? "Destination value kept"
                            : "Waiting for your decision"}
                      </small>
                    )}
                  </td>
                  <td title={PROVENANCE_LABEL[f.provenance.kind]}>
                    {f.provenance.label}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Azure DevOps ids read as "#4711"; Jira keys ("POR-12") as they are. */
function keyLabel(key: string): string {
  return /^\d+$/.test(key) ? `#${key}` : key;
}

function counts(plan: DeliveryPlan, send: string[]) {
  const updates = send.filter(
    (id) => plan.items.find((i) => i.id === id)?.operation === "update",
  ).length;
  return { creates: send.length - updates, updates };
}

/** "3 new work items and 2 updates" */
function sendSummary(plan: DeliveryPlan, send: string[]): string {
  const { creates, updates } = counts(plan, send);
  return [
    creates ? `${creates} new work item${creates === 1 ? "" : "s"}` : "",
    updates ? `${updates} update${updates === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" and ");
}

/** The confirmation's button: "Create 3 work items", "Update 2 work items" or "Publish 5 changes". */
function publishLabel(plan: DeliveryPlan, send: string[]): string {
  const { creates, updates } = counts(plan, send);
  const n = (k: number) => `${k} work item${k === 1 ? "" : "s"}`;
  return updates && creates
    ? `Publish ${creates + updates} changes`
    : updates
      ? `Update ${n(updates)}`
      : `Create ${n(creates)}`;
}

/** The last publish or check: what happened to each item, with links to the work items. */
export function PublishResults({ run }: { run: PublishRunSummary }) {
  const [copied, setCopied] = useState(false);
  const made = run.items.filter(
    (i) =>
      i.key &&
      (i.outcome === "created" ||
        i.outcome === "updated" ||
        i.outcome === "reused"),
  );
  const shown = run.items.filter((i) => i.outcome !== "unchanged");
  const added = run.links.filter((l) => l.outcome === "added").length;
  const failedLinks = run.links.filter(
    (l) => l.outcome === "refused" || l.outcome === "uncertain",
  );
  return (
    <section className="delivery-results" aria-label="Last publish">
      <div className="inline-between">
        <span className="section-kicker">
          LAST RUN · {run.destination} ·{" "}
          {run.finishedAt.slice(0, 16).replace("T", " ")}
        </span>
        <Badge tone={run.status === "completed" ? "green" : "amber"} dot>
          {run.status === "completed" ? "Completed" : "Stopped early"}
        </Badge>
      </div>
      {run.message && <p className="field-hint">{run.message}</p>}
      {shown.map((item) => (
        <div className="delivery-result-row" key={item.itemId}>
          <span>
            <strong>{item.title}</strong>
            {item.message && <small>{item.message}</small>}
          </span>
          <span className="delivery-item-actions">
            {item.key && item.url && (
              <a href={item.url} target="_blank" rel="noreferrer noopener">
                {keyLabel(item.key)} <ExternalLink size={11} />
              </a>
            )}
            <Badge tone={OUTCOME[item.outcome].tone}>
              {OUTCOME[item.outcome].label}
            </Badge>
          </span>
        </div>
      ))}
      {(added > 0 || failedLinks.length > 0) && (
        <p className="field-hint">
          {added} dependency link(s) added.
          {failedLinks.length > 0 &&
            ` ${failedLinks.length} link(s) could not be added; publishing again tries them again.`}
        </p>
      )}
      {made.length > 0 && (
        <Button
          compact
          variant="ghost"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(made.map((i) => keyLabel(i.key!)).join(", "))
              .then(() => setCopied(true))
          }
        >
          <Copy size={13} /> {copied ? "Copied" : `Copy ${made.length} IDs`}
        </Button>
      )}
    </section>
  );
}

/** Presentational plan view (rendered statically in tests). */
export function DeliveryPlanSummary({
  view,
  busy = false,
  onAnswer,
  onPreview,
  onAttachment,
  onPublish,
  onCheck,
}: {
  view: DeliveryPlanView;
  busy?: boolean;
  onAnswer: (request: DeliveryDecisionRequest) => void;
  onPreview: (item: PlannedItem) => void;
  onAttachment: (attachmentId: string, include: boolean) => void;
  onPublish: () => void;
  onCheck: () => void;
}) {
  const { plan, stale, publishing } = view;
  const label = SYSTEM_LABEL[plan.system];
  const [showNotes, setShowNotes] = useState(false);
  const [showAssumed, setShowAssumed] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const blocking = plan.issues.filter(
    (i) => i.severity === "blocking" && !i.decisionId,
  );
  const open = plan.decisions.filter((d) => !d.resolution);
  const assumed = plan.decisions.filter((d) => d.resolution?.assumed);
  const notes = plan.issues.filter(
    (i) => i.severity !== "blocking" && !i.id.startsWith("assumed:"),
  );
  const answered = plan.decisions.filter(
    (d) => d.resolution && !d.resolution.assumed,
  );
  const notSent = new Map(
    publishing.scope.notSent.map((n) => [n.itemId, n.reason]),
  );
  const statusOf = (item: PlannedItem) =>
    notSent.has(item.id)
      ? {
          label: "Not sent",
          tone: "amber" as const,
          detail: notSent.get(item.id),
        }
      : item.operation === "keep" && item.existing
        ? { label: `Already in ${label}`, tone: "neutral" as const }
        : undefined;
  return (
    <div className="delivery-plan">
      <div className="inline-between">
        <div>
          <span className="section-kicker">
            DELIVERY PLAN · {plan.destination.label}
          </span>
          <h3>{planHeadline(plan)}</h3>
        </div>
        <Badge tone={READINESS_TONE[plan.readiness]} dot>
          {READINESS_LABEL[plan.readiness]}
        </Badge>
      </div>
      {stale.length > 0 && (
        <p className="delivery-stale" role="status">
          <RefreshCw size={13} /> This plan is out of date: {stale.join(" ")}{" "}
          Plan again.
        </p>
      )}
      <p className="field-hint">
        {plan.summary.creates} new · {plan.summary.updates} updates ·{" "}
        {plan.summary.relationships} links · {plan.summary.blocking} problem(s)
        · {open.length} open question(s) · {assumed.length} assumption(s).{" "}
        {plan.ai.message ?? (plan.ai.requested ? "" : "Planned without AI.")}
      </p>

      {blocking.length > 0 && (
        <section aria-label="Problems to fix">
          <span className="section-kicker">
            PROBLEMS (THESE ITEMS STAY BEHIND)
          </span>
          {blocking.map((i) => (
            <p className="delivery-problem" key={i.id}>
              <AlertTriangle size={13} /> {i.message}
            </p>
          ))}
        </section>
      )}

      {open.length > 0 && (
        <section aria-label="Decisions">
          <span className="section-kicker">YOUR DECISIONS ({open.length})</span>
          {open.map((d) => (
            <DecisionCard key={d.id} decision={d} onAnswer={onAnswer} />
          ))}
        </section>
      )}

      {assumed.length > 0 && (
        <section aria-label="Assumptions">
          <div className="inline-between">
            <span className="section-kicker">
              ASSUMED ({assumed.length}) · CHANGE ANY THAT ARE WRONG
            </span>
            <Button
              compact
              variant="ghost"
              onClick={() => setShowAssumed((v) => !v)}
              aria-expanded={showAssumed}
            >
              {showAssumed ? "Hide" : "Review"}
            </Button>
          </div>
          {!showAssumed && (
            <p className="field-hint">
              {assumed
                .slice(0, 3)
                .map((d) => `${answerLabel(d)} (${d.question})`)
                .join(" · ")}
              {assumed.length > 3 ? ` · and ${assumed.length - 3} more` : ""}
            </p>
          )}
          {showAssumed &&
            assumed.map((d) => (
              <DecisionCard key={d.id} decision={d} onAnswer={onAnswer} />
            ))}
        </section>
      )}

      <section aria-label="Planned items">
        <span className="section-kicker">WHAT WOULD BE SENT</span>
        {plan.items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            status={statusOf(item)}
            onPreview={onPreview}
          />
        ))}
      </section>

      {plan.attachments.length > 0 && (
        <section aria-label="Screenshots">
          <span className="section-kicker">
            SCREENSHOTS (NOT SENT IN THIS VERSION)
          </span>
          {plan.attachments.map((a) => (
            <Toggle
              key={a.id}
              label={`${a.screenName} → ${a.itemId.replace(/^uc:/, "")}`}
              description={a.note}
              checked={a.include}
              onChange={(include) => onAttachment(a.id, include)}
            />
          ))}
        </section>
      )}

      {(notes.length > 0 || answered.length > 0) && (
        <Button
          compact
          variant="ghost"
          onClick={() => setShowNotes((v) => !v)}
          aria-expanded={showNotes}
        >
          {showNotes ? "Hide" : "Show"} notes and answered decisions (
          {notes.length + answered.length})
        </Button>
      )}
      {showNotes && (
        <div className="delivery-notes">
          {notes.map((i) => (
            <p key={i.id}>
              <Badge tone={i.severity === "warning" ? "amber" : "neutral"}>
                {i.severity}
              </Badge>{" "}
              {i.message}
            </p>
          ))}
          {answered.map((d) => (
            <p key={d.id}>
              <CheckCircle2 size={12} /> {d.question}{" "}
              <strong>{answerLabel(d)}</strong>
              <Button
                compact
                variant="ghost"
                onClick={() => onAnswer({ decisionId: d.id, value: null })}
              >
                Change
              </Button>
            </p>
          ))}
        </div>
      )}

      <Button
        compact
        variant="ghost"
        onClick={() => setShowDiagnostics((v) => !v)}
        aria-expanded={showDiagnostics}
      >
        {showDiagnostics ? "Hide" : "Show"} destination details
      </Button>
      {showDiagnostics && (
        <div className="delivery-notes">
          <p>
            Structure read {plan.destination.discoveredAt.slice(0, 10)} ·
            fingerprint{" "}
            <code>{plan.destination.schemaFingerprint.slice(0, 12)}</code> ·
            format {plan.destination.textFormat}
          </p>
          {plan.destination.capabilities.map((c) => (
            <p key={c.id}>
              <Badge
                tone={
                  c.state === "supported"
                    ? "green"
                    : c.state === "unsupported"
                      ? "red"
                      : "neutral"
                }
              >
                {c.state}
              </Badge>{" "}
              {c.note}
            </p>
          ))}
          {plan.ai.usage && (
            <p>
              AI: {plan.ai.connection} · {plan.ai.usage.inputTokens} in /{" "}
              {plan.ai.usage.outputTokens} out tokens
            </p>
          )}
        </div>
      )}

      <div className="delivery-publish">
        {publishing.enabled ? (
          <>
            <div className="delivery-publish-actions">
              <Button
                variant="primary"
                disabled={busy || !!publishing.blockedReason}
                onClick={onPublish}
              >
                <Upload size={14} /> Publish to {label}…
              </Button>
              {publishing.needsCheck > 0 && (
                <Button disabled={busy} onClick={onCheck}>
                  <SearchCheck size={14} /> Check {label}
                </Button>
              )}
            </div>
            <p className="field-hint">
              {publishing.blockedReason ??
                `${sendSummary(plan, publishing.scope.send)} would be sent${
                  publishing.scope.notSent.length
                    ? `; ${publishing.scope.notSent.length} stay behind (reasons above)`
                    : ""
                }. You confirm before anything is sent.`}
            </p>
          </>
        ) : (
          <p className="field-hint">{publishing.blockedReason}</p>
        )}
      </div>

      {publishing.lastRun && <PublishResults run={publishing.lastRun} />}
    </div>
  );
}

/** What the confirmation lists: what will be created where, what stays behind and what was assumed. */
export function PublishConfirmation({
  view,
  destination,
}: {
  view: DeliveryPlanView;
  destination: string;
}) {
  const { plan, publishing } = view;
  const label = SYSTEM_LABEL[plan.system];
  const items = new Map(plan.items.map((i) => [i.id, i]));
  const byType = new Map<string, number>();
  const updates = publishing.scope.send.filter(
    (id) => items.get(id)?.operation === "update",
  );
  for (const id of publishing.scope.send) {
    if (updates.includes(id)) continue;
    const type = items.get(id)?.typeName ?? "";
    byType.set(type, (byType.get(type) ?? 0) + 1);
  }
  const assumed = plan.decisions.filter((d) => d.resolution?.assumed);
  const screenshots = plan.attachments.filter((a) => a.include).length;
  return (
    <div className="delivery-confirm">
      <p className="delivery-confirm-destination">
        <span className="section-kicker">{label}</span>
        <strong>{destination}</strong>
      </p>
      {byType.size > 0 && (
        <p>
          <strong>Create:</strong>{" "}
          {[...byType].map(([type, n]) => `${n} × ${type}`).join(" · ")}
        </p>
      )}
      {updates.length > 0 && (
        <div>
          <strong>Update ({updates.length}):</strong> only the fields changed in
          Coherence; edits the team made in {label} are kept.
          <ul>
            {updates.slice(0, 8).map((id) => {
              const item = items.get(id)!;
              return (
                <li key={id}>
                  {keyLabel(item.existing?.key ?? "")} {item.title}:{" "}
                  {item.fields
                    .filter((f) => f.updateAction === "send")
                    .map((f) => f.fieldName)
                    .join(", ")}
                </li>
              );
            })}
            {updates.length > 8 && <li>and {updates.length - 8} more</li>}
          </ul>
        </div>
      )}
      {publishing.scope.unchanged.length > 0 && (
        <p>
          <strong>Already there:</strong> {publishing.scope.unchanged.length}{" "}
          item(s); nothing is sent for them.
        </p>
      )}
      {publishing.scope.notSent.length > 0 && (
        <div>
          <strong>Stay behind ({publishing.scope.notSent.length}):</strong>
          <ul>
            {publishing.scope.notSent.slice(0, 8).map((n) => (
              <li key={n.itemId}>
                {items.get(n.itemId)?.title ?? n.itemId}: {n.reason}
              </li>
            ))}
            {publishing.scope.notSent.length > 8 && (
              <li>and {publishing.scope.notSent.length - 8} more</li>
            )}
          </ul>
        </div>
      )}
      {assumed.length > 0 && (
        <p>
          <strong>Assumed ({assumed.length}):</strong>{" "}
          {assumed
            .map((d) => `${answerLabel(d)} for "${d.question}"`)
            .join(" · ")}
        </p>
      )}
      {screenshots > 0 && (
        <p className="field-hint">
          Screenshots aren't sent in this version; {screenshots} included
          screenshot(s) stay in Coherence.
        </p>
      )}
      {plan.system === "azdo" ? (
        <p className="field-hint">
          Coherence first asks {label} to check every item without saving it,
          and leaves behind anything {label} would refuse. If {label} still
          refuses an item while saving, the items already created stay and are
          listed. Coherence never deletes, closes or reassigns anything, and
          only adds tags.
        </p>
      ) : (
        <p className="field-hint">
          {label} can't check an issue without saving it, so a refusal shows up
          while publishing: the issues already created stay and are listed, and
          a{" "}
          {plan.system === "jira"
            ? "refused Epic"
            : "milestone that can't be created"}{" "}
          keeps its {plan.system === "jira" ? "stories" : "issues"} back.
          Coherence never deletes, closes or assigns anything, and only adds
          labels.
        </p>
      )}
    </div>
  );
}

export function DeliveryPlanPanel({
  project,
  target,
  configured,
  destination,
  useCaseIds,
  onJob,
  attempt,
  job,
}: {
  project: Project;
  target: ExternalSystem;
  configured: boolean;
  /** Where publishing writes, as configured ("https://dev.azure.com/acme · Portal"). */
  destination: string;
  /** The use cases selected on the Export page; drafts are planned too (flagged). */
  useCaseIds: string[];
  onJob: (path: string, body: unknown) => Promise<void>;
  attempt: Attempt;
  job: Job | null;
}) {
  const [view, setView] = useState<DeliveryPlanView | null>(null);
  const [preview, setPreview] = useState<DeliveryPayloadPreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [refresh, setRefresh] = useState(false);
  const base = `/projects/${project.id}/delivery/plans`;
  const label = SYSTEM_LABEL[target];

  async function load() {
    try {
      setView(await api<DeliveryPlanView>(`${base}/${target}`));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setView(null);
      else throw err;
    }
  }
  useEffect(() => {
    setView(null);
    if (configured) void attempt(load);
  }, [project.id, target, configured]);
  const ours =
    job?.projectId === project.id &&
    (job.kind === "delivery-plan" || job.kind === "delivery-publish");
  const finished =
    ours && ["succeeded", "failed", "cancelled"].includes(job.status)
      ? job.id
      : undefined;
  useEffect(() => {
    if (finished) void attempt(load);
  }, [finished]);
  const running = ours && ["queued", "running"].includes(job.status);

  function start(useAi: boolean) {
    const body: DeliveryPlanRequest = {
      target,
      useAi,
      ...(useCaseIds.length ? { useCaseIds } : {}),
      includeUnapproved: true,
      refreshDestination: refresh,
    };
    void onJob(base, body);
  }

  function publish() {
    if (!view) return;
    setConfirming(false);
    const body: DeliveryPublishRequest = {
      revision: view.plan.revision,
      fingerprint: view.fingerprint,
    };
    void onJob(`${base}/${target}/publish`, body);
  }

  const sending = view?.publishing.scope.send.length ?? 0;
  return (
    <section className="real-panel delivery-panel">
      <div className="inline-between">
        <div>
          <span className="section-kicker">INTELLIGENT DELIVERY MAPPING</span>
          <h2>Plan the hand-off, then publish.</h2>
          <p className="field-hint">
            Coherence reads how this destination is set up (read-only), maps the
            selected use cases to its work item types and fields, and asks you
            only about what it cannot work out. Where it has a good guess it
            assumes it, and shows you so you can change it.
          </p>
        </div>
      </div>
      <div className="delivery-start">
        <Button
          variant="primary"
          disabled={!configured || running || !useCaseIds.length}
          onClick={() => start(true)}
        >
          <Sparkles size={14} /> Plan with AI
        </Button>
        <Button
          disabled={!configured || running || !useCaseIds.length}
          onClick={() => start(false)}
        >
          Plan without AI
        </Button>
        <Toggle
          label="Re-read destination"
          description="Read the destination's structure again instead of the saved snapshot."
          checked={refresh}
          onChange={setRefresh}
        />
      </div>
      <p className="field-hint">
        {useCaseIds.length
          ? `${useCaseIds.length} selected use case(s) are planned, drafts included (they are flagged). `
          : "Select use cases above to plan them. "}
        AI uses this project's writing model and may use tokens; field values
        are never invented.
      </p>
      {!configured && (
        <p className="field-hint">
          Set up this destination in Settings → Integrations first.
        </p>
      )}
      {view && (
        <DeliveryPlanSummary
          view={view}
          busy={running}
          onAnswer={(request) =>
            void attempt(async () =>
              setView(
                await api<DeliveryPlanView>(
                  `${base}/${target}/decisions`,
                  "POST",
                  request,
                ),
              ),
            )
          }
          onAttachment={(attachmentId, include) =>
            void attempt(async () =>
              setView(
                await api<DeliveryPlanView>(
                  `${base}/${target}/attachments`,
                  "POST",
                  { attachmentId, include },
                ),
              ),
            )
          }
          onPublish={() => setConfirming(true)}
          onCheck={() => void onJob(`${base}/${target}/check`, {})}
          onPreview={(item) =>
            void attempt(async () =>
              setPreview(
                await api<DeliveryPayloadPreview>(
                  `${base}/${target}/items/${encodeURIComponent(item.id)}/preview`,
                ),
              ),
            )
          }
        />
      )}
      <Modal
        open={confirming && !!view}
        onClose={() => setConfirming(false)}
        title={`Publish to ${label}`}
        description="This writes to your real work items. It can't be undone from Coherence."
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="primary" disabled={!sending} onClick={publish}>
              <Upload size={14} />{" "}
              {view ? publishLabel(view.plan, view.publishing.scope.send) : ""}
            </Button>
          </>
        }
      >
        {view && <PublishConfirmation view={view} destination={destination} />}
      </Modal>
      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        title={`${preview?.itemId ?? ""} · payload preview`}
        description="Exactly what publishing sends; work items that don't exist yet appear as {{item}}."
        wide
      >
        <p className="section-kicker">
          {preview?.request} · {preview?.format}
        </p>
        {preview?.notes.map((n) => (
          <p className="field-hint" key={n}>
            {n}
          </p>
        ))}
        <pre className="real-payload">
          {JSON.stringify(preview?.body, null, 2)}
        </pre>
        {preview?.relationships.map((r) => (
          <div key={r.description}>
            <span className="section-kicker">{r.description}</span>
            <pre className="real-payload">
              {JSON.stringify(r.body, null, 2)}
            </pre>
          </div>
        ))}
      </Modal>
    </section>
  );
}
