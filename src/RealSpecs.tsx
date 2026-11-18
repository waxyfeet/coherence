import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  GitBranch,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type {
  ReviseUseCaseResult,
  RevisionProposalReview,
  SaveSpecFileResponse,
  SpecFileContent,
  SyncResult,
  SearchHit,
} from "../shared/api";
import type {
  Job,
  Project,
  SolutionModel,
  SpecFileNode,
} from "../shared/types";
import type { SettingsData } from "./data";
import { api } from "./api";
import { prefersReducedMotion } from "./appearance";
import { replaceWorkspaceHash } from "./workspaceHistory";
import { projectConnectionChoices } from "../shared/generationContext";
import {
  Badge,
  Button,
  Confirm,
  Field,
  IconButton,
  Menu,
  Modal,
  Picker,
  SectionHeading,
} from "./ui";
import { RevisionDiff } from "./RevisionDiff";
import { MarkdownDocument } from "./MarkdownDocument";
import type { Attempt } from "./RealScreens";
type Props = {
  operationError: string;
  busy: boolean;
  project: Project;
  model: SolutionModel | null;
  tree: SpecFileNode | null;
  caseId: string;
  setCaseId: (id: string) => void;
  settings: SettingsData;
  job: Job | null;
  activityOpen: boolean;
  onRefresh: () => Promise<void>;
  attempt: Attempt;
  notify: (s: string) => void;
  onDirty: (dirty: boolean) => void;
  onJob: (path: string, body: unknown) => Promise<void>;
  onImpact: (description: string) => void;
};
function flatten(node: SpecFileNode | null): SpecFileNode[] {
  if (!node) return [];
  return [node, ...(node.children ?? []).flatMap(flatten)];
}
export function RealSpecs({
  operationError,
  busy,
  project,
  model,
  tree,
  caseId,
  setCaseId,
  settings,
  job,
  activityOpen,
  onRefresh,
  attempt,
  notify,
  onDirty,
  onJob,
  onImpact,
}: Props) {
  const selected = model?.useCases.find((u) => u.id === caseId);
  const textConnectionId =
    projectConnectionChoices(project, model?.options).textConnectionId ??
    settings.textId;
  const textModelId =
    projectConnectionChoices(project, model?.options).textModelId ??
    (settings.connections.find((c) => c.id === textConnectionId)?.provider ===
    "mock"
      ? "demo"
      : undefined);
  const writer = settings.connections.find((c) => c.id === textConnectionId);
  const writerConfigured =
    !!writer &&
    (writer.provider === "mock" ||
      !!(textModelId && writer.modelIds?.includes(textModelId)));
  const [path, setPath] = useState("");
  const [file, setFile] = useState<SpecFileContent | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [pending, setPending] = useState<null | (() => void)>(null);
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [proposal, setProposal] = useState<RevisionProposalReview | null>(null);
  const [proposalId, setProposalId] = useState("");
  const [proposalError, setProposalError] = useState("");
  const [reviewInvalid, setReviewInvalid] = useState(false);
  const [proposalLoading, setProposalLoading] = useState(false);
  const proposalSequence = useRef(0);
  const [messages, setMessages] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [raw, setRaw] = useState(false);
  const sequence = useRef(0);
  const documentRoot = useRef<HTMLDivElement>(null);
  const scrollTarget = useRef<{ anchor?: string; line?: number } | null>(null);
  useEffect(() => {
    if (
      loading ||
      editing ||
      !file ||
      !documentRoot.current ||
      !scrollTarget.current
    )
      return;
    const target = scrollTarget.current;
    const element = target.line
      ? documentRoot.current.querySelector(
          `[data-source-line="${target.line}"]`,
        )
      : Array.from(
          documentRoot.current.querySelectorAll<HTMLElement>("[id]"),
        ).find((e) => e.id === target.anchor);
    if (element) {
      element.scrollIntoView({ block: "start", behavior: "instant" });
      scrollTarget.current = null;
    }
  }, [file?.content, loading, editing, raw]);
  const [outline, setOutline] = useState<
    { id: string; label: string; level: string }[]
  >([]);
  useEffect(() => {
    setOutline(
      Array.from(
        documentRoot.current?.querySelectorAll<HTMLHeadingElement>(
          ".markdown-document h2, .markdown-document h3",
        ) ?? [],
      ).map((h) => ({
        id: h.id,
        label: h.textContent ?? "",
        level: h.tagName,
      })),
    );
  }, [file?.content, editing, raw, loading]);
  const dirty = editing && draft !== (file?.content ?? "");
  const seenProposal = useRef("");
  const initialFile = useRef(
    new URLSearchParams(location.hash.split("?")[1] ?? "").get("file"),
  );
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  useEffect(() => {
    if (search.trim().length < 2) {
      setSearchHits([]);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      void api<SearchHit[]>(
        `/projects/${project.id}/search?q=${encodeURIComponent(search)}`,
      )
        .then((hits) => {
          if (active) setSearchHits(hits);
        })
        .catch(() => {
          if (active) setSearchHits([]);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [search, project.id]);
  const files = flatten(tree).filter(
    (f) => f.type !== "dir" && /\.(md|markdown|feature)$/i.test(f.path),
  );
  async function load(link: string, line?: number) {
    const hashIndex = link.indexOf("#");
    const nextPath = hashIndex < 0 ? link : link.slice(0, hashIndex);
    let anchor = hashIndex < 0 ? undefined : link.slice(hashIndex + 1);
    try {
      if (anchor) anchor = decodeURIComponent(anchor);
    } catch {}
    scrollTarget.current = { anchor, line };
    if (line) setRaw(true);
    const token = ++sequence.current;
    setPath(nextPath);
    setLoading(true);
    setEditing(false);
    setMessages([]);
    setFile(null);
    await attempt(async () => {
      const content = await api<SpecFileContent>(
        `/projects/${project.id}/files/content?path=${encodeURIComponent(nextPath)}`,
      );
      if (sequence.current !== token) return;
      setFile(content);
      setDraft(content.content);
      if (content.useCaseId) setCaseId(content.useCaseId);
    });
    if (sequence.current === token) setLoading(false);
  }
  useEffect(() => {
    if (initialFile.current) {
      const p = initialFile.current;
      initialFile.current = null;
      const line = Number(
        new URLSearchParams(location.hash.split("?")[1] ?? "").get("line"),
      );
      void load(p, Number.isInteger(line) && line > 0 ? line : undefined);
      return;
    }
    if (selected) {
      const next =
        selected.filePath ?? `use-cases/${selected.id}-${selected.slug}.md`;
      if (file?.useCaseId !== selected.id) void load(next);
    } else if (!path && files[0]) void load(files[0].path);
  }, [selected?.id, model?.generatedAt]);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    if (
      !activityOpen &&
      job?.projectId === project.id &&
      job.kind === "revise" &&
      job.status === "succeeded" &&
      seenProposal.current !== job.id
    ) {
      const result = job.result as ReviseUseCaseResult;
      if (result?.proposalId) {
        seenProposal.current = job.id;
        void loadProposal(result.proposalId);
      }
    }
  }, [job?.id, job?.status, activityOpen]);
  async function loadProposal(id: string) {
    const sequence = ++proposalSequence.current;
    setProposalId(id);
    setProposal(null);
    setProposalError("");
    setReviewInvalid(false);
    setProposalLoading(true);
    try {
      const saved = await api<RevisionProposalReview>(
        `/projects/${project.id}/proposals/${id}`,
      );
      if (sequence !== proposalSequence.current) return;
      if (saved.status === "pending" && saved.reviewToken) setProposal(saved);
      else setProposalId("");
    } catch (error) {
      if (sequence === proposalSequence.current) {
        setReviewInvalid(true);
        setProposalError(
          error instanceof Error
            ? error.message
            : "The complete proposal could not be loaded. Review is required before Apply.",
        );
      }
    } finally {
      if (sequence === proposalSequence.current) setProposalLoading(false);
    }
  }
  async function discardProposal() {
    if (!proposalId || busy) return;
    await attempt(async () => {
      await api(
        `/projects/${project.id}/proposals/${proposalId}/discard`,
        "POST",
        {},
      );
      proposalSequence.current++;
      setProposalId("");
      setProposal(null);
    });
  }
  async function applyProposal() {
    if (!proposal || busy || dirty || proposalLoading || reviewInvalid) return;
    const reviewed = proposal;
    await attempt(async () => {
      try {
        await api(
          `/projects/${project.id}/proposals/${reviewed.id}/apply`,
          "POST",
          { reviewToken: reviewed.reviewToken },
        );
      } catch (error) {
        setReviewInvalid(true);
        setProposalError(
          error instanceof Error
            ? error.message
            : "Apply failed. Review again before retrying.",
        );
        throw error;
      }
      setProposalId("");
      setProposal(null);
      await onRefresh();
      if (path) await load(path);
      notify("Reviewed proposal applied.");
    });
  }
  function choose(nextPath: string, id?: string, line?: number) {
    const action = () => {
      if (id) setCaseId(id);
      replaceWorkspaceHash(
        `#/projects/${encodeURIComponent(project.id)}/use-cases?file=${encodeURIComponent(nextPath)}${id ? "&case=" + encodeURIComponent(id) : ""}${line ? "&line=" + line : ""}`,
      );
      void load(nextPath, line);
    };
    if (dirty) setPending(() => action);
    else action();
  }
  async function save() {
    if (!file || saving) return;
    setSaving(true);
    const result = await attempt(() =>
      api<SaveSpecFileResponse>(
        `/projects/${project.id}/files/content`,
        "PUT",
        {
          path: file.path,
          content: draft,
          baseHash: file.contentHash,
          baseMtimeMs: file.mtimeMs,
        },
      ),
    );
    if (result) {
      setMessages(result.parseErrors);
      const fresh = await attempt(() =>
        api<SpecFileContent>(
          `/projects/${project.id}/files/content?path=${encodeURIComponent(file.path)}`,
        ),
      );
      if (fresh) {
        setFile(fresh);
        setDraft(fresh.content);
        setEditing(false);
      }
      await onRefresh();
      notify(
        result.parseErrors.length
          ? "File saved. Review the parsing notes before continuing."
          : "Markdown saved. Linked outputs have been refreshed.",
      );
    }
    setSaving(false);
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "s" &&
        editing &&
        !document.querySelector(".settings-window")
      ) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const cases =
    model?.useCases.filter(
      (u) =>
        (status === "all" || u.status === status) &&
        (u.id + " " + u.title + " " + u.story.iWant)
          .toLowerCase()
          .includes(search.toLowerCase()),
    ) ?? [];
  if (!model)
    return (
      <div className="workspace-page">
        <SectionHeading
          eyebrow="DEVELOPER-READY SPECIFICATIONS"
          title="A place for every requirement."
          description="Generate from your screenshots to create linked use cases and editable Markdown."
        />
        <div className="real-empty-evidence">
          <FileText size={42} />
          <h2>Your specification is waiting to take shape.</h2>
          <p>
            Start in Analysis. The workbench will show stories, exact UI rules,
            <br />
            BDD scenarios, evidence and supporting files here.
          </p>
        </div>
      </div>
    );
  const activeCase = file?.useCaseId
    ? model.useCases.find((u) => u.id === file.useCaseId)
    : undefined;
  return (
    <div className="workspace-page use-cases-page">
      <SectionHeading
        eyebrow="SHARED UNDERSTANDING"
        title="Use cases"
        description={`${model.useCases.length} connected use cases. Human judgement stays at the centre.`}
        actions={
          <>
            <Button
              onClick={() =>
                void attempt(async () => {
                  const result = await api<SyncResult>(
                    `/projects/${project.id}/sync`,
                    "POST",
                    {},
                  );
                  await onRefresh();
                  if (path && !dirty) await load(path);
                  setMessages(result.parseErrors.flatMap((p) => p.errors));
                  notify(
                    `${result.changed.length} disk changes synced; ${result.missingFiles.length} missing files.`,
                  );
                })
              }
              disabled={dirty}
            >
              <RefreshCw size={14} />
              Sync from disk
            </Button>
            <Menu
              trigger={
                <Button>
                  <MoreHorizontal size={15} />
                </Button>
              }
              items={[
                {
                  label: "Re-render supporting outputs",
                  onSelect: () =>
                    void attempt(async () => {
                      await api(`/projects/${project.id}/rerender`, "POST", {});
                      await onRefresh();
                      if (path) await load(path);
                      notify(
                        "Generated outputs refreshed. Human edits are preserved.",
                      );
                    }),
                },
              ]}
            />
          </>
        }
      />
      <div className="use-case-workbench">
        <aside className="case-navigation">
          <div className="case-search">
            <Search size={14} />
            <input
              aria-label="Search use cases"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find a use case…"
            />
          </div>
          <div className="case-filter">
            <Picker
              value={status}
              onChange={setStatus}
              label="Filter use cases"
              options={[
                { value: "all", label: "All statuses" },
                { value: "generated", label: "Generated" },
                { value: "edited", label: "Edited" },
                { value: "approved", label: "Approved" },
                { value: "stale", label: "Needs review" },
              ]}
            />
          </div>
          <div className="case-navigation-scroll">
            {search.trim().length >= 2 && (
              <div className="disk-search-results">
                <div className="nav-group-label">
                  MATCHES IN SAVED FILES · {searchHits.length}
                </div>
                {searchHits.slice(0, 30).map((hit, i) => (
                  <button
                    key={hit.path + "-" + i}
                    onClick={() => choose(hit.path, hit.useCaseId, hit.line)}
                  >
                    <strong>{hit.title}</strong>
                    <small>
                      {hit.path}:{hit.line}
                    </small>
                    <span>{hit.preview}</span>
                  </button>
                ))}
              </div>
            )}
            {model.features.map((feature) => (
              <div className="case-feature-group" key={feature.id}>
                <div className="case-group-title">
                  <ChevronDown size={12} />
                  {feature.name}
                </div>
                {cases
                  .filter((u) => u.featureId === feature.id)
                  .map((u) => (
                    <button
                      key={u.id}
                      className={`case-nav-item ${activeCase?.id === u.id ? "selected" : ""}`}
                      onClick={() =>
                        choose(
                          u.filePath ?? `use-cases/${u.id}-${u.slug}.md`,
                          u.id,
                        )
                      }
                    >
                      <FileText size={14} />
                      <span>
                        <small>{u.id}</small>
                        <strong>{u.title}</strong>
                      </span>
                      <span
                        className={`small-dot ${u.status === "approved" ? "green" : u.status === "stale" ? "amber" : ""}`}
                      />
                    </button>
                  ))}
              </div>
            ))}
            {!cases.length && (
              <p className="small-empty">No matching use cases.</p>
            )}
            <div className="supporting-files">
              <div className="nav-group-label">
                <Folder size={12} />
                SUPPORTING FILES
              </div>
              {files
                .filter((f) => !f.path.startsWith("use-cases/"))
                .map((f) => (
                  <button
                    className={file?.path === f.path ? "selected" : ""}
                    key={f.path}
                    onClick={() => choose(f.path)}
                  >
                    <FileCode2 size={13} />
                    <span>{f.name}</span>
                  </button>
                ))}
            </div>
          </div>
          <div className="case-nav-foot">
            <ShieldCheck size={13} />
            <span>Markdown is the editable source.</span>
          </div>
        </aside>
        <section className="case-document">
          <div className="document-toolbar">
            <div>
              <FileText size={14} />
              <span className="mono">
                {(file?.path ?? path) || "Choose a document"}
              </span>
              {activeCase && (
                <Badge
                  tone={
                    activeCase.status === "approved"
                      ? "green"
                      : activeCase.status === "stale"
                        ? "amber"
                        : "neutral"
                  }
                >
                  {activeCase.status}
                </Badge>
              )}
            </div>
            <div>
              {editing ? (
                <>
                  <Button
                    compact
                    onClick={() =>
                      dirty
                        ? setPending(() => () => {
                            setDraft(file?.content ?? "");
                            setEditing(false);
                          })
                        : setEditing(false)
                    }
                  >
                    Cancel
                  </Button>
                  <Button
                    compact
                    variant="primary"
                    disabled={!dirty || saving}
                    onClick={() => void save()}
                  >
                    <Save size={13} />
                    {saving ? "Saving…" : "Save"}
                  </Button>
                </>
              ) : (
                <>
                  <IconButton
                    label={
                      raw ? "Read rendered Markdown" : "View Markdown source"
                    }
                    onClick={() => setRaw((v) => !v)}
                  >
                    <FileCode2 size={15} />
                  </IconButton>
                  <Button
                    compact
                    disabled={!file || file.path.endsWith(".feature")}
                    onClick={() => setEditing(true)}
                  >
                    <Pencil size={13} />
                    Edit
                  </Button>
                  {activeCase && (
                    <Button compact onClick={() => setRevisionOpen(true)}>
                      <Sparkles size={13} />
                      Revise
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
          {messages.length > 0 && (
            <div className="document-attention" role="status">
              {messages.map((m, i) => (
                <p key={i}>{m}</p>
              ))}
            </div>
          )}
          {loading ? (
            <div className="real-loading">
              <LoaderCircle className="spin" />
            </div>
          ) : editing ? (
            <div className="editor-frame">
              <div className="editor-label">
                <span>MARKDOWN SOURCE · EXACT CONTENT</span>
                <span>Ctrl S to save</span>
              </div>
              <textarea
                aria-label="Markdown editor"
                spellCheck={false}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  onDirty(e.target.value !== (file?.content ?? ""));
                }}
              />
            </div>
          ) : (
            <div className="document-scroll" ref={documentRoot}>
              {file &&
                (raw || file.path.endsWith(".feature") ? (
                  <pre className="raw-markdown source-line-view">
                    <code>
                      {file.content.split("\n").map((text, index) => (
                        <span key={index} data-source-line={index + 1}>
                          {text || " "}
                          {"\n"}
                        </span>
                      ))}
                    </code>
                  </pre>
                ) : (
                  <MarkdownDocument
                    content={file.content}
                    projectId={project.id}
                    path={file.path}
                    onFile={(p) => choose(p)}
                  />
                ))}
              {!file && (
                <div className="real-loading">
                  <p>
                    This file could not be opened. Your saved files are
                    retained.
                  </p>
                  <Button onClick={() => void load(path)}>
                    Retry opening file
                  </Button>
                </div>
              )}
            </div>
          )}
          <div className="document-statusbar">
            <span>
              <span className={`small-dot ${dirty ? "amber" : "green"}`} />
              {dirty
                ? "Unsaved draft"
                : editing
                  ? "Editing saved content"
                  : "Saved file"}
            </span>
            <span>
              {file?.content.length.toLocaleString() ?? 0} characters ·{" "}
              {file?.path.endsWith(".feature") ? "Gherkin" : "Markdown"}
            </span>
          </div>
        </section>
        <aside className="case-context">
          <div className="pane-label">
            <span>CONTEXT & CONNECTIONS</span>
            <GitBranch size={14} />
          </div>
          <div className="case-context-scroll">
            {!!outline.length && (
              <nav
                className="inspector-section document-outline"
                aria-label="Document outline"
              >
                <span className="section-kicker">ON THIS PAGE</span>
                {outline.map((heading, i) => (
                  <button
                    key={heading.id + "-" + i}
                    className={`outline-link ${heading.level === "H3" ? "nested" : ""}`}
                    onClick={() =>
                      documentRoot.current
                        ?.querySelectorAll("[id]")
                        .forEach((element) => {
                          if (element.id === heading.id)
                            element.scrollIntoView({
                              block: "start",
                              behavior: prefersReducedMotion()
                                ? "instant"
                                : "smooth",
                            });
                        })
                    }
                  >
                    {heading.label}
                  </button>
                ))}
              </nav>
            )}
            {activeCase ? (
              <>
                <div className="inspector-section">
                  <span className="section-kicker">{activeCase.id}</span>
                  <h3>{activeCase.title}</h3>
                  <span className="feature-label">
                    {
                      model.features.find((f) => f.id === activeCase.featureId)
                        ?.name
                    }
                  </span>
                  <div className="metadata-list">
                    <span>
                      Size<strong>{activeCase.size}</strong>
                    </span>
                    <span>
                      Revision<strong>{activeCase.revision}</strong>
                    </span>
                    <span>
                      Build order<strong>{activeCase.order}</strong>
                    </span>
                  </div>
                  <Button
                    compact
                    disabled={dirty || activeCase.status === "approved"}
                    onClick={() =>
                      void attempt(async () => {
                        await api(
                          `/projects/${project.id}/use-cases/${activeCase.id}/status`,
                          "PATCH",
                          { status: "approved" },
                        );
                        await onRefresh();
                        if (file) await load(file.path);
                        notify(
                          "Use case approved. Its content is protected during regeneration.",
                        );
                      })
                    }
                  >
                    <Check size={13} />
                    Approve use case
                  </Button>
                  {activeCase.status === "approved" && (
                    <Button
                      compact
                      variant="ghost"
                      disabled={dirty}
                      onClick={() =>
                        void attempt(async () => {
                          await api(
                            `/projects/${project.id}/use-cases/${activeCase.id}/status`,
                            "PATCH",
                            { status: "edited" },
                          );
                          await onRefresh();
                          if (file) await load(file.path);
                        })
                      }
                    >
                      Return to editing
                    </Button>
                  )}
                  {activeCase.staleReason && (
                    <p className="real-inline-error">
                      Needs review: {activeCase.staleReason}
                    </p>
                  )}
                </div>
                <div className="inspector-section">
                  <span className="section-kicker">PRECONDITIONS</span>
                  {activeCase.preconditions.map((p, i) => (
                    <p key={i} className="dependency-state">
                      <span className="dependency-dot" />
                      {p}
                    </p>
                  ))}
                  <span className="section-kicker">POSTCONDITIONS</span>
                  {activeCase.postconditions.map((p, i) => (
                    <p key={i} className="dependency-state after">
                      <span className="dependency-dot" />
                      {p}
                    </p>
                  ))}
                </div>
                <div className="inspector-section">
                  <span className="section-kicker">DEPENDS ON</span>
                  {activeCase.dependsOn.length ? (
                    activeCase.dependsOn.map((id) => {
                      const uc = model.useCases.find((u) => u.id === id);
                      return (
                        <button
                          className="evidence-link"
                          key={id}
                          onClick={() =>
                            uc &&
                            choose(
                              uc.filePath ?? `use-cases/${uc.id}-${uc.slug}.md`,
                              id,
                            )
                          }
                        >
                          {id}
                          <span>{uc?.title}</span>
                          <ChevronRight size={13} />
                        </button>
                      );
                    })
                  ) : (
                    <p>Journey entry point.</p>
                  )}
                  <span className="section-kicker">USED BY</span>
                  {model.useCases
                    .filter((u) => u.dependsOn.includes(activeCase.id))
                    .map((uc) => (
                      <button
                        className="evidence-link"
                        key={uc.id}
                        onClick={() =>
                          choose(
                            uc.filePath ?? `use-cases/${uc.id}-${uc.slug}.md`,
                            uc.id,
                          )
                        }
                      >
                        {uc.id}
                        <span>{uc.title}</span>
                        <ChevronRight size={13} />
                      </button>
                    ))}
                </div>
                <div className="inspector-section">
                  <span className="section-kicker">EVIDENCE</span>
                  {activeCase.screenIds.map((id) => (
                    <div className="evidence-link" key={id}>
                      <FileText size={13} />
                      <span>
                        {project.screens.find((s) => s.id === id)?.name ?? id}
                      </span>
                    </div>
                  ))}
                  <p>
                    {activeCase.elementIds.length} covered elements ·{" "}
                    {activeCase.businessRules.length} rules ·{" "}
                    {activeCase.scenarios.length} scenarios
                  </p>
                </div>
                <div className="inspector-section">
                  <Button
                    compact
                    onClick={() =>
                      onImpact(activeCase.id + " · " + activeCase.title)
                    }
                  >
                    <GitBranch size={13} />
                    Analyse knock-on effects
                  </Button>
                </div>
              </>
            ) : (
              <div className="inspector-section">
                <span className="section-kicker">SUPPORTING DOCUMENT</span>
                <h3>A connected specification.</h3>
                <p>
                  Generated reports, Gherkin and evidence are derived from your
                  use cases. Put lasting edits and notes in a use-case Markdown
                  file.
                </p>
              </div>
            )}
          </div>
        </aside>
      </div>
      <Confirm
        open={!!pending}
        title="Keep this draft?"
        description="Save your document first, or discard the draft to continue."
        onCancel={() => setPending(null)}
        onDiscard={() => {
          const action = pending;
          setPending(null);
          onDirty(false);
          action?.();
        }}
      />
      <Modal
        open={revisionOpen}
        onClose={() => setRevisionOpen(false)}
        title="A considered revision."
        description="Describe the change. The writer will prepare a proposal for your review before any document is changed."
        footer={
          <>
            <Button onClick={() => setRevisionOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={
                instructions.trim().length < 3 || dirty || !writerConfigured
              }
              onClick={() => {
                setRevisionOpen(false);
                void onJob(
                  `/projects/${project.id}/use-cases/${activeCase?.id}/revise`,
                  {
                    instructions,
                    connectionId: textConnectionId,
                    modelId: textModelId,
                  },
                );
              }}
            >
              <Sparkles size={14} />
              Prepare proposal
            </Button>
          </>
        }
      >
        <Field label="What should change?" htmlFor="revision-instructions">
          <textarea
            id="revision-instructions"
            rows={6}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </Field>
        <p className="revision-connection field-hint">
          Revision connection:{" "}
          {settings.connections.find((c) => c.id === textConnectionId)?.name ??
            "Missing connection"}{" "}
          ·{" "}
          {textModelId ||
            "Choose an exact writing model in Analysis before revising"}
        </p>
        <p className="field-hint">
          {!writerConfigured &&
            "Choose an available exact writing model in Analysis before revising. "}
          {settings.connections.find((c) => c.id === textConnectionId)
            ?.provider === "mock"
            ? "The offline writer returns fixture content. It does not understand arbitrary instructions."
            : "Uses your selected text model. This can incur provider charges."}
        </p>
      </Modal>
      <Modal
        open={!!proposalId}
        onClose={() => void discardProposal()}
        title="Review the proposed revision"
        description="Review the complete changes. Apply verifies this exact proposal, document and model again; any change requires another review."
        wide
        footer={
          <>
            <Button disabled={busy} onClick={() => void discardProposal()}>
              Keep current document
            </Button>
            {reviewInvalid && (
              <Button
                disabled={busy || proposalLoading}
                onClick={() => void loadProposal(proposalId)}
              >
                Review latest proposal
              </Button>
            )}
            <Button
              variant="primary"
              disabled={
                busy || dirty || proposalLoading || !proposal || reviewInvalid
              }
              onClick={() => void applyProposal()}
            >
              Apply reviewed proposal <Check size={14} />
            </Button>
          </>
        }
      >
        {proposalError && (
          <p className="real-inline-error" role="alert">
            {proposalError}
          </p>
        )}
        {dirty && (
          <p className="real-inline-error">
            Your unsaved document draft is retained. Keep the current document,
            then save or cancel the draft before requesting another review.
          </p>
        )}
        {proposalLoading && (
          <p role="status">Loading the complete saved proposal…</p>
        )}
        {proposal && (
          <RevisionDiff
            key={proposal.reviewToken}
            before={proposal.baselineMarkdown}
            after={proposal.proposedMarkdown}
          />
        )}
      </Modal>
    </div>
  );
}
