import { useEffect, useRef, useState } from "react";
import { FolderOpen, FolderSearch, Files, ArrowRight } from "lucide-react";
import type { Project } from "../shared/types";
import type { FoundProject, StorageInfo } from "../shared/storage";
import { api } from "./api";
import { Button, Field, Modal } from "./ui";
import "./projectFiles.css";

function useFolderChooser() {
  const [choosing, setChoosing] = useState(false),
    [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  const cancel = () => {
    pending.current?.abort();
    pending.current = null;
    setChoosing(false);
  };
  useEffect(() => () => pending.current?.abort(), []);
  async function choose(purpose: "workspace" | "project", initialPath = "") {
    if (pending.current) return null;
    const controller = new AbortController();
    pending.current = controller;
    setChoosing(true);
    setError("");
    try {
      const result = await api<{ path: string | null }>(
        "/storage/choose-folder",
        "POST",
        { purpose, initialPath },
        controller.signal,
      );
      return controller.signal.aborted ? null : result.path;
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : "The folder chooser could not open.",
        );
      return null;
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setChoosing(false);
      }
    }
  }
  return { choose, choosing, error, cancel, setError };
}

/** A complete project location replaces the misleading portable 'output folder'. */
export function ProjectLocationField({
  workspaceDir,
  onWorkspaceChange,
  project,
}: {
  workspaceDir?: string;
  onWorkspaceChange: (p: string) => void;
  project?: Project;
}) {
  const [info, setInfo] = useState<StorageInfo | null>(null),
    [loadError, setLoadError] = useState("");
  const chooser = useFolderChooser();
  useEffect(() => {
    let current = true;
    void api<StorageInfo>("/storage").then(
      (r) => {
        if (current) setInfo(r);
      },
      () => {
        if (current)
          setLoadError(
            "Project location is unavailable. Reconnect the local session and try again.",
          );
      },
    );
    return () => {
      current = false;
    };
  }, []);
  if (project?.storage)
    return (
      <Field
        label="Project folder"
        hint="Screenshots, editable requirements and history stay together in this folder. Close Coherence before moving it, then use Open existing project to reconnect."
      >
        <code className="path-display">{project.projectPath}</code>
        <Button
          onClick={() =>
            void api(
              `/storage/reveal/${encodeURIComponent(project.id)}`,
              "POST",
              {},
            ).catch((e) => chooser.setError(e.message))
          }
        >
          <FolderOpen size={15} />
          Open project folder
        </Button>
        {chooser.error && <p role="alert">{chooser.error}</p>}
      </Field>
    );
  return (
    <Field
      label="Project workspace"
      hint="Coherence creates a separate project folder here. Your screenshots, editable requirements and history will stay together."
    >
      <Button
        className="output-folder-picker"
        disabled={chooser.choosing || !info}
        onClick={() =>
          void chooser
            .choose("workspace", workspaceDir || info?.workspace)
            .then((p) => {
              if (p) onWorkspaceChange(p);
            })
        }
      >
        <FolderOpen size={16} />
        <span>
          {chooser.choosing
            ? "Waiting for folder selection…"
            : workspaceDir ||
              (info
                ? info.workspace || "Choose your project workspace…"
                : "Finding your project workspace…")}
        </span>
      </Button>
      {workspaceDir && (
        <Button compact onClick={() => onWorkspaceChange("")}>
          Use default workspace
        </Button>
      )}
      {!workspaceDir && info?.workspaceNote && (
        <p className="muted">{info.workspaceNote}</p>
      )}
      {chooser.choosing && (
        <Button compact onClick={chooser.cancel}>
          Cancel folder selection
        </Button>
      )}
      {(chooser.error || loadError) && (
        <p className="real-inline-error" role="alert">
          {chooser.error || loadError}
        </p>
      )}
    </Field>
  );
}

