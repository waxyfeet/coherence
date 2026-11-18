import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  ClipboardList,
  Cloud,
  Code2,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileCheck2,
  FileCode2,
  FileText,
  FlaskConical,
  GitBranch,
  GitFork as Github,
  Image,
  Layers2,
  ListFilter,
  LoaderCircle,
  MoreHorizontal,
  Network,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import {
  Badge,
  Button,
  Field,
  IconButton,
  Menu,
  Modal,
  Picker,
  SectionHeading,
  Toggle,
} from "./ui";
import {
  providers,
  stageNotes,
  stages,
  useCaseMarkdown,
  type ScreenItem,
  type SettingsData,
  type UseCase,
} from "./data";
import SampleScreen from "./SampleScreen";

export type RunStatus =
  "idle" | "running" | "complete" | "cancelled" | "failed";
export interface SampleReport {
  title: string;
  description: string;
  status: "analysed" | "partially-applied" | "applied" | "discarded";
  appliedIds: string[];
}
export function StatusBadge({ status }: { status: UseCase["status"] }) {
  return (
    <Badge
      tone={
        status === "approved"
          ? "green"
          : status === "stale"
            ? "amber"
            : status === "edited"
              ? "blue"
              : "neutral"
      }
      dot
    >
      {status === "stale"
        ? "Needs review"
        : status[0].toUpperCase() + status.slice(1)}
    </Badge>
  );
}

export function OverviewWorkspace({
  projectName,
  description,
  onEdit,
  onNavigate,
  screens,
  useCases,
}: {
  projectName: string;
  description: string;
  onEdit: () => void;
  onNavigate: (page: string) => void;
  screens: ScreenItem[];
  useCases: UseCase[];
}) {
  return (
    <div className="workspace-page overview-page">
      <SectionHeading
        eyebrow="YOUR PROJECT"
        title={projectName}
        description="From the first screen to the last acceptance criterion."
        actions={
          <Button onClick={onEdit}>
            <Pencil size={14} />
            Edit project brief
          </Button>
        }
      />
      <div className="overview-layout">
        <div>
          <div className="project-brief">
            <span className="section-kicker">THE BRIEF</span>
            <h2>
              Make the journey clear.
              <br />
              Make the work buildable.
            </h2>
            <p>{description}</p>
            <div className="project-tags">
              <Badge>Customer portal</Badge>
              <Badge>Order management</Badge>
              <Badge tone="accent">Sample project</Badge>
            </div>
          </div>
          <div className="overview-screen-strip">
            {screens.slice(0, 4).map((s) => (
              <button key={s.id} onClick={() => onNavigate("screens")}>
                <SampleScreen screen={s} miniature />
                <span>
                  {s.title}
                  <ArrowRight size={12} />
                </span>
              </button>
            ))}
          </div>
        </div>
        <aside className="journey-card">
          <span className="section-kicker">
            A SMALL JOURNEY. A COMPLETE PICTURE.
          </span>
          {[
            {
              page: "screens",
              title: "Start with the screens",
              desc: `${screens.length} sample designs and their context`,
              icon: Image,
            },
            {
              page: "analysis",
              title: "Let the pieces connect",
              desc: "Try the scripted analysis pipeline",
              icon: Sparkles,
            },
            {
              page: "use-cases",
              title: "Make the requirements yours",
              desc: `Review and edit ${useCases.length} sample use cases`,
              icon: FileText,
            },
            {
              page: "changes",
              title: "Understand what changes",
              desc: "Explore the connected sample impact",
              icon: GitBranch,
            },
            {
              page: "export",
              title: "Bring the team along",
              desc: "Preview a simulated tracker export",
              icon: ArrowDownToLine,
            },
          ].map((item, i) => (
            <button key={item.page} onClick={() => onNavigate(item.page)}>
              <span className="journey-step">
                <item.icon size={17} />
              </span>
              <span>
                <small>0{i + 1}</small>
                <strong>{item.title}</strong>
                <p>{item.desc}</p>
              </span>
              <ChevronRight size={15} />
            </button>
          ))}
        </aside>
      </div>
    </div>
  );
}

