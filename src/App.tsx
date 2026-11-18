import { useCallback, useEffect, useState } from "react";
import { BrandMark } from "./BrandMark";
import {
  ArrowRight,
  Bell,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Command,
  FileText,
  FlaskConical,
  Folder,
  GitBranch,
  Image,
  Keyboard,
  LayoutDashboard,
  LoaderCircle,
  Menu as MenuIcon,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import {
  initialScreens,
  initialSettings,
  initialUseCases,
  stageNotes,
  stages,
  useCaseMarkdown,
  type Page,
  type ScreenItem,
  type SettingsData,
  type UseCase,
} from "./data";
import { Badge, Button, Confirm, Field, IconButton, Menu, Modal } from "./ui";
import SettingsWindow from "./SettingsWindow";
import ScreensWorkspace from "./ScreensWorkspace";
import {
  AnalysisWorkspace,
  ChangesWorkspace,
  ExportWorkspace,
  GraphWorkspace,
  OverviewWorkspace,
  UseCasesWorkspace,
  type RunStatus,
  type SampleReport,
} from "./Workspaces";

const navigation = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "screens", label: "Screens", icon: Image },
  { id: "analysis", label: "Analysis", icon: Sparkles },
  { id: "use-cases", label: "Use cases", icon: FileText },
  { id: "graph", label: "Knowledge graph", icon: Network },
  { id: "changes", label: "Changes", icon: GitBranch },
  { id: "export", label: "Export", icon: Upload },
] as const;
const sampleReport: SampleReport = {
  title: "An approval step for larger orders",
  description:
    "Require a manager’s approval for orders over $5,000 before the order can be fulfilled.",
  status: "analysed",
  appliedIds: [],
};
const readPage = (): Page => {
  const p = window.location.hash.replace("#/", "").split("?")[0];
  return navigation.some((n) => n.id === p) ? (p as Page) : "screens";
};

