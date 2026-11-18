import { downloadPrivate } from "./localSession";
import { PrivateImage } from "./PrivateImage";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Download,
  FileCode2,
  GitBranch,
  Layers2,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react";
import type {
  ChangeRequest,
  DeterministicImpact,
  ExportPreview,
  ExportResult,
  ExternalSystem,
  ImpactReport,
  Job,
  Project,
  PublicSettings,
  SolutionModel,
  SolutionGraph,
} from "../shared/types";
import type { SettingsData } from "./data";
import type { Attempt } from "./RealScreens";
import { api } from "./api";
import { OFFLINE_MODEL_ID } from "../shared/modelSelection";
import { visibleModels } from "../shared/modelCatalogue";
import { projectConnectionChoices } from "../shared/generationContext";
import { linkBelongsToTarget } from "../server/export/target";
import { DeliveryPlanPanel } from "./DeliveryPlan";
import {
  Badge,
  Button,
  Field,
  Modal,
  Picker,
  SectionHeading,
  Toggle,
} from "./ui";
type JobAction = (path: string, body: unknown) => Promise<void>;
export function RealChanges({
  graph,
  project,
  model,
  reports,
  settings,
  onJob,
  attempt,
  onRefresh,
  onCase,
  initialChange,
}: {
  graph: SolutionGraph;
  project: Project;
  model: SolutionModel | null;
  reports: ImpactReport[];
  settings: SettingsData;
  onJob: JobAction;
  attempt: Attempt;
  onRefresh: () => Promise<void>;
  onCase: (id: string) => void;
  initialChange?: ChangeRequest;
}) {
  const [description, setDescription] = useState(
    initialChange?.description ?? "",
  );
  const [targetKind, setTargetKind] = useState<string>(
    initialChange?.targetKind ?? "free",
  );
  const [targetId, setTargetId] = useState(initialChange?.targetId ?? "");
  const [trace, setTrace] = useState<DeterministicImpact | null>(null);
  const [selectedId, setSelectedId] = useState(reports[0]?.id ?? "");
  const [selected, setSelected] = useState<string[]>([]);
  const [connection, setConnection] = useState(
    projectConnectionChoices(project, model?.options).textConnectionId ??
      settings.textId,
  );
  const [modelId, setModelId] = useState(
    projectConnectionChoices(project, model?.options).textModelId ??
      (settings.connections.find((c) => c.id === connection)?.provider ===
      "mock"
        ? OFFLINE_MODEL_ID
        : ""),
  );
  const configuredConnection = settings.connections.find(
    (c) => c.id === connection,
  );
  const modelIds =
    configuredConnection?.provider === "mock"
      ? [OFFLINE_MODEL_ID]
      : (configuredConnection?.modelIds ?? []);
  const modelAvailable = !!configuredConnection && modelIds.includes(modelId);
  const ordinaryIds =
    configuredConnection?.provider === "mock"
      ? [OFFLINE_MODEL_ID]
      : configuredConnection
        ? visibleModels(configuredConnection)
        : [];
  const [confirmApply, setConfirmApply] = useState(false);
  const [compareScreen, setCompareScreen] = useState(false);
  const report = reports.find((r) => r.id === selectedId) ?? reports[0];
  const pendingItems =
    report?.items.filter(
      (i) => !(report.appliedUseCaseIds ?? []).includes(i.useCaseId),
    ) ?? [];
  useEffect(() => {
    if (!reports.some((r) => r.id === selectedId))
      setSelectedId(reports[0]?.id ?? "");
  }, [reports]);
  useEffect(() => {
    setSelected(pendingItems.map((i) => i.useCaseId));
  }, [report?.id, report?.status, report?.appliedUseCaseIds?.join(",")]);
  useEffect(() => {
    setTrace(null);
  }, [description, targetKind, targetId]);
  const targets =
    targetKind === "screen"
      ? project.screens.map((s) => ({ value: s.id, label: s.name }))
      : targetKind === "usecase"
        ? (model?.useCases ?? []).map((u) => ({
            value: u.id,
            label: u.id + " · " + u.title,
          }))
        : targetKind === "element"
          ? (model?.screens ?? []).flatMap((s) =>
              s.elements.map((e) => ({ value: e.id, label: e.label || e.key })),
            )
          : graph.nodes
              .filter((n) => n.kind === targetKind)
              .map((n) => ({ value: n.id, label: n.label }));
  const change: ChangeRequest = {
    targetKind: targetKind as ChangeRequest["targetKind"],
    targetId: targetId || undefined,
    description,
    source: "manual",
  };
  return (
    <div className="workspace-page real-changes-page">
      <SectionHeading
        eyebrow="CHANGE, WITH CONTEXT"
        title="Understand the ripple."
        description="Trace a change through evidence, dependencies and the requirements your team relies on."
      />
      <div className="real-changes-layout">
        <section className="real-change-composer real-panel">
          <span className="section-kicker">A NEW CHANGE</span>
          <h2>What is changing?</h2>
          <Field label="Start from">
            <Picker
              label="Change target kind"
              value={targetKind}
              onChange={(v) => {
                setTargetKind(v);
                setTargetId("");
              }}
              options={[
                { value: "free", label: "A description of the change" },
                { value: "screen", label: "A screenshot" },
                { value: "usecase", label: "A use case" },
                { value: "element", label: "A visible UI element" },
                { value: "region", label: "A screen region" },
                { value: "rule", label: "A business rule" },
                { value: "scenario", label: "A scenario" },
                { value: "persona", label: "A persona" },
                { value: "feature", label: "A feature" },
              ]}
            />
          </Field>
          {targetKind !== "free" && (
            <Field label="Evidence target">
              <Picker
                label="Evidence target"
                value={targetId || "_choose"}
                onChange={setTargetId}
                options={[
                  { value: "_choose", label: "Choose a target…" },
                  ...targets,
                ]}
              />
            </Field>
          )}
          <Field label="Describe the change" htmlFor="change-description">
            <textarea
              id="change-description"
              rows={6}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="For example, require approval before a large order can be fulfilled…"
            />
          </Field>
          <Field label="Impact analyst">
            <Picker
              label="Impact analyst"
              value={connection}
              onChange={(id) => {
                setConnection(id);
                setModelId(
                  settings.connections.find((c) => c.id === id)?.provider ===
                    "mock"
                    ? OFFLINE_MODEL_ID
                    : "",
                );
              }}
              options={[
                ...settings.connections.map((c) => ({
                  value: c.id,
                  label: c.name,
                  detail:
                    c.provider === "mock"
                      ? "Built-in simulation"
                      : "Provider connection",
                })),
                ...(connection && !configuredConnection
                  ? [
                      {
                        value: connection,
                        label: "Connection unavailable — choose again",
                      },
                    ]
                  : []),
              ]}
            />
          </Field>
          <Field label="Impact model ID">
            <Picker
              value={modelId}
              onChange={setModelId}
              label="Impact model ID"
              placeholder="Choose an exact model"
              disabled={
                !configuredConnection ||
                configuredConnection.provider === "mock"
              }
              options={[
                ...ordinaryIds.map((value) => ({ value, label: value })),
                ...(modelId && !ordinaryIds.includes(modelId)
                  ? [
                      {
                        value: modelId,
                        label: modelAvailable
                          ? modelId
                          : `${modelId} · unavailable, choose again`,
                      },
                    ]
                  : []),
              ]}
            />
          </Field>
          <p className="field-hint">
            {settings.connections.find((c) => c.id === connection)?.provider ===
            "mock"
              ? "Offline impact uses deterministic fixture reasoning. It does not run a real AI model."
              : "Analysis sends relevant project requirements to your selected model."}
          </p>
          <div className="real-button-row">
            <Button
              disabled={!model || (targetKind !== "free" && !targetId)}
              onClick={() =>
                void attempt(async () =>
                  setTrace(
                    await api<DeterministicImpact>(
                      `/projects/${project.id}/impact/preview`,
                      "POST",
                      change,
                    ),
                  ),
                )
              }
            >
              <GitBranch size={14} />
              Trace connections
            </Button>
            <Button
              variant="primary"
              disabled={
                !model ||
                !modelAvailable ||
                description.trim().length < 3 ||
                (targetKind !== "free" && !targetId)
              }
              onClick={() =>
                void onJob(`/projects/${project.id}/impact`, {
                  change,
                  connectionId: connection,
                  modelId,
                })
              }
            >
              <Sparkles size={14} />
              Analyse impact
            </Button>
          </div>
          {trace && (
            <div className="real-trace">
              <span className="section-kicker">
                DETERMINISTIC TRACE · NO AI
              </span>
              {[
                ["Direct", trace.directUseCaseIds],
                ["Downstream", trace.downstreamUseCaseIds],
                ["Upstream", trace.upstreamUseCaseIds],
                ["Related", trace.relatedUseCaseIds],
              ].map(([label, ids]) => (
                <div key={label as string}>
                  <strong>{label}</strong>
                  <span>{(ids as string[]).join(", ") || "None"}</span>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="real-impact-panel">
          <div className="real-report-tabs">
            {reports.length ? (
              reports.map((r) => (
                <button
                  key={r.id}
                  className={report?.id === r.id ? "selected" : ""}
                  onClick={() => setSelectedId(r.id)}
                >
                  <GitBranch size={14} />
                  <span>
                    {r.change.description.slice(0, 55)}
                    <small>{new Date(r.createdAt).toLocaleString()}</small>
                  </span>
                  <Badge>{r.status.replaceAll("-", " ")}</Badge>
                </button>
              ))
            ) : (
              <div className="real-panel">
                <span className="section-kicker">IMPACT REPORTS</span>
                <h2>See the consequences before you commit.</h2>
                <p className="muted">
                  A report explains direct, downstream, upstream and related
                  effects. You choose which use cases to update.
                </p>
              </div>
            )}
          </div>
          {report && (
            <>
              <div className="real-panel real-report-heading">
                <div className="inline-between">
                  <Badge
                    tone={report.status === "discarded" ? "neutral" : "accent"}
                  >
                    {report.status}
                  </Badge>
                  <span className="small muted">{report.analysedBy}</span>
                </div>
                <h2>{report.summary}</h2>
                <p>{report.change.description}</p>
                {report.change.screenDiff && (
                  <div className="screen-change-summary">
                    <span className="section-kicker">
                      SCREEN EVIDENCE · V{report.change.screenDiff.fromVersion}{" "}
                      → V{report.change.screenDiff.toVersion}
                    </span>
                    <div className="real-button-row">
                      <Badge tone="green">
                        {report.change.screenDiff.added.length} added
                      </Badge>
                      <Badge tone="amber">
                        {report.change.screenDiff.removed.length} removed
                      </Badge>
                      <Badge>
                        {report.change.screenDiff.modified.length} modified
                      </Badge>
                      <Button compact onClick={() => setCompareScreen(true)}>
                        Compare saved versions
                      </Button>
                    </div>
                    <p>{report.change.screenDiff.summary}</p>
                    {report.change.screenDiff.modified.map((item) => (
                      <div className="screen-diff-item" key={item.after.id}>
                        <strong>{item.after.label || item.after.key}</strong>
                        <span>{item.changes.join("; ")}</span>
                      </div>
                    ))}
                  </div>
                )}
                {report.risks.length > 0 && (
                  <div className="real-risk">
                    <strong>Consider before applying</strong>
                    {report.risks.map((r, i) => (
                      <p key={i}>{r}</p>
                    ))}
                  </div>
                )}
              </div>
              <div className="real-impact-items">
                {report.items.map((item) => {
                  const applied = report.appliedUseCaseIds?.includes(
                    item.useCaseId,
                  );
                  return (
                    <div
                      className={`real-impact-item ${applied ? "applied" : ""}`}
                      key={item.useCaseId}
                    >
                      <label>
                        <input
                          type="checkbox"
                          disabled={applied || report.status === "discarded"}
                          checked={
                            selected.includes(item.useCaseId) && !applied
                          }
                          onChange={(e) =>
                            setSelected((v) =>
                              e.target.checked
                                ? [...v, item.useCaseId]
                                : v.filter((id) => id !== item.useCaseId),
                            )
                          }
                        />
                        <span>
                          <button
                            className="text-button"
                            onClick={(e) => {
                              e.preventDefault();
                              onCase(item.useCaseId);
                            }}
                          >
                            {item.useCaseId}
                            <ArrowRight size={12} />
                          </button>
                          <strong>
                            {
                              model?.useCases.find(
                                (u) => u.id === item.useCaseId,
                              )?.title
                            }
                          </strong>
                        </span>
                        <Badge
                          tone={item.severity === "high" ? "amber" : "neutral"}
                        >
                          {applied ? "Applied" : item.severity}
                        </Badge>
                      </label>
                      <div className="impact-item-copy">
                        <span className="section-kicker">
                          {item.relation} · {item.affectedSections.join(", ")}
                        </span>
                        <p>{item.reason}</p>
                        <ul>
                          {item.suggestedChanges.map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  );
                })}
              </div>
              {report.suggestedNewUseCases.length > 0 && (
                <div className="real-panel">
                  <span className="section-kicker">
                    SUGGESTED ADDITIONS · NOT CREATED
                  </span>
                  {report.suggestedNewUseCases.map((s, i) => (
                    <div key={i}>
                      <h4>{s.title}</h4>
                      <p className="muted">{s.reason}</p>
                    </div>
                  ))}
                </div>
              )}
              <div className="real-delivery-footer">
                <Button
                  disabled={
                    report.status === "discarded" || report.status === "applied"
                  }
                  onClick={() =>
                    void attempt(async () => {
                      await api(
                        `/projects/${project.id}/impact/${report.id}/discard`,
                        "POST",
                        {},
                      );
                      await onRefresh();
                    })
                  }
                >
                  Discard report
                </Button>
                <Button
                  variant="primary"
                  disabled={
                    !selected.length ||
                    report.status === "discarded" ||
                    report.status === "applied"
                  }
                  onClick={() => setConfirmApply(true)}
                >
                  <Check size={14} />
                  Review & apply {selected.length} changes
                </Button>
              </div>
            </>
          )}
        </section>
      </div>
      <Modal
        open={compareScreen}
        onClose={() => setCompareScreen(false)}
        title="Compare screenshot versions"
        description="Original saved image bytes. The difference inventory was produced by the selected analysis provider."
        wide
      >
        <div className="real-screen-comparison">
          {report?.change.screenDiff &&
            [
              report.change.screenDiff.fromVersion,
              report.change.screenDiff.toVersion,
            ].map((version) => (
              <div key={version}>
                <Badge>Version {version}</Badge>
                <PrivateImage
                  src={`/api/projects/${project.id}/screens/${report.change.screenDiff!.screenId}/image?version=${version}`}
                  alt={`Screenshot version ${version}`}
                />
              </div>
            ))}
        </div>
      </Modal>
      <Modal
        open={confirmApply}
        onClose={() => setConfirmApply(false)}
        title="Apply the selected impact changes?"
        description="The writer will update these use cases using the report’s instructions. Current files are checked against the report baseline; snapshots are kept."
        footer={
          <>
            <Button onClick={() => setConfirmApply(false)}>
              Keep reviewing
            </Button>
            <Button
              variant="primary"
              disabled={!modelAvailable}
              onClick={() => {
                setConfirmApply(false);
                void onJob(
                  `/projects/${project.id}/impact/${report!.id}/apply`,
                  { useCaseIds: selected, connectionId: connection, modelId },
                );
              }}
            >
              Apply selected changes
            </Button>
          </>
        }
      >
        <div className="real-selection-list">
          {selected.map((id) => (
            <p key={id}>
              <Check size={13} />
              {id} · {model?.useCases.find((u) => u.id === id)?.title}
            </p>
          ))}
        </div>
      </Modal>
    </div>
  );
}
export function RealExport({
  project,
  model,
  settings,
  onJob,
  attempt,
  job,
  onSettings,
}: {
  project: Project;
  model: SolutionModel | null;
  settings: PublicSettings;
  onJob: JobAction;
  attempt: Attempt;
  job: Job | null;
  onSettings: () => void;
}) {
  // The first destination that is set up (Azure DevOps first: it is the one that can be published to).
  const [target, setTarget] = useState<ExternalSystem>(
    () =>
      (["azdo", "jira", "github"] as const).find(
        (id) => settings.integrations[id],
      ) ?? "azdo",
  );
  // Approved requirements by default; drafts and stale use cases are selected only deliberately.
  const [selected, setSelected] = useState<string[]>(
    model?.useCases.filter((u) => u.status === "approved").map((u) => u.id) ??
      [],
  );
  const [parents, setParents] = useState(true);
  const [dependencies, setDependencies] = useState(true);
  const [update, setUpdate] = useState(true);
  const [points, setPoints] = useState(true);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [plan, setPlan] = useState(false);
  useEffect(() => {
    setSelected((v) =>
      v.filter((id) => model?.useCases.some((u) => u.id === id)),
    );
  }, [model?.useCases.map((u) => u.id).join(",")]);
  const configured = !!settings.integrations[target];
  const currentExportLink = (
    uc: NonNullable<typeof model>["useCases"][number],
  ) => {
    const link = uc.external.find((e) => e.system === target),
      config = settings.integrations[target];
    return link && config && linkBelongsToTarget(target, config, link)
      ? link
      : undefined;
  };
  const result =
    job?.projectId === project.id &&
    job.kind === "export" &&
    job.status === "succeeded"
      ? (job.result as ExportResult)
      : null;
  const selectedCases =
    model?.useCases.filter((u) => selected.includes(u.id)) ?? [];
  const targetLabel = { jira: "Jira", azdo: "Azure DevOps", github: "GitHub" }[
    target
  ];
  const csvUrl = `/api/projects/${project.id}/export/csv?useCaseIds=${encodeURIComponent(selected.join(","))}`;
  const azdo = settings.integrations.azdo;
  const destination =
    target === "azdo" && azdo
      ? `${azdo.orgUrl.replace(/\/+$/, "")} · ${azdo.project}`
      : target === "jira" && settings.integrations.jira
        ? `${settings.integrations.jira.baseUrl} · ${settings.integrations.jira.projectKey}`
        : target === "github" && settings.integrations.github
          ? `${settings.integrations.github.owner}/${settings.integrations.github.repo}`
          : targetLabel;
  return (
    <div className="workspace-page real-export-page">
      <SectionHeading
        eyebrow="FROM UNDERSTANDING TO DELIVERY"
        title="Ready for the team."
        description="Review the exact content, rehearse the plan and carry your specification into delivery."
        actions={
          <Button onClick={onSettings}>
            Configure destinations
            <ChevronRight size={13} />
          </Button>
        }
      />
      <div className="simulation-banner">
        <ShieldCheck size={17} />
        <span>
          <strong>
            Publishing creates real{" "}
            {target === "azdo" ? "work items" : "issues"} in {targetLabel}
          </strong>{" "}
          after you confirm, from the delivery plan below. Coherence never
          deletes, closes or reassigns anything there. Previews and CSV use your
          actual reviewed Markdown.
        </span>
        <Badge tone="blue">Publishing</Badge>
      </div>
      <div className="real-export-layout">
        <section className="real-panel real-export-selection">
          <div className="inline-between">
            <div>
              <span className="section-kicker">REVIEWED USE CASES</span>
              <h2>Choose what travels.</h2>
            </div>
            <Badge>{selected.length} selected</Badge>
          </div>
          <div className="inline-between">
            <Button
              compact
              variant="ghost"
              onClick={() =>
                setSelected(model?.useCases.map((u) => u.id) ?? [])
              }
            >
              Select all
            </Button>
            <Button
              compact
              variant="ghost"
              onClick={() =>
                setSelected(
                  model?.useCases
                    .filter((u) => u.status === "approved")
                    .map((u) => u.id) ?? [],
                )
              }
            >
              Approved only
            </Button>
            <Button compact variant="ghost" onClick={() => setSelected([])}>
              Clear
            </Button>
            <Button
              compact
              variant="ghost"
              onClick={() =>
                setSelected(
                  model?.useCases
                    .filter((u) => {
                      const link = currentExportLink(u);
                      return !link || link.revision !== u.revision;
                    })
                    .map((u) => u.id) ?? [],
                )
              }
            >
              Changed or new
            </Button>
          </div>
          <div className="real-export-cases">
            {model?.useCases.map((uc) => (
              <label className="real-export-case" key={uc.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(uc.id)}
                  onChange={(e) =>
                    setSelected((v) =>
                      e.target.checked
                        ? [...v, uc.id]
                        : v.filter((id) => id !== uc.id),
                    )
                  }
                />
                <span>
                  <small>
                    {uc.id} · {uc.size}
                  </small>
                  <strong>{uc.title}</strong>
                  <small
                    className="export-revision-state"
                    title={uc.external.find((e) => e.system === target)?.url}
                  >
                    {(() => {
                      const saved = uc.external.find(
                        (e) => e.system === target,
                      );
                      const link = currentExportLink(uc);
                      return link
                        ? `${link.key} · ${link.revision === uc.revision ? "Exported revision is current" : "Changed since export"}`
                        : saved
                          ? "Different destination · new item planned"
                          : "Not exported to this tracker";
                    })()}
                  </small>
                  <span>
                    {model.features.find((f) => f.id === uc.featureId)?.name}
                  </span>
                </span>
                <Badge
                  tone={
                    uc.status === "approved"
                      ? "green"
                      : uc.status === "stale"
                        ? "amber"
                        : "neutral"
                  }
                >
                  {uc.status}
                </Badge>
                <button
                  aria-label={`Preview ${uc.id} payload`}
                  className="icon-button"
                  disabled={!configured}
                  onClick={(e) => {
                    e.preventDefault();
                    void attempt(async () =>
                      setPreview(
                        await api<ExportPreview>(
                          `/projects/${project.id}/export/preview?target=${target}&useCaseId=${uc.id}`,
                        ),
                      ),
                    );
                  }}
                >
                  <FileCode2 size={15} />
                </button>
              </label>
            ))}
            {!model && (
              <p className="muted">
                Generate and review specifications before exporting.
              </p>
            )}
          </div>
        </section>
        <aside className="real-panel real-export-options">
          <span className="section-kicker">DESTINATION</span>
          <h2>A deliberate hand-off.</h2>
          <div className="target-options">
            {(["jira", "azdo", "github"] as const).map((id) => (
              <button
                className={target === id ? "selected" : ""}
                key={id}
                onClick={() => setTarget(id)}
              >
                <Layers2 size={17} />
                <strong>
                  {{ jira: "Jira", azdo: "Azure DevOps", github: "GitHub" }[id]}
                </strong>
                <Badge tone={settings.integrations[id] ? "green" : "neutral"}>
                  {settings.integrations[id] ? "Configured" : "Set up"}
                </Badge>
              </button>
            ))}
          </div>
          {!configured && (
            <p className="field-hint">
              Add the destination details in Settings to preview
              tracker-specific content and plan the hand-off.
            </p>
          )}
          <a
            className={`button ${selected.length ? "" : "disabled"}`}
            href={selected.length ? csvUrl : undefined}
            download
            onClick={(e) => {
              e.preventDefault();
              if (selected.length)
                void attempt(async () => {
                  await downloadPrivate(csvUrl, "coherence-use-cases.csv");
                });
            }}
          >
            <Download size={14} />
            Download real CSV
          </a>
          <p className="field-hint">
            CSV reads the Markdown files on disk and protects spreadsheet cells
            from formula execution.
          </p>
          <details className="classic-export">
            <summary>Classic export (preview only)</summary>
            <div className="options-section">
              <Toggle
                label="Feature parents"
                description="Group stories under epics, features or milestones."
                checked={parents}
                onChange={setParents}
              />
              <Toggle
                label="Dependency links"
                description="Keep the implementation chain visible."
                checked={dependencies}
                onChange={setDependencies}
              />
              <Toggle
                label="Update known work items"
                description="Match existing links to this exact target."
                checked={update}
                onChange={setUpdate}
              />
              <Toggle
                label="Include story points"
                description="Small 3 · Medium 5 · Large 8"
                checked={points}
                onChange={setPoints}
              />
            </div>
            <Button disabled={!selected.length} onClick={() => setPlan(true)}>
              <GitBranch size={14} />
              Review export plan
            </Button>
            <Button
              variant="primary"
              disabled={!selected.length || !configured}
              onClick={() =>
                void onJob(`/projects/${project.id}/export`, {
                  target,
                  useCaseIds: selected,
                  dryRun: true,
                  createFeatureParents: parents,
                  linkDependencies: dependencies,
                  updateExisting: update,
                  includeStoryPoints: points,
                })
              }
            >
              <Upload size={14} />
              Run local dry run
            </Button>
            <p className="field-hint">
              The older direct export, kept for comparison: its dry run makes no
              tracker requests. Publishing uses the delivery plan below.
            </p>
          </details>
        </aside>
      </div>
      <DeliveryPlanPanel
        project={project}
        target={target}
        configured={configured}
        destination={destination}
        useCaseIds={selected}
        onJob={onJob}
        attempt={attempt}
        job={job}
      />
      {result && (
        <section className="real-panel real-export-results">
          <div className="inline-between">
            <h3>
              {result.dryRun ? "Dry-run results" : "Saved export results"}
            </h3>
            <Badge tone="green">
              {result.target} · {result.items.length} items
            </Badge>
          </div>
          {result.items.map((item) => (
            <div className="job-history-row" key={item.useCaseId}>
              <span>
                {item.useCaseId} · {item.title}
                <small>
                  {item.error ?? "No remote work item was created."}
                </small>
              </span>
              <Badge tone={item.error ? "amber" : "green"}>{item.action}</Badge>
            </div>
          ))}
        </section>
      )}
      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        title={`${preview?.useCaseId} · ${targetLabel} payload`}
        description="Exact tracker conversion from the reviewed Markdown on disk. No request is sent."
        wide
      >
        <div className="real-payload-meta">
          {Object.entries(preview?.fields ?? {}).map(([key, value]) => (
            <span key={key}>
              <strong>{key}</strong>
              {value}
            </span>
          ))}
        </div>
        <p className="section-kicker">{preview?.bodyFormat}</p>
        <pre className="real-payload">{preview?.description}</pre>
        {preview?.acceptanceCriteria && (
          <>
            <span className="section-kicker">ACCEPTANCE CRITERIA</span>
            <pre className="real-payload">{preview.acceptanceCriteria}</pre>
          </>
        )}
      </Modal>
      <Modal
        open={plan}
        onClose={() => setPlan(false)}
        title="Review the delivery plan"
        description={`${selected.length} selected use cases · ${targetLabel} · local rehearsal only`}
        wide
        footer={<Button onClick={() => setPlan(false)}>Done reviewing</Button>}
      >
        <div className="real-selection-list">
          {parents && (
            <p>
              <Layers2 size={14} />
              {new Set(selectedCases.map((u) => u.featureId)).size} feature
              parents would be created or matched.
            </p>
          )}
          {selectedCases.map((u) => (
            <div className="real-plan-item" key={u.id}>
              <Badge>{u.id}</Badge>
              <strong>{u.title}</strong>
              <span>
                {points ? { S: 3, M: 5, L: 8 }[u.size] + " points" : ""}
              </span>
              <small>
                {dependencies
                  ? "Depends on " +
                    (u.dependsOn.join(", ") || "no prerequisite")
                  : "Dependency links disabled"}
              </small>
            </div>
          ))}
        </div>
        <p className="field-hint">
          {update
            ? "Existing links are reused only when they belong to the selected destination."
            : "The plan is configured to create new items."}{" "}
          Remote create/update and ambiguous-outcome reconciliation require a
          separately authorized integration test.
        </p>
      </Modal>
    </div>
  );
}
