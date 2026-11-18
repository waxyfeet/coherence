import { useEffect, useState } from "react";
import type {
  Project,
  ProjectArea,
  ProjectDeletionPreview,
  ProjectSummary,
} from "../shared/types";
import { api } from "./api";
import { Button, Field, Modal, Picker } from "./ui";
export type ProjectAction = {
  kind: "duplicate" | "trash" | "move";
  project: Pick<ProjectSummary, "id" | "name" | "areaId">;
};
export function ProjectLifecycleDialog({
  action,
  areas,
  onClose,
  onComplete,
}: {
  action: ProjectAction | null;
  areas: ProjectArea[];
  onClose: () => void;
  onComplete: (project?: Project) => Promise<void>;
}) {
  const [name, setName] = useState(""),
    [areaId, setAreaId] = useState("");
  const [preview, setPreview] = useState<ProjectDeletionPreview | null>(null);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setError("");
    setPreview(null);
    setName(`${action?.project.name.slice(0, 113) ?? ""} (copy)`);
    setAreaId(action?.project.areaId ?? "");
    setLoading(action?.kind === "trash");
    if (action?.kind === "trash")
      void api<ProjectDeletionPreview>(
        `/projects/${action.project.id}/deletion-preview`,
      )
        .then((p) => {
          if (live) setPreview(p);
        })
        .catch((e) => {
          if (live) setError(e.message);
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    return () => {
      live = false;
    };
  }, [action]);
  async function apply() {
    if (!action || busy || loading) return;
    setBusy(true);
    setError("");
    try {
      let result: Project | undefined;
      if (action.kind === "duplicate")
        result = await api<Project>(
          `/projects/${action.project.id}/duplicate`,
          "POST",
          { name },
        );
      else if (action.kind === "move")
        result = await api<Project>(`/projects/${action.project.id}`, "PATCH", {
          areaId: areaId || null,
        });
      else {
        if (!preview) return;
        await api(`/projects/${action.project.id}/trash`, "POST", {
          confirmation: action.project.id,
          expectedUpdatedAt: preview.updatedAt,
        });
      }
      await onComplete(result);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The project operation failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={!!action}
      onClose={() => !busy && onClose()}
      title={
        action?.kind === "trash"
          ? "Move this project to trash?"
          : action?.kind === "duplicate"
            ? "Duplicate project"
            : "Move project to an area"
      }
      description={
        action?.kind === "trash"
          ? "You can restore this project from Local trash. Published remote items remain untouched."
          : action?.kind === "duplicate"
            ? "Keep the brief, model choices, last submitted run settings, area, screenshot notes, order and all image versions. Start in Draft with no analysis, specs, jobs or export records. A fresh output folder protects the original."
            : "Choose the group for this project. Moving it does not change its files or generated content."
      }
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            {action?.kind === "trash" ? "Keep project" : "Cancel"}
          </Button>
          <Button
            variant={action?.kind === "trash" ? "danger" : "primary"}
            disabled={
              busy ||
              loading ||
              (action?.kind === "trash" && !preview) ||
              (action?.kind === "duplicate" && !name.trim())
            }
            onClick={() => void apply()}
          >
            {busy
              ? "Working…"
              : action?.kind === "trash"
                ? "Move to trash"
                : action?.kind === "duplicate"
                  ? "Create duplicate"
                  : "Move project"}
          </Button>
        </>
      }
    >
      <p className="project-action-name">{action?.project.name}</p>
      {action?.kind === "duplicate" && (
        <Field label="Duplicate name" htmlFor="duplicate-name">
          <input
            id="duplicate-name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
      )}
      {action?.kind === "move" && (
        <Field label="Area">
          <Picker
            label="Project area"
            value={areaId}
            onChange={setAreaId}
            options={[
              { value: "", label: "Unassigned" },
              ...areas.map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
        </Field>
      )}
      {action?.kind === "trash" && (
        <>
          <p className="muted">
            The project folder, images, analysis, specifications, history and
            local export records are kept in Local trash. Custom output folders
            stay in their current locations.
          </p>
          {loading ? (
            <p className="muted">Checking owned project folders…</p>
          ) : (
            preview && (
              <div className="deletion-paths">
                <strong>Project folder to move</strong>
                {preview.paths.slice(0, 1).map((p) => (
                  <code key={p}>{p}</code>
                ))}
              </div>
            )
          )}
        </>
      )}
      {error && (
        <p className="real-inline-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
