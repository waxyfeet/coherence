import { useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Cpu,
  FileText,
  Layers2,
  LoaderCircle,
  Play,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
} from "lucide-react";
import type {
  GenerationOptions,
  Job,
  Project,
  SolutionModel,
} from "../shared/types";
import type { Connection, SettingsData } from "./data";
import { connectionInput } from "./api";
import { estimateGeneration } from "../shared/generationEstimate";
import { PROVIDER_PRESETS } from "../shared/providers";
import { allowsLocalAnalysis } from "../shared/localModelPolicy";
import { formatUsd } from "../shared/pricing";
import { OFFLINE_MODEL_ID } from "../shared/modelSelection";
import {
  analysisModelDefaults,
  defaultRoleIssue,
  sameAnalysisDefaults,
} from "../shared/analysisDefaults";
import {
  modelEvidenceForConnection,
  evidenceLabel,
} from "../shared/modelCapabilities";
import { visibleModels } from "../shared/modelCatalogue";
import { JobProgressPanel } from "./JobProgressPanel";
import { failureText } from "./jobFailure";
import { keyRequired, keyState } from "./connectionKey";
import {
  projectConnectionChoices,
  savedGenerationKind,
} from "../shared/generationContext";
import { GenerationProvenance } from "./GenerationProvenance";
import {
  Badge,
  Button,
  Field,
  Picker,
  SectionHeading,
  Toggle,
  Modal,
} from "./ui";
type Props = {
  project: Project;
  model: SolutionModel | null;
  settings: SettingsData;
  job: Job | null;
  busy: boolean;
  onGenerate: (o: GenerationOptions) => void;
  onCancel: () => void;
  /** Discards what a stopped run kept for Try again (owner test note 7). */
  onAbandon: () => void;
  onSettings: () => void;
  onSpecs: () => void;
  onProjectConnections: (llm: {
    visionConnectionId: string;
    textConnectionId: string;
    visionModelId: string;
    textModelId: string;
    visionAcknowledged: boolean;
  }) => Promise<unknown>;
};
/** A model picker entry that opens AI connections instead of choosing a model. */
const ADD_MODEL = "\u0000add-model";
const MODELS_SECTION = "analysis-models";
const stages = [
  ["Preparing screens", "Gather the brief, evidence and preserved edits."],
  ["Reading screens", "Inventory elements, exact labels and uncertainty."],
  ["Mapping journeys", "Connect personas, navigation and screen states."],
  ["Planning use cases", "Establish coverage and a deterministic build order."],
  ["Writing use cases", "Write stories, rules and BDD acceptance criteria."],
  ["Reviewing", "Check coverage, consistency and chained outcomes."],
  ["Writing files", "Save editable Markdown and supporting outputs."],
];
export function RealAnalysis({
  project,
  model,
  settings,
  job,
  busy,
  onGenerate,
  onCancel,
  onAbandon,
  onSettings,
  onSpecs,
  onProjectConnections,
}: Props) {
  const preferences = project.generationPreferences ?? model?.options;
  const choices = projectConnectionChoices(project, model?.options);
  const [vision, setVision] = useState(
    choices.visionConnectionId ?? settings.visionId,
  );
  const [text, setText] = useState(choices.textConnectionId ?? settings.textId);
  const [visionModel, setVisionModel] = useState(
    choices.visionModelId ??
      (settings.connections.find((c) => c.id === vision)?.provider === "mock"
        ? OFFLINE_MODEL_ID
        : ""),
  );
  const [textModel, setTextModel] = useState(
    choices.textModelId ??
      (settings.connections.find((c) => c.id === text)?.provider === "mock"
        ? OFFLINE_MODEL_ID
        : ""),
  );
  const [visionAcknowledged, setVisionAcknowledged] = useState(
    choices.visionAcknowledged ?? false,
  );
  const [thoroughness, setThoroughness] = useState(
    preferences?.thoroughness ?? settings.thoroughness,
  );
  const [granularity, setGranularity] = useState(
    preferences?.granularity ?? settings.granularity,
  );
  const [preserve, setPreserve] = useState(
    preferences?.preserveEdited ?? settings.preserveEdits,
  );
  const [embed, setEmbed] = useState(
    preferences?.embedScreenImages ?? settings.embedImages,
  );
  const [reuse, setReuse] = useState(
    preferences?.reuseScreenAnalyses ?? settings.reuseAnalysis,
  );
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [confirmOffline, setConfirmOffline] = useState(false);
  // The id of the stopped run the BA changed the model choices after.
  const [changedAfter, setChangedAfter] = useState<string>();
  const protectedCases =
    model?.useCases.filter((u) => u.status !== "generated") ?? [];
  function generate() {
    onGenerate({
      visionConnectionId: vision,
      textConnectionId: text,
      visionModelId: visionModel,
      textModelId: textModel,
      visionAcknowledged,
      thoroughness: thoroughness as GenerationOptions["thoroughness"],
      granularity: granularity as GenerationOptions["granularity"],
      preserveEdited: preserve,
      embedScreenImages: embed,
      reuseScreenAnalyses: reuse,
    });
  }
  const options = settings.connections.map((c) => ({
    value: c.id,
    label: c.name,
    detail:
      c.provider === "mock"
        ? "Built-in simulation · no AI"
        : `${c.modelIds?.length ?? 0} configured IDs`,
  }));
  const offline = [vision, text].every(
    (id) => settings.connections.find((c) => c.id === id)?.provider === "mock",
  );
  const usesOfflineSteps = [vision, text].some(
    (id) => settings.connections.find((c) => c.id === id)?.provider === "mock",
  );
  function reviewOverwrite() {
    if (!preserve && protectedCases.length) setConfirmOverwrite(true);
    else generate();
  }
  function requestGeneration() {
    if (
      model &&
      savedGenerationKind(model.generator) !== "offline" &&
      usesOfflineSteps
    )
      setConfirmOffline(true);
    else reviewOverwrite();
  }
  const visionChoice = settings.connections.find((c) => c.id === vision),
    textChoice = settings.connections.find((c) => c.id === text);
  const roleEvidence = (c: typeof visionChoice, id: string) =>
    modelEvidenceForConnection(c, id);
  const readingEvidence = roleEvidence(visionChoice, visionModel);
  const evidence =
    visionChoice?.provider === "mock"
      ? "simulated"
      : visionChoice?.vision === "no"
        ? "unsupported"
        : readingEvidence.image.state;
  const visionAllowed =
    !!visionChoice &&
    evidence !== "unsupported" &&
    (evidence !== "unknown" ||
      visionAcknowledged ||
      visionChoice.vision === "yes");
  const writingAllowed =
    roleEvidence(textChoice, textModel).text.state !== "unsupported";
  const configured = (c: typeof visionChoice, id: string) =>
    !!c &&
    (c.provider === "mock"
      ? id === OFFLINE_MODEL_ID
      : !!c.modelIds?.includes(id));
  const imageRank = (c: typeof visionChoice, id: string) =>
    ({ tested: 0, "provider-reported": 0, unknown: 1, unsupported: 2 })[
      roleEvidence(c, id).image.state
    ];
  const modelOptions = (
    c: typeof visionChoice,
    id: string,
    reading = false,
  ) => {
    const listed =
      c?.provider === "mock" ? [OFFLINE_MODEL_ID] : c ? visibleModels(c) : [];
    // A stable sort keeps the account's own order within each group.
    const ids = reading
      ? [...listed].sort((a, b) => imageRank(c, a) - imageRank(c, b))
      : listed;
    return [
      ...ids.map((value) => ({
        value,
        label:
          reading &&
          c?.provider !== "mock" &&
          roleEvidence(c, value).image.state === "unsupported"
            ? `${value} · can't read screenshots`
            : value,
        detail:
          c?.provider === "mock"
            ? "Built-in simulation"
            : `Images: ${evidenceLabel(roleEvidence(c, value).image)} · Text: ${evidenceLabel(roleEvidence(c, value).text)}`,
      })),
      ...(id && !ids.includes(id)
        ? [
            {
              value: id,
              label: c?.modelIds?.includes(id)
                ? id
                : `${id} · unavailable, choose again`,
              detail: c?.modelIds?.includes(id)
                ? "Current choice · hidden from ordinary list"
                : "Not configured on this connection",
            },
          ]
        : []),
      ...(c && c.provider !== "mock"
        ? [
            {
              value: ADD_MODEL,
              label: "Add a model…",
              detail:
                "Opens AI connections, where this account's models are listed",
            },
          ]
        : []),
    ];
  };
  const connectionOptions = (id: string) => [
    ...options,
    ...(id && !settings.connections.some((c) => c.id === id)
      ? [
          {
            value: id,
            label: "Connection unavailable — choose again",
            detail: "Saved project assignment retained",
          },
        ]
      : []),
  ];
  const estimate = estimateGeneration({
    screenCount: project.screens.length,
    screensToRead: project.screens.length,
    thoroughness: thoroughness as GenerationOptions["thoroughness"],
    vision: visionChoice
      ? {
          provider: connectionInput(visionChoice).provider,
          model: visionModel,
          baseUrl: visionChoice.endpoint,
          concurrency: visionChoice.concurrency,
        }
      : undefined,
    text: textChoice
      ? {
          provider: connectionInput(textChoice).provider,
          model: textModel,
          baseUrl: textChoice.endpoint,
          concurrency: textChoice.concurrency,
        }
      : undefined,
  });
  const localPolicyBlocked =
    !!project.localOnly &&
    [visionChoice, textChoice].some(
      (choice) => !choice || !allowsLocalAnalysis(connectionInput(choice)),
    );
  const savedDefaults = analysisModelDefaults(
    settings.analysisDefaults,
    settings.connections,
  );
  const defaultsIssue =
    defaultRoleIssue(savedDefaults, settings.connections, true) ??
    defaultRoleIssue(savedDefaults, settings.connections, false) ??
    (project.localOnly &&
    [savedDefaults.visionConnectionId, savedDefaults.textConnectionId].some(
      (id) => {
        const c = settings.connections.find((c) => c.id === id);
        return !c || !allowsLocalAnalysis(connectionInput(c));
      },
    )
      ? "Saved defaults are blocked by this project's local-only policy."
      : undefined);
  const defaultsMatch = sameAnalysisDefaults(savedDefaults, {
    visionConnectionId: vision,
    visionModelId: visionModel,
    textConnectionId: text,
    textModelId: textModel,
  });
  function useSavedDefaults() {
    markChanged();
    setVision(savedDefaults.visionConnectionId);
    setVisionModel(savedDefaults.visionModelId);
    setText(savedDefaults.textConnectionId);
    setTextModel(savedDefaults.textModelId);
    setVisionAcknowledged(false);
  }
  const destination = (choice?: Connection) =>
    !choice
      ? "Select a connection."
      : choice.provider === "mock"
        ? "Simulated · no data leaves this computer."
        : allowsLocalAnalysis(connectionInput(choice))
          ? "Local endpoint · runs on this computer; your endpoint may relay data."
          : "Remote or LAN endpoint · data leaves this computer; API usage or charges may apply.";
  // Saved settings only, so a key is either saved, missing or not needed here.
  const keyless = [visionChoice, textChoice].filter(
    (c, i, all): c is Connection =>
      !!c && all.indexOf(c) === i && keyState(c) === "missing",
  );
  const keyBlocked = keyless.find(keyRequired);
  const keyWarning =
    keyless.length && !keyBlocked
      ? `No API key is saved for ${keyless.map((c) => c.name).join(" and ")}. If the service needs one, the run will stop at its first request.`
      : "";
  const preflightMessage = localPolicyBlocked
    ? "Local-only policy blocks these choices. Select Offline demo or loopback Ollama/compatible connections for both roles."
    : !project.screens.length
      ? "Add screenshots before starting."
      : !visionChoice || !textChoice
        ? "Choose an available connection for both roles."
        : !configured(visionChoice, visionModel) ||
            !configured(textChoice, textModel)
          ? "Choose an available exact model ID for both roles. Add manual IDs in Settings if needed; legacy assignments require explicit reselection."
          : keyBlocked
            ? `No API key is saved for ${keyBlocked.name}. Add it in Settings → AI connections.`
            : !writingAllowed
              ? "This writing model is reported as unable to generate text. Choose another exact model."
              : !visionAllowed
                ? evidence === "unsupported"
                  ? "This model is reported as unable to read images. Choose another reading model."
                  : "Image support is unverified. Confirm it beside the reading model, explicitly test image understanding in Connections, or choose a model with image-support evidence."
                : "";
  const running = job && ["queued", "running"].includes(job.status);
  const currentStage = stages.findIndex(
    ([name]) => job?.progress.stage === name,
  );
  const finished = job?.status === "succeeded";
  const stopped =
    job && (job.status === "failed" || job.status === "cancelled") ? job : null;
  const choicesChanged = !!stopped && changedAfter === stopped.id;
  const resetAt = stopped?.failure?.resetAt
    ? Date.parse(stopped.failure.resetAt)
    : NaN;
  const pausedUntil =
    stopped?.failure?.kind === "rate-limited" && resetAt > Date.now()
      ? new Date(resetAt).toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        })
      : undefined;
  const stopReason =
    stopped?.status === "cancelled"
      ? "You cancelled it."
      : stopped
        ? failureText(stopped)
        : undefined;
  // A model on the same account that the provider says reads screenshots, offered when the chosen one can't.
  const suggestedReader =
    visionChoice && visionChoice.provider !== "mock" && !visionAllowed
      ? visibleModels(visionChoice).find(
          (id) => id !== visionModel && imageRank(visionChoice, id) === 0,
        )
      : undefined;
  // A removed connection: a saved one that lists the same exact model (owner test notes 1 and 6).
  const replacementFor = (id: string, model: string) =>
    id && model && !settings.connections.some((c) => c.id === id)
      ? settings.connections.find(
          (c) => c.provider !== "mock" && c.modelIds?.includes(model),
        )
      : undefined;
  const readerReplacement = replacementFor(vision, visionModel);
  const writerReplacement = replacementFor(text, textModel);
  const replacement = readerReplacement ?? writerReplacement;
  function useReplacement() {
    if (readerReplacement) {
      setVision(readerReplacement.id);
      setVisionAcknowledged(false);
    }
    if (writerReplacement) setText(writerReplacement.id);
    markChanged();
  }
  function markChanged() {
    if (stopped) setChangedAfter(stopped.id);
  }
  function showModels() {
    const section = document.getElementById(MODELS_SECTION);
    section?.scrollIntoView({ behavior: "smooth", block: "start" });
    section?.querySelector<HTMLElement>("button")?.focus();
  }
  function pickModel(value: string, set: (id: string) => void) {
    if (value === ADD_MODEL) {
      onSettings();
      return;
    }
    set(value);
    markChanged();
  }
  return (
    <div className="workspace-page analysis-page">
      <SectionHeading
        eyebrow="FROM EVIDENCE TO UNDERSTANDING"
        title="A thoughtful analysis."
        description="A focused team of agents, one shared specification."
        actions={
          <Button onClick={onSettings}>
            <Settings2 size={14} />
            Configure models
          </Button>
        }
      />
      {model && <GenerationProvenance model={model} />}
      {!model && offline && !defaultsMatch && !defaultsIssue && (
        <div className="settings-callout project-defaults-notice" role="status">
          <Settings2 size={17} />
          <div>
            <strong>Your saved AI setup is ready to use</strong>
            <p>
              This project still uses Offline demo. Load your saved analysis
              defaults, review the models and destinations, then save or
              generate when ready.
            </p>
            <Button
              compact
              disabled={busy || !!running}
              onClick={useSavedDefaults}
            >
              Use saved analysis defaults
            </Button>
          </div>
        </div>
      )}
      <div className="simulation-banner next-run-banner">
        <ShieldCheck size={16} />
        <span>
          <strong>
            {localPolicyBlocked
              ? "Next run · Blocked by local-only policy"
              : offline
                ? "Next run · Offline fixture provider"
                : usesOfflineSteps
                  ? "Next run · Mixed providers"
                  : "Next run · Your selected models"}
          </strong>
          {localPolicyBlocked
            ? " · No AI request can start with these choices. Select permitted connections below."
            : offline
              ? " · Starting a new run will use synthetic fixtures, with no AI analysis or external requests. This does not describe any saved result above."
              : " · A new run sends screenshot evidence and project context to the selected providers. Cloud usage may incur charges."}
        </span>
        <Badge tone={offline ? "amber" : "blue"}>
          {localPolicyBlocked
            ? "Blocked"
            : offline
              ? "Next run: synthetic"
              : usesOfflineSteps
                ? "Next run: mixed"
                : "Network on run"}
        </Badge>
      </div>
      <section
        className="generation-provenance"
        aria-label="Next run data destinations"
      >
        <strong>
          Data destinations for the next run
          {project.localOnly ? " - local-only policy enforced" : ""}
        </strong>
        <p>
          Read screens (Analyst and Inspector):{" "}
          {visionChoice?.name ?? "Missing connection"} ·{" "}
          {visionModel || "Select a model"}
        </p>
        <p>{destination(visionChoice)}</p>
        <p className="mono">
          {!visionChoice
            ? "Select a connection"
            : visionChoice.provider === "mock"
              ? "Offline fixture: no outbound data"
              : visionChoice?.endpoint ||
                (visionChoice &&
                  PROVIDER_PRESETS[connectionInput(visionChoice).provider]
                    .defaultBaseUrl) ||
                "https://generativelanguage.googleapis.com"}
        </p>
        <p>
          Write use cases / reasoning (mapping, planning, writing and review):{" "}
          {textChoice?.name ?? "Missing connection"} ·{" "}
          {textModel || "Select a model"}
        </p>
        <p>{destination(textChoice)}</p>
        <p className="mono">
          {!textChoice
            ? "Select a connection"
            : textChoice.provider === "mock"
              ? "Offline fixture: no outbound data"
              : textChoice?.endpoint ||
                (textChoice &&
                  PROVIDER_PRESETS[connectionInput(textChoice).provider]
                    .defaultBaseUrl) ||
                "https://generativelanguage.googleapis.com"}
        </p>
        <p>
          Reading sends screenshots, notes and project context. Writing sends
          inventories, project context and specifications; a vision-capable
          writer also receives screenshots. Only run with destinations you
          trust. Missing saved connections must be explicitly replaced.
        </p>
      </section>
      <div className="analysis-layout">
        <section className="pipeline-panel">
          <div className="panel-header">
            <div>
              <span className="section-kicker">THE ANALYSIS PIPELINE</span>
              <h2>
                {running
                  ? "Building a shared understanding…"
                  : finished
                    ? "Your specification is ready for review."
                    : "Seven steps. One coherent story."}
              </h2>
            </div>
            <Badge tone={running ? "accent" : finished ? "green" : "neutral"}>
              {job?.status ?? "Ready"}
            </Badge>
          </div>
          {job && <JobProgressPanel job={job} />}
          <div className="pipeline-stages">
            {stages.map(([name, description], i) => {
              const complete = finished || (currentStage > i && running);
              const active = !!running && currentStage === i;
              return (
                <div
                  key={name}
                  className={`pipeline-step ${complete ? "complete" : ""} ${active ? "active" : ""}`}
                >
                  <div className="pipeline-line" />
                  <span className="pipeline-icon">
                    {active ? (
                      <LoaderCircle size={17} className="spin" />
                    ) : complete ? (
                      <Check size={17} />
                    ) : (
                      <span>{i + 1}</span>
                    )}
                  </span>
                  <div>
                    <strong>{name}</strong>
                    <p>{description}</p>
                  </div>
                  <span className="pipeline-step-state">
                    {active
                      ? `${job.progress.current}/${job.progress.total || "—"}`
                      : complete
                        ? "Complete"
                        : "Pending"}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="pipeline-footer">
            {running ? (
              <Button onClick={onCancel}>
                <Square size={12} />
                Cancel operation
              </Button>
            ) : stopped ? null : (
              <Button
                variant="primary"
                disabled={busy || !!preflightMessage}
                onClick={requestGeneration}
              >
                <Play size={14} />
                {model
                  ? "Regenerate specifications"
                  : offline
                    ? "Generate offline example"
                    : "Generate specifications"}
              </Button>
            )}
            {model && (
              <Button onClick={onSpecs}>
                Review use cases
                <ArrowRight size={14} />
              </Button>
            )}
            <span className="muted small">
              {project.screens.length} screens · Markdown + Gherkin
            </span>
          </div>
          {stopped && !running && (
            <div
              className={`run-stopped${choicesChanged ? " earlier" : ""}`}
              role="status"
            >
              <strong>
                {choicesChanged
                  ? "The last run didn't finish"
                  : stopped.status === "cancelled"
                    ? "This run was cancelled"
                    : pausedUntil
                      ? `This run is paused until ${pausedUntil}`
                      : "This run didn't finish"}
              </strong>
              <p>{choicesChanged ? `Last run: ${stopReason}` : stopReason}</p>
              <p className="field-hint">
                {model ? "Your existing specification is unchanged. " : ""}
                Try again reuses the steps this run finished, as long as the
                models and settings stay the same.
              </p>
              <div className="run-stopped-actions">
                <Button
                  variant="primary"
                  disabled={busy || !!preflightMessage}
                  onClick={requestGeneration}
                >
                  <Play size={14} />
                  {choicesChanged ? "Start with these choices" : "Try again"}
                </Button>
                <Button onClick={showModels}>Change models</Button>
                <Button variant="ghost" disabled={busy} onClick={onAbandon}>
                  Abandon run
                </Button>
              </div>
            </div>
          )}
          {preflightMessage && (
            <div className="settings-callout run-blocked" role="status">
              <Settings2 size={17} />
              <div>
                <strong>Can't start yet</strong>
                <p>{preflightMessage}</p>
                <div className="run-stopped-actions">
                  {replacement && (
                    <Button compact onClick={useReplacement}>
                      Use {replacement.name}, which has the same model
                    </Button>
                  )}
                  {suggestedReader && (
                    <Button
                      compact
                      onClick={() => {
                        setVisionModel(suggestedReader);
                        setVisionAcknowledged(false);
                        markChanged();
                      }}
                    >
                      Read screens with {suggestedReader}
                    </Button>
                  )}
                  <Button compact onClick={showModels}>
                    Change models
                  </Button>
                </div>
              </div>
            </div>
          )}
          {!preflightMessage && keyWarning && (
            <p className="field-hint" role="status">
              {keyWarning}
            </p>
          )}
          {job && (
            <div className="real-run-summary">
              <span>{job.usage.calls} calls</span>
              <span>{job.usage.inputTokens.toLocaleString()} input tokens</span>
              <span>
                {job.usage.outputTokens.toLocaleString()} output tokens
              </span>
              <span>
                {job.usage.costUsd === undefined
                  ? "Cost unavailable"
                  : `~${job.usage.costUsd.toFixed(4)} estimated`}
              </span>
            </div>
          )}
        </section>
        <aside className="analysis-options">
          <div className="pane-heading">
            <Settings2 size={16} />
            <h3>Analysis configuration</h3>
          </div>
          <div className="options-section">
            <p className="field-hint">
              This project keeps its own model choices. Settings defaults apply
              to new projects.
            </p>
            <Button
              className="model-copy"
              compact
              disabled={busy || !!running || !!defaultsIssue || defaultsMatch}
              onClick={useSavedDefaults}
            >
              Use saved analysis defaults
            </Button>
            <p className="field-hint" role="status">
              {defaultsIssue
                ? `Saved defaults need attention in Settings. ${defaultsIssue}`
                : defaultsMatch
                  ? "The selected models match your saved analysis defaults."
                  : "Loads both model choices below for review. Nothing is saved or run until you choose Save or Generate."}
            </p>
          </div>
          <div className="options-section" id={MODELS_SECTION}>
            <div className="model-role">
              <span className="role-icon">
                <Layers2 size={17} />
              </span>
              <div>
                <strong>Screen reading</strong>
                <small>Analyst & Inspector · requires vision</small>
              </div>
            </div>
            <Field label="Read screens — connection">
              <Picker
                value={vision}
                onChange={(id) => {
                  markChanged();
                  setVision(id);
                  setVisionModel(
                    settings.connections.find((c) => c.id === id)?.provider ===
                      "mock"
                      ? OFFLINE_MODEL_ID
                      : "",
                  );
                  setVisionAcknowledged(false);
                }}
                label="Read screens connection"
                options={connectionOptions(vision)}
              />
            </Field>
            <Field label="Read screens — model">
              <Picker
                value={visionModel}
                onChange={(id) =>
                  pickModel(id, (value) => {
                    setVisionModel(value);
                    setVisionAcknowledged(false);
                  })
                }
                label="Read screens model"
                placeholder="Choose a model ID"
                disabled={!visionChoice || visionChoice.provider === "mock"}
                options={modelOptions(visionChoice, visionModel, true)}
              />
            </Field>
            {visionChoice?.provider !== "mock" && (
              <div className="model-capability-note">
                <p>
                  {evidence === "unsupported"
                    ? "This model cannot read screenshots. Choose a model with screenshot support."
                    : evidence === "unknown"
                      ? "Coherence does not yet know whether this model can read screenshots."
                      : evidence === "provider-reported"
                        ? "The provider lists screenshot support for this model. No extra test is required before generating."
                        : "Screenshot support passed Coherence’s sample-image test. Review the results for your own screens."}
                </p>
                {evidence === "unknown" && visionChoice?.vision === "yes" && (
                  <p>
                    Your account explicitly enables image input. This is your
                    declaration, not a verified capability. Only continue if
                    this exact model accepts screenshots.
                  </p>
                )}
                {evidence === "unknown" && visionChoice?.vision !== "yes" && (
                  <>
                    <p>
                      Saving a connection or choosing a default does not verify
                      image support. If you know this exact model accepts
                      images, confirm below; otherwise use the explicit image
                      test in Connections. Tests may incur provider charges.
                    </p>
                    <label>
                      <input
                        type="checkbox"
                        checked={visionAcknowledged}
                        onChange={(event) =>
                          setVisionAcknowledged(event.target.checked)
                        }
                      />
                      I confirm this model accepts screenshots (not verified by
                      Coherence).
                    </label>
                    <p>
                      This confirmation is only needed while image support is
                      unknown. Save choices for this project to remember it;
                      changing the reading connection or model clears it.
                    </p>
                  </>
                )}
                {(evidence === "unknown" || evidence === "unsupported") && (
                  <Button compact onClick={onSettings}>
                    Check screenshot support in Connections
                  </Button>
                )}
              </div>
            )}
            <div className="model-role">
              <span className="role-icon violet">
                <Cpu size={17} />
              </span>
              <div>
                <strong>Reasoning & writing</strong>
                <small>Journey Mapper · Planner · Writer · Reviewer</small>
              </div>
            </div>
            <Field label="Write use cases / reasoning — connection">
              <Picker
                value={text}
                onChange={(id) => {
                  markChanged();
                  setText(id);
                  setTextModel(
                    settings.connections.find((c) => c.id === id)?.provider ===
                      "mock"
                      ? OFFLINE_MODEL_ID
                      : "",
                  );
                }}
                label="Write use cases / reasoning connection"
                options={connectionOptions(text)}
              />
            </Field>
            <Field label="Write use cases / reasoning — model">
              <Picker
                value={textModel}
                onChange={(id) => pickModel(id, setTextModel)}
                label="Write use cases / reasoning model"
                placeholder="Choose a model ID"
                disabled={!textChoice || textChoice.provider === "mock"}
                options={modelOptions(textChoice, textModel)}
              />
            </Field>
            {textChoice?.provider !== "mock" && (
              <p className="field-hint">
                Text generation:{" "}
                {evidenceLabel(roleEvidence(textChoice, textModel).text)}.
                Vision is not required for writing. Native structured output:{" "}
                {evidenceLabel(
                  roleEvidence(textChoice, textModel).nativeStructured,
                )}
                ; prompt and validate:{" "}
                {evidenceLabel(
                  roleEvidence(textChoice, textModel).promptStructured,
                )}
                .
              </p>
            )}
            <Button
              className="model-copy"
              compact
              disabled={!configured(visionChoice, visionModel)}
              onClick={() => {
                setText(vision);
                setTextModel(visionModel);
                markChanged();
              }}
            >
              Use the same model for both
            </Button>
            <Button
              compact
              disabled={
                !configured(visionChoice, visionModel) ||
                !configured(textChoice, textModel) ||
                !visionAllowed ||
                !writingAllowed ||
                localPolicyBlocked ||
                (vision === project.llm.visionConnectionId &&
                  text === project.llm.textConnectionId &&
                  visionModel === project.llm.visionModelId &&
                  textModel === project.llm.textModelId &&
                  visionAcknowledged === !!project.llm.visionAcknowledged)
              }
              onClick={() =>
                void onProjectConnections({
                  visionConnectionId: vision,
                  textConnectionId: text,
                  visionModelId: visionModel,
                  textModelId: textModel,
                  visionAcknowledged,
                })
              }
            >
              Save choices for this project
            </Button>
          </div>
          <div className="options-section">
            <Field label="Thoroughness">
              <Picker
                label="Thoroughness"
                value={thoroughness}
                onChange={setThoroughness}
                options={[
                  {
                    value: "standard",
                    label: "Standard",
                    detail: "One screen reading pass",
                  },
                  {
                    value: "thorough",
                    label: "Thorough",
                    detail: "Inspector verification and review repair",
                  },
                ]}
              />
            </Field>
            <Field label="Use-case granularity">
              <Picker
                label="Use-case granularity"
                value={granularity}
                onChange={setGranularity}
                options={[
                  {
                    value: "fine",
                    label: "Fine",
                    detail: "Smaller, focused behaviors",
                  },
                  { value: "balanced", label: "Balanced" },
                  {
                    value: "coarse",
                    label: "Coarse",
                    detail: "Broader workflow slices",
                  },
                ]}
              />
            </Field>
          </div>
          <div className="options-section">
            <Toggle
              label="Preserve human edits"
              description="Keep edited and approved use cases."
              checked={preserve}
              onChange={setPreserve}
            />
            <Toggle
              label="Include screenshot evidence"
              description="Copy evidence into generated outputs."
              checked={embed}
              onChange={setEmbed}
            />
            <Toggle
              label="Reuse current screen readings"
              description="Input fingerprints include notes, model and context."
              checked={reuse}
              onChange={setReuse}
            />
          </div>
          <div className="analysis-estimate">
            <Sparkles size={17} />
            <div>
              <strong>
                {offline ? "No model charges" : "Usage is provider-dependent"}
              </strong>
              <p>
                {offline
                  ? "Outputs are deterministic fixtures, clearly labelled as synthetic."
                  : `Rough planning estimate: ≈${estimate.useCases} use cases · ≈${(estimate.inputTokens + estimate.outputTokens).toLocaleString()} tokens · ${estimate.costUsd === undefined ? "cost unknown" : formatUsd(estimate.costUsd) + " estimated"} · ${estimate.minutes.low}–${estimate.minutes.high} minutes.`}
              </p>
              {!offline && (
                <details className="estimate-assumptions">
                  <summary>Estimate assumptions</summary>
                  <p>
                    Adapted from the original planning heuristic: 3 use cases
                    per screen; 6,000/2,000 input/output reading tokens per
                    screen; 8,000/2,500 writing tokens per use case. Assumes
                    every image is reread. Thorough passes, concurrency and
                    indicative bundled prices affect the estimate. Retries,
                    cache hits, actual model speed and output size can change it
                    substantially. This is not a quote or a promised completion
                    time.
                  </p>
                </details>
              )}
            </div>
          </div>
        </aside>
      </div>
      {model && (
        <div className="real-review-strip">
          <div>
            <FileText size={18} />
            <strong>{model.useCases.length} use cases</strong>
            <span>
              {model.features.length} features ·{" "}
              {model.review.filter((r) => !r.resolved).length} unresolved review
              findings
            </span>
          </div>
          <Button compact onClick={onSpecs}>
            Open workbench
            <ChevronRight size={13} />
          </Button>
        </div>
      )}
      <Modal
        open={confirmOffline}
        onClose={() => setConfirmOffline(false)}
        title="Use offline fixtures for this run?"
        description="A saved specification already exists. Your next-run choices include the offline demo, which produces synthetic content and can replace generated requirements. Saved human edits are protected only when preservation is enabled."
        footer={
          <>
            <Button onClick={() => setConfirmOffline(false)}>
              Keep current specification
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmOffline(false);
                reviewOverwrite();
              }}
            >
              Continue with offline fixture steps
            </Button>
          </>
        }
      >
        <p className="muted">
          Review both model selectors before continuing. Changing a selector
          alone has not modified the saved output.
        </p>
      </Modal>
      <Modal
        open={confirmOverwrite}
        onClose={() => setConfirmOverwrite(false)}
        title="Replace protected specifications?"
        description="Human edit preservation is off for this run. These edited, approved or stale use cases may be replaced. Review the affected documents before continuing."
        footer={
          <>
            <Button onClick={() => setConfirmOverwrite(false)}>
              Keep current documents
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmOverwrite(false);
                generate();
              }}
            >
              Regenerate without preservation
            </Button>
          </>
        }
      >
        <ul className="overwrite-files">
          {protectedCases.map((u) => (
            <li key={u.id}>
              <strong>
                {u.id} · {u.title}
              </strong>
              <span className="muted small">
                {u.filePath ?? `use-cases/${u.id}-${u.slug}.md`} · {u.status}
              </span>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}