export function ProjectFiles({
  onOpened,
}: {
  onOpened: (id: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [info, setInfo] = useState<StorageInfo | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const chooser = useFolderChooser();
  async function load() {
    setInfo(await api<StorageInfo>("/storage"));
  }
  async function attempt(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Project files could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  }
  const close = () => {
    chooser.cancel();
    if (!busy) {
      setOpen(false);
    }
  };
  async function openExisting() {
    const selected = await chooser.choose("project", info?.workspace);
    if (selected)
      await attempt(async () => {
        const project = await api<Project>("/storage/open", "POST", {
          path: selected,
        });
        setOpen(false);
        await onOpened(project.id);
      });
  }
  // Installer finding ST-09 / decision D12: after a reinstall, a new computer or a lost profile.
  const [found, setFound] = useState<FoundProject[] | null>(null);
  async function findProjects() {
    const selected = await chooser.choose("workspace", info?.workspace);
    if (selected)
      await attempt(async () => {
        setFound(
          await api<FoundProject[]>("/storage/find", "POST", {
            path: selected,
          }),
        );
      });
  }
  async function openFound(project: FoundProject) {
    await attempt(async () => {
      const opened = await api<Project>("/storage/open", "POST", {
        path: project.path,
        expectedId: project.id,
      });
      setOpen(false);
      await onOpened(opened.id);
    });
  }
  return (
    <>
      <Button
        compact
        onClick={() => {
          setOpen(true);
          void attempt(load);
        }}
      >
        <Files size={15} />
        Project files
      </Button>
      <Modal
        open={open}
        onClose={close}
        title="Your project files"
        description="Keep complete projects where you can find, copy and back them up."
        wide
        footer={
          <Button disabled={busy} onClick={close}>
            Done
          </Button>
        }
      >
        <div className="project-files-panel">
          {(error || chooser.error) && (
            <p role="alert" className="real-inline-error">
              {error || chooser.error}
            </p>
          )}
          <>
            <Field
              label="Default project workspace"
              hint="Changing this affects new projects only. Existing folders stay in place."
            >
              <code className="path-display">
                {info
                  ? info.workspace || "Choose a workspace to begin"
                  : "Finding workspace…"}
              </code>
              <Button
                disabled={busy || chooser.choosing || !info}
                onClick={() =>
                  void chooser
                    .choose("workspace", info?.workspace)
                    .then((p) => {
                      if (p)
                        void attempt(async () => {
                          setInfo(
                            await api<StorageInfo>(
                              "/storage/workspace",
                              "PUT",
                              { path: p },
                            ),
                          );
                        });
                    })
                }
              >
                <FolderOpen size={15} />
                Choose workspace
              </Button>
            </Field>
            <Button
              disabled={busy || chooser.choosing || !info}
              onClick={() => void openExisting()}
            >
              <FolderOpen size={15} />
              Open existing Coherence project
              <ArrowRight size={14} />
            </Button>
            <p>
              Choose the complete project folder after a copy, move or
              reinstall. Missing folders stay in your library; selecting the
              same project at its new location reconnects it. Saved requirements
              remain readable without the old AI keys.
            </p>
            <Button
              disabled={busy || chooser.choosing || !info}
              onClick={() => void findProjects()}
            >
              <FolderSearch size={15} />
              Find Coherence projects in a folder
            </Button>
            <p>
              Lists every project in a folder you choose, including its
              Coherence Trash, for example after a reinstall or on a new
              computer.
            </p>
            {found &&
              (found.length ? (
                <ul className="found-projects" aria-label="Projects found">
                  {found.map((p) => (
                    <li key={p.path}>
                      <div>
                        <strong>{p.name}</strong>
                        <code className="path-display">{p.path}</code>
                        <span className="muted">{foundStatus(p)}</span>
                      </div>
                      {!p.problem && !p.inTrash && p.library !== "here" && (
                        <Button
                          compact
                          disabled={busy}
                          onClick={() => void openFound(p)}
                        >
                          {p.library === "elsewhere"
                            ? "Reconnect here"
                            : "Open"}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No Coherence projects in that folder.</p>
              ))}
          </>
          {chooser.choosing && (
            <Button onClick={chooser.cancel}>Cancel folder selection</Button>
          )}
        </div>
      </Modal>
    </>
  );
}
function foundStatus(p: FoundProject): string {
  if (p.problem) return p.problem;
  if (p.inTrash)
    return "In Coherence Trash. Restore it from Trash, or move the folder out of .coherence-trash and open it.";
  if (p.library === "here") return "Already in your library.";
  if (p.library === "elsewhere")
    return "In your library at another folder. Reconnect here if that folder is gone.";
  return "Not in your library yet.";
}

export function ReconnectProject({
  id,
  onOpened,
}: {
  id: string;
  onOpened: (id: string) => void | Promise<void>;
}) {
  const chooser = useFolderChooser();
  return (
    <div className="project-reconnect">
      <Button
        compact
        disabled={chooser.choosing}
        onClick={() =>
          void chooser.choose("project").then(async (selected) => {
            if (!selected) return;
            try {
              const project = await api<Project>("/storage/open", "POST", {
                path: selected,
                expectedId: id,
              });
              await onOpened(project.id);
            } catch (e) {
              chooser.setError(
                e instanceof Error
                  ? e.message
                  : "The selected folder could not reconnect this project.",
              );
            }
          })
        }
      >
        Reconnect project folder
      </Button>
      {chooser.choosing && (
        <Button compact onClick={chooser.cancel}>
          Cancel folder selection
        </Button>
      )}
      {chooser.error && (
        <p role="alert" className="real-inline-error">
          {chooser.error}
        </p>
      )}
    </div>
  );
}
