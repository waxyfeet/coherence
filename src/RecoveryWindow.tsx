import { useEffect, useState, type RefObject } from "react";
import type {
  ModelSnapshotInfo,
  TrashedProjectInfo,
} from "../server/storage/recovery";
import { api } from "./api";
import type { TrashDeletionPreview } from "../shared/types";
import { Badge, Button, Modal } from "./ui";

export function RecoveryWindow({
  mode,
  projectId,
  onClose,
  onRestored,
  onDeleted,
  notify,
  returnFocusRef,
}: {
  mode: "history" | "trash" | null;
  projectId: string;
  onClose: () => void;
  onRestored: (projectId: string) => Promise<void>;
  onDeleted: () => Promise<void>;
  notify: (message: string) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [rows, setRows] = useState<(ModelSnapshotInfo | TrashedProjectInfo)[]>(
    [],
  );
  const [selected, setSelected] = useState<
    ModelSnapshotInfo | TrashedProjectInfo | null
  >(null);
  const [deleting, setDeleting] = useState(false);
  const [preview, setPreview] = useState<TrashDeletionPreview | null>(null);
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!mode) return;
    let alive = true;
    setSelected(null);
    setDeleting(false);
    setPreview(null);
    setRows([]);
    setError("");
    setLoading(true);
    void api<(ModelSnapshotInfo | TrashedProjectInfo)[]>(
      mode === "trash" ? "/trash" : `/projects/${projectId}/history`,
    )
      .then((values) => {
        if (alive) setRows(values);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [mode, projectId]);
  useEffect(() => {
    if (!deleting || !selected || mode !== "trash") return;
    let alive = true;
    setError("");
    setPreview(null);
    setLoading(true);
    void api<TrashDeletionPreview>(
      `/trash/${encodeURIComponent(selected.id)}/deletion-preview`,
    )
      .then((value) => {
        if (alive) setPreview(value);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [deleting, selected, mode]);
  function back() {
    setSelected(null);
    setDeleting(false);
    setPreview(null);
    setError("");
    setLoading(false);
  }
  async function remove() {
    if (!selected || !preview || busy || loading) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `/trash/${encodeURIComponent(selected.id)}/permanent-delete`,
        "POST",
        {
          confirmation: preview.trashId,
          expectedRevision: preview.revision,
        },
      );
      setRows((values) => values.filter((row) => row.id !== selected.id));
      back();
      await onDeleted();
      notify(
        "Project permanently deleted from Local trash. Published remote items were kept.",
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Permanent deletion failed. Review the retained records before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    try {
      const restored = await api<{ id?: string }>(
        mode === "trash"
          ? `/trash/${encodeURIComponent(selected.id)}/restore`
          : `/projects/${projectId}/history/${encodeURIComponent(selected.id)}/restore`,
        "POST",
        {},
      );
      await onRestored(mode === "trash" ? restored.id! : projectId);
      notify(
        mode === "trash"
          ? "Project restored from local trash."
          : "Model snapshot restored. Markdown files were kept; review before syncing or re-rendering.",
      );
      onClose();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Restore failed. The saved files are retained.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={!!mode}
      returnFocusRef={returnFocusRef}
      onClose={() => !busy && onClose()}
      title={
        deleting
          ? "Permanently delete this project?"
          : selected
            ? "Restore this saved version?"
            : mode === "trash"
              ? "Local project trash"
              : "Model history"
      }
      description={
        mode === "trash"
          ? deleting
            ? "Are you sure? This cannot be undone through Local trash. Published remote items remain untouched."
            : "Restore a project or permanently delete it after review. Projects stay here until you choose; nothing is automatically emptied. Custom output folders stay in place until permanently deleted."
          : "Restoring snapshots the current model first. It does not rewrite Markdown or silently import external edits."
      }
      footer={
        selected ? (
          <>
            <Button disabled={busy} onClick={back}>
              {deleting ? "Keep in trash" : "Back to saved versions"}
            </Button>
            <Button
              disabled={busy || (deleting && (loading || !preview))}
              variant={deleting ? "danger" : "primary"}
              onClick={() => void (deleting ? remove() : restore())}
            >
              {busy
                ? "Working…"
                : deleting
                  ? "Delete permanently"
                  : mode === "trash"
                    ? "Restore project"
                    : "Restore selected version"}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Done</Button>
        )
      }
    >
      {error && (
        <p className="real-inline-error" role="alert">
          {error}
        </p>
      )}
      {selected ? (
        <div className="recovery-confirm">
          <strong>{"name" in selected ? selected.name : selected.id}</strong>
          <p>
            {deleting
              ? "The saved project, screenshots, specifications, human edits, history and local records will be removed. Separate backups and published remote items are kept."
              : mode === "history"
                ? "Existing Markdown remains on disk. Its contents may differ from this model snapshot. Use Sync from disk or Re-render deliberately after review."
                : "The original project folder, screenshot versions and output records will be restored locally."}
          </p>
          {deleting &&
            (loading ? (
              <p>Checking owned project folders…</p>
            ) : (
              preview && (
                <div className="deletion-paths">
                  <strong>Local folders to remove</strong>
                  {preview.paths.map((p) => (
                    <code key={p}>{p}</code>
                  ))}
                  <p>
                    Workspace parents, separate backups and published remote
                    items are kept.
                  </p>
                </div>
              )
            ))}
        </div>
      ) : loading ? (
        <p className="muted">Reading local records…</p>
      ) : rows.length ? (
        <div className="recovery-list">
          {rows.map((row) => (
            <div className="recovery-row" key={row.id}>
              <div>
                <strong>
                  {"name" in row
                    ? row.name
                    : new Date(row.savedAt).toLocaleString()}
                </strong>
                <small>
                  {"deletedAt" in row
                    ? `Deleted ${new Date(row.deletedAt).toLocaleString()}`
                    : `${row.useCaseCount} use cases · ${row.screenCount} screens`}
                </small>
              </div>
              <Badge>{"deletedAt" in row ? "In trash" : "Snapshot"}</Badge>
              <Button
                compact
                onClick={() => {
                  setDeleting(false);
                  setSelected(row);
                }}
              >
                {mode === "trash" ? "Restore" : "Review restore"}
              </Button>
              {mode === "trash" && (
                <Button
                  compact
                  variant="danger"
                  onClick={() => {
                    setPreview(null);
                    setDeleting(true);
                    setSelected(row);
                  }}
                >
                  Delete permanently
                </Button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">
          {mode === "trash"
            ? "Local trash is empty. Projects you move to trash appear here. Previously permanently deleted projects cannot be restored here."
            : "No model snapshots yet. Previous models are saved when a model is replaced."}
        </p>
      )}
    </Modal>
  );
}
