import { useCallback, useEffect, useRef, useState } from "react";
import { PrivateImage } from "./PrivateImage";
import { HomeHero } from "./HomeHero";
import { BrandMark } from "./BrandMark";
import {
  ProjectFiles,
  ProjectLocationField,
  ReconnectProject,
} from "./ProjectFiles";
import { SessionEventSource, downloadPrivate } from "./localSession";
import {
  ArrowRight,
  Bell,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  GitBranch,
  Image,
  Layers2,
  LayoutDashboard,
  LoaderCircle,
  Menu as MenuIcon,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  X,
  Copy,
  MoreHorizontal,
  Download,
  FolderX,
} from "lucide-react";
import type { ConnectionUsage, ProjectDetail, JobStarted } from "../shared/api";
import type {
  ChangeRequest,
  ImpactReport,
  Job,
  ProjectSummary,
  ProjectArea,
  PublicSettings,
  SolutionGraph,
  SolutionModel,
  SpecFileNode,
} from "../shared/types";
import {
  api,
  settingsFromPublic,
  saveSettings,
  testSettings,
  testCapability,
  discoverModels,
} from "./api";
import type { Page, SettingsData } from "./data";
import {
  Badge,
  Button,
  Confirm,
  Field,
  IconButton,
  Menu,
  Modal,
  SectionHeading,
  Picker,
  Toggle,
} from "./ui";
import SettingsWindow from "./SettingsWindow";
import { catalogueIdentity } from "./ConnectionModels";
import { capabilityIdentity } from "./ModelCapabilityTests";
import { RecoveryWindow } from "./RecoveryWindow";
import { JobProgressPanel } from "./JobProgressPanel";
import { failureText } from "./jobFailure";
import {
  projectConnectionChoices,
  savedGenerationKind,
} from "../shared/generationContext";
import { LibraryAreas } from "./LibraryAreas";
import {
  ProjectLifecycleDialog,
  type ProjectAction,
} from "./ProjectLifecycleDialog";
import { RealScreens } from "./RealScreens";
import {
  RealAnalysis,
  RealSpecs,
  RealGraph,
  RealChanges,
  RealExport,
} from "./RealWorkspaces";
import "./real.css";
import {
  readWorkspaceRoute,
  workspaceHash,
  type WorkspaceRoute,
} from "./workspaceNavigation";
import {
  createWorkspaceHistory,
  replaceWorkspaceHash,
} from "./workspaceHistory";

