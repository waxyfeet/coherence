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
  Minus,
  MoreHorizontal,
  MousePointer2,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
  ZoomIn,
} from "lucide-react";
import {
  Badge,
  Button,
  Field,
  IconButton,
  Menu,
  Modal,
  SectionHeading,
} from "./ui";
import { initialScreens, type ScreenItem } from "./data";
import SampleScreen from "./SampleScreen";

export default function ScreensWorkspace({
  screens,
  selectedId,
  onSelect,
  onUpdate,
  onAdd,
  onRemove,
  onReorder,
  onNext,
  onOpenCase,
  notify,
}: {
  screens: ScreenItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  onUpdate: (id: string, patch: Partial<ScreenItem>) => void;
  onAdd: (screens: ScreenItem[]) => void;
  onRemove: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  onNext: () => void;
  onOpenCase: (id: string) => void;
  notify: (text: string) => void;
}) {
  const screen = screens.find((s) => s.id === selectedId) ?? screens[0];
  const index = screens.indexOf(screen);
  const [notes, setNotes] = useState(screen.notes);
  const [inspector, setInspector] = useState("details");
  const [overlay, setOverlay] = useState(false);
  const [element, setElement] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [focus, setFocus] = useState(false);
  const [remove, setRemove] = useState(false);
  const [figma, setFigma] = useState(false);
  const [framesLoaded, setFramesLoaded] = useState(false);
  const [frameSelection, setFrameSelection] = useState(
    initialScreens.map((s) => s.id),
  );
  const [figmaUrl, setFigmaUrl] = useState(
    "https://www.figma.com/design/sample/Northstar",
  );
  const [dragged, setDragged] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setNotes(screen.notes);
    setZoom(1);
    setElement(null);
  }, [screen.id]);

  async function readFiles(files: FileList | File[] | null, replace = false) {
    if (!files) return;
    const prepared: ScreenItem[] = [];
    for (const file of Array.from(files)) {
      if (
        !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          file.type,
        ) ||
        file.size > 25 * 1024 * 1024
      ) {
        notify(`${file.name}: choose PNG, JPEG, WebP or GIF under 25 MB.`);
        continue;
      }
      const url = URL.createObjectURL(file);
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        prepared.push({
          id: `local-${Date.now()}-${prepared.length}`,
          title: file.name.replace(/\.[^.]+$/, ""),
          kind: "orders",
          fileName: file.name,
          version: 1,
          notes:
            "Local preview only. The sample analysis does not read this image.",
          width: image.naturalWidth,
          height: image.naturalHeight,
          url,
        });
      } catch {
        URL.revokeObjectURL(url);
        notify(`${file.name} could not be decoded.`);
      }
    }
    if (replace && prepared[0]) {
      onUpdate(screen.id, {
        ...prepared[0],
        id: screen.id,
        title: screen.title,
        version: screen.version + 1,
      });
      notify(
        "Image replaced in memory. The scripted analysis still uses sample results.",
      );
    } else if (prepared.length) {
      onAdd(prepared);
      notify(
        `${prepared.length} image${prepared.length > 1 ? "s" : ""} added to the browser preview. Nothing was uploaded.`,
      );
    }
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
        void readFiles(files);
      }
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  });
  const elementLabels =
    screen.kind === "login"
      ? ["Work email", "Password", "Sign in"]
      : screen.kind === "create"
        ? ["Customer", "Delivery address", "Submit order"]
        : screen.kind === "detail"
          ? ["Order summary", "Status timeline", "Line items"]
          : ["Search orders", "All statuses", "Orders table", "New order"];
  const matchingCase =
    screen.kind === "login"
      ? "UC-001"
      : screen.kind === "create"
        ? "UC-004"
        : screen.kind === "detail"
          ? "UC-006"
          : "UC-003";

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
                <Button>
                  <Upload size={14} />
                  Import
                  <ChevronDownIcon />
                </Button>
              }
              items={[
                {
                  label: "Browse local images",
                  icon: <FileImage size={14} />,
                  onSelect: () => fileRef.current?.click(),
                },
                {
                  label: "Figma frames · mock",
                  icon: <Frame size={14} />,
                  onSelect: () => {
                    setFigma(true);
                    setFramesLoaded(false);
                  },
                },
              ]}
            />
            <Button variant="primary" onClick={onNext}>
              Analyse screens
              <ArrowRight size={14} />
            </Button>
          </>
        }
      />
      <input
        className="sr-only"
        ref={fileRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif"
        aria-label="Choose local screenshot images"
        onChange={(e) => {
          void readFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        className="sr-only"
        ref={replaceRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        aria-label="Replace selected screenshot"
        onChange={(e) => {
          void readFiles(e.target.files, true);
          e.target.value = "";
        }}
      />
      <div className="screens-workbench">
        <aside className="screen-filmstrip">
          <div className="pane-label">
            <span>JOURNEY ORDER</span>
            <Badge>{screens.length}</Badge>
          </div>
          <div className="filmstrip-items">
            {screens.map((s, i) => (
              <div
                key={s.id}
                draggable
                onDragStart={() => setDragged(s.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragged)
                    onReorder(
                      screens.findIndex((x) => x.id === dragged),
                      i,
                    );
                  setDragged(null);
                }}
                className={`screen-thumb ${s.id === screen.id ? "selected" : ""} ${dragged === s.id ? "dragging" : ""}`}
              >
                <button
                  className="screen-thumb-select"
                  aria-label={`Select ${s.title}`}
                  aria-pressed={s.id === screen.id}
                  onClick={() => onSelect(s.id)}
                >
                  <div className="screen-thumb-image">
                    <SampleScreen screen={s} miniature />
                    <span className="screen-number">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    {s.version > 1 && <span className="thumb-change-dot" />}
                  </div>
                  <div className="screen-thumb-title">
                    <span>{s.title}</span>
                    <small>
                      {s.version > 1
                        ? "Updated · v" + s.version
                        : "v1 · Sample screen"}
                    </small>
                  </div>
                </button>
                <Menu
                  trigger={
                    <button
                      className="thumb-menu icon-button"
                      aria-label={`Actions for ${s.title}`}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  }
                  items={[
                    {
                      label: "Move earlier",
                      icon: <ArrowUp size={13} />,
                      onSelect: () => onReorder(i, Math.max(0, i - 1)),
                    },
                    {
                      label: "Move later",
                      icon: <ArrowDown size={13} />,
                      onSelect: () =>
                        onReorder(i, Math.min(screens.length - 1, i + 1)),
                    },
                    {
                      label: "Select screen",
                      icon: <Focus size={13} />,
                      onSelect: () => onSelect(s.id),
                    },
                  ]}
                />
              </div>
            ))}
          </div>
          <button
            className="add-screen-tile"
            onClick={() => fileRef.current?.click()}
          >
            <Plus size={17} />
            <span>Add screens</span>
            <small>or paste an image</small>
          </button>
          <p className="filmstrip-hint">Drag to reorder the journey.</p>
        </aside>
        <section className="screen-canvas-panel">
          <div className="canvas-toolbar">
            <div className="canvas-file">
              <FileImage size={14} />
              <span>{screen.fileName}</span>
              <Badge tone={screen.version > 1 ? "amber" : "neutral"}>
                v{screen.version}
              </Badge>
            </div>
            <div className="canvas-tools">
              <TipButton
                label="Inspect sample elements"
                active={overlay}
                onClick={() => {
                  setOverlay((v) => !v);
                  setInspector("elements");
                }}
              >
                <MousePointer2 size={15} />
              </TipButton>
              <span className="toolbar-separator" />
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
                    <MoreHorizontal size={17} />
                  </button>
                }
                items={[
                  {
                    label: "Replace image locally",
                    icon: <ImagePlus size={14} />,
                    onSelect: () => replaceRef.current?.click(),
                  },
                  {
                    label: "Fit to view",
                    icon: <Maximize2 size={14} />,
                    onSelect: () => setZoom(1),
                  },
                  {
                    label: "Remove from sample session",
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
            className="canvas-surface"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) e.preventDefault();
            }}
            onDrop={(e) => {
              if (e.dataTransfer.files.length) {
                e.preventDefault();
                void readFiles(e.dataTransfer.files);
              }
            }}
          >
            <div className="canvas-stamp">
              <span className="crosshair">+</span> SCREEN{" "}
              {String(index + 1).padStart(2, "0")} /{" "}
              {String(screens.length).padStart(2, "0")}
            </div>
            <div
              className="screen-artboard"
              style={{ width: `${zoom * 100}%` }}
            >
              <div className="artboard-browser">
                <span className="browser-dot" />
                <span className="browser-dot" />
                <span className="browser-dot" />
                <span className="artboard-url">
                  northstar.example /{" "}
                  {screen.kind === "orders" ? "orders" : screen.kind}
                </span>
                <span>↗</span>
              </div>
              <div className="artboard-image">
                <SampleScreen screen={screen} />
                {overlay &&
                  !screen.url &&
                  elementLabels.map((label, i) => (
                    <button
                      key={label}
                      className={`element-box ${element === label ? "selected" : ""}`}
                      style={{
                        left: `${screen.kind === "login" ? 8 : 21 + i * 4}%`,
                        top: `${screen.kind === "login" ? 43 + i * 15 : 47 + i * 8}%`,
                        width: `${screen.kind === "login" ? 35 : Math.max(18, 48 - i * 9)}%`,
                        height:
                          screen.kind === "orders" && i === 2 ? "28%" : "7%",
                      }}
                      aria-label={`Inspect ${label}`}
                      onClick={() => {
                        setElement(label);
                        setInspector("elements");
                      }}
                    >
                      <span>{label}</span>
                    </button>
                  ))}
              </div>
            </div>
            <div className="canvas-bottom-note">
              <span className="crosshair">+</span>
              <span>
                {screen.url
                  ? "Local image · preview only"
                  : "Original synthetic design · Northstar customer portal"}
              </span>
              <span className="crosshair">+</span>
            </div>
          </div>
          <div className="canvas-footer">
            <div>
              <span className="small-dot green" />
              {screen.width} × {screen.height}
              <span className="footer-dot">·</span>
              {screen.url ? "Local preview" : "PNG · sample"}
            </div>
            <div className="zoom-controls">
              <IconButton
                label="Zoom out"
                disabled={zoom <= 0.65}
                onClick={() => setZoom((v) => Math.max(0.65, v - 0.15))}
              >
                <Minus size={13} />
              </IconButton>
              <button
                onClick={() => setZoom(1)}
                aria-label="Fit screenshot to view"
              >
                {Math.round(zoom * 100)}%
              </button>
              <IconButton
                label="Zoom in"
                disabled={zoom >= 1.6}
                onClick={() => setZoom((v) => Math.min(1.6, v + 0.15))}
              >
                <Plus size={13} />
              </IconButton>
              <span className="toolbar-separator" />
              <IconButton label="Fit to view" onClick={() => setZoom(1)}>
                <Focus size={14} />
              </IconButton>
            </div>
          </div>
        </section>
        <aside className="screen-inspector">
          <div className="inspector-tabs">
            <button
              className={inspector === "details" ? "active" : ""}
              onClick={() => setInspector("details")}
            >
              Details
            </button>
            <button
              className={inspector === "elements" ? "active" : ""}
              onClick={() => {
                setInspector("elements");
                setOverlay(true);
              }}
            >
              Elements<Badge>{elementLabels.length}</Badge>
            </button>
          </div>
          <div className="inspector-body">
            {inspector === "details" ? (
              <>
                <div className="inspector-section">
                  <span className="section-kicker">SCREEN DETAILS</span>
                  <h3>{screen.title}</h3>
                  <p>Part of the customer ordering journey.</p>
                  <div className="metadata-list">
                    <span>
                      Version
                      <strong>{String(screen.version).padStart(2, "0")}</strong>
                    </span>
                    <span>
                      Source
                      <strong>
                        {screen.url ? "Local image" : "Sample design"}
                      </strong>
                    </span>
                    <span>
                      Analysis
                      <strong>
                        <Badge
                          tone={screen.version > 1 ? "amber" : "green"}
                          dot
                        >
                          {screen.version > 1
                            ? "Review changes"
                            : "Sample ready"}
                        </Badge>
                      </strong>
                    </span>
                  </div>
                </div>
                <div className="inspector-section">
                  <div className="inline-between">
                    <span className="section-kicker">
                      CONTEXT FOR THE ANALYST
                    </span>
                    <SlidersHorizontal size={13} />
                  </div>
                  <p>Add the details a screenshot can’t tell.</p>
                  <label className="sr-only" htmlFor="screen-notes">
                    Screen notes
                  </label>
                  <textarea
                    id="screen-notes"
                    className="screen-notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={5}
                  />
                  <Button
                    compact
                    disabled={notes === screen.notes}
                    onClick={() => {
                      onUpdate(screen.id, { notes });
                      notify("Screen notes updated for this session.");
                    }}
                  >
                    <Check size={12} />
                    Save notes
                  </Button>
                </div>
                <div className="inspector-section">
                  <span className="section-kicker">LINKED USE CASE</span>
                  <button
                    className="linked-case"
                    onClick={() => onOpenCase(matchingCase)}
                  >
                    <span className="case-mini-icon">
                      <FileImage size={15} />
                    </span>
                    <span>
                      <small>{matchingCase}</small>
                      <strong>
                        {screen.kind === "orders"
                          ? "Browse and filter orders"
                          : screen.kind === "login"
                            ? "Sign in to your account"
                            : screen.kind === "create"
                              ? "Enter delivery details"
                              : "Review order details"}
                      </strong>
                    </span>
                    <ChevronRight size={13} />
                  </button>
                </div>
                <div className="inspector-tip">
                  <Layers2 size={16} />
                  <p>
                    Capture dropdowns and error states as extra screens to give
                    your analyst the full picture.
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="inspector-section">
                  <div className="inline-between">
                    <span className="section-kicker">SAMPLE INVENTORY</span>
                    <Badge tone="green">Covered</Badge>
                  </div>
                  <p>
                    Hand-authored example elements. No image recognition is
                    taking place.
                  </p>
                  {elementLabels.map((label, i) => (
                    <button
                      className={`element-list-item ${element === label ? "selected" : ""}`}
                      key={label}
                      onClick={() => {
                        setElement(label);
                        setOverlay(true);
                      }}
                    >
                      <span className="element-index">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span>
                        {label}
                        <small>
                          {i === 0
                            ? "Input"
                            : i === 1
                              ? "Selection"
                              : "Interaction"}
                        </small>
                      </span>
                      <span className="small-dot green" />
                    </button>
                  ))}
                </div>
                {element && (
                  <div className="inspector-section">
                    <span className="section-kicker">ELEMENT DETAILS</span>
                    <h3>{element}</h3>
                    <p>
                      Visible label: “{element}”. Bounds and coverage are part
                      of the synthetic fixture.
                    </p>
                    <button
                      className="text-button"
                      onClick={() => onOpenCase(matchingCase)}
                    >
                      View covering use case
                      <ArrowRight size={13} />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="inspector-navigation">
            <IconButton
              label="Previous screen"
              disabled={index === 0}
              onClick={() => onSelect(screens[index - 1].id)}
            >
              <ChevronLeft size={15} />
            </IconButton>
            <span>
              {index + 1} of {screens.length} screens
            </span>
            <IconButton
              label="Next screen"
              disabled={index === screens.length - 1}
              onClick={() => onSelect(screens[index + 1].id)}
            >
              <ChevronRight size={15} />
            </IconButton>
          </div>
        </aside>
      </div>
      <Modal
        open={focus}
        onClose={() => setFocus(false)}
        title={screen.title}
        description="Synthetic screenshot preview. The pictured Northstar controls are part of the image."
        wide
      >
        <SampleScreen screen={screen} />
      </Modal>
      <Modal
        open={remove}
        onClose={() => setRemove(false)}
        title="Remove this screen?"
        description="This only changes the sample browser session. The bundled example can be restored by refreshing."
        footer={
          <>
            <Button onClick={() => setRemove(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={screens.length <= 1}
              onClick={() => {
                onRemove(screen.id);
                setRemove(false);
              }}
            >
              Remove sample screen
            </Button>
          </>
        }
      >
        <p className="muted">
          {screens.length <= 1
            ? "Keep at least one screen in the sample workspace."
            : `“${screen.title}” will be removed from the filmstrip. Existing sample use cases remain available.`}
        </p>
      </Modal>
      <Modal
        open={figma}
        onClose={() => setFigma(false)}
        title="Import design frames"
        description="Figma import demonstration · no Figma account or API connection."
        wide
        footer={
          <>
            <span className="dialog-footer-note">Synthetic frames only</span>
            <Button onClick={() => setFigma(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!framesLoaded || frameSelection.length === 0}
              onClick={() => {
                const frames = initialScreens
                  .filter((s) => frameSelection.includes(s.id))
                  .map((s, i) => ({
                    ...s,
                    id: `frame-${Date.now()}-${i}`,
                    title: s.title + " · imported",
                    notes:
                      "Imported from a bundled sample frame. No Figma request was made.",
                  }));
                onAdd(frames);
                setFigma(false);
                notify(
                  `${frames.length} sample frames added. Figma was not contacted.`,
                );
              }}
            >
              Import {frameSelection.length} sample frames
              <ArrowRight size={14} />
            </Button>
          </>
        }
      >
        <Field label="Figma file URL" htmlFor="figma-url">
          <div className="input-action">
            <input
              id="figma-url"
              value={figmaUrl}
              onChange={(e) => setFigmaUrl(e.target.value)}
            />
            <Button
              disabled={!figmaUrl.trim()}
              onClick={() => setFramesLoaded(true)}
            >
              <Frame size={14} />
              Load sample frames
            </Button>
          </div>
        </Field>
        {framesLoaded ? (
          <div className="figma-frame-grid">
            {initialScreens.map((s) => (
              <label key={s.id}>
                <div>
                  <SampleScreen screen={s} miniature />
                </div>
                <span>
                  <input
                    type="checkbox"
                    checked={frameSelection.includes(s.id)}
                    onChange={(e) =>
                      setFrameSelection((v) =>
                        e.target.checked
                          ? [...v, s.id]
                          : v.filter((id) => id !== s.id),
                      )
                    }
                  />
                  {s.title}
                </span>
              </label>
            ))}
          </div>
        ) : (
          <div className="import-empty">
            <Frame size={30} />
            <h3>A frame for every part of the journey.</h3>
            <p>
              Load the four bundled sample frames to try selecting and
              importing.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
function TipButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <IconButton
      label={label}
      aria-pressed={active}
      className={active ? "active" : ""}
      onClick={onClick}
    >
      {children}
    </IconButton>
  );
}
function ChevronDownIcon() {
  return <ChevronRight size={12} style={{ transform: "rotate(90deg)" }} />;
}