export function AnalysisWorkspace({
  status,
  stage,
  onStart,
  onCancel,
  onNext,
  onSettings,
  settings,
  screenCount,
}: {
  status: RunStatus;
  stage: number;
  onStart: (scenario: string) => void;
  onCancel: () => void;
  onNext: () => void;
  onSettings: () => void;
  settings: SettingsData;
  screenCount: number;
}) {
  const [scenario, setScenario] = useState("success");
  const [thorough, setThorough] = useState(settings.thoroughness);
  const [size, setSize] = useState(settings.granularity);
  const [preserve, setPreserve] = useState(settings.preserveEdits);
  const vision =
    settings.connections.find((c) => c.id === settings.visionId) ??
    settings.connections[0];
  const text =
    settings.connections.find((c) => c.id === settings.textId) ??
    settings.connections[0];
  return (
    <div className="workspace-page analysis-page">
      <SectionHeading
        eyebrow="FROM PIXELS TO PURPOSE"
        title="Analysis"
        description="See how your screens become a connected set of requirements."
        actions={
          <>
            <Button onClick={onSettings}>
              <Settings2 size={14} />
              Configure models
            </Button>
            {status === "running" ? (
              <Button onClick={onCancel}>
                <Square size={12} />
                Stop simulation
              </Button>
            ) : (
              <Button variant="primary" onClick={() => onStart(scenario)}>
                <Play size={14} />
                {status === "complete" ? "Run again" : "Run sample analysis"}
              </Button>
            )}
          </>
        }
      />
      <div className="simulation-banner">
        <FlaskConical size={16} />
        <div>
          <strong>An interactive demonstration, without the AI calls.</strong>
          <span>
            This scripted run uses the four bundled screens and hand-authored
            results. Your own images are not analysed.
          </span>
        </div>
        <Badge tone="accent">Simulation</Badge>
      </div>
      <div className="analysis-layout">
        <section className="pipeline-panel">
          <div className="panel-header">
            <div>
              <span className="section-kicker">THE ANALYSIS PIPELINE</span>
              <h2>
                {status === "complete"
                  ? "The sample is ready to review."
                  : status === "running"
                    ? "Connecting the dots."
                    : status === "failed"
                      ? "A useful failure state."
                      : "A clear process, at every step."}
              </h2>
            </div>
            <Badge
              tone={
                status === "complete"
                  ? "green"
                  : status === "failed"
                    ? "red"
                    : "neutral"
              }
              dot
            >
              {status === "running"
                ? "Demo running"
                : status === "complete"
                  ? "Demo complete"
                  : status === "cancelled"
                    ? "Stopped"
                    : status === "failed"
                      ? "Demo failed"
                      : "Ready to explore"}
            </Badge>
          </div>
          <div className="pipeline-stages">
            {stages.map((name, i) => {
              const completed = status === "complete" || i < stage;
              const current = status === "running" && i === stage;
              return (
                <div
                  key={name}
                  className={`pipeline-step ${completed ? "completed" : ""} ${current ? "current" : ""} ${status === "failed" && i === stage ? "failed" : ""}`}
                >
                  <span className="pipeline-line" />
                  <span className="pipeline-icon">
                    {completed ? (
                      <Check size={16} />
                    ) : current ? (
                      <LoaderCircle size={16} className="spin" />
                    ) : (
                      <span>{String(i + 1).padStart(2, "0")}</span>
                    )}
                  </span>
                  <div>
                    <h3>
                      {name}
                      {i === 1 && <Badge tone="blue">Vision</Badge>}
                      {i === 4 && <Badge>Writing</Badge>}
                    </h3>
                    <p>{stageNotes[i]}</p>
                    {current && (
                      <div className="stage-pulse">
                        <span />
                        Scripted sample step · no model request
                      </div>
                    )}
                  </div>
                  <span className="pipeline-step-state">
                    {completed ? "Complete" : current ? "In progress" : "—"}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="pipeline-footer">
            {status === "complete" ? (
              <>
                <span>
                  <CheckCheck size={17} />8 use cases · 2 feature groups · 4
                  sample screens
                </span>
                <Button variant="primary" onClick={onNext}>
                  Review use cases
                  <ArrowRight size={14} />
                </Button>
              </>
            ) : status === "failed" ? (
              <div className="inline-error">
                <CircleHelp size={17} />
                <span>
                  Simulated connection error. Nothing was sent or billed. Choose
                  “Successful run” and retry.
                </span>
              </div>
            ) : (
              <>
                <span>
                  <ShieldCheck size={15} />
                  No screenshots sent. No tokens used.
                </span>
                <span>
                  {status === "running"
                    ? `Demo step ${stage + 1} of ${stages.length}`
                    : "You can leave this page while the demo runs."}
                </span>
              </>
            )}
          </div>
        </section>
        <aside className="analysis-options">
          <div className="pane-heading">
            <h3>For this demonstration</h3>
            <span>Run preferences</span>
          </div>
          <div className="model-role">
            <span className="role-icon">
              <Image size={16} />
            </span>
            <div>
              <small>READ SCREENS</small>
              <strong>{vision.name}</strong>
              <span>
                {providers[vision.provider].label} · sample configuration
              </span>
            </div>
          </div>
          <div className="model-role">
            <span className="role-icon violet">
              <Pencil size={16} />
            </span>
            <div>
              <small>PLAN, WRITE & REVIEW</small>
              <strong>{text.name}</strong>
              <span>
                {providers[text.provider].kind} · sample configuration
              </span>
            </div>
          </div>
          <div className="options-section">
            <Field label="Thoroughness">
              <Picker
                label="Analysis thoroughness"
                value={thorough}
                onChange={setThorough}
                disabled={status === "running"}
                options={[
                  { value: "standard", label: "Standard" },
                  { value: "thorough", label: "Thorough · inspect & review" },
                ]}
              />
            </Field>
            <Field label="Use-case size">
              <Picker
                label="Analysis use-case size"
                value={size}
                onChange={setSize}
                disabled={status === "running"}
                options={[
                  { value: "fine", label: "Fine" },
                  { value: "balanced", label: "Balanced" },
                  { value: "coarse", label: "Coarse" },
                ]}
              />
            </Field>
            <Toggle
              label="Preserve my edits"
              checked={preserve}
              onChange={setPreserve}
            />
            <p className="field-hint">
              Preferences demonstrate the controls. The sample output is fixed,
              and existing session edits are retained.
            </p>
          </div>
          <div className="options-section">
            <Field label="Try a scenario">
              <Picker
                label="Analysis simulation scenario"
                value={scenario}
                onChange={setScenario}
                disabled={status === "running"}
                options={[
                  { value: "success", label: "Successful run" },
                  {
                    value: "failure",
                    label: "Connection error",
                    detail: "Explore the failure and retry experience",
                  },
                ]}
              />
            </Field>
          </div>
          <div className="analysis-estimate">
            <span className="section-kicker">ILLUSTRATIVE SCOPE</span>
            <div>
              <span>Workspace images</span>
              <strong>{screenCount}</strong>
            </div>
            <div>
              <span>Bundled result fixture</span>
              <strong>8 use cases</strong>
            </div>
            <div>
              <span>Actual API cost</span>
              <strong className="green-text">$0.00 · no calls</strong>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

const supportingFiles = [
  "README.md",
  "BUILD-PLAN.md",
  "TRACEABILITY.md",
  "QUESTIONS.md",
  "DATA-DICTIONARY.md",
  "REVIEW.md",
  "CHANGELOG.md",
];
function supportingContent(file: string, useCases: UseCase[]) {
  return `# ${file.replace(".md", "").replaceAll("-", " ")}\n\n> Synthetic supporting document · read-only in this prototype.\n\n${file === "BUILD-PLAN.md" ? "## Recommended build order\n\n" + useCases.map((u, i) => `${i + 1}. ${u.id} · ${u.title}`).join("\n") : file === "QUESTIONS.md" ? "## Questions for the product owner\n\n- Which customer roles can approve high-value orders?\n- Is the $5,000 threshold before or after tax?\n- What delivery destinations are supported?" : file === "TRACEABILITY.md" ? "## Screen → use case → business rules\n\n" + useCases.map((u) => `- ${u.screenId} → ${u.id} → ${u.rules.length} sample rules`).join("\n") : "## Northstar customer portal\n\nA customer workspace for browsing orders, creating a new order and tracking fulfilment.\n\n## Journey\n\nSign in → Browse orders → Create an order → Review details\n\n## Feature groups\n\n- Account & access\n- Order management\n\n## About this example\n\nAll content is hand-authored sample data for exploring ScreenScribe."}`;
}
function inlineMarkdown(text: string) {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .map((part, i) =>
      part.startsWith("**") ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : (
        part
      ),
    );
}
export function MarkdownSample({ content }: { content: string }) {
  const lines = content.split("\n");
  const blocks: React.ReactNode[] = [];
  let code: string[] | null = null;
  lines.forEach((line, i) => {
    if (line.startsWith("```")) {
      if (code) {
        blocks.push(
          <pre key={`code-${i}`}>
            {code.map((l, j) => (
              <span key={j}>
                {l.match(/^(GIVEN|WHEN|THEN|AND) /) ? (
                  <>
                    <b>{l.split(" ")[0]}</b>
                    {l.slice(l.indexOf(" "))}
                  </>
                ) : (
                  l
                )}
                {"\n"}
              </span>
            ))}
          </pre>,
        );
        code = null;
      } else code = [];
      return;
    }
    if (code) {
      code.push(line);
      return;
    }
    if (!line.trim()) return;
    if (line.startsWith("### ")) blocks.push(<h3 key={i}>{line.slice(4)}</h3>);
    else if (line.startsWith("## "))
      blocks.push(<h2 key={i}>{line.slice(3)}</h2>);
    else if (line.startsWith("# "))
      blocks.push(<h1 key={i}>{line.slice(2)}</h1>);
    else if (line.startsWith("> "))
      blocks.push(<blockquote key={i}>{line.slice(2)}</blockquote>);
    else if (line.startsWith("- "))
      blocks.push(
        <div className="markdown-bullet" key={i}>
          <span>•</span>
          <p>{inlineMarkdown(line.slice(2))}</p>
        </div>,
      );
    else blocks.push(<p key={i}>{inlineMarkdown(line)}</p>);
  });
  return <article className="markdown-sample">{blocks}</article>;
}

export function UseCasesWorkspace({
  useCases,
  selectedId,
  onSelect,
  documents,
  editor,
  onEdit,
  onDraft,
  onSave,
  onCancelEdit,
  onApprove,
  onRevision,
  onScreen,
  onChanges,
  notify,
}: {
  useCases: UseCase[];
  selectedId: string;
  onSelect: (id: string) => void;
  documents: Record<string, string>;
  editor: { id: string; text: string } | null;
  onEdit: () => void;
  onDraft: (text: string) => void;
  onSave: () => void;
  onCancelEdit: () => void;
  onApprove: () => void;
  onRevision: (text: string) => void;
  onScreen: (id: string) => void;
  onChanges: () => void;
  notify: (text: string) => void;
}) {
  const uc = useCases.find((u) => u.id === selectedId) ?? useCases[0];
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [mode, setMode] = useState("cases");
  const [file, setFile] = useState<string | null>(null);
  const [revise, setRevise] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [revision, setRevision] = useState<string | null>(null);
  const [revising, setRevising] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => setFile(null), [selectedId]);
  const content = documents[uc.id] ?? useCaseMarkdown(uc);
  const isEditing = editor?.id === uc.id && !file;
  const visible = useCases.filter(
    (u) =>
      (filter === "all" || u.status === filter) &&
      (u.id + " " + u.title + " " + u.feature)
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const submitRevision = () => {
    setRevising(true);
    timer.current = setTimeout(() => {
      setRevision(
        content +
          `\n## Proposed refinement\n\n${instructions}\n\n> This sample proposal appends your instruction. No AI rewrite was performed.\n`,
      );
      setRevising(false);
    }, 700);
  };
  return (
    <div className="workspace-page use-cases-page">
      <SectionHeading
        eyebrow="YOUR SPECIFICATION WORKSPACE"
        title="Use cases"
        description="Clear stories. Specific rules. A shared understanding."
        actions={
          <>
            <Badge tone="green" dot>
              {useCases.filter((u) => u.status === "approved").length} of{" "}
              {useCases.length} approved
            </Badge>
            <Button onClick={onChanges}>
              <GitBranch size={14} />
              Review changes
            </Button>
          </>
        }
      />
      <div className="use-case-workbench">
        <aside className="case-navigation">
          <div className="segmented-control">
            <button
              className={mode === "cases" ? "active" : ""}
              onClick={() => {
                setMode("cases");
                setFile(null);
              }}
            >
              Use cases
            </button>
            <button
              className={mode === "files" ? "active" : ""}
              onClick={() => setMode("files")}
            >
              Files
            </button>
          </div>
          <div className="case-search">
            <Search size={14} />
            <input
              aria-label="Search use cases"
              placeholder="Find a use case…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="case-filter">
            <Picker
              label="Filter use cases by status"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All statuses" },
                { value: "approved", label: "Approved" },
                { value: "stale", label: "Needs review" },
                { value: "edited", label: "Edited" },
                { value: "generated", label: "Generated" },
              ]}
            />
            <span>{visible.length}</span>
          </div>
          <div className="case-navigation-scroll">
            {mode === "files" && (
              <div className="supporting-files">
                <div className="nav-group-label">PROJECT DOCUMENTS</div>
                {supportingFiles.map((name) => (
                  <button
                    key={name}
                    className={file === name ? "selected" : ""}
                    onClick={() => {
                      if (editor) {
                        notify(
                          "Save or finish editing the current use case before opening a report.",
                        );
                        return;
                      }
                      setFile(name);
                    }}
                  >
                    <FileText size={14} />
                    {name}
                  </button>
                ))}
                <div className="nav-group-label">USE CASES</div>
              </div>
            )}
            {["Account & access", "Order management"].map((feature) => (
              <div className="case-feature-group" key={feature}>
                <div className="case-group-title">
                  <ChevronDown size={12} />
                  {feature}
                  <span>
                    {visible.filter((u) => u.feature === feature).length}
                  </span>
                </div>
                {visible
                  .filter((u) => u.feature === feature)
                  .map((u) => (
                    <button
                      className={`case-list-item ${u.id === uc.id && !file ? "selected" : ""}`}
                      key={u.id}
                      onClick={() => {
                        onSelect(u.id);
                      }}
                    >
                      <span className={`case-status-dot ${u.status}`} />
                      <span>
                        <small>
                          {u.id}
                          <span>{u.size}</span>
                        </small>
                        <strong>{u.title}</strong>
                      </span>
                    </button>
                  ))}
              </div>
            ))}
            {visible.length === 0 && (
              <div className="small-empty">
                No matching use cases.
                <button
                  className="text-button"
                  onClick={() => {
                    setQuery("");
                    setFilter("all");
                  }}
                >
                  Clear filters
                </button>
              </div>
            )}
          </div>
          <div className="case-nav-foot">
            <FileText size={13} />
            {supportingFiles.length + useCases.length} sample documents
          </div>
        </aside>
        <section className="case-document">
          <div className="document-toolbar">
            <div>
              <FileText size={14} />
              <span className="mono">{file ?? uc.id}</span>
              {!file && <StatusBadge status={uc.status} />}
            </div>
            <div>
              {!file && (
                <>
                  <button
                    className={`document-tab ${!isEditing ? "active" : ""}`}
                    onClick={onCancelEdit}
                  >
                    Read
                  </button>
                  <button
                    className={`document-tab ${isEditing ? "active" : ""}`}
                    onClick={onEdit}
                  >
                    Edit
                  </button>
                  <span className="toolbar-separator" />
                  {isEditing ? (
                    <Button compact variant="primary" onClick={onSave}>
                      <Save size={13} />
                      Save
                    </Button>
                  ) : (
                    <Button
                      compact
                      variant={
                        uc.status === "approved" ? "secondary" : "primary"
                      }
                      onClick={onApprove}
                    >
                      <Check size={13} />
                      {uc.status === "approved" ? "Unapprove" : "Approve"}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
          {!file && uc.status === "stale" && (
            <div className="document-attention">
              <GitBranch size={14} />
              <span>A proposed order policy may affect this use case.</span>
              <button onClick={onChanges}>
                Review impact
                <ArrowRight size={12} />
              </button>
            </div>
          )}
          {isEditing ? (
            <div className="editor-frame">
              <div className="editor-label">
                <Code2 size={13} />
                Markdown editor
                <span>Changes are kept in this browser session only.</span>
              </div>
              <textarea
                spellCheck={false}
                aria-label="Use-case Markdown editor"
                value={editor.text}
                onChange={(e) => onDraft(e.target.value)}
              />
            </div>
          ) : (
            <div className="document-scroll">
              <MarkdownSample
                content={file ? supportingContent(file, useCases) : content}
              />
            </div>
          )}
          <div className="document-statusbar">
            <span>
              <span className="small-dot green" />
              {isEditing
                ? editor.text === content
                  ? "Saved in session"
                  : "Unsaved edits"
                : "Sample document"}
            </span>
            <span>
              {isEditing ? "Ctrl / ⌘ + S to save" : "Markdown · use-case-bdd"}
            </span>
          </div>
        </section>
        <aside className="case-context">
          <div className="pane-label">
            <span>DOCUMENT DETAILS</span>
            <Menu
              trigger={
                <button className="icon-button" aria-label="Document actions">
                  <MoreHorizontal size={15} />
                </button>
              }
              items={[
                {
                  label: "Copy sample Markdown",
                  icon: <Copy size={13} />,
                  onSelect: () => {
                    void navigator.clipboard
                      .writeText(content)
                      .then(() =>
                        notify("Sample Markdown copied to the clipboard."),
                      )
                      .catch(() =>
                        notify("Clipboard is unavailable in this browser."),
                      );
                  },
                },
              ]}
            />
          </div>
          <div className="case-context-scroll">
            <div className="inspector-section">
              <span className="section-kicker">FEATURE</span>
              <p className="feature-label">
                <Layers2 size={14} />
                {uc.feature}
              </p>
              <div className="metadata-list">
                <span>
                  Build size
                  <strong>
                    {uc.size} · {uc.size === "S" ? "Small" : "Medium"}
                  </strong>
                </span>
                <span>
                  Source<strong>Sample fixture</strong>
                </span>
                <span>
                  Rules<strong>{uc.rules.length} illustrated</strong>
                </span>
              </div>
            </div>
            <div className="inspector-section">
              <span className="section-kicker">SCREEN EVIDENCE</span>
              <button
                className="evidence-link"
                onClick={() => onScreen(uc.screenId)}
              >
                <Image size={17} />
                <span>
                  {uc.screenId === "orders"
                    ? "Order overview"
                    : uc.screenId === "login"
                      ? "Sign in"
                      : uc.screenId === "create"
                        ? "Create an order"
                        : "Order details"}
                  <small>Open source screen</small>
                </span>
                <ArrowRight size={13} />
              </button>
            </div>
            <div className="inspector-section">
              <span className="section-kicker">DEPENDENCY CHAIN</span>
              <div className="dependency-state">
                <span className="dependency-dot" />
                <small>BEFORE</small>
                <p>{uc.pre}</p>
              </div>
              <div className="dependency-state after">
                <span className="dependency-dot" />
                <small>AFTER</small>
                <p>{uc.post}</p>
              </div>
            </div>
            <div className="inspector-section">
              <span className="section-kicker">REFINE THE DETAILS</span>
              <p>Explore a proposal before changing your specification.</p>
              <Button
                disabled={isEditing}
                onClick={() => {
                  setInstructions("");
                  setRevision(null);
                  setRevise(true);
                }}
              >
                <Sparkles size={14} />
                Revise with AI<Badge>Mock</Badge>
              </Button>
            </div>
            <div className="inspector-tip">
              <CircleHelp size={16} />
              <p>
                This example is hand-authored. Confirm inferred business policy
                before a real build.
              </p>
            </div>
          </div>
        </aside>
      </div>
      <Modal
        open={revise}
        onClose={() => {
          if (timer.current) clearTimeout(timer.current);
          setRevising(false);
          setRevise(false);
        }}
        title={`Refine ${uc.id}`}
        description="Sample proposal flow · no AI request or file write."
        wide
        footer={
          <>
            <span className="dialog-footer-note">
              {revision
                ? "Review the sample addition before applying."
                : "Your original sample remains unchanged."}
            </span>
            <Button onClick={() => setRevise(false)}>
              {revision ? "Discard proposal" : "Cancel"}
            </Button>
            {revision ? (
              <Button
                variant="primary"
                onClick={() => {
                  onRevision(revision);
                  setRevise(false);
                }}
              >
                Apply sample revision
                <Check size={14} />
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={instructions.trim().length < 8 || revising}
                onClick={submitRevision}
              >
                {revising ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <Sparkles size={14} />
                )}
                Create mock proposal
              </Button>
            )}
          </>
        }
      >
        {!revision ? (
          <>
            <Field
              label="What would you like to change?"
              htmlFor="revision-instructions"
            >
              <textarea
                id="revision-instructions"
                rows={5}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="For example: add an empty state with a clear action to create the first order."
              />
            </Field>
            <div className="suggestion-chips">
              {[
                "Add a clearer empty state",
                "Include a negative validation scenario",
                "Clarify who can perform this action",
              ].map((t) => (
                <button key={t} onClick={() => setInstructions(t)}>
                  {t}
                  <Plus size={11} />
                </button>
              ))}
            </div>
            <p className="field-hint">
              For this demonstration, your instruction is appended as a proposed
              refinement rather than interpreted by an AI model.
            </p>
          </>
        ) : (
          <div className="revision-comparison">
            <div>
              <span>BEFORE</span>
              <pre>{content.slice(-700)}</pre>
            </div>
            <div>
              <span>PROPOSED ADDITION · MOCK</span>
              <div className="diff-addition">
                <strong>+ Proposed refinement</strong>
                <p>+ {instructions}</p>
                <small>+ No AI rewrite was performed.</small>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

const affected = [
  {
    id: "UC-004",
    relation: "Direct",
    reason:
      "Delivery details must collect the information needed for approval.",
    changes: "Add the approval requirement to the order details.",
  },
  {
    id: "UC-007",
    relation: "Direct",
    reason: "Submitting a high-value order now needs an approval state.",
    changes: "Describe the threshold, pending-approval state and confirmation.",
  },
  {
    id: "UC-008",
    relation: "Downstream",
    reason:
      "Order tracking must explain when an order is waiting for approval.",
    changes: "Include an awaiting approval step in the progress timeline.",
  },
];
export function ChangesWorkspace({
  report,
  onReport,
  useCases,
  onApply,
  onDiscard,
  onCase,
}: {
  report: SampleReport;
  onReport: (report: SampleReport) => void;
  useCases: UseCase[];
  onApply: (ids: string[]) => void;
  onDiscard: () => void;
  onCase: (id: string) => void;
}) {
  const [selected, setSelected] = useState(["UC-004", "UC-007"]);
  const [newOpen, setNewOpen] = useState(false);
  const [description, setDescription] = useState(report.description);
  const [target, setTarget] = useState("UC-007");
  const [working, setWorking] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const remaining = selected.filter((id) => !report.appliedIds.includes(id));
  return (
    <div className="workspace-page changes-page">
      <SectionHeading
        eyebrow="CHANGE WITH CONFIDENCE"
        title="Changes"
        description="Understand the ripple before rewriting the requirements."
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setDescription("");
              setNewOpen(true);
            }}
          >
            <Plus size={14} />
            Propose a change
          </Button>
        }
      />
      <div className="changes-layout">
        <aside className="report-navigation">
          <div className="pane-label">
            <span>IMPACT REPORTS</span>
            <Badge>1</Badge>
          </div>
          <div className="report-card selected">
            <div>
              <span className="report-icon">
                <GitBranch size={17} />
              </span>
              <Badge tone={report.status === "applied" ? "green" : "amber"}>
                {report.status === "applied"
                  ? "Applied"
                  : report.status === "discarded"
                    ? "Discarded"
                    : "Review ready"}
              </Badge>
            </div>
            <h3>{report.title}</h3>
            <p>Order management · sample report</p>
            <div>
              <span>IR-001</span>
              <span>3 affected</span>
            </div>
          </div>
          <div className="report-sidebar-note">
            <Network size={21} />
            <h3>Every change has a story.</h3>
            <p>
              The sample graph shows why these use cases are connected. A real
              impact analysis is not running.
            </p>
          </div>
        </aside>
        <section className="report-detail">
          <div className="report-detail-header">
            <div className="eyebrow">
              IR-001 <span>·</span> ILLUSTRATIVE IMPACT
            </div>
            <h2>{report.title}</h2>
            <p>{report.description}</p>
            <div className="report-summary-tags">
              <Badge tone="accent">
                <FlaskConical size={11} />
                Synthetic report
              </Badge>
              <Badge>2 direct</Badge>
              <Badge>1 downstream</Badge>
              <Badge tone={report.status === "applied" ? "green" : "neutral"}>
                {report.status.replace("-", " ")}
              </Badge>
            </div>
          </div>
          <div className="change-flow">
            <div>
              <Image size={18} />
              <span>Screen & policy</span>
            </div>
            <span className="flow-connector" />
            <div>
              <ClipboardList size={18} />
              <span>Order submission</span>
            </div>
            <span className="flow-connector" />
            <div>
              <GitBranch size={18} />
              <span>3 linked use cases</span>
            </div>
          </div>
          <div className="impact-list-heading">
            <div>
              <h3>What would need to change</h3>
              <p>Select the sample updates you want to apply.</p>
            </div>
            <button
              className="text-button"
              onClick={() =>
                setSelected(
                  affected
                    .filter((a) => !report.appliedIds.includes(a.id))
                    .map((a) => a.id),
                )
              }
            >
              Select remaining
            </button>
          </div>
          <div className="impact-items">
            {affected.map((item) => {
              const uc = useCases.find((u) => u.id === item.id)!;
              const applied = report.appliedIds.includes(item.id);
              return (
                <div
                  className={`impact-item ${applied ? "applied" : ""}`}
                  key={item.id}
                >
                  <input
                    type="checkbox"
                    aria-label={`Apply change to ${item.id}`}
                    checked={selected.includes(item.id) || applied}
                    disabled={applied || report.status === "discarded"}
                    onChange={(e) =>
                      setSelected((s) =>
                        e.target.checked
                          ? [...s, item.id]
                          : s.filter((id) => id !== item.id),
                      )
                    }
                  />
                  <div>
                    <div className="impact-item-title">
                      <button onClick={() => onCase(item.id)}>
                        <span className="mono">{item.id}</span>
                        {uc.title}
                        <ArrowRight size={12} />
                      </button>
                      <Badge
                        tone={
                          applied
                            ? "green"
                            : item.relation === "Direct"
                              ? "amber"
                              : "blue"
                        }
                      >
                        {applied ? "Applied in sample" : item.relation}
                      </Badge>
                    </div>
                    <p>{item.reason}</p>
                    <div className="proposed-rule">
                      <Plus size={12} />
                      <span>{item.changes}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="report-open-question">
            <CircleHelp size={17} />
            <div>
              <strong>A question worth answering</strong>
              <p>
                Does the $5,000 threshold include tax and delivery? Which role
                can approve the order?
              </p>
            </div>
          </div>
          <div className="report-actions">
            <span>
              {report.appliedIds.length > 0
                ? `${report.appliedIds.length} sample updates applied`
                : `${remaining.length} sample updates selected`}
            </span>
            <Button
              variant="ghost"
              disabled={
                report.status === "discarded" || report.status === "applied"
              }
              onClick={onDiscard}
            >
              Discard report
            </Button>
            <Button
              variant="primary"
              disabled={!remaining.length || report.status === "discarded"}
              onClick={() => onApply(remaining)}
            >
              <Check size={14} />
              Apply {remaining.length} sample updates
            </Button>
          </div>
        </section>
      </div>
      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="Propose a change"
        description="Explore a sample impact report. No AI analysis takes place."
        footer={
          <>
            <Button onClick={() => setNewOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={description.trim().length < 8 || working}
              onClick={() => {
                setWorking(true);
                timer.current = setTimeout(() => {
                  onReport({
                    title: "Proposed order policy",
                    description,
                    status: "analysed",
                    appliedIds: [],
                  });
                  setSelected(["UC-004", "UC-007"]);
                  setWorking(false);
                  setNewOpen(false);
                }, 700);
              }}
            >
              {working ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <GitBranch size={14} />
              )}
              Create sample report
            </Button>
          </>
        }
      >
        <Field label="Starting use case">
          <Picker
            label="Change target"
            value={target}
            onChange={setTarget}
            options={useCases.map((u) => ({
              value: u.id,
              label: `${u.id} · ${u.title}`,
            }))}
          />
        </Field>
        <Field label="Describe the change" htmlFor="change-description">
          <textarea
            id="change-description"
            rows={5}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="For example: require an approval for orders over $5,000."
          />
        </Field>
        <div className="settings-mini-notice">
          <FlaskConical size={14} />
          This demonstration always illustrates the three sample order
          relationships, regardless of the chosen target.
        </div>
      </Modal>
    </div>
  );
}

export function ExportWorkspace({
  useCases,
  documents,
  onConfigure,
  notify,
}: {
  useCases: UseCase[];
  documents: Record<string, string>;
  onConfigure: (target: string) => void;
  notify: (text: string) => void;
}) {
  const [target, setTarget] = useState("jira");
  const [selection, setSelection] = useState(
    useCases.filter((u) => u.status === "approved").map((u) => u.id),
  );
  const [parents, setParents] = useState(true);
  const [links, setLinks] = useState(true);
  const [updates, setUpdates] = useState(true);
  const [points, setPoints] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);
  const [plan, setPlan] = useState(false);
  const [scenario, setScenario] = useState("success");
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<
    { id: string; ok: boolean; key: string }[]
  >([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const selected = useCases.filter((u) => selection.includes(u.id));
  const targetName =
    target === "jira" ? "Jira" : target === "azdo" ? "Azure DevOps" : "GitHub";
  function simulate(retry = false) {
    setRunning(true);
    timer.current = setTimeout(() => {
      if (retry) setResults((r) => r.map((v) => ({ ...v, ok: true })));
      else
        setResults(
          selected.map((u, i) => ({
            id: u.id,
            ok: scenario === "success" || i !== selected.length - 1,
            key:
              target === "github"
                ? `DEMO #${101 + i}`
                : target === "azdo"
                  ? `DEMO ${101 + i}`
                  : `DEMO-${101 + i}`,
          })),
        );
      setRunning(false);
      notify("Simulated export finished. No tracker was contacted.");
    }, 900);
  }
  function csv() {
    const rows = [
      ["ID", "Title", "Status", "Size", "Source"],
      ...selected.map((u) => [
        u.id,
        u.title,
        u.status,
        u.size,
        "Synthetic sample",
      ]),
    ];
    const content = rows
      .map((r) => r.map((v) => '"' + v.replaceAll('"', '""') + '"').join(","))
      .join("\r\n");
    const url = URL.createObjectURL(
      new Blob([content], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "screenscribe-sample-use-cases.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify("Sample CSV prepared locally. It contains synthetic data only.");
  }
  return (
    <div className="workspace-page export-page">
      <SectionHeading
        eyebrow="READY FOR THE NEXT CHAPTER"
        title="Export"
        description="Turn reviewed requirements into work your team can pick up."
        actions={
          <Button onClick={csv} disabled={!selected.length}>
            <Download size={14} />
            Sample CSV
          </Button>
        }
      />
      <div className="export-targets">
        {[
          {
            id: "jira",
            name: "Jira",
            detail: "northstar-demo · NORTH",
            icon: Layers2,
          },
          {
            id: "azdo",
            name: "Azure DevOps",
            detail: "northstar-demo · Customer portal",
            icon: ClipboardList,
          },
          {
            id: "github",
            name: "GitHub",
            detail: "northstar-demo / customer-portal",
            icon: Github,
          },
        ].map((t) => (
          <button
            key={t.id}
            className={target === t.id ? "selected" : ""}
            aria-pressed={target === t.id}
            onClick={() => {
              setTarget(t.id);
              setResults([]);
            }}
          >
            <span className={`integration-avatar ${t.id}`}>
              <t.icon size={20} />
            </span>
            <span>
              <strong>{t.name}</strong>
              <small>{t.detail}</small>
            </span>
            <span className="target-radio">{target === t.id && <span />}</span>
          </button>
        ))}
      </div>
      <div className="export-layout">
        <section className="export-selection">
          <div className="export-selection-header">
            <div>
              <h2>Choose the use cases</h2>
              <span>{selected.length} selected · sample data only</span>
            </div>
            <div className="selection-shortcuts">
              {["All", "Approved", "None"].map((label) => (
                <button
                  key={label}
                  onClick={() =>
                    setSelection(
                      label === "All"
                        ? useCases.map((u) => u.id)
                        : label === "Approved"
                          ? useCases
                              .filter((u) => u.status === "approved")
                              .map((u) => u.id)
                          : [],
                    )
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="export-table-wrap">
            <table className="export-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select all use cases for export"
                      checked={selection.length === useCases.length}
                      onChange={(e) =>
                        setSelection(
                          e.target.checked ? useCases.map((u) => u.id) : [],
                        )
                      }
                    />
                  </th>
                  <th>USE CASE</th>
                  <th>STATUS</th>
                  <th>SIZE</th>
                  <th>
                    <span className="sr-only">Preview</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {useCases.map((u) => (
                  <tr
                    key={u.id}
                    className={selection.includes(u.id) ? "checked" : ""}
                  >
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${u.id} for export`}
                        checked={selection.includes(u.id)}
                        onChange={(e) =>
                          setSelection((s) =>
                            e.target.checked
                              ? [...s, u.id]
                              : s.filter((id) => id !== u.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      <small className="mono">{u.id}</small>
                      <strong>{u.title}</strong>
                    </td>
                    <td>
                      <StatusBadge status={u.status} />
                    </td>
                    <td>
                      <span className="size-tag">{u.size}</span>
                    </td>
                    <td>
                      <IconButton
                        label={`Preview ${u.id} export`}
                        onClick={() => setPreview(u.id)}
                      >
                        <ExternalLink size={14} />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="export-safety">
            <ShieldCheck size={16} />
            <span>
              Review the exact sample payload before trying the export
              simulation.
            </span>
          </div>
          {results.length > 0 && (
            <div className="export-results" aria-live="polite">
              <div>
                <h3>
                  <CheckCheck size={16} />
                  Simulation results
                </h3>
                <Badge tone={results.every((r) => r.ok) ? "green" : "amber"}>
                  {results.filter((r) => r.ok).length} of {results.length}{" "}
                  successful
                </Badge>
              </div>
              {results.map((r) => (
                <div
                  className={`export-result-row ${r.ok ? "success" : "failed"}`}
                  key={r.id}
                >
                  {r.ok ? <Check size={14} /> : <CircleHelp size={14} />}
                  <strong>{r.id}</strong>
                  <span>{r.ok ? r.key : "Simulated connection timeout"}</span>
                  <Badge>{r.ok ? "Mock created" : "Mock failed"}</Badge>
                </div>
              ))}
              {results.some((r) => !r.ok) && (
                <Button
                  compact
                  onClick={() => simulate(true)}
                  disabled={running}
                >
                  <RotateCcw size={12} />
                  Retry failed sample items
                </Button>
              )}
              <p>
                Illustrative IDs only. No real work items or links were created.
              </p>
            </div>
          )}
        </section>
        <aside className="export-options">
          <div className="pane-heading">
            <h3>Destination & options</h3>
            <button className="text-button" onClick={() => onConfigure(target)}>
              Configure
              <ArrowRight size={12} />
            </button>
          </div>
          <div className="destination-note">
            <FlaskConical size={17} />
            <div>
              <strong>Sample {targetName} destination</strong>
              <span>No account connected. No external writes.</span>
            </div>
          </div>
          <div className="options-section">
            <Toggle
              label="Create feature parents"
              description={
                target === "jira"
                  ? "Group use cases under sample epics."
                  : target === "github"
                    ? "Group features as sample milestones."
                    : "Group work under sample features."
              }
              checked={parents}
              onChange={setParents}
            />
            <Toggle
              label="Link dependencies"
              description="Keep the implementation order visible."
              checked={links}
              onChange={setLinks}
            />
            <Toggle
              label="Update existing items"
              description="Demonstrate target-scoped updates."
              checked={updates}
              onChange={setUpdates}
            />
            <Toggle
              label={
                target === "github"
                  ? "Include size labels"
                  : "Include story points"
              }
              description="Small = 3 · Medium = 5 · Large = 8"
              checked={points}
              onChange={setPoints}
            />
          </div>
          <Field label="Simulation outcome">
            <Picker
              value={scenario}
              onChange={setScenario}
              label="Export simulation outcome"
              options={[
                { value: "success", label: "All successful" },
                {
                  value: "partial",
                  label: "One item fails",
                  detail: "Explore partial results and retry",
                },
              ]}
            />
          </Field>
          <div className="export-action-buttons">
            <Button
              disabled={!selected.length || running}
              onClick={() => setPlan(true)}
            >
              <Search size={14} />
              Preview export plan
            </Button>
            <Button
              variant="primary"
              disabled={!selected.length || running}
              onClick={() => simulate()}
            >
              {running ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <ArrowUpRightIcon />
              )}
              {running ? "Simulating…" : `Simulate export to ${targetName}`}
            </Button>
          </div>
          <p className="field-hint">
            This is a POC. Export options shape the sample plan; they do not
            call a tracker.
          </p>
        </aside>
      </div>
      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        title={`${preview} · ${targetName} preview`}
        description="Illustrative payload from the current sample content. Nothing is sent."
        wide
      >
        <div className="payload-meta">
          <Badge tone="accent">Mock payload</Badge>
          <span>
            {"Sample Markdown · target-specific conversion is deferred"}
          </span>
        </div>
        <pre className="payload-preview">
          {preview
            ? `Title: [${preview}] ${useCases.find((u) => u.id === preview)?.title}\nTarget: ${targetName} sample destination\n\n${documents[preview] ?? useCaseMarkdown(useCases.find((u) => u.id === preview)!)}`
            : ""}
        </pre>
      </Modal>
      <Modal
        open={plan}
        onClose={() => setPlan(false)}
        title="Your sample export plan"
        description="Local preview only. No network requests or tracker changes."
        wide
        footer={
          <>
            <span className="dialog-footer-note">
              Dry-run illustration · {selected.length} sample items
            </span>
            <Button onClick={() => setPlan(false)}>Close preview</Button>
          </>
        }
      >
        <div className="export-plan-summary">
          <Badge tone="accent">{targetName}</Badge>
          <span>
            {parents ? "Feature parents included" : "No feature parents"}
          </span>
          <span>{links ? "Dependencies included" : "No dependency links"}</span>
          <span>{points ? "Size / points included" : "No size / points"}</span>
        </div>
        {selected.map((u) => (
          <div className="export-plan-row" key={u.id}>
            <Plus size={14} />
            <span className="mono">{u.id}</span>
            <strong>{u.title}</strong>
            <Badge>{updates ? "Create / update" : "Create new"}</Badge>
          </div>
        ))}
        <p className="field-hint">
          The payload preview is illustrative. Full target-specific conversion
          and remote identity tracking belong to a later stage.
        </p>
      </Modal>
    </div>
  );
}
function ArrowUpRightIcon() {
  return <ArrowRight size={14} style={{ transform: "rotate(-45deg)" }} />;
}

export function GraphWorkspace({
  useCases,
  onCase,
}: {
  useCases: UseCase[];
  onCase: (id: string) => void;
}) {
  const [selected, setSelected] = useState("UC-003");
  const [query, setQuery] = useState("");
  const [view, setView] = useState("graph");
  const uc = useCases.find((u) => u.id === selected) ?? useCases[2];
  const visible = useCases.filter((u) =>
    (u.id + " " + u.title).toLowerCase().includes(query.toLowerCase()),
  );
  const positions: Record<string, [number, number]> = {
    "UC-001": [60, 180],
    "UC-002": [350, 180],
    "UC-003": [640, 95],
    "UC-004": [640, 320],
    "UC-005": [930, 320],
    "UC-006": [930, 95],
    "UC-007": [1220, 320],
    "UC-008": [1220, 95],
  };
  return (
    <div className="workspace-page graph-page">
      <SectionHeading
        eyebrow="THE BIGGER PICTURE"
        title="Knowledge graph"
        description="See the relationships behind the requirements."
        actions={
          <Badge tone="accent">
            <FlaskConical size={11} />
            Sample relationships
          </Badge>
        }
      />
      <div className="graph-workbench">
        <div className="graph-toolbar">
          <div className="case-search">
            <Search size={14} />
            <input
              aria-label="Search graph nodes"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a use case…"
            />
          </div>
          <div className="segmented-control">
            <button
              className={view === "graph" ? "active" : ""}
              onClick={() => setView("graph")}
            >
              <Network size={13} />
              Graph
            </button>
            <button
              className={view === "list" ? "active" : ""}
              onClick={() => setView("list")}
            >
              <ClipboardList size={13} />
              List
            </button>
          </div>
        </div>
        <div className="graph-layout">
          <div className="graph-canvas">
            {view === "graph" ? (
              <svg
                viewBox="0 0 1510 600"
                role="img"
                aria-label="Sample use-case dependency graph"
              >
                <defs>
                  <marker
                    id="graph-arrow"
                    markerWidth="6"
                    markerHeight="6"
                    refX="5"
                    refY="3"
                    orient="auto"
                  >
                    <path d="M0,0 L6,3 L0,6" fill="var(--graph-edge)" />
                  </marker>
                </defs>
                {[
                  ["UC-001", "UC-002"],
                  ["UC-002", "UC-003"],
                  ["UC-002", "UC-004"],
                  ["UC-003", "UC-006"],
                  ["UC-004", "UC-005"],
                  ["UC-005", "UC-007"],
                  ["UC-006", "UC-008"],
                  ["UC-007", "UC-008"],
                ].map(([from, to]) => {
                  const [x, y] = positions[from];
                  const [tx, ty] = positions[to];
                  return (
                    <path
                      key={from + to}
                      d={`M${x + 218},${y + 47} C${x + 252},${y + 47} ${tx - 38},${ty + 47} ${tx},${ty + 47}`}
                      fill="none"
                      stroke="var(--graph-edge)"
                      strokeWidth={2}
                      markerEnd="url(#graph-arrow)"
                    />
                  );
                })}
                {useCases.map((u) => {
                  const [x, y] = positions[u.id];
                  return (
                    <g
                      key={u.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Select graph node ${u.id}`}
                      onClick={() => setSelected(u.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelected(u.id);
                        }
                      }}
                      className={`graph-node ${selected === u.id ? "selected" : ""}`}
                      opacity={visible.some((v) => v.id === u.id) ? 1 : 0.2}
                    >
                      <rect x={x} y={y} width={218} height={95} rx={10} />
                      <circle cx={x + 19} cy={y + 23} r={4} />
                      <text x={x + 32} y={y + 28} className="graph-node-id">
                        {u.id}
                      </text>
                      <text x={x + 16} y={y + 57}>
                        {u.title.split(" ").slice(0, 4).join(" ")}
                      </text>
                      <text x={x + 16} y={y + 77}>
                        {u.title.split(" ").slice(4).join(" ")}
                      </text>
                    </g>
                  );
                })}
                <text x={62} y={460} className="graph-section-label">
                  ACCOUNT & ACCESS
                </text>
                <text x={640} y={460} className="graph-section-label">
                  ORDER MANAGEMENT
                </text>
              </svg>
            ) : (
              <div className="graph-list">
                {visible.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => setSelected(u.id)}
                    className={selected === u.id ? "selected" : ""}
                  >
                    <Badge>{u.id}</Badge>
                    <strong>{u.title}</strong>
                    <StatusBadge status={u.status} />
                  </button>
                ))}
              </div>
            )}
            <div className="graph-legend">
              <span>
                <i />
                Use case
              </span>
              <span>→</span>Depends on a preceding state
              <span className="subtle-label">
                Static layout · interactive selection
              </span>
            </div>
          </div>
          <aside className="graph-inspector">
            <div className="pane-label">
              <span>SELECTED NODE</span>
              <GitBranch size={14} />
            </div>
            <div className="inspector-section">
              <span className="mono muted">{uc.id}</span>
              <h3>{uc.title}</h3>
              <StatusBadge status={uc.status} />
              <p>{uc.feature}</p>
              <div className="dependency-state">
                <small>REQUIRES</small>
                <p>{uc.pre}</p>
              </div>
              <div className="dependency-state after">
                <small>ESTABLISHES</small>
                <p>{uc.post}</p>
              </div>
              <Button onClick={() => onCase(uc.id)}>
                Open use case
                <ArrowRight size={13} />
              </Button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