const navigation = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "screens", label: "Screens", icon: Image },
  { id: "analysis", label: "Analysis", icon: Sparkles },
  { id: "use-cases", label: "Use cases", icon: FileText },
  { id: "graph", label: "Knowledge graph", icon: Network },
  { id: "changes", label: "Changes", icon: GitBranch },
  { id: "export", label: "Export", icon: Upload },
] as const;
const emptyGraph: SolutionGraph = { nodes: [], edges: [] };
export default function RealApp() {
  const initial = useRef(readWorkspaceRoute(location.hash));
  const [pid, setPid] = useState(initial.current.pid);
  const [page, setPage] = useState<Page>(initial.current.page);
  const [library, setLibrary] = useState(initial.current.library);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [areas, setAreas] = useState<ProjectArea[]>([]);
  const [selectedArea, setSelectedArea] = useState("all");
  const [projectAreaId, setProjectAreaId] = useState("");
  const [projectAction, setProjectAction] = useState<ProjectAction | null>(
    null,
  );
  const [projectFilter, setProjectFilter] = useState("");
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [model, setModel] = useState<SolutionModel | null>(null);
  const [tree, setTree] = useState<SpecFileNode | null>(null);
  const [graph, setGraph] = useState(emptyGraph);
  const [reports, setReports] = useState<ImpactReport[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [publicSettings, setPublicSettings] = useState<PublicSettings | null>(
    null,
  );
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState("connections");
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width: 760px)").matches,
  );
  const sidebar = useRef<HTMLElement>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [activity, setActivity] = useState(false);
  const stream = useRef<SessionEventSource | null>(null);
  const streamPoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const [projectModal, setProjectModal] = useState<"create" | "edit" | null>(
    null,
  );
  const projectDialogTrigger = useRef<HTMLElement | null>(null);
  const [form, setForm] = useState<{
    name: string;
    description: string;
    additionalContext: string;
    localOnly: boolean;
    outputDir: string;
    workspaceDir?: string;
  }>({
    name: "",
    description: "",
    additionalContext: "",
    localOnly: false,
    outputDir: "",
  });
  const [recovery, setRecovery] = useState<"history" | "trash" | null>(null);
  const recoveryTrigger = useRef<HTMLElement | null>(null);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const markDirty = useCallback((value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  }, []);
  const [pending, setPending] = useState<null | (() => void)>(null);
  const [historyNotice, setHistoryNotice] = useState("");
  const workspaceHistory = useRef<ReturnType<
    typeof createWorkspaceHistory
  > | null>(null);
  const [contentEpoch, setContentEpoch] = useState(0);
  const [caseId, setCaseId] = useState(initial.current.caseId);
  const [screenId, setScreenId] = useState(initial.current.screenId);
  const [changeDraft, setChangeDraft] = useState<{
    projectId: string;
    change: ChangeRequest;
  } | null>(null);
  const [demoOpen, setDemoOpen] = useState(false);
  const demoPending = useRef(false);
  const pidRef = useRef(pid);
  const notify = useCallback((message: string) => {
    setToast(message);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5500);
    return () => clearTimeout(timer);
  }, [toast]);
  const attempt = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError("");
      try {
        return await action();
      } catch (e) {
        setError(e instanceof Error ? e.message : "The operation failed.");
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [],
  );
  const refresh = useCallback(async (id = pidRef.current) => {
    const [list, groups] = await Promise.all([
      api<ProjectSummary[]>("/projects"),
      api<ProjectArea[]>("/areas"),
    ]);
    setProjects(list);
    setAreas(groups);
    setSelectedArea((value) =>
      value === "all" ||
      value === "unassigned" ||
      groups.some((a) => a.id === value)
        ? value
        : "unassigned",
    );
    if (pidRef.current !== id) return;
    if (
      id &&
      !list.some((p) => p.id === id) &&
      readWorkspaceRoute(location.hash).library
    ) {
      // A deleted remembered selection must not resurrect or select another project.
      pidRef.current = "";
      setPid("");
      setCaseId("");
      setScreenId("");
      replaceWorkspaceHash("#/projects");
      setProject(null);
      setModel(null);
      setTree(null);
      setGraph(emptyGraph);
      setReports([]);
      setJobs([]);
      return;
    }
    if (!id) {
      setProject(null);
      setModel(null);
      setTree(null);
      setGraph(emptyGraph);
      setReports([]);
      setJobs([]);
      return;
    }
    const detail = await api<ProjectDetail>(
      "/projects/" + encodeURIComponent(id),
    );
    const [m, t, g, r, j] = await Promise.all([
      detail.hasModel
        ? api<SolutionModel>(`/projects/${id}/model`)
        : Promise.resolve(null),
      api<SpecFileNode>(`/projects/${id}/files`),
      api<SolutionGraph>(`/projects/${id}/graph`),
      api<ImpactReport[]>(`/projects/${id}/impact`),
      api<Job[]>(`/projects/${id}/jobs`),
    ]);
    if (pidRef.current !== id) return;
    setProject(detail);
    setModel(m);
    setTree(t);
    setGraph(g);
    setReports(r);
    setJobs(j);
    setScreenId((s) =>
      detail.screens.some((v) => v.id === s)
        ? s
        : (detail.screens[0]?.id ?? ""),
    );
    setCaseId((s) =>
      m?.useCases.some((v) => v.id === s) ? s : (m?.useCases[0]?.id ?? ""),
    );
    if (detail.activeJobId) {
      const active = j.find((v) => v.id === detail.activeJobId);
      if (active) setJob(active);
    }
  }, []);
  async function bootstrap() {
    setLoading(true);
    try {
      const s = await api<PublicSettings>("/settings");
      setPublicSettings(s);
      setSettings(settingsFromPublic(s));
      await refresh();
      setError("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The local service is unavailable.",
      );
    } finally {
      setLoading(false);
    }
  }
  /** Saved keys Windows cannot unlock: the server keeps that file aside and continues without its keys. */
  async function resetSavedKeys() {
    try {
      const s = await api<PublicSettings>("/settings/keys/reset", "POST");
      setPublicSettings(s);
      setSettings(settingsFromPublic(s));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The saved keys could not be reset.",
      );
    }
  }
  useEffect(() => {
    void bootstrap();
    return () => {
      stream.current?.close();
      if (streamPoll.current) clearInterval(streamPoll.current);
    };
  }, []);
  useEffect(() => {
    if (!publicSettings) return;
    setProject(null);
    setModel(null);
    setLoading(true);
    void refresh(pid)
      .catch((e) => {
        if (pidRef.current === pid) setError(e.message);
      })
      .finally(() => {
        if (pidRef.current === pid) setLoading(false);
      });
  }, [pid]);
  function applyRoute(route: WorkspaceRoute) {
    const switchedProject = route.pid !== pidRef.current;
    if (switchedProject) {
      setProject(null);
      setModel(null);
      setTree(null);
      setGraph(emptyGraph);
      setReports([]);
      setJobs([]);
    }
    pidRef.current = route.pid;
    setPid(route.pid);
    setPage(route.page);
    setLibrary(route.library);
    // A supporting-file link has no case=; keep same-project selections so a
    // background refresh cannot redirect that document to the default use case.
    if (switchedProject || route.caseId) setCaseId(route.caseId);
    if (switchedProject || route.screenId) setScreenId(route.screenId);
    setMobile(false);
  }
  function navigate(route: WorkspaceRoute) {
    setHistoryNotice("");
    const action = () => {
      markDirty(false);
      setContentEpoch((v) => v + 1);
      applyRoute(route);
      const hash = workspaceHash(route);
      workspaceHistory.current!.push(hash);
    };
    if (dirtyRef.current) setPending(() => action);
    else action();
  }
  function changeRoute(
    nextPid: string,
    nextPage: Page,
    nextCase?: string,
    nextScreen?: string,
  ) {
    navigate({
      pid: nextPid,
      page: nextPage,
      library: !nextPid,
      caseId: nextCase ?? (nextPid === pid ? caseId : ""),
      screenId: nextScreen ?? (nextPid === pid ? screenId : ""),
    });
  }
  function showLibrary() {
    navigate({ pid, page, library: true, caseId, screenId });
  }
  useEffect(() => {
    const navigation = createWorkspaceHistory({
      shouldBlock: () => dirtyRef.current,
      onNavigate: (hash) => {
        setHistoryNotice("");
        markDirty(false);
        setContentEpoch((v) => v + 1);
        applyRoute(readWorkspaceRoute(hash));
      },
      onBlocked: (retry, notice) => {
        setHistoryNotice(notice ?? "");
        setPending(() => retry);
      },
    });
    workspaceHistory.current = navigation;
    return () => {
      navigation.dispose();
      workspaceHistory.current = null;
    };
  }, [markDirty]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setMobile(false);
        setSettingsOpen(true);
      }
    };
    const unload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("keydown", key);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("beforeunload", unload);
    };
  }, [dirty]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const changed = () => {
      setNarrow(media.matches);
      if (!media.matches) setMobile(false);
    };
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    if (!mobile) return;
    const panel = sidebar.current!;
    const buttons = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          "button:not(:disabled), a[href], input",
        ),
      ).filter((el) => el.getClientRects().length);
    buttons()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobile(false);
      }
      if (event.key === "Tab") {
        const list = buttons(),
          first = list[0],
          last = list.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    panel.addEventListener("keydown", key);
    return () => {
      panel.removeEventListener("keydown", key);
      if (
        panel.contains(document.activeElement) ||
        document.activeElement === document.body
      )
        document.getElementById("workspace-navigation-toggle")?.focus();
    };
  }, [mobile]);
  function trackJob(next: Job) {
    setJob(next);
    stream.current?.close();
    if (streamPoll.current) clearInterval(streamPoll.current);
    const events = new SessionEventSource(`/api/jobs/${next.id}/events`);
    stream.current = events;
    let lastEventAt = Date.now();
    let refreshing = false;
    // The server closes the stream after a final status; that close is not an interruption.
    let ended = false;
    const update = (value: Job) => {
      setJob(value);
      if (["succeeded", "failed", "cancelled"].includes(value.status)) {
        events.close();
        stream.current = null;
        if (streamPoll.current) clearInterval(streamPoll.current);
        streamPoll.current = null;
        void refresh().catch((e) => setError(e.message));
        if (value.status === "failed")
          setError(failureText(value) ?? "The job failed.");
        else
          notify(
            value.status === "succeeded"
              ? "Operation complete. Saved outputs are ready."
              : "Operation cancelled. Saved work is kept.",
          );
      }
    };
    events.onmessage = (e) => {
      lastEventAt = Date.now();
      const event = JSON.parse(e.data);
      if (event.type === "snapshot") update(event.job);
      else if (event.type === "progress")
        setJob((j) => (j ? { ...j, progress: event.progress } : j));
      else if (event.type === "log")
        setJob((j) => (j ? { ...j, logs: [...j.logs, event.entry] } : j));
      else if (event.type === "usage")
        setJob((j) => (j ? { ...j, usage: event.usage } : j));
      else if (event.type === "live")
        setJob((j) => (j ? { ...j, live: event.calls } : j));
      else if (event.type === "status") {
        if (["succeeded", "failed", "cancelled"].includes(event.status))
          ended = true;
        void api<Job>(`/jobs/${next.id}`)
          .then(update)
          .catch((e) => setError(e.message));
      }
    };
    events.onerror = () => {
      if (ended || stream.current !== events) return;
      setToast(
        "Activity connection interrupted. Reconnecting to the saved job snapshot…",
      );
      void refreshSnapshot();
    };
    async function refreshSnapshot() {
      if (refreshing || stream.current !== events) return;
      refreshing = true;
      try {
        const saved = await api<Job>(`/jobs/${next.id}`);
        if (stream.current === events) update(saved);
      } catch {
        /* The event stream and watchdog retry when the local service returns. */
      } finally {
        refreshing = false;
      }
    }
    // A development proxy or sleeping laptop may leave SSE open without delivering another event.
    // Reading a persisted job is safe; this never starts or retries model/tracker work.
    streamPoll.current = setInterval(() => {
      if (Date.now() - lastEventAt > 8000) void refreshSnapshot();
    }, 5000);
  }
  useEffect(() => {
    if (project?.activeJobId && !stream.current) {
      const active = jobs.find((v) => v.id === project.activeJobId);
      if (active) trackJob(active);
    }
  }, [project?.activeJobId]);
  async function startJob(path: string, body: unknown) {
    if (dirtyRef.current) {
      setError(
        "Save or discard your document draft before starting an operation.",
      );
      return;
    }
    const started = await attempt(() => api<JobStarted>(path, "POST", body));
    if (started) {
      trackJob(started.job);
      setActivity(true);
    }
  }
  const active = !!job && ["queued", "running"].includes(job.status);
  const projectActive = active && job.projectId === pid;
  const filteredProjects = projects.filter(
    (p) =>
      `${p.name} ${p.description}`
        .toLowerCase()
        .includes(projectFilter.trim().toLowerCase()) &&
      (selectedArea === "all" ||
        (selectedArea === "unassigned"
          ? !areas.some((a) => a.id === p.areaId)
          : p.areaId === selectedArea)),
  );
  function editProject() {
    if (!project) return;
    projectDialogTrigger.current = null;
    setProjectAreaId(project.areaId ?? "");
    setForm({
      name: project.name,
      description: project.description,
      additionalContext: project.additionalContext,
      localOnly: project.localOnly ?? false,
      outputDir: project.outputDir,
    });
    setProjectModal("edit");
  }
  function openNewProject() {
    projectDialogTrigger.current = document.activeElement as HTMLElement;
    setForm({
      name: "",
      description: "",
      additionalContext: "",
      localOnly: false,
      outputDir: "",
    });
    setProjectAreaId(
      areas.some((a) => a.id === selectedArea) ? selectedArea : "",
    );
    setProjectModal("create");
  }
  async function saveProject() {
    const result = await attempt(() =>
      projectModal === "create"
        ? api<ProjectDetail>("/projects", "POST", {
            ...form,
            areaId: projectAreaId || null,
          })
        : api<ProjectDetail>(`/projects/${pid}`, "PATCH", {
            ...form,
            areaId: projectAreaId || null,
          }),
    );
    if (result) {
      setProjectModal(null);
      changeRoute(result.id, "screens");
      await refresh(result.id);
      notify("Project saved locally.");
    }
  }
  const openCase = (id: string) => changeRoute(pid, "use-cases", id);
  async function createDemo() {
    if (demoPending.current) return;
    demoPending.current = true;
    try {
      await attempt(async () => {
        const demo = await api<ProjectDetail>("/projects/demo", "POST", {});
        setDemoOpen(false);
        changeRoute(demo.id, "screens");
        await refresh(demo.id);
      });
    } finally {
      demoPending.current = false;
    }
  }
  function proposeChange(
    targetKind: ChangeRequest["targetKind"],
    targetId: string,
    description: string,
  ) {
    setChangeDraft({
      projectId: pid,
      change: { targetKind, targetId, description, source: "manual" },
    });
    changeRoute(pid, "changes");
  }
  if (!settings || !publicSettings)
    return (
      <div className="boot-screen">
        <BrandMark size={54} />
        <h1>Coherence</h1>
        <p>
          {loading
            ? "Opening your local workspace…"
            : error || "Start the local API to open your projects."}
        </p>
        {!loading && (
          <>
            <Button variant="primary" onClick={() => void bootstrap()}>
              <RefreshCw size={14} />
              Retry connection
            </Button>
            {import.meta.env.VITE_COHERENCE_RELEASE !== "1" && (
              <>
                <a href="?prototype">Explore the visual prototype</a>
                <code>npm run dev</code>
              </>
            )}
          </>
        )}
      </div>
    );
  const projectChoices = project
    ? projectConnectionChoices(project, model?.options)
    : {};
  const savedKind = model ? savedGenerationKind(model.generator) : undefined;
  const modelLabel = projectChoices.visionConnectionId ?? settings.visionId;
  const offline = [
    modelLabel,
    projectChoices.textConnectionId ?? settings.textId,
  ].every(
    (id) => settings.connections.find((c) => c.id === id)?.provider === "mock",
  );
  const navigationToggle = (
    <IconButton
      className="mobile-menu-toggle"
      id="workspace-navigation-toggle"
      label="Toggle workspace navigation"
      showTooltip={!library}
      aria-expanded={mobile}
      onClick={() => setMobile((v) => !v)}
    >
      <MenuIcon size={17} />
    </IconButton>
  );
  return (
    <div
      className={`app-shell real-app ${collapsed ? "sidebar-collapsed" : ""} ${settingsOpen ? "settings-active" : ""}`}
    >
      <header className="app-titlebar" inert={mobile || undefined}>
        <div className="app-brand">
          <BrandMark />
          <span>Coherence</span>
        </div>
        {library && navigationToggle}
      </header>
      {mobile && (
        <button
          className="mobile-nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        ref={sidebar}
        aria-label="Workspace navigation"
        inert={(narrow && !mobile) || undefined}
        className={`app-sidebar ${mobile ? "mobile-open" : ""}`}
      >
        <nav aria-label="Global navigation" className="global-navigation">
          <button
            className={`nav-link ${library ? "active" : ""}`}
            aria-label="Projects"
            title="Projects"
            aria-current={library ? "page" : undefined}
            onClick={showLibrary}
          >
            <Folder size={17} />
            <span>Projects</span>
          </button>
        </nav>
        <div className="sidebar-nav-heading">ACTIVE PROJECT</div>
        <div className="sidebar-project">
          <Menu
            trigger={
              <button
                className="project-switcher"
                aria-label={
                  project
                    ? `Switch project · ${project.name}`
                    : "Select a project"
                }
                title={project?.name ?? "Select a project"}
              >
                <span className="project-avatar">
                  {project?.name[0] ?? "S"}
                  <span />
                </span>
                <span>
                  <strong>{project?.name ?? "Select a project"}</strong>
                  <small>
                    {project
                      ? project.screens.length + " screens"
                      : "Choose from your library"}
                  </small>
                </span>
                <ChevronDown size={14} />
              </button>
            }
            items={[
              {
                label: "All projects",
                icon: <Folder size={14} />,
                onSelect: showLibrary,
              },
              ...projects.map((p) => ({
                label: p.name,
                onSelect: () => changeRoute(p.id, "overview"),
              })),
              {
                label: "New project",
                icon: <Plus size={14} />,
                divider: true,
                onSelect: () => {
                  projectDialogTrigger.current = null;
                  setForm({
                    name: "",
                    description: "",
                    additionalContext: "",
                    localOnly: false,
                    outputDir: "",
                  });
                  setProjectModal("create");
                  setProjectAreaId("");
                },
              },
              ...(project
                ? [
                    {
                      label: "Edit project brief",
                      icon: <FileText size={14} />,
                      onSelect: editProject,
                    },
                  ]
                : []),
            ]}
          />
        </div>
        {project ? (
          <nav className="app-navigation" aria-label="Project navigation">
            {navigation.map((n) => (
              <button
                key={n.id}
                className={`nav-link ${page === n.id && !library ? "active" : ""}`}
                aria-current={page === n.id && !library ? "page" : undefined}
                onClick={() => changeRoute(pid, n.id)}
                aria-label={n.label}
                title={n.label}
              >
                <n.icon size={17} />
                <span>{n.label}</span>
                {n.id === "screens" && (
                  <small>{project?.screens.length ?? 0}</small>
                )}
                {n.id === "use-cases" && (
                  <small>{model?.useCases.length ?? 0}</small>
                )}
                {n.id === "analysis" && projectActive && (
                  <LoaderCircle size={13} className="spin" />
                )}
              </button>
            ))}
          </nav>
        ) : (
          <p className="project-selection-hint">
            Select a project to open its workspace.
          </p>
        )}
        <div className="sidebar-flex-space" />
        <div className="sidebar-bottom">
          <button
            className="nav-link"
            aria-label="Activity"
            title="Activity"
            onClick={() => {
              setMobile(false);
              setActivity(true);
            }}
          >
            <Bell size={17} />
            <span>Activity</span>
            {active && <Badge tone="accent">1</Badge>}
          </button>
          <button
            className="nav-link"
            onClick={() => {
              setMobile(false);
              setSettingsOpen(true);
            }}
            aria-label="Open settings"
          >
            <Settings2 size={17} />
            <span>Settings</span>
          </button>
          <div className="sidebar-profile">
            <span className="profile-avatar">
              <Folder size={15} />
            </span>
            <span>
              <strong>Personal workspace</strong>
              <small>Stored on this computer</small>
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
      <main className="app-main" inert={mobile || undefined}>
        {!library && (
          <div className="workspace-toolbar">
            <div className="workspace-breadcrumb">
              {navigationToggle}
              <button
                className="text-button breadcrumb-project"
                aria-label="Project library"
                onClick={showLibrary}
              >
                Projects
              </button>
              <ChevronRight size={12} />
              <strong>{navigation.find((n) => n.id === page)?.label}</strong>
            </div>
            <div className="workspace-toolbar-right">
              <Badge
                tone={
                  savedKind === "offline" ||
                  savedKind === "mixed" ||
                  (!model && offline)
                    ? "amber"
                    : "green"
                }
                dot
              >
                {savedKind === "provider"
                  ? "Saved · model-backed"
                  : savedKind === "mixed"
                    ? "Saved · mixed providers"
                    : savedKind === "offline"
                      ? "Saved · offline generation"
                      : offline
                        ? "Offline fixture provider"
                        : "Local project"}
              </Badge>
              <IconButton
                label="Refresh workspace"
                onClick={() => void attempt(() => refresh())}
              >
                <RefreshCw size={15} />
              </IconButton>
              <IconButton
                label="Settings"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings2 size={16} />
              </IconButton>
            </div>
          </div>
        )}
        {publicSettings?.keysLocked && (
          <div className="real-error" role="alert">
            <span>
              Windows couldn't unlock the AI keys saved in Coherence for this
              account, for example after moving to a new computer or Windows
              account. Your projects and other settings are fine. Reset the
              saved keys to enter them again; the locked copy stays in your
              Coherence data folder.
            </span>
            <Button onClick={() => void resetSavedKeys()}>
              Reset saved keys
            </Button>
          </div>
        )}
        {error && (
          <div className="real-error" role="alert">
            <span>{error}</span>
            <IconButton label="Dismiss error" onClick={() => setError("")}>
              <X size={14} />
            </IconButton>
          </div>
        )}
        {loading ? (
          <div className="real-loading">
            <LoaderCircle className="spin" />
            <p>Opening workspace…</p>
          </div>
        ) : library ? (
          <div
            className={`workspace-page library-page${projects.length ? " has-projects" : ""}`}
          >
            <SectionHeading
              title="Your projects"
              description="Screens, context and specifications, together in one place."
              actions={
                <>
                  {projects.length > 0 && (
                    <>
                      <Button variant="primary" onClick={openNewProject}>
                        <Plus size={15} />
                        New project
                      </Button>
                      <Button onClick={() => setDemoOpen(true)}>
                        <Sparkles size={14} />
                        Try ACME demo
                      </Button>
                    </>
                  )}
                  <div className="library-secondary-actions">
                    <ProjectFiles
                      onOpened={async (id) => {
                        changeRoute(id, "overview");
                        await refresh(id);
                      }}
                    />
                    <IconButton
                      label="Refresh project list"
                      onClick={() => void attempt(() => refresh())}
                    >
                      <RefreshCw size={15} />
                    </IconButton>
                    <Menu
                      trigger={
                        <IconButton
                          label="Library options"
                          id="library-options"
                        >
                          <MoreHorizontal size={17} />
                        </IconButton>
                      }
                      items={[
                        {
                          label: "Local trash",
                          icon: <Trash2 size={14} />,
                          onSelect: () => {
                            recoveryTrigger.current =
                              document.getElementById("library-options");
                            setRecovery("trash");
                          },
                        },
                      ]}
                    />
                  </div>
                </>
              }
            />
            <HomeHero
              hasProjects={projects.length > 0}
              onNewProject={openNewProject}
              onDemo={() => setDemoOpen(true)}
              busy={busy}
            />
            <LibraryAreas
              areas={areas}
              projects={projects}
              selected={selectedArea}
              onSelect={setSelectedArea}
              onRefresh={() => refresh()}
            />
            <div className="library-heading">
              <span className="section-kicker">PROJECTS</span>
              <Badge>
                {filteredProjects.length} / {projects.length}
              </Badge>
              <label className="library-filter">
                <Search size={14} />
                <input
                  aria-label="Filter projects"
                  placeholder="Find a project…"
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                />
              </label>
            </div>
            <div className="project-grid">
              {filteredProjects.map((p) => (
                <div className="project-card-shell" key={p.id}>
                  <button
                    className="project-card"
                    disabled={p.availability === "unavailable"}
                    onClick={() => changeRoute(p.id, "overview")}
                  >
                    <div className="project-card-art">
                      {p.thumbnailScreenId ? (
                        <PrivateImage
                          src={`/api/projects/${p.id}/screens/${p.thumbnailScreenId}/image`}
                          alt=""
                        />
                      ) : (
                        <Layers2 size={35} />
                      )}
                      <Badge>
                        {p.availability === "unavailable"
                          ? "Folder unavailable"
                          : p.status.replace("-", " ")}
                      </Badge>
                    </div>
                    <h3>{p.name}</h3>
                    <p>
                      {p.description ||
                        "Your next shared understanding starts here."}
                    </p>
                    <div>
                      <span>{p.screenCount} screens</span>
                      <span>{p.useCaseCount} use cases</span>
                      <ArrowRight size={14} />
                    </div>
                  </button>
                  {p.availability === "unavailable" && (
                    <ReconnectProject
                      id={p.id}
                      onOpened={async (id) => {
                        changeRoute(id, "overview");
                        await refresh(id);
                      }}
                    />
                  )}
                  <Menu
                    trigger={
                      <IconButton
                        className="project-card-menu"
                        label={`Actions for ${p.name}`}
                      >
                        <MoreHorizontal size={17} />
                      </IconButton>
                    }
                    items={[
                      ...(p.availability === "unavailable"
                        ? [
                            {
                              // Installer finding ST-09: forget a project whose folder is gone; no file is touched.
                              label: "Remove from library",
                              icon: <FolderX size={14} />,
                              onSelect: () =>
                                void api(
                                  `/storage/forget/${encodeURIComponent(p.id)}`,
                                  "POST",
                                )
                                  .then(() => refresh())
                                  .catch((e: unknown) =>
                                    setError(
                                      e instanceof Error
                                        ? e.message
                                        : "The project could not be removed from the library.",
                                    ),
                                  ),
                            },
                          ]
                        : [
                            {
                              // Decision D12: a complete-project backup as one .zip.
                              label: "Export project as .zip",
                              icon: <Download size={14} />,
                              onSelect: () =>
                                void downloadPrivate(
                                  `/api/storage/archive/${encodeURIComponent(p.id)}`,
                                  `${p.id}.zip`,
                                ).catch((e: unknown) =>
                                  setError(
                                    e instanceof Error
                                      ? e.message
                                      : "The project could not be exported.",
                                  ),
                                ),
                            },
                          ]),
                      {
                        label: "Duplicate project",
                        icon: <Copy size={14} />,
                        onSelect: () =>
                          setProjectAction({ kind: "duplicate", project: p }),
                      },
                      {
                        label: "Move to area",
                        icon: <Folder size={14} />,
                        onSelect: () =>
                          setProjectAction({ kind: "move", project: p }),
                      },
                      {
                        label: "Move to trash",
                        icon: <Trash2 size={14} />,
                        danger: true,
                        divider: true,
                        onSelect: () =>
                          setProjectAction({ kind: "trash", project: p }),
                      },
                    ]}
                  />
                </div>
              ))}
              {!filteredProjects.length && (
                <div className="library-empty">
                  <Folder size={24} aria-hidden="true" />
                  {!projects.length && <h3>Your next idea starts here.</h3>}
                  <p>
                    {projects.length
                      ? selectedArea === "all"
                        ? "No projects match your search."
                        : "No projects match this area and search."
                      : "Create your first project, or try the ACME demo to see Coherence in action."}
                  </p>
                  {projects.length > 0 && (
                    <Button
                      onClick={() => {
                        setProjectFilter("");
                        setSelectedArea("all");
                      }}
                    >
                      Show all projects
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : project?.id === pid ? (
          <>
            {page === "overview" && (
              <div className="workspace-page real-overview">
                <SectionHeading
                  eyebrow="THE BIG PICTURE"
                  title={project.name}
                  description={
                    project.description ||
                    "Add a project brief to give your analyst the full picture."
                  }
                  actions={
                    <>
                      <Button
                        disabled={dirty || projectActive}
                        onClick={(e) => {
                          recoveryTrigger.current = e.currentTarget;
                          setRecovery("history");
                        }}
                      >
                        Model history
                      </Button>
                      <Button
                        onClick={() =>
                          void attempt(() =>
                            api(`/projects/${pid}/reveal-output`, "POST", {}),
                          )
                        }
                      >
                        Open output folder
                      </Button>
                      <Button onClick={editProject}>
                        <FileText size={14} />
                        Edit brief
                      </Button>
                    </>
                  }
                />
                <div className="real-overview-grid">
                  <div className="real-panel">
                    <span className="section-kicker">
                      CONTEXT & CONSTRAINTS
                    </span>
                    <h2>A little context goes a long way.</h2>
                    <p className="pre-wrap">
                      {project.additionalContext ||
                        "Capture roles, business rules, constraints and uncertainties here. These details guide analysis alongside your screenshots."}
                    </p>
                    <Button onClick={editProject}>
                      Shape the brief
                      <ArrowRight size={14} />
                    </Button>
                  </div>
                  <div className="real-panel">
                    <span className="section-kicker">WORKSPACE SNAPSHOT</span>
                    <div className="overview-stat-list">
                      <span>
                        Screens<strong>{project.screens.length}</strong>
                      </span>
                      <span>
                        Use cases<strong>{model?.useCases.length ?? 0}</strong>
                      </span>
                      <span>
                        Approved
                        <strong>
                          {model?.useCases.filter(
                            (u) => u.status === "approved",
                          ).length ?? 0}
                        </strong>
                      </span>
                      <span>
                        Review findings
                        <strong>
                          {model?.review.filter((r) => !r.resolved).length ?? 0}
                        </strong>
                      </span>
                    </div>
                    <p className="small muted">
                      {project.storage
                        ? "Complete project folder"
                        : "Specifications folder"}
                    </p>
                    <code className="path-display">
                      {project.projectPath || project.outputDir}
                    </code>
                    <Button
                      compact
                      onClick={() =>
                        void attempt(() =>
                          api(
                            project.storage
                              ? `/storage/reveal/${pid}`
                              : `/projects/${pid}/reveal-output`,
                            "POST",
                            {},
                          ),
                        )
                      }
                    >
                      {project.storage
                        ? "Open project folder ↗"
                        : "Open output folder ↗"}
                    </Button>
                  </div>
                </div>
                <div className="real-panel">
                  <span className="section-kicker">THE JOURNEY</span>
                  <div className="journey-step-row">
                    {navigation
                      .filter((n) =>
                        [
                          "screens",
                          "analysis",
                          "use-cases",
                          "changes",
                          "export",
                        ].includes(n.id),
                      )
                      .map((n, i) => (
                        <button
                          key={n.id}
                          onClick={() => changeRoute(pid, n.id)}
                        >
                          <span>0{i + 1}</span>
                          <n.icon size={21} />
                          <strong>{n.label}</strong>
                          <ArrowRight size={14} />
                        </button>
                      ))}
                  </div>
                </div>
                <div className="project-lifecycle-actions">
                  <Button
                    disabled={dirty || projectActive}
                    onClick={() =>
                      setProjectAction({ kind: "duplicate", project })
                    }
                  >
                    <Copy size={13} />
                    Duplicate project
                  </Button>
                  <Button
                    disabled={dirty || projectActive}
                    onClick={() => setProjectAction({ kind: "move", project })}
                  >
                    <Folder size={13} />
                    Move to area
                  </Button>
                  <Button
                    disabled={dirty || projectActive}
                    variant="ghost"
                    onClick={() => setProjectAction({ kind: "trash", project })}
                  >
                    <Trash2 size={13} />
                    Move to trash
                  </Button>
                </div>
              </div>
            )}
            {page === "screens" && (
              <RealScreens
                onImportFigma={(request) =>
                  startJob(`/projects/${pid}/figma/import-job`, request)
                }
                operationError={error}
                busy={busy}
                onDirty={markDirty}
                project={project}
                model={model}
                screenId={screenId}
                setScreenId={(id) => {
                  if (pidRef.current !== pid) return;
                  setScreenId(id);
                  replaceWorkspaceHash(
                    workspaceHash({
                      pid,
                      page: "screens",
                      library: false,
                      caseId,
                      screenId: id,
                    }),
                  );
                }}
                onRefresh={() => refresh()}
                attempt={attempt}
                notify={notify}
                onNext={() => changeRoute(pid, "analysis")}
                onCase={openCase}
                onProposeChange={(elementId, label) =>
                  proposeChange(
                    "element",
                    elementId,
                    `Describe the change to “${label}”.`,
                  )
                }
                onReanalyse={(sid) =>
                  startJob(`/projects/${pid}/screens/${sid}/reanalyse`, {})
                }
              />
            )}
            {page === "analysis" && (
              <RealAnalysis
                key={project.id}
                project={project}
                model={model}
                settings={settings}
                job={
                  job?.projectId === pid && job.kind === "generate" ? job : null
                }
                busy={busy || projectActive}
                onGenerate={(options) =>
                  startJob(`/projects/${pid}/generate`, options)
                }
                onCancel={() =>
                  void attempt(() => api(`/jobs/${job!.id}/cancel`, "POST", {}))
                }
                onAbandon={() =>
                  void attempt(async () => {
                    await api(`/projects/${pid}/generate/abandon`, "POST", {});
                    setJob(null);
                    notify(
                      "Run abandoned. The steps it finished were discarded; it stays in Activity.",
                    );
                  })
                }
                onSettings={() => {
                  setSettingsCategory("connections");
                  setSettingsOpen(true);
                }}
                onSpecs={() => changeRoute(pid, "use-cases")}
                onProjectConnections={(llm) =>
                  attempt(async () => {
                    await api(`/projects/${pid}`, "PATCH", { llm });
                    await refresh();
                  })
                }
              />
            )}
            {page === "use-cases" && (
              <RealSpecs
                operationError={error}
                busy={busy}
                key={pid + "-" + contentEpoch}
                project={project}
                model={model}
                tree={tree}
                caseId={caseId}
                setCaseId={(id) => {
                  if (pidRef.current === pid) setCaseId(id);
                }}
                settings={settings}
                job={job}
                activityOpen={activity}
                onRefresh={() => refresh()}
                attempt={attempt}
                notify={notify}
                onDirty={markDirty}
                onJob={startJob}
                onImpact={(description) =>
                  proposeChange(
                    "usecase",
                    caseId,
                    `Review the knock-on impact of changes to ${description}.`,
                  )
                }
              />
            )}
            {page === "graph" && (
              <RealGraph
                onProposeChange={(kind, id, label) =>
                  proposeChange(kind, id, `Describe the change to “${label}”.`)
                }
                graph={graph}
                onCase={openCase}
                onScreen={(id) => {
                  changeRoute(pid, "screens", undefined, id);
                }}
              />
            )}
            {page === "changes" && (
              <RealChanges
                key={project.id}
                graph={graph}
                initialChange={
                  changeDraft?.projectId === pid
                    ? changeDraft.change
                    : undefined
                }
                project={project}
                model={model}
                reports={reports}
                settings={settings}
                onJob={startJob}
                attempt={attempt}
                onRefresh={() => refresh()}
                onCase={openCase}
              />
            )}
            {page === "export" && (
              <RealExport
                project={project}
                model={model}
                settings={publicSettings}
                onJob={startJob}
                attempt={attempt}
                job={job}
                onSettings={() => {
                  setSettingsCategory("integrations");
                  setSettingsOpen(true);
                }}
              />
            )}
          </>
        ) : (
          <div className="real-loading">
            <p>Choose a project from the library.</p>
            <Button onClick={() => changeRoute("", "overview")}>
              Your projects
            </Button>
          </div>
        )}
      </main>
      <SettingsWindow
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        live
        initialCategory={settingsCategory}
        notify={notify}
        onTest={testSettings}
        onCapability={async (c, model, capability, mode, signal) => {
          const result = await testCapability(
            c,
            model,
            capability,
            mode,
            signal,
          );
          if (result.persisted && !c.apiKey && !signal?.aborted)
            setSettings((current) =>
              current
                ? {
                    ...current,
                    connections: current.connections.map((row) =>
                      capabilityIdentity(row) === capabilityIdentity(c)
                        ? {
                            ...row,
                            capabilities: {
                              ...row.capabilities,
                              [model]: result.records ?? [result.record],
                            },
                          }
                        : row,
                    ),
                  }
                : current,
            );
          return result;
        }}
        onConnectionUsage={(id) =>
          api<ConnectionUsage>(
            `/settings/connections/${encodeURIComponent(id)}/usage`,
          )
        }
        onReassign={(from, to) =>
          api<{ moved: number; kept: number }>(
            `/settings/connections/${encodeURIComponent(from)}/reassign`,
            "POST",
            { to },
          )
        }
        onDiscover={async (c) => {
          const result = await discoverModels(c);
          // Refresh readonly metadata for an unchanged saved account; never replace a settings draft.
          if (result.catalogue && !c.apiKey)
            setSettings((current) =>
              current
                ? {
                    ...current,
                    connections: current.connections.map((row) =>
                      catalogueIdentity(row) === catalogueIdentity(c)
                        ? { ...row, catalogue: result.catalogue }
                        : row,
                    ),
                  }
                : current,
            );
          return result;
        }}
        onSave={async (value) => {
          const saved = await saveSettings(value, publicSettings.revision ?? 0);
          setPublicSettings(saved);
          const next = settingsFromPublic(saved);
          setSettings(next);
          return next;
        }}
      />
      <RecoveryWindow
        returnFocusRef={recoveryTrigger}
        mode={recovery}
        projectId={pid}
        onClose={() => setRecovery(null)}
        notify={notify}
        onDeleted={async () => {
          await attempt(() => refresh());
        }}
        onRestored={async (id) => {
          if (id !== pid) {
            changeRoute(id, "overview");
          }
          await refresh(id);
        }}
      />
      <Modal
        open={!!projectModal}
        returnFocusRef={projectDialogTrigger}
        onClose={() => !busy && setProjectModal(null)}
        title={
          projectModal === "create"
            ? "A new shared understanding."
            : "Shape the project brief."
        }
        description="Give the analyst the context that pictures alone can’t provide."
        footer={
          <>
            <Button onClick={() => setProjectModal(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={busy || !form.name.trim()}
              onClick={() => void saveProject()}
            >
              {busy ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <CheckIcon />
              )}
              {projectModal === "create" ? "Create project" : "Save project"}
            </Button>
          </>
        }
      >
        <div className="real-form">
          {error && (
            <p className="real-inline-error" role="alert">
              {error}
            </p>
          )}
          <Field label="Project name" htmlFor="project-name">
            <input
              id="project-name"
              value={form.name}
              onChange={(e) => setForm((v) => ({ ...v, name: e.target.value }))}
              autoFocus
            />
          </Field>
          <Field label="Area">
            <Picker
              label="Project area"
              value={projectAreaId}
              onChange={setProjectAreaId}
              options={[
                { value: "", label: "Unassigned" },
                ...areas.map((a) => ({ value: a.id, label: a.name })),
              ]}
            />
          </Field>
          <Field label="Description" htmlFor="project-description">
            <textarea
              id="project-description"
              rows={3}
              value={form.description}
              onChange={(e) =>
                setForm((v) => ({ ...v, description: e.target.value }))
              }
            />
          </Field>
          <Field
            label="Roles, business rules & constraints"
            htmlFor="project-context"
          >
            <textarea
              id="project-context"
              rows={5}
              value={form.additionalContext}
              onChange={(e) =>
                setForm((v) => ({ ...v, additionalContext: e.target.value }))
              }
            />
          </Field>
          <Toggle
            label="Keep AI analysis on this computer"
            checked={form.localOnly}
            onChange={(localOnly) => setForm((v) => ({ ...v, localOnly }))}
            description="Blocks cloud and LAN model destinations for every AI role. Allows offline fixtures and Ollama/compatible servers on loopback. Figma and tracker integrations are separate."
          />
          <ProjectLocationField
            workspaceDir={form.workspaceDir}
            onWorkspaceChange={(workspaceDir) =>
              setForm((v) => ({ ...v, workspaceDir }))
            }
            project={
              projectModal === "edit" ? (project ?? undefined) : undefined
            }
          />
        </div>
      </Modal>
      <Modal
        open={activity}
        onClose={() => setActivity(false)}
        title="Workspace activity"
        description="Saved progress, provider usage and operation history."
        wide
        footer={
          active ? (
            <Button
              onClick={() =>
                void attempt(() => api(`/jobs/${job.id}/cancel`, "POST", {}))
              }
            >
              Cancel running operation
            </Button>
          ) : (
            <>
              <Button onClick={() => setActivity(false)}>Done</Button>
              {job?.kind === "screen-reanalysis" &&
                job.status === "succeeded" && (
                  <Button
                    variant="primary"
                    onClick={() => {
                      setActivity(false);
                      changeRoute(pid, "changes");
                    }}
                  >
                    Review screen changes
                    <ArrowRight size={13} />
                  </Button>
                )}
            </>
          )
        }
      >
        <div className="real-activity">
          {job && (
            <>
              <div className="inline-between">
                <strong>
                  {job.kind.replaceAll("-", " ")} · {job.status}
                </strong>
              </div>
              <JobProgressPanel job={job} />
              <p className="small muted">
                {job.usage.calls} provider calls · {job.usage.inputTokens} input
                / {job.usage.outputTokens} output tokens ·{" "}
                {job.usage.costUsd === undefined
                  ? "cost unknown"
                  : `~${job.usage.costUsd.toFixed(4)} estimated`}
              </p>
              <div className="real-log" role="log">
                {job.logs.map((l, i) => (
                  <div className={l.level} key={i}>
                    <time>{l.at.slice(11, 19)}</time>
                    <span>{l.message}</span>
                  </div>
                ))}
              </div>
              {failureText(job) && (
                <p className="real-inline-error">{failureText(job)}</p>
              )}
            </>
          )}
          <h3>Project history</h3>
          {jobs.length ? (
            jobs.map((j) => (
              <button
                className="job-history-row"
                key={j.id}
                disabled={active && j.id !== job.id}
                onClick={() => setJob(j)}
              >
                <span>
                  {j.kind.replaceAll("-", " ")}
                  <small>{new Date(j.createdAt).toLocaleString()}</small>
                </span>
                <Badge
                  tone={
                    j.status === "succeeded"
                      ? "green"
                      : j.status === "failed"
                        ? "amber"
                        : "neutral"
                  }
                >
                  {j.status}
                </Badge>
              </button>
            ))
          ) : (
            <p className="muted">Your operations will appear here.</p>
          )}
        </div>
      </Modal>
      <Modal
        open={demoOpen}
        onClose={() => !demoPending.current && setDemoOpen(false)}
        title="Try the ACME demo"
        description="Create a new, independent project with fictional screenshots. Existing projects stay unchanged."
        footer={
          <>
            <Button disabled={busy} onClick={() => setDemoOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void createDemo()}
            >
              Create demo project
            </Button>
          </>
        }
      >
        <p>
          Screens → simulated analysis → editable use cases. The offline demo
          needs no AI key and makes no paid AI calls. Creating it does not start
          analysis.
        </p>
        <p className="muted">
          Already tried ACME? Open that project from your library to keep
          working. This action creates another copy; it does not reuse an
          existing demo.
        </p>
        {error && (
          <p role="alert" className="real-inline-error">
            {error}
          </p>
        )}
      </Modal>
      <Confirm
        open={!!pending}
        title="Keep your document draft?"
        description={
          historyNotice ||
          "You have unsaved edits. Keep editing to save them, or discard the draft to continue."
        }
        onCancel={() => {
          setPending(null);
          setHistoryNotice("");
        }}
        onDiscard={() => {
          const action = pending;
          setPending(null);
          action?.();
        }}
      />
      <ProjectLifecycleDialog
        action={projectAction}
        areas={areas}
        onClose={() => setProjectAction(null)}
        onComplete={async (result) => {
          const action = projectAction;
          setProjectAction(null);
          if (action?.kind === "duplicate" && result) {
            changeRoute(result.id, "screens");
            await attempt(() => refresh(result.id));
            notify(
              "Duplicate created in Draft. Analysis can be run independently.",
            );
          } else {
            if (action?.kind === "trash")
              setProjects((list) =>
                list.filter((p) => p.id !== action.project.id),
              );
            const deletedCurrent =
              action?.kind === "trash" && action.project.id === pid;
            if (
              action?.kind === "trash" &&
              job?.projectId === action.project.id
            )
              setJob(null);
            if (deletedCurrent) {
              changeRoute("", "overview");
            }
            await attempt(() => refresh(deletedCurrent ? "" : pid));
            notify(
              action?.kind === "trash"
                ? "Project moved to Local trash. You can restore it there. Published remote items were kept."
                : "Project moved to its area.",
            );
          }
        }}
      />
      {toast && (
        <div className="toast-stack" role="status">
          <div className="toast">
            <span>{toast}</span>
            <button
              aria-label="Dismiss notification"
              onClick={() => setToast("")}
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
function CheckIcon() {
  return <ArrowRight size={14} />;
}
