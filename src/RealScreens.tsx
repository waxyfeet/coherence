import { PrivateImage } from "./PrivateImage";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Expand,
  FileImage,
  Focus,
  Frame,
  ImagePlus,
  Layers2,
  Maximize2,
  MoreHorizontal,
  MousePointer2,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import type { Project, Screen, SolutionModel } from "../shared/types";
import type { FigmaFrame, FigmaImportRequest } from "../shared/api";
import { api } from "./api";
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
export type Attempt = <T>(action: () => Promise<T>) => Promise<T | undefined>;
type Props = {
  operationError: string;
  busy: boolean;
  project: Project;
  model: SolutionModel | null;
  screenId: string;
  setScreenId: (id: string) => void;
  onRefresh: () => Promise<void>;
  attempt: Attempt;
  notify: (s: string) => void;
  onNext: () => void;
  onCase: (s: string) => void;
  onReanalyse: (s: string) => void;
  onDirty: (dirty: boolean) => void;
  onProposeChange: (elementId: string, label: string) => void;
  onImportFigma: (request: FigmaImportRequest) => Promise<void>;
};
export function RealScreens({
  operationError,
  busy,
  project,
  model,
  screenId,
  setScreenId,
  onRefresh,
  attempt,
  notify,
  onNext,
  onCase,
  onReanalyse,
  onDirty,
  onProposeChange,
  onImportFigma,
}: Props) {
  const screen =
    project.screens.find((s) => s.id === screenId) ?? project.screens[0];
  const index = project.screens.findIndex((s) => s.id === screen?.id);
  const [notes, setNotes] = useState("");
  const [name, setName] = useState("");
  const [overlay, setOverlay] = useState(false);
  const [focus, setFocus] = useState(false);
  const [remove, setRemove] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [elementId, setElementId] = useState("");
  const [version, setVersion] = useState(0);
  const [dragged, setDragged] = useState("");
  const [uploading, setUploading] = useState(false);
  const [figma, setFigma] = useState(false);
  const [figmaUrl, setFigmaUrl] = useState("");
  const [frames, setFrames] = useState<FigmaFrame[]>([]);
  const [selectedFrames, setSelectedFrames] = useState<string[]>([]);
  const [frameFilter, setFrameFilter] = useState("");
  const [figmaScale, setFigmaScale] = useState("2");
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const [pendingScreen, setPendingScreen] = useState("");
  const dirty = !!screen && (notes !== screen.notes || name !== screen.name);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  function selectScreen(id: string) {
    if (dirty) setPendingScreen(id);
    else setScreenId(id);
  }
  const analysis = model?.screens.find((s) => s.screenId === screen?.id);
  const elements = analysis?.elements ?? [];
  const selectedElement = elements.find((e) => e.id === elementId);
  const linked =
    model?.useCases.filter((u) => u.screenIds.includes(screen?.id)) ?? [];
  const image = (s: Screen, v?: number) =>
    `/api/projects/${project.id}/screens/${s.id}/image?version=${v || s.version}`;
  useEffect(() => {
    setNotes(screen?.notes ?? "");
    setName(screen?.name ?? "");
    setVersion(0);
    setElementId("");
  }, [screen?.id, screen?.notes, screen?.name]);
  async function upload(files: FileList | File[] | null, replace = false) {
    if (!files?.length) return;
    if (files.length > 50) {
      notify("Choose at most 50 screenshots per upload.");
      return;
    }
    setUploading(true);
    const form = new FormData();
    for (const file of Array.from(files))
      form.append(replace ? "file" : "files", file);
    await attempt(async () => {
      await api(
        `/projects/${project.id}/screens${replace ? "/" + screen.id + "/image" : ""}`,
        replace ? "PUT" : "POST",
        form,
      );
      await onRefresh();
      notify(
        replace
          ? "Screenshot replaced. Previous versions are kept."
          : "Screenshots saved in this project.",
      );
    });
    setUploading(false);
  }
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      if (
        (e.target as HTMLElement).closest("input,textarea,[contenteditable]") ||
        document.querySelector('[role="dialog"]')
      )
        return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (files.length) {
        e.preventDefault();
        void upload(files);
      }
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  });
  async function reorder(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return;
    const ids = project.screens.map((s) => s.id);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    await attempt(async () => {
      await api(`/projects/${project.id}/screens-order`, "PUT", {
        screenIds: ids,
      });
      await onRefresh();
    });
  }
  return (
    <div className="workspace-page screens-page">
      <SectionHeading
        eyebrow="DESIGN EVIDENCE"
        title="Screens"
        description="Every good specification starts with a clear picture."
        actions={
          <>
            <Menu
              trigger={
                <Button disabled={uploading}>
                  <Upload size={14} />
                  Import
                  <ChevronRight size={12} />
                </Button>
              }
              items={[
                {
                  label: "Browse local images",
                  icon: <FileImage size={14} />,
                  onSelect: () => fileInput.current?.click(),
                },
                {
                  label: "Import Figma frames",
                  icon: <Frame size={14} />,
                  onSelect: () => setFigma(true),
                },
              ]}
            />
            <Button variant="primary" disabled={!screen} onClick={onNext}>
              Analyse screens
              <ArrowRight size={14} />
            </Button>
          </>
        }
      />
      <input
        className="sr-only"
        ref={fileInput}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif"
        aria-label="Upload screenshots"
        onChange={(e) => {
          void upload(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        className="sr-only"
        ref={replaceInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        aria-label="Replace screenshot image"
        onChange={(e) => {
          void upload(e.target.files, true);
          e.target.value = "";
        }}
      />
      {!screen ? (
        <div
          className="real-empty-evidence"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void upload(e.dataTransfer.files);
          }}
        >
          <div className="empty-evidence-art">
            <Layers2 size={43} />
            <span>01</span>
          </div>
          <span className="section-kicker">A PICTURE OF WHAT COMES NEXT</span>
          <h2>Start with your screens.</h2>
          <p>
            Drop screenshots here, paste an image, or browse your computer.
            <br />
            PNG, JPEG, WebP and GIF · up to 25 MB each
          </p>
          <Button
            variant="primary"
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
          >
            <Plus size={15} />
            {uploading ? "Saving images…" : "Add screenshots"}
          </Button>
        </div>
      ) : (
        <div className="screens-workbench">
          <aside className="screen-filmstrip">
            <div className="pane-label">
              <span>JOURNEY ORDER</span>
              <Badge>{project.screens.length}</Badge>
            </div>
            <div className="filmstrip-items">
              {project.screens.map((s, i) => (
                <div
                  className={`screen-thumb ${s.id === screen.id ? "selected" : ""}`}
                  key={s.id}
                  draggable
                  onDragStart={() => setDragged(s.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    void reorder(
                      project.screens.findIndex((v) => v.id === dragged),
                      i,
                    );
                    setDragged("");
                  }}
                >
                  <button
                    className="screen-thumb-select"
                    aria-label={`Select ${s.name}`}
                    aria-pressed={s.id === screen.id}
                    onClick={() => selectScreen(s.id)}
                  >
                    <div className="screen-thumb-image">
                      <PrivateImage src={image(s)} alt="" />
                      <span className="screen-number">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      {s.version !== s.analysedVersion && s.analysedVersion && (
                        <span className="thumb-change-dot" />
                      )}
                    </div>
                    <div className="screen-thumb-title">
                      <span>{s.name}</span>
                      <small>
                        v{s.version} ·{" "}
                        {s.analysedVersion === s.version
                          ? "Analysed"
                          : "Ready to read"}
                      </small>
                    </div>
                  </button>
                  <Menu
                    trigger={
                      <button
                        className="thumb-menu icon-button"
                        aria-label={`Actions for ${s.name}`}
                      >
                        <MoreHorizontal size={14} />
                      </button>
                    }
                    items={[
                      {
                        label: "Move earlier",
                        icon: <ArrowUp size={13} />,
                        onSelect: () => void reorder(i, Math.max(0, i - 1)),
                      },
                      {
                        label: "Move later",
                        icon: <ArrowDown size={13} />,
                        onSelect: () =>
                          void reorder(
                            i,
                            Math.min(project.screens.length - 1, i + 1),
                          ),
                      },
                    ]}
                  />
                </div>
              ))}
            </div>
            <button
              className="add-screen-tile"
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
            >
              <Plus size={17} />
              <span>{uploading ? "Saving images…" : "Add screens"}</span>
              <small>or paste an image</small>
            </button>
            <p className="filmstrip-hint">Drag to reorder the journey.</p>
          </aside>
          <section className="screen-canvas-panel">
            <div className="canvas-toolbar">
              <div className="canvas-file">
                <FileImage size={14} />
                <span>{screen.originalFileName}</span>
                <Badge>v{version || screen.version}</Badge>
              </div>
              <div className="canvas-tools">
                <IconButton
                  label="Inspect detected elements"
                  aria-pressed={overlay}
                  onClick={() => setOverlay((v) => !v)}
                >
                  <MousePointer2 size={15} />
                </IconButton>
                <IconButton
                  label="View screenshot larger"
                  onClick={() => setFocus(true)}
                >
                  <Expand size={15} />
                </IconButton>
                <Menu
                  trigger={
                    <button
                      className="icon-button"
                      aria-label="Screenshot actions"
                    >
                      <MoreHorizontal size={16} />
                    </button>
                  }
                  items={[
                    {
                      label: "Replace image",
                      icon: <ImagePlus size={14} />,
                      onSelect: () => replaceInput.current?.click(),
                    },
                    {
                      label: "Reanalyse & compare changes",
                      icon: <Layers2 size={14} />,
                      onSelect: () => onReanalyse(screen.id),
                    },
                    {
                      label: "Fit to view",
                      icon: <Maximize2 size={14} />,
                      onSelect: () => setZoom(1),
                    },
                    {
                      label: "Remove screenshot",
                      icon: <Trash2 size={14} />,
                      danger: true,
                      divider: true,
                      onSelect: () => setRemove(true),
                    },
                  ]}
                />
              </div>
            </div>
            <div
              className="canvas-surface real-canvas"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void upload(e.dataTransfer.files);
              }}
            >
              <div className="canvas-stamp">
                <span className="crosshair">+</span> SCREEN{" "}
                {String(index + 1).padStart(2, "0")} /{" "}
                {String(project.screens.length).padStart(2, "0")}
              </div>
              <div
                className="real-artboard"
                style={{ width: `${zoom * 100}%` }}
              >
                <PrivateImage src={image(screen, version)} alt={screen.name} />
                {overlay &&
                  elements
                    .filter((e) => e.bounds)
                    .map((e) => (
                      <button
                        className={`element-box ${elementId === e.id ? "selected" : ""}`}
                        key={e.id}
                        aria-label={`Inspect ${e.label || e.key}`}
                        style={{
                          left: `${e.bounds!.x}%`,
                          top: `${e.bounds!.y}%`,
                          width: `${e.bounds!.width}%`,
                          height: `${e.bounds!.height}%`,
                        }}
                        onClick={() => setElementId(e.id)}
                      >
                        <span>{e.label || e.key}</span>
                      </button>
                    ))}
              </div>
              <div className="canvas-bottom-note">
                <span className="crosshair">+</span>
                <span>
                  {screen.width} × {screen.height} · saved screenshot
                </span>
                <span className="crosshair">+</span>
              </div>
            </div>
            <div className="canvas-footer">
              <div>
                <span className="small-dot green" />
                {(screen.sizeBytes / 1024).toFixed(0)} KB
                <span className="footer-dot">·</span>
                {screen.mimeType.replace("image/", "").toUpperCase()}
              </div>
              <div className="zoom-controls">
                <IconButton
                  label="Zoom out"
                  onClick={() => setZoom((z) => Math.max(0.5, z - 0.15))}
                >
                  <span>−</span>
                </IconButton>
                <button onClick={() => setZoom(1)}>
                  {Math.round(zoom * 100)}%
                </button>
                <IconButton
                  label="Zoom in"
                  onClick={() => setZoom((z) => Math.min(2, z + 0.15))}
                >
                  <Plus size={13} />
                </IconButton>
                <IconButton
                  label="Fit screenshot to view"
                  onClick={() => setZoom(1)}
                >
                  <Focus size={14} />
                </IconButton>
              </div>
            </div>
          </section>
          <aside className="screen-inspector">
            <div className="inspector-tabs">
              <button
                className={!overlay ? "active" : ""}
                onClick={() => setOverlay(false)}
              >
                Details
              </button>
              <button
                className={overlay ? "active" : ""}
                onClick={() => setOverlay(true)}
              >
                Elements<Badge>{elements.length}</Badge>
              </button>
            </div>
            <div className="inspector-body">
              {!overlay ? (
                <>
                  <div className="inspector-section">
                    <span className="section-kicker">SCREEN DETAILS</span>
                    <Field label="Screen name" htmlFor="screen-name">
                      <input
                        id="screen-name"
                        value={name}
                        onChange={(e) => {
                          setName(e.target.value);
                          onDirty(
                            e.target.value !== screen.name ||
                              notes !== screen.notes,
                          );
                        }}
                      />
                    </Field>
                    <div className="metadata-list">
                      <span>
                        Version<strong>{screen.version}</strong>
                      </span>
                      <span>
                        Analysis
                        <strong>
                          {screen.analysedVersion === screen.version
                            ? "Current"
                            : screen.analysedVersion
                              ? "Changed"
                              : "Not read yet"}
                        </strong>
                      </span>
                    </div>
                    {screen.version > 1 && (
                      <Field label="Image history" htmlFor="screen-version">
                        <select
                          id="screen-version"
                          value={version || screen.version}
                          onChange={(e) => setVersion(Number(e.target.value))}
                        >
                          {Array.from({ length: screen.version }, (_, i) => (
                            <option key={i} value={i + 1}>
                              Version {i + 1}
                              {i + 1 === screen.version ? " · current" : ""}
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}
                  </div>
                  <div className="inspector-section">
                    <span className="section-kicker">
                      CONTEXT FOR THE ANALYST
                    </span>
                    <p>Add the details a screenshot can’t tell.</p>
                    <label htmlFor="screen-notes" className="sr-only">
                      Screen notes
                    </label>
                    <textarea
                      id="screen-notes"
                      className="screen-notes"
                      rows={6}
                      value={notes}
                      onChange={(e) => {
                        setNotes(e.target.value);
                        onDirty(
                          e.target.value !== screen.notes ||
                            name !== screen.name,
                        );
                      }}
                    />
                    <Button
                      compact
                      disabled={name === screen.name && notes === screen.notes}
                      onClick={() =>
                        void attempt(async () => {
                          await api(
                            `/projects/${project.id}/screens/${screen.id}`,
                            "PATCH",
                            { name, notes },
                          );
                          await onRefresh();
                          notify(
                            "Screen name and notes saved. Future analysis will use the updated context.",
                          );
                        })
                      }
                    >
                      <Check size={12} />
                      Save details
                    </Button>
                  </div>
                  <div className="inspector-section">
                    <span className="section-kicker">LINKED USE CASES</span>
                    {linked.length ? (
                      linked.map((u) => (
                        <button
                          className="linked-case"
                          key={u.id}
                          onClick={() => onCase(u.id)}
                        >
                          <span>
                            <small>{u.id}</small>
                            <strong>{u.title}</strong>
                          </span>
                          <ChevronRight size={13} />
                        </button>
                      ))
                    ) : (
                      <p>Generate specifications to establish traceability.</p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="inspector-section">
                    <span className="section-kicker">ELEMENT INVENTORY</span>
                    <p>
                      {analysis
                        ? analysis.purpose
                        : "Run analysis to inspect visible elements and uncertain details."}
                    </p>
                    {elements.map((e, i) => (
                      <button
                        className={`element-list-item ${elementId === e.id ? "selected" : ""}`}
                        key={e.id}
                        onClick={() => setElementId(e.id)}
                      >
                        <span className="element-index">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <span>
                          {e.label || e.key}
                          <small>
                            {e.type} ·{" "}
                            {e.inferred.length
                              ? "includes inference"
                              : "observed"}
                          </small>
                        </span>
                        <span
                          className={`small-dot ${model?.useCases.some((u) => u.elementIds.includes(e.id)) ? "green" : "amber"}`}
                        />
                      </button>
                    ))}
                  </div>
                  {selectedElement && (
                    <div className="inspector-section">
                      <span className="section-kicker">
                        {selectedElement.id}
                      </span>
                      <h3>{selectedElement.label || selectedElement.key}</h3>
                      <p>{selectedElement.description}</p>
                      <p>{selectedElement.behavior}</p>
                      <p className="small muted">
                        Region:{" "}
                        {analysis?.regions.find(
                          (r) => r.id === selectedElement.regionId,
                        )?.name ?? selectedElement.regionId}
                        {selectedElement.bounds
                          ? ` · ${selectedElement.bounds.x.toFixed(1)}%, ${selectedElement.bounds.y.toFixed(1)}% · ${selectedElement.bounds.width.toFixed(1)}% × ${selectedElement.bounds.height.toFixed(1)}%`
                          : " · Bounds unknown"}
                      </p>
                      {!!selectedElement.validation?.length && (
                        <>
                          <h4>Validation</h4>
                          <p>{selectedElement.validation.join("; ")}</p>
                        </>
                      )}
                      {!!selectedElement.states?.length && (
                        <>
                          <h4>Observed states</h4>
                          <p>{selectedElement.states.join(" · ")}</p>
                        </>
                      )}
                      {selectedElement.options && (
                        <>
                          <h4>Exact options</h4>
                          <p>{selectedElement.options.join(" · ")}</p>
                        </>
                      )}
                      {selectedElement.inferred.length > 0 && (
                        <>
                          <h4>Inferred details</h4>
                          <p>{selectedElement.inferred.join("; ")}</p>
                        </>
                      )}
                      {model?.useCases
                        .filter((u) =>
                          u.elementIds.includes(selectedElement.id),
                        )
                        .map((u) => (
                          <button
                            key={u.id}
                            className="text-button"
                            onClick={() => onCase(u.id)}
                          >
                            {u.id} · {u.title}
                            <ArrowRight size={12} />
                          </button>
                        ))}
                      <Button
                        compact
                        onClick={() =>
                          onProposeChange(
                            selectedElement.id,
                            selectedElement.label || selectedElement.key,
                          )
                        }
                      >
                        <Layers2 size={13} />
                        Propose a change
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="inspector-navigation">
              <IconButton
                label="Previous screen"
                disabled={index === 0}
                onClick={() => selectScreen(project.screens[index - 1].id)}
              >
                <ChevronLeft size={15} />
              </IconButton>
              <span>
                {index + 1} of {project.screens.length} screens
              </span>
              <IconButton
                label="Next screen"
                disabled={index === project.screens.length - 1}
                onClick={() => selectScreen(project.screens[index + 1].id)}
              >
                <ChevronRight size={15} />
              </IconButton>
            </div>
          </aside>
        </div>
      )}
      <Confirm
        open={!!pendingScreen}
        title="Keep your screen details?"
        description="Save your notes and screen name before switching, or discard this draft."
        onCancel={() => setPendingScreen("")}
        onDiscard={() => {
          setScreenId(pendingScreen);
          setPendingScreen("");
        }}
      />
      <Modal
        open={focus}
        onClose={() => setFocus(false)}
        title={screen?.name ?? "Screenshot"}
        description="Saved evidence · controls pictured inside the image are not interactive."
        wide
      >
        {screen && (
          <PrivateImage
            className="focus-evidence"
            src={image(screen, version)}
            alt={screen.name}
          />
        )}
      </Modal>
      <Modal
        open={remove}
        onClose={() => setRemove(false)}
        title="Remove this screenshot?"
        description="Its existing specifications are retained for review."
        footer={
          <>
            <Button onClick={() => setRemove(false)}>Keep screen</Button>
            <Button
              variant="danger"
              onClick={() =>
                void attempt(async () => {
                  await api(
                    `/projects/${project.id}/screens/${screen.id}`,
                    "DELETE",
                  );
                  setRemove(false);
                  await onRefresh();
                })
              }
            >
              Remove screenshot
            </Button>
          </>
        }
      >
        <p className="muted">{screen?.name}</p>
      </Modal>
      <Modal
        open={figma}
        onClose={() => !busy && setFigma(false)}
        title="Import Figma frames"
        description="Reads selected frames from Figma using your configured token. This contacts Figma when you load or import."
        wide
        footer={
          <>
            <Button disabled={busy} onClick={() => setFigma(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy || !selectedFrames.length}
              onClick={() => {
                setFigma(false);
                void onImportFigma({
                  fileUrl: figmaUrl,
                  frameIds: selectedFrames,
                  scale: Number(figmaScale) as 1 | 2,
                });
              }}
            >
              {busy ? "Working…" : "Import selected frames"}
            </Button>
          </>
        }
      >
        {operationError && (
          <p className="real-inline-error" role="alert">
            {operationError}
          </p>
        )}
        <Field label="Figma file URL" htmlFor="figma-file">
          <div className="input-action">
            <input
              id="figma-file"
              value={figmaUrl}
              onChange={(e) => setFigmaUrl(e.target.value)}
            />
            <Button
              disabled={busy}
              onClick={() =>
                void attempt(async () => {
                  const result = await api<{ frames: FigmaFrame[] }>(
                    `/projects/${project.id}/figma/frames`,
                    "POST",
                    { fileUrl: figmaUrl },
                  );
                  setFrames(result.frames);
                  setSelectedFrames([]);
                })
              }
            >
              Load frames
            </Button>
          </div>
        </Field>
        <div className="form-grid real-frame-options">
          <Field label="Filter frames" htmlFor="figma-filter">
            <input
              id="figma-filter"
              value={frameFilter}
              onChange={(e) => setFrameFilter(e.target.value)}
              placeholder="Frame or page name…"
            />
          </Field>
          <Field label="Import scale">
            <Picker
              value={figmaScale}
              onChange={setFigmaScale}
              label="Figma import scale"
              options={[
                { value: "1", label: "1× · original size" },
                { value: "2", label: "2× · more detail" },
              ]}
            />
          </Field>
        </div>
        <div className="real-frame-list">
          {frames
            .filter((f) =>
              `${f.name} ${f.page}`
                .toLowerCase()
                .includes(frameFilter.toLowerCase()),
            )
            .map((f) => (
              <label key={f.id}>
                <input
                  type="checkbox"
                  checked={selectedFrames.includes(f.id)}
                  onChange={(e) =>
                    setSelectedFrames((v) =>
                      e.target.checked
                        ? [...v, f.id]
                        : v.filter((id) => id !== f.id),
                    )
                  }
                />
                {f.thumbnailUrl && (
                  <PrivateImage
                    src={f.thumbnailUrl}
                    alt={`Preview of ${f.name}`}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                )}
                <span>
                  {f.name}
                  <small className="muted">
                    {f.page} · {f.width} × {f.height}
                  </small>
                </span>
              </label>
            ))}
        </div>
      </Modal>
    </div>
  );
}