export default function App() {
  const [page, setPage] = useState<Page>(readPage);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [screens, setScreens] = useState(() => structuredClone(initialScreens));
  const [screenId, setScreenId] = useState("orders");
  const [useCases, setUseCases] = useState(() =>
    structuredClone(initialUseCases),
  );
  const [caseId, setCaseId] = useState("UC-003");
  const [documents, setDocuments] = useState<Record<string, string>>({});
  const [editor, setEditor] = useState<{ id: string; text: string } | null>(
    null,
  );
  const [pending, setPending] = useState<null | (() => void)>(null);
  const [settings, setSettings] = useState<SettingsData>(() =>
    structuredClone(initialSettings),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState("connections");
  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  const [runStage, setRunStage] = useState(0);
  const [runScenario, setRunScenario] = useState("success");
  const [report, setReport] = useState(() => structuredClone(sampleReport));
  const [activity, setActivity] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [help, setHelp] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [projectEdit, setProjectEdit] = useState(false);
  const [projectName, setProjectName] = useState("Northstar customer portal");
  const [description, setDescription] = useState(
    "A considered customer portal for a growing wholesale business. Customers can securely sign in, browse their orders, create new orders and follow each delivery. Our goal: make every interaction clear, and every requirement ready to build.",
  );
  const [briefName, setBriefName] = useState(projectName);
  const [briefDescription, setBriefDescription] = useState(description);
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const notify = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts([{ id, text }]);
    setTimeout(() => setToasts((t) => t.filter((v) => v.id !== id)), 4800);
  }, []);
  const getDocument = (id: string) =>
    documents[id] ?? useCaseMarkdown(useCases.find((u) => u.id === id)!);
  const editorDirty = !!editor && editor.text !== getDocument(editor.id);

  function requestAction(action: () => void) {
    if (editorDirty) setPending(() => action);
    else {
      setEditor(null);
      action();
    }
  }
  function navigate(next: string) {
    if (!navigation.some((n) => n.id === next)) return;
    requestAction(() => {
      setPage(next as Page);
      window.location.hash = "/" + next;
      setMobileNav(false);
    });
  }
  function openCase(id: string) {
    requestAction(() => {
      setCaseId(id);
      setPage("use-cases");
      window.location.hash = "/use-cases";
      setMobileNav(false);
    });
  }
  function openScreen(id: string) {
    requestAction(() => {
      if (screens.some((s) => s.id === id)) setScreenId(id);
      else
        notify(
          "The bundled source screen is no longer in this sample filmstrip.",
        );
      setPage("screens");
      window.location.hash = "/screens";
    });
  }
  function openSettings(category = "connections") {
    setSettingsCategory(category);
    setSettingsOpen(true);
  }
  function saveDocument() {
    if (!editor) return;
    setDocuments((d) => ({ ...d, [editor.id]: editor.text }));
    setUseCases((u) =>
      u.map((c) => (c.id === editor.id ? { ...c, status: "edited" } : c)),
    );
    notify("Sample document saved in this session. No file was written.");
  }
  function completePending(save: boolean) {
    if (save) saveDocument();
    const action = pending;
    setPending(null);
    setEditor(null);
    action?.();
  }
  function startRun(scenario: string) {
    setRunScenario(scenario);
    setRunStage(0);
    setRunStatus("running");
    notify("Scripted analysis started. No images are being sent to a model.");
  }
  useEffect(() => {
    if (runStatus !== "running") return;
    const timer = setTimeout(() => {
      if (runScenario === "failure" && runStage === 1) {
        setRunStatus("failed");
        return;
      }
      if (runStage < stages.length - 1) setRunStage((s) => s + 1);
      else {
        setRunStatus("complete");
        notify(
          "Sample analysis complete. The bundled results are ready to explore.",
        );
      }
    }, 900);
    return () => clearTimeout(timer);
  }, [runStatus, runStage, runScenario, notify]);
  useEffect(() => {
    document.title = `${navigation.find((n) => n.id === page)?.label} · Coherence`;
  }, [page]);
  useEffect(() => {
    const onHash = () => {
      const next = readPage();
      if (next === page) return;
      if (editorDirty) {
        window.history.replaceState(null, "", "#/" + page);
        requestAction(() => {
          setPage(next);
          window.location.hash = "/" + next;
        });
      } else {
        setEditor(null);
        setPage(next);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        openSettings();
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "k" &&
        !settingsOpen
      ) {
        e.preventDefault();
        setCommandOpen((v) => !v);
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "s" &&
        !settingsOpen &&
        editor
      ) {
        e.preventDefault();
        saveDocument();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (editorDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [editorDirty]);

  function applyChanges(ids: string[]) {
    setUseCases((items) =>
      items.map((u) => (ids.includes(u.id) ? { ...u, status: "edited" } : u)),
    );
    setDocuments((current) => {
      const next = { ...current };
      for (const id of ids) {
        const uc = useCases.find((u) => u.id === id)!;
        next[id] =
          (current[id] ?? useCaseMarkdown(uc)) +
          `\n## Sample change applied\n\n${report.description}\n\n> Illustrative update applied in this browser session. No AI rewrite occurred.\n`;
      }
      return next;
    });
    const appliedIds = Array.from(new Set([...report.appliedIds, ...ids]));
    setReport((r) => ({
      ...r,
      appliedIds,
      status: appliedIds.length === 3 ? "applied" : "partially-applied",
    }));
    notify(
      `${ids.length} sample use cases updated. Review their new content before approving.`,
    );
  }
  function reset() {
    screens.forEach((s) => {
      if (s.url) URL.revokeObjectURL(s.url);
    });
    setScreens(structuredClone(initialScreens));
    setScreenId("orders");
    setUseCases(structuredClone(initialUseCases));
    setCaseId("UC-003");
    setDocuments({});
    setEditor(null);
    setSettings(structuredClone(initialSettings));
    setRunStatus("idle");
    setRunStage(0);
    setReport(structuredClone(sampleReport));
    setProjectName("Northstar customer portal");
    setDescription(
      "A considered customer portal for a growing wholesale business. Customers can securely sign in, browse their orders, create new orders and follow each delivery. Our goal: make every interaction clear, and every requirement ready to build.",
    );
    setResetOpen(false);
    setPage("screens");
    window.location.hash = "/screens";
    notify("Sample workspace restored.");
  }
  const commandItems = [
    ...navigation.map((n) => ({
      label: n.label,
      detail: "Workspace",
      icon: n.icon,
      action: () => navigate(n.id),
    })),
    {
      label: "Settings",
      detail: "Configure your workspace",
      icon: Settings2,
      action: () => openSettings(),
    },
    ...useCases.map((u) => ({
      label: `${u.id} · ${u.title}`,
      detail: "Sample use case",
      icon: FileText,
      action: () => openCase(u.id),
    })),
  ].filter((c) =>
    (c.label + " " + c.detail)
      .toLowerCase()
      .includes(commandQuery.toLowerCase()),
  );
  return (
    <div
      className={`app-shell ${collapsed ? "sidebar-collapsed" : ""} ${settingsOpen ? "settings-active" : ""}`}
    >
      <header className="app-titlebar">
        <div className="app-brand">
          <BrandMark />
          <span>Coherence</span>
        </div>
        <div className="app-window-tab">
          <span className="tiny-status-dot" />
          Northstar customer portal<Badge>Workspace</Badge>
        </div>
        <div className="titlebar-right">
          <span>LOCAL DESIGN PREVIEW</span>
          <button
            onClick={() => setHelp(true)}
            aria-label="About this prototype"
          >
            <CircleHelp size={14} />
          </button>
        </div>
      </header>
      {mobileNav && (
        <button
          className="mobile-nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`app-sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <div className="sidebar-project">
          <Menu
            trigger={
              <button className="project-switcher">
                <span className="project-avatar">
                  N<span />
                </span>
                <span>
                  <strong>Northstar</strong>
                  <small>Customer portal</small>
                </span>
                <ChevronDown size={14} />
              </button>
            }
            items={[
              {
                label: "Project overview",
                icon: <Folder size={14} />,
                onSelect: () => navigate("overview"),
              },
              {
                label: "Edit project brief",
                icon: <FileText size={14} />,
                onSelect: () => {
                  setBriefName(projectName);
                  setBriefDescription(description);
                  setProjectEdit(true);
                },
              },
              {
                label: "Reset sample workspace",
                icon: <RotateCcw size={14} />,
                divider: true,
                onSelect: () => setResetOpen(true),
              },
            ]}
          />
          <button
            className="sidebar-search"
            onClick={() => {
              setCommandQuery("");
              setCommandOpen(true);
            }}
          >
            <Search size={14} />
            <span>Go to anything</span>
            <kbd>Ctrl K</kbd>
          </button>
        </div>
        <div className="sidebar-nav-heading">WORKSPACE</div>
        <nav className="app-navigation" aria-label="Main workspace navigation">
          {navigation.map((n) => (
            <button
              key={n.id}
              className={`nav-link ${page === n.id ? "active" : ""}`}
              aria-current={page === n.id ? "page" : undefined}
              aria-label={n.label}
              onClick={() => navigate(n.id)}
            >
              <n.icon size={17} />
              <span>{n.label}</span>
              {n.id === "screens" && <small>{screens.length}</small>}
              {n.id === "use-cases" && <small>{useCases.length}</small>}
              {n.id === "changes" &&
                useCases.some((u) => u.status === "stale") && (
                  <small className="attention-count">
                    {useCases.filter((u) => u.status === "stale").length}
                  </small>
                )}
              {n.id === "analysis" && runStatus === "running" && (
                <LoaderCircle size={12} className="spin" />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-flex-space" />
        <div className="sidebar-note">
          <span className="sidebar-note-symbol">✧</span>
          <strong>Clarity, before code.</strong>
          <p>Explore the journey from a screen to a shared understanding.</p>
          <button onClick={() => setHelp(true)}>
            Take a look around
            <ArrowRight size={12} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <button className="nav-link" onClick={() => setActivity(true)}>
            <span
              className={`activity-icon ${runStatus === "running" ? "running" : ""}`}
            >
              {runStatus === "running" ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <Bell size={17} />
              )}
            </span>
            <span>Activity</span>
            {runStatus === "running" && (
              <small className="attention-count">1</small>
            )}
          </button>
          <button
            className="nav-link settings-nav-link"
            aria-label="Open settings"
            onClick={() => openSettings()}
          >
            <Settings2 size={17} />
            <span>Settings</span>
            <kbd>Ctrl ,</kbd>
          </button>
          <div className="sidebar-profile">
            <span className="profile-avatar">JD</span>
            <span>
              <strong>Jamie Davis</strong>
              <small>Sample workspace</small>
            </span>
            <IconButton
              label={collapsed ? "Expand navigation" : "Collapse navigation"}
              onClick={() => setCollapsed((v) => !v)}
            >
              {collapsed ? (
                <PanelLeftOpen size={15} />
              ) : (
                <PanelLeftClose size={15} />
              )}
            </IconButton>
          </div>
        </div>
      </aside>
      <main className="app-main">
        <div className="workspace-toolbar">
          <div className="workspace-breadcrumb">
            <IconButton
              label="Toggle workspace navigation"
              className="mobile-menu-toggle"
              onClick={() => setMobileNav((v) => !v)}
            >
              <MenuIcon size={18} />
            </IconButton>
            <span className="breadcrumb-project">Northstar</span>
            <ChevronRight size={12} />
            <strong>{navigation.find((n) => n.id === page)?.label}</strong>
          </div>
          <div className="workspace-toolbar-right">
            <Badge tone="accent" dot>
              POC · sample data
            </Badge>
            <span className="toolbar-separator" />
            <IconButton
              label="Search workspace"
              onClick={() => {
                setCommandQuery("");
                setCommandOpen(true);
              }}
            >
              <Search size={16} />
            </IconButton>
            <IconButton label="Settings" onClick={() => openSettings()}>
              <Settings2 size={16} />
            </IconButton>
          </div>
        </div>
        {page === "overview" && (
          <OverviewWorkspace
            projectName={projectName}
            description={description}
            onEdit={() => {
              setBriefName(projectName);
              setBriefDescription(description);
              setProjectEdit(true);
            }}
            onNavigate={navigate}
            screens={screens}
            useCases={useCases}
          />
        )}
        {page === "screens" && (
          <ScreensWorkspace
            screens={screens}
            selectedId={screenId}
            onSelect={setScreenId}
            onUpdate={(id, patch) =>
              setScreens((s) =>
                s.map((x) => (x.id === id ? { ...x, ...patch } : x)),
              )
            }
            onAdd={(items) => {
              setScreens((s) => [...s, ...items]);
              setScreenId(items[0].id);
            }}
            onRemove={(id) =>
              setScreens((s) => {
                const next = s.filter((x) => x.id !== id);
                setScreenId(next[0].id);
                return next;
              })
            }
            onReorder={(from, to) =>
              setScreens((s) => {
                const next = [...s];
                const [item] = next.splice(from, 1);
                next.splice(to, 0, item);
                return next;
              })
            }
            onNext={() => navigate("analysis")}
            onOpenCase={openCase}
            notify={notify}
          />
        )}
        {page === "analysis" && (
          <AnalysisWorkspace
            status={runStatus}
            stage={runStage}
            onStart={startRun}
            onCancel={() => {
              setRunStatus("cancelled");
              notify(
                "The scripted demonstration was stopped. Existing sample results are unchanged.",
              );
            }}
            onNext={() => navigate("use-cases")}
            onSettings={() => openSettings("analysis")}
            settings={settings}
            screenCount={screens.length}
          />
        )}
        {page === "use-cases" && (
          <UseCasesWorkspace
            useCases={useCases}
            selectedId={caseId}
            onSelect={(id) => requestAction(() => setCaseId(id))}
            documents={documents}
            editor={editor}
            onEdit={() => setEditor({ id: caseId, text: getDocument(caseId) })}
            onDraft={(text) => setEditor((e) => (e ? { ...e, text } : null))}
            onSave={saveDocument}
            onCancelEdit={() => requestAction(() => setEditor(null))}
            onApprove={() => {
              setUseCases((items) =>
                items.map((u) =>
                  u.id === caseId
                    ? {
                        ...u,
                        status: u.status === "approved" ? "edited" : "approved",
                      }
                    : u,
                ),
              );
              notify("Review status updated in the sample session.");
            }}
            onRevision={(text) => {
              setDocuments((d) => ({ ...d, [caseId]: text }));
              setUseCases((items) =>
                items.map((u) =>
                  u.id === caseId ? { ...u, status: "edited" } : u,
                ),
              );
              notify("Sample revision applied. No AI model was called.");
            }}
            onScreen={openScreen}
            onChanges={() => navigate("changes")}
            notify={notify}
          />
        )}
        {page === "graph" && (
          <GraphWorkspace useCases={useCases} onCase={openCase} />
        )}
        {page === "changes" && (
          <ChangesWorkspace
            report={report}
            onReport={(value) => {
              setReport(value);
              setUseCases((items) =>
                items.map((u) =>
                  ["UC-004", "UC-007", "UC-008"].includes(u.id)
                    ? { ...u, status: "stale" }
                    : u,
                ),
              );
            }}
            useCases={useCases}
            onApply={applyChanges}
            onDiscard={() => {
              setReport((r) => ({ ...r, status: "discarded" }));
              setUseCases((items) =>
                items.map((u) =>
                  u.status === "stale" ? { ...u, status: "generated" } : u,
                ),
              );
              notify(
                "Sample report discarded. Applied edits remain in the session.",
              );
            }}
            onCase={openCase}
          />
        )}
        {page === "export" && (
          <ExportWorkspace
            useCases={useCases}
            documents={documents}
            onConfigure={openSettings}
            notify={notify}
          />
        )}
      </main>
      <footer className="app-statusbar">
        <div>
          <FlaskConical size={11} />
          <strong>Interactive prototype</strong>
          <span>All AI, connection tests and exports are simulated.</span>
        </div>
        <div>
          <span className="small-dot" />
          Session only
          <button onClick={() => setResetOpen(true)}>Reset preview</button>
        </div>
      </footer>
      <SettingsWindow
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSave={setSettings}
        initialCategory={settingsCategory}
        notify={notify}
      />
      <Confirm
        open={!!pending}
        title="Your edits are still here."
        description="Save the sample document before continuing, or discard the unsaved edits. Nothing has been written to a file."
        onCancel={() => setPending(null)}
        onDiscard={() => completePending(false)}
        onSave={() => completePending(true)}
        saveLabel="Save and continue"
        discardLabel="Discard edits"
      />
      <Modal
        open={activity}
        onClose={() => setActivity(false)}
        title="Workspace activity"
        description="Scripted sample activity. No AI requests, background worker or paid calls."
        footer={
          <>
            <span className="dialog-footer-note">
              Closing this window keeps the sample timer running.
            </span>
            <Button onClick={() => setActivity(false)}>Close</Button>
            {runStatus === "running" && (
              <Button onClick={() => setRunStatus("cancelled")}>
                <SquareIcon />
                Stop simulation
              </Button>
            )}
          </>
        }
      >
        <div className="activity-run">
          <div className="inline-between">
            <strong>Northstar · sample analysis</strong>
            <Badge tone={runStatus === "complete" ? "green" : "accent"}>
              {runStatus === "idle" ? "Not started" : runStatus}
            </Badge>
          </div>
          {runStatus === "idle" ? (
            <p className="muted">
              Start a sample analysis to explore stage-by-stage feedback.
            </p>
          ) : (
            <>
              <p>{stages[runStage]}</p>
              <div className="activity-progress">
                <span
                  style={{
                    width: `${runStatus === "complete" ? 100 : (runStage / stages.length) * 100}%`,
                  }}
                />
              </div>
              <p className="field-hint">
                Scripted steps completed, not actual AI progress.
              </p>
            </>
          )}
          <Button
            onClick={() => {
              setActivity(false);
              navigate("analysis");
            }}
          >
            Open analysis
            <ArrowRight size={13} />
          </Button>
        </div>
      </Modal>
      <Modal
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        title="Go to anything"
        description="Navigate the sample workspace."
        wide
      >
        <div className="command-input">
          <Search size={18} />
          <input
            autoFocus
            aria-label="Search workspace commands"
            value={commandQuery}
            onChange={(e) => setCommandQuery(e.target.value)}
            placeholder="Screens, settings, a use case…"
          />
        </div>
        <div className="command-results">
          {commandItems.map((c) => (
            <button
              key={c.label}
              onClick={() => {
                setCommandOpen(false);
                c.action();
              }}
            >
              <c.icon size={17} />
              <span>
                {c.label}
                <small>{c.detail}</small>
              </span>
              <ArrowRight size={14} />
            </button>
          ))}
          {!commandItems.length && (
            <p className="muted">No matching commands.</p>
          )}
        </div>
      </Modal>
      <Modal
        open={projectEdit}
        onClose={() => setProjectEdit(false)}
        title="The project brief"
        description="A little context makes every screen more useful."
        footer={
          <>
            <Button onClick={() => setProjectEdit(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!briefName.trim()}
              onClick={() => {
                setProjectName(briefName.trim());
                setDescription(briefDescription);
                setProjectEdit(false);
                notify("Sample project brief updated for this session.");
              }}
            >
              Save sample brief
              <Check size={14} />
            </Button>
          </>
        }
      >
        <Field label="Project name" htmlFor="project-name">
          <input
            id="project-name"
            value={briefName}
            onChange={(e) => setBriefName(e.target.value)}
          />
        </Field>
        <Field label="Description" htmlFor="project-description">
          <textarea
            id="project-description"
            rows={7}
            value={briefDescription}
            onChange={(e) => setBriefDescription(e.target.value)}
          />
        </Field>
        <Badge tone="accent">Sample session only</Badge>
      </Modal>
      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="A fresh look at the sample?"
        description="Restore the original sample screens, use cases, settings and report. This discards this session’s changes."
        footer={
          <>
            <Button onClick={() => setResetOpen(false)}>Keep exploring</Button>
            <Button variant="primary" onClick={reset}>
              <RotateCcw size={14} />
              Reset sample workspace
            </Button>
          </>
        }
      >
        <p className="muted">
          Your original ScreenScribe application is never accessed by this
          prototype.
        </p>
      </Modal>
      <Modal
        open={help}
        onClose={() => setHelp(false)}
        title="Clarity, before code."
        description="A hands-on preview of Coherence. Everything is synthetic; the interactions are yours to explore."
        wide
      >
        <div className="tour-list">
          {[
            {
              icon: Settings2,
              title: "Make Settings your first stop.",
              text: "Configure sample cloud and local models. Open Advanced, try a mock failure, resize the category rail, and drag the window.",
            },
            {
              icon: Image,
              title: "Give the screens some context.",
              text: "Select screens, add notes, inspect sample elements, reorder the journey or preview your own local image.",
            },
            {
              icon: Sparkles,
              title: "Follow the sample analysis.",
              text: "Run or stop the scripted pipeline. Try the failure scenario and see how activity stays visible.",
            },
            {
              icon: FileText,
              title: "Make the requirements yours.",
              text: "Edit Markdown, approve a use case, review a mock revision proposal and apply selected sample changes.",
            },
            {
              icon: Upload,
              title: "Preview the handoff.",
              text: "Choose a tracker, inspect sample payloads, simulate a partial export and retry, or download a synthetic CSV.",
            },
          ].map((t) => (
            <div key={t.title}>
              <span>
                <t.icon size={20} />
              </span>
              <div>
                <h3>{t.title}</h3>
                <p>{t.text}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="settings-mini-notice">
          <FlaskConical size={15} />
          No services are connected. Refresh resets the workspace. Real
          integration is outside Stage 1.
        </div>
      </Modal>
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div className="toast" key={t.id}>
            <span>
              <Check size={14} />
            </span>
            <p>{t.text}</p>
            <button
              aria-label="Dismiss notification"
              onClick={() =>
                setToasts((all) => all.filter((x) => x.id !== t.id))
              }
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
function SquareIcon() {
  return <span className="stop-square" />;
}
