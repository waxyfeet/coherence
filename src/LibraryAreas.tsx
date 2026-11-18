import { useState } from "react";
import { FolderPlus, MoreHorizontal } from "lucide-react";
import type { ProjectArea, ProjectSummary } from "../shared/types";
import { api } from "./api";
import { Button, Field, IconButton, Menu, Modal } from "./ui";

export function LibraryAreas({
  areas,
  projects,
  selected,
  onSelect,
  onRefresh,
}: {
  areas: ProjectArea[];
  projects: ProjectSummary[];
  selected: string;
  onSelect: (id: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [dialog, setDialog] = useState<{
    kind: "new" | "rename" | "remove";
    area?: ProjectArea;
  } | null>(null);
  const [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  function open(kind: "new" | "rename" | "remove", area?: ProjectArea) {
    setName(area?.name ?? "");
    setError("");
    setDialog({ kind, area });
  }
  async function save() {
    if (!dialog || busy) return;
    setBusy(true);
    setError("");
    try {
      if (dialog.kind === "remove") {
        await api(`/areas/${dialog.area!.id}`, "DELETE");
        onSelect("unassigned");
      } else {
        const area = await api<ProjectArea>(
          dialog.kind === "new" ? "/areas" : `/areas/${dialog.area!.id}`,
          dialog.kind === "new" ? "POST" : "PATCH",
          { name },
        );
        onSelect(area.id);
      }
      setDialog(null);
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this area.");
    } finally {
      setBusy(false);
    }
  }
  const count = (id: string) =>
    projects.filter(
      (p) =>
        id === "all" ||
        (id === "unassigned"
          ? !areas.some((a) => a.id === p.areaId)
          : p.areaId === id),
    ).length;
  return (
    <>
      <div className="library-areas" aria-label="Project areas">
        <div className="area-filters">
          {[
            { id: "all", name: "All projects" },
            { id: "unassigned", name: "Unassigned" },
            ...areas,
          ].map((area) => (
            <div
              className={`area-chip ${selected === area.id ? "selected" : ""}`}
              key={area.id}
            >
              <button
                onClick={() => onSelect(area.id)}
                aria-pressed={selected === area.id}
              >
                <span>{area.name}</span>
                <small>{count(area.id)}</small>
              </button>
              {"createdAt" in area && (
                <Menu
                  trigger={
                    <IconButton label={`Manage area ${area.name}`}>
                      <MoreHorizontal size={13} />
                    </IconButton>
                  }
                  items={[
                    {
                      label: "Rename area",
                      onSelect: () => open("rename", area),
                    },
                    {
                      label: "Remove area",
                      danger: true,
                      onSelect: () => open("remove", area),
                    },
                  ]}
                />
              )}
            </div>
          ))}
        </div>
        <Button compact onClick={() => open("new")}>
          <FolderPlus size={14} />
          New area
        </Button>
      </div>
      <Modal
        open={!!dialog}
        onClose={() => !busy && setDialog(null)}
        title={
          dialog?.kind === "new"
            ? "A new project area"
            : dialog?.kind === "rename"
              ? "Rename area"
              : "Remove this area?"
        }
        description={
          dialog?.kind === "remove"
            ? "Projects are kept and moved to Unassigned. Only the group is removed."
            : "Group related projects in a named area. Each project belongs to one area or Unassigned."
        }
        footer={
          <>
            <Button disabled={busy} onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy || (dialog?.kind !== "remove" && !name.trim())}
              variant={dialog?.kind === "remove" ? "danger" : "primary"}
              onClick={() => void save()}
            >
              {busy
                ? "Saving…"
                : dialog?.kind === "remove"
                  ? "Remove area, keep projects"
                  : "Save area"}
            </Button>
          </>
        }
      >
        {dialog?.kind === "remove" ? (
          <p>{dialog.area?.name}</p>
        ) : (
          <Field label="Area name" htmlFor="area-name">
            <input
              id="area-name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </Field>
        )}
        {error && (
          <p className="real-inline-error" role="alert">
            {error}
          </p>
        )}
      </Modal>
    </>
  );
}
