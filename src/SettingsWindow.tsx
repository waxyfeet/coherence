import { PROVIDER_PRESETS } from "../shared/providers";
import type { ConnectionUsage, ListModelsResponse } from "../shared/api";
import { OFFLINE_MODEL_ID } from "../shared/modelSelection";
import type { CapabilityTester } from "./ModelCapabilityTests";
import { modelEvidenceForConnection } from "../shared/modelCapabilities";
import {
  analysisModelDefaults,
  sameAnalysisDefaults,
  defaultRoleIssue,
} from "../shared/analysisDefaults";
import { AnalysisModelDefaults } from "./AnalysisModelDefaults";
import { OutputBudgetField } from "./OutputBudgetField";
import { BrandMark } from "./BrandMark";
import {
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
  type CSSProperties,
} from "react";
import { Dialog } from "radix-ui";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cloud,
  Copy,
  Cpu,
  Eye,
  EyeOff,
  FlaskConical,
  Folder,
  GitFork as Github,
  Grip,
  Layers2,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Monitor,
  MoreHorizontal,
  Move,
  Palette,
  PanelLeftClose,
  Plug,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import {
  Badge,
  Button,
  Confirm,
  Field,
  IconButton,
  Menu,
  Picker,
  Tip,
  Toggle,
} from "./ui";
import {
  initialSettings,
  newConnection,
  providers,
  tuningDefaults,
  type Connection,
  type Provider,
  type SettingsData,
} from "./data";
import { mountAppearance } from "./appearance";
import { SessionAuthorization } from "./sessionAuthorization";
import {
  matchesConnectionFilter,
  type ConnectionFilter,
} from "./connectionFilters";
import {
  ConnectionModels,
  catalogueIdentity,
  keyCheckText,
} from "./ConnectionModels";
import { keyState } from "./connectionKey";
import {
  LOCAL_SERVER_ADDRESS,
  RECOGNISED_SERVICES,
  normaliseCompatibleAddress,
  recognisedService,
} from "../shared/compatibleServices";
import {
  ODYSSEUS_THEMES,
  ODYSSEUS_PALETTES,
  isOdysseusTheme,
} from "./themes/odysseus";

const clone = <T,>(value: T): T => structuredClone(value);
const editableConnection = ({
  catalogue: _catalogue,
  capabilities: _capabilities,
  ...c
}: Connection) => c;
const sections = [
  {
    title: "AI & MODELS",
    items: [
      {
        id: "connections",
        label: "Connections",
        icon: Plug,
        keywords:
          "provider model API key BYOK cloud local Ollama LM Studio vLLM Anthropic OpenAI Azure Gemini connection endpoint timeout tokens effort temperature structured output",
      },
      {
        id: "analysis",
        label: "Analysis defaults",
        icon: SlidersHorizontal,
        keywords:
          "agents roles vision writer thoroughness granularity preserve screenshots cache",
      },
    ],
  },
  {
    title: "CONNECTED TOOLS",
    items: [
      {
        id: "integrations",
        label: "Integrations",
        icon: Layers2,
        keywords: "Jira Azure DevOps GitHub Figma tracker export",
      },
      {
        id: "jira",
        label: "Jira",
        icon: ArrowUpRight,
        sub: true,
        keywords: "Atlassian epic project token issue points",
      },
      {
        id: "azdo",
        label: "Azure DevOps",
        icon: Layers2,
        sub: true,
        keywords: "Microsoft PAT organization work items",
      },
      {
        id: "github",
        label: "GitHub",
        icon: Github,
        sub: true,
        keywords: "repository issues token milestones GHE",
      },
      {
        id: "figma",
        label: "Figma",
        icon: Palette,
        sub: true,
        keywords: "design import frames token",
      },
    ],
  },
  {
    title: "APPLICATION",
    items: [
      {
        id: "appearance",
        label: "Appearance",
        icon: Palette,
        keywords: "theme dark light system colour motion",
      },
      {
        id: "storage",
        label: "Workspace",
        icon: Folder,
        keywords: "storage output files project folder",
      },
    ],
  },
];
const integrationNames: Record<string, string> = {
  jira: "Jira",
  azdo: "Azure DevOps",
  github: "GitHub",
  figma: "Figma",
};
const integrationFields: Record<
  string,
  { key: string; label: string; placeholder?: string; help?: string }[]
> = {
  jira: [
    { key: "url", label: "Site URL" },
    {
      key: "email",
      label: "Account email",
      help: "Jira Cloud uses your account email and API token.",
    },
    { key: "project", label: "Project key" },
    { key: "issueType", label: "Story issue type" },
    { key: "parentType", label: "Feature issue type" },
    { key: "linkType", label: "Dependency link type" },
    { key: "labels", label: "Labels" },
    {
      key: "pointsField",
      label: "Story points field",
      help: "An optional custom field ID, such as customfield_10016.",
    },
  ],
  azdo: [
    { key: "url", label: "Organisation URL" },
    { key: "project", label: "Project" },
    { key: "issueType", label: "Work item type" },
    { key: "parentType", label: "Parent work item type" },
    { key: "area", label: "Area path" },
    { key: "iteration", label: "Iteration path" },
    { key: "labels", label: "Tags" },
  ],
  github: [
    { key: "owner", label: "Owner" },
    { key: "repo", label: "Repository" },
    {
      key: "url",
      label: "API URL",
      help: "A custom API URL can represent a GitHub Enterprise instance.",
    },
    { key: "labels", label: "Labels" },
  ],
  figma: [
    {
      key: "url",
      label: "Sample Figma file URL",
      help: "The import demonstration uses bundled sample screens. No file is requested.",
    },
  ],
};

function Help({ text }: { text: string }) {
  return (
    <Tip label={text}>
      <button className="help-icon" type="button" aria-label={text}>
        <CircleHelp size={13} />
      </button>
    </Tip>
  );
}
function PanelTitle({
  icon,
  title,
  description,
  actions,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="settings-panel-title">
      <div className="settings-title-icon">{icon}</div>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {actions && <div className="settings-title-actions">{actions}</div>}
    </div>
  );
}

/** What removing a connection affects, in plain words (owner test notes 1 and 6). */
export function removalText(
  removal: { usage?: ConnectionUsage; target?: { name: string } } | undefined,
): string {
  const usage = removal?.usage;
  const uses = [
    usage?.readingDefault ? "the Read screens default" : "",
    usage?.writingDefault ? "the Write use cases default" : "",
    usage?.projects.length
      ? `${usage.projects.length} project${usage.projects.length === 1 ? "" : "s"} (${usage.projects
          .slice(0, 3)
          .map((p) => p.name)
          .join(", ")}${usage.projects.length > 3 ? ", …" : ""})`
      : "",
  ].filter(Boolean);
  const list =
    uses.length > 1
      ? `${uses.slice(0, -1).join(", ")} and ${uses.at(-1)}`
      : uses[0];
  return [
    "Any key saved for it is deleted from this computer, and the change is saved straight away.",
    list ? `It is used by ${list}.` : "Nothing uses it.",
    list && removal?.target
      ? `They can move to ${removal.target.name}, which has the same model${usage!.modelIds.length === 1 ? "" : "s"}. Or remove it and choose later: defaults go back to the Offline demo, and projects ask you to choose again.`
      : list
        ? "No other connection has the same models: defaults go back to the Offline demo, and projects ask you to choose again."
        : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export default function SettingsWindow({
  open,
  onClose,
  settings,
  onSave,
  notify,
  initialCategory = "connections",
  live = false,
  onTest,
  onDiscover,
  onCapability,
  onConnectionUsage,
  onReassign,
}: {
  open: boolean;
  onClose: () => void;
  settings: SettingsData;
  onSave: (settings: SettingsData) => void | Promise<SettingsData>;
  live?: boolean;
  onTest?: (
    category: string,
    connection: Connection,
    draft: SettingsData,
  ) => Promise<{ ok: boolean; message: string }>;
  onDiscover?: (connection: Connection) => Promise<ListModelsResponse>;
  onCapability?: CapabilityTester;
  /** What uses a saved connection, asked before removing it (owner test notes 1 and 6). */
  onConnectionUsage?: (id: string) => Promise<ConnectionUsage>;
  /** Moves the projects that use one connection to another. */
  onReassign?: (
    from: string,
    to: string,
  ) => Promise<{ moved: number; kept: number }>;
  notify: (text: string) => void;
  initialCategory?: string;
}) {
  const sessionAuthorized = useContext(SessionAuthorization);
  const [testModelId, setTestModelId] = useState("");
  const catalogueResults = useRef(
    new Map<string, NonNullable<ListModelsResponse["catalogue"]>>(),
  );
  const discoverySequence = useRef(0);
  const [discovering, setDiscovering] = useState(false);
  const [draft, setDraft] = useState(() => clone(settings));
  const [category, setCategory] = useState("connections");
  const [selectedId, setSelectedId] = useState<string | undefined>(
    settings.connections[0]?.id,
  );
  const [connectionFilter, setConnectionFilter] =
    useState<ConnectionFilter>("all");
  // New accounts share the atomic Settings draft, but are not saved pills.
  const [newConnectionId, setNewConnectionId] = useState<string>();
  const newConnectionNameEdited = useRef(false);
  const [query, setQuery] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [discovered, setDiscovered] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<
    { value: string; label: string }[]
  >([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [serviceMessage, setServiceMessage] = useState("");
  const testSequence = useRef(0);
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "success" | "failure"
  >("idle");
  const [testOutcome, setTestOutcome] = useState("success");
  const [testLabel, setTestLabel] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [guard, setGuard] = useState(false);
  const [railWidth, setRailWidth] = useState(218);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [maximized, setMaximized] = useState(false);
  const windowRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uid = useId();
  const selected =
    draft.connections.find((c) => c.id === selectedId) ?? draft.connections[0];
  const savedOf = (c: Connection) =>
    settings.connections.find((value) => value.id === c.id);
  // Removing a saved connection: what uses it, and where those uses can move.
  const [removal, setRemoval] = useState<{
    id: string;
    name: string;
    usage?: ConnectionUsage;
    target?: Connection;
  }>();
  // What Coherence changed in a pasted address, shown until the address is edited again.
  const [addressNote, setAddressNote] = useState<{
    id: string;
    text: string;
  }>();
  const selectedService =
    selected?.provider === "compatible"
      ? recognisedService(selected.endpoint)
      : undefined;
  const compatibleHint = [
    addressNote && addressNote.id === selected?.id ? addressNote.text : "",
    selectedService
      ? `Recognised address: ${selectedService.name}. Recognised is not verified: finding models checks it.`
      : "For an online service, paste its API address or choose one below. For a server on this computer, use its address ending in /v1.",
    "Keys go in the API key field, never in the address.",
  ]
    .filter(Boolean)
    .join(" ");
  function chooseAddress(url: string) {
    setAddressNote(undefined);
    updateConnection({ endpoint: url });
  }
  /** Owner test note 2: accept what people paste, and say what changed. */
  function tidyAddress() {
    if (!live || selected?.provider !== "compatible") return;
    const tidy = normaliseCompatibleAddress(selected.endpoint);
    if (!tidy || tidy.url === selected.endpoint) return;
    updateConnection({ endpoint: tidy.url });
    setAddressNote({
      id: selected.id,
      text: `Coherence ${tidy.changes.join(", ")}.`,
    });
  }
  // An empty library has no selected connection.
  const selectedKey = selected
    ? keyState(selected, savedOf(selected))
    : "not-needed";
  const editable = (value: SettingsData) =>
    JSON.stringify({
      ...value,
      connections: value.connections.map(editableConnection),
    });
  const dirty = editable(draft) !== editable(settings);
  const connectionDirty = (c: Connection) => {
    const saved = settings.connections.find((value) => value.id === c.id);
    return (
      !saved ||
      JSON.stringify(editableConnection(c)) !==
        JSON.stringify(editableConnection(saved))
    );
  };
  const connectionCategory = ["connections", "cloud", "local"].includes(
    category,
  );
  const integrationCategory = [
    "integrations",
    "jira",
    "azdo",
    "github",
    "figma",
  ].includes(category);
  const provider = providers[selected?.provider ?? "anthropic"];
  const builtInOffline = live && selected?.provider === "mock";
  const selectedPreset =
    PROVIDER_PRESETS[
      selected?.provider === "azure"
        ? "azure-openai"
        : selected?.provider === "compatible" ||
            selected?.provider === "lmstudio"
          ? "openai-compatible"
          : (selected?.provider ?? "mock")
    ];
  const listedConnections = draft.connections.filter(
    (c) => c.id !== newConnectionId,
  );
  const matchingConnections = listedConnections.filter((c) =>
    matchesConnectionFilter(c, connectionFilter),
  );
  const creatingConnection =
    !!newConnectionId && selected?.id === newConnectionId;
  const selectedVisible =
    creatingConnection ||
    matchingConnections.some((c) => c.id === selected?.id);
  const tuningEvidence = modelEvidenceForConnection(selected, testModelId);

  useEffect(() => {
    if (open) {
      setSaveError("");
      setDraft(clone(settings));
      // Preserve callers using the former filtered Settings destinations.
      setCategory(
        ["cloud", "local"].includes(initialCategory)
          ? "connections"
          : initialCategory,
      );
      setConnectionFilter(
        initialCategory === "cloud" || initialCategory === "local"
          ? initialCategory
          : "all",
      );
      setNewConnectionId(undefined);
      newConnectionNameEdited.current = false;
      const initial = settings.connections.find((c) =>
        matchesConnectionFilter(
          c,
          initialCategory === "cloud" || initialCategory === "local"
            ? initialCategory
            : "all",
        ),
      );
      setSelectedId(
        !["cloud", "local"].includes(initialCategory) &&
          settings.connections.some((c) => c.id === selectedId)
          ? selectedId
          : (initial?.id ?? settings.connections[0]?.id),
      );
      setAdvanced(false);
      setShowKey(false);
      setErrors({});
      setGuard(false);
      setTestStatus("idle");
      setPosition({ x: 0, y: 0 });
    } else if (timer.current) {
      clearTimeout(timer.current);
    }
  }, [open]);
  useEffect(() => {
    testSequence.current++;
    setTestStatus("idle");
    setDiscovered(false);
    if (timer.current) clearTimeout(timer.current);
  }, [selectedId, category]);
  useEffect(() => {
    setTestModelId("");
    setDiscoveredModels([]);
    discoverySequence.current++;
    setDiscovering(false);
  }, [selectedId]);
  useEffect(
    () => () => {
      discoverySequence.current++;
    },
    [open],
  );
  useEffect(() => {
    return mountAppearance(open ? draft : settings, live, sessionAuthorized);
  }, [
    sessionAuthorized,
    live,
    open,
    draft.theme,
    draft.density,
    draft.reduceMotion,
    draft.backgroundEffects,
    settings.theme,
    settings.density,
    settings.reduceMotion,
    settings.backgroundEffects,
  ]);
  useEffect(() => {
    const reset = () => {
      setPosition({ x: 0, y: 0 });
    };
    window.addEventListener("resize", reset);
    return () => {
      window.removeEventListener("resize", reset);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function updateConnection(patch: Partial<Connection>) {
    testSequence.current++;
    if (
      ["provider", "endpoint", "apiKey", "azureVersion"].some(
        (key) => key in patch,
      )
    ) {
      discoverySequence.current++;
      setDiscovering(false);
      setDiscoveredModels([]);
      patch = { catalogue: undefined, ...patch };
    }
    if (patch.provider && patch.provider !== selected.provider)
      patch = { ...patch, visibleModelIds: [], manualModelIds: [] };
    if (
      [
        "provider",
        "endpoint",
        "apiKey",
        "keyPresent",
        "azureVersion",
        "vision",
        "structured",
        "effort",
        "temperature",
        "maxTokens",
        "timeout",
      ].some((key) => key in patch)
    )
      patch = { ...patch, capabilities: undefined };
    setDraft((s) => ({
      ...s,
      connections: s.connections.map((c) =>
        c.id === selected.id ? { ...c, ...patch } : c,
      ),
    }));
    setErrors({});
    setTestStatus("idle");
    if (timer.current) clearTimeout(timer.current);
  }
  function update<K extends keyof SettingsData>(
    key: K,
    value: SettingsData[K],
  ) {
    setDraft((s) => ({ ...s, [key]: value }));
  }
  function validate(data = draft): boolean {
    const invalid: Record<string, string> = {};
    for (const c of data.connections) {
      // Live Offline is read-only and does not consume provider tuning. Keep legacy values;
      // the API still validates every saved record under the existing atomic save contract.
      if (live && c.provider === "mock") continue;
      if (!c.name.trim()) invalid.name = "Give this connection a name.";
      if (live && c.pendingModelId?.trim())
        invalid.model = `Click Add model or clear the pending model ID for ${c.name} before saving.`;
      if (!live && !c.model.trim())
        invalid.model = "Enter a model ID or deployment name.";
      try {
        const url = new URL(c.endpoint);
        if (!["http:", "https:"].includes(url.protocol)) throw Error();
      } catch {
        invalid.endpoint =
          c.provider === "compatible" && !c.endpoint.trim()
            ? "Enter the service's API address, or choose one below."
            : "Use a full http:// or https:// endpoint URL.";
      }
      if (live && keyState(c, savedOf(c)) === "saved-elsewhere")
        invalid.apiKey = `Enter the API key again for this address, or Clear the saved key. The saved key is only sent to the address it was saved with.`;
      if (c.concurrency < 1 || c.concurrency > 64)
        invalid.concurrency = "Choose between 1 and 64 parallel requests.";
      if (c.timeout !== 0 && (c.timeout < 5 || c.timeout > 7200))
        invalid.timeout =
          "Choose a timeout between 5 and 7,200 seconds, or leave it empty for Automatic.";
      if (
        c.maxTokens !== 0 &&
        (!Number.isInteger(c.maxTokens) ||
          c.maxTokens < 256 ||
          c.maxTokens > 1000000)
      )
        invalid.maxTokens = "Choose between 256 and 1,000,000 tokens.";
      if (Object.keys(invalid).length) {
        setSelectedId(c.id);
        setCategory("connections");
        break;
      }
    }
    setErrors(invalid);
    if (live && !Object.keys(invalid).length) {
      const next = analysisModelDefaults(
        data.analysisDefaults,
        data.connections,
      );
      const previous = analysisModelDefaults(
        settings.analysisDefaults,
        settings.connections,
      );
      // A default whose connection this save removes must be dealt with (owner test note 6).
      const removesDefault = [
        next.visionConnectionId,
        next.textConnectionId,
      ].some(
        (id) =>
          !data.connections.some((c) => c.id === id) &&
          settings.connections.some((c) => c.id === id),
      );
      if (removesDefault || !sameAnalysisDefaults(next, previous)) {
        const issue =
          defaultRoleIssue(next, data.connections, true) ??
          defaultRoleIssue(next, data.connections, false);
        if (issue) {
          invalid.analysisDefaults = issue;
          setCategory("analysis");
          setErrors({ ...invalid });
        }
      }
    }
    if (invalid.concurrency || invalid.timeout || invalid.maxTokens)
      setAdvanced(true);
    return Object.keys(invalid).length === 0;
  }
  /** Saves `data` (the draft unless given); `message` replaces the usual notice. True when saved. */
  async function save(
    close: boolean,
    data = draft,
    message?: string,
  ): Promise<boolean> {
    if (saving || !validate(data)) {
      setGuard(false);
      return false;
    }
    setSaving(true);
    setSaveError("");
    try {
      let safe = clone(data);
      if (live) {
        const result = await onSave(safe);
        if (result) safe = result;
        const keyless = safe.connections
          .filter((c) => keyState(c) === "missing")
          .map((c) => c.name);
        notify(
          message
            ? message
            : keyless.length
              ? `Settings saved. ${keyless.join(", ")} ${keyless.length === 1 ? "has" : "have"} no API key: analysis will stop at the first request unless the service needs none.`
              : "Settings saved to the Coherence data folder. Secrets are protected by Windows.",
        );
      } else {
        safe.connections = safe.connections.map((c) => ({
          ...c,
          apiKey: "",
          keyPresent: c.keyPresent || c.apiKey.length > 0,
        }));
        for (const key of Object.keys(safe.integrations))
          safe.integrations[key].token = "";
        onSave(safe);
        notify(
          "Settings saved for this session. Placeholder secrets discarded.",
        );
      }
      setDraft(safe);
      if (newConnectionId) {
        setSelectedId(newConnectionId);
        setConnectionFilter("all");
        setNewConnectionId(undefined);
      }
      setGuard(false);
      if (close) onClose();
      return true;
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "Settings could not be saved. Your draft is kept.",
      );
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function discover() {
    if (discovered && !live) {
      setDiscovered(false);
      return;
    }
    if (live && onDiscover) {
      const sequence = ++discoverySequence.current;
      setDiscovering(true);
      try {
        const models = await onDiscover(selected);
        if (sequence !== discoverySequence.current) return;
        setDiscoveredModels(
          models.models.map((m) => ({ value: m.id, label: m.label ?? m.id })),
        );
        setDiscovered(true);
        notify(
          models.error ??
            models.models.length +
              " models returned by the configured provider.",
        );
      } catch (error) {
        if (sequence !== discoverySequence.current) return;
        notify(
          error instanceof Error ? error.message : "Model discovery failed.",
        );
      } finally {
        if (sequence === discoverySequence.current) setDiscovering(false);
      }
    } else {
      setDiscovered(true);
      notify("Sample model catalog loaded. No provider was contacted.");
    }
  }
  function requestClose() {
    if (saving) return;
    if (dirty) setGuard(true);
    else onClose();
  }
  function addConnection(kind: Provider) {
    if (newConnectionId || saving) return;
    const c = newConnection(kind, `connection-${crypto.randomUUID()}`);
    if (live) {
      c.model = "";
      c.modelIds = [];
      // Online service or a server on this computer is the user's choice (owner test note 2).
      if (kind === "compatible") c.endpoint = "";
    }
    setDraft((s) => ({ ...s, connections: [...s.connections, c] }));
    beginConnection(c);
  }
  function beginConnection(c: Connection) {
    setNewConnectionId(c.id);
    newConnectionNameEdited.current = false;
    setSelectedId(c.id);
    setCategory("connections");
    setAdvanced(false);
    setErrors({});
    setSaveError("");
  }
  function cancelNewConnection() {
    if (saving) return;
    testSequence.current++;
    discoverySequence.current++;
    setDiscovering(false);
    setDraft((s) => ({
      ...s,
      connections: s.connections.filter((c) => c.id !== newConnectionId),
    }));
    setNewConnectionId(undefined);
    setSelectedId(matchingConnections[0]?.id ?? listedConnections[0]?.id);
    setErrors({});
    setSaveError("");
  }
  function filterConnections(value: ConnectionFilter) {
    setConnectionFilter(value);
    const next = listedConnections.find((c) =>
      matchesConnectionFilter(c, value),
    );
    setSelectedId(next?.id);
  }
  /** A saved connection that lists every model ID the uses chose, so they can move without a guess. */
  function moveTarget(id: string, usage: ConnectionUsage) {
    return usage.modelIds.length
      ? settings.connections.find(
          (c) =>
            c.id !== id &&
            c.provider !== "mock" &&
            usage.modelIds.every((m) => c.modelIds?.includes(m)),
        )
      : undefined;
  }
  async function removeConnection() {
    if (draft.connections.length < 2) {
      notify(
        live
          ? "Keep at least one connection."
          : "Keep at least one sample connection.",
      );
      return;
    }
    if (live) {
      // Owner test notes 1 and 6: say what removing it affects, and save it at once.
      const usage =
        onConnectionUsage &&
        settings.connections.some((c) => c.id === selected.id)
          ? await onConnectionUsage(selected.id).catch(() => undefined)
          : undefined;
      setRemoval({
        id: selected.id,
        name: selected.name,
        usage,
        target: usage ? moveTarget(selected.id, usage) : undefined,
      });
      return;
    }
    const next = draft.connections.filter((c) => c.id !== selected.id);
    setDraft((s) => ({
      ...s,
      connections: next,
      defaultId: s.defaultId === selected.id ? next[0].id : s.defaultId,
      visionId: !live && s.visionId === selected.id ? next[0].id : s.visionId,
      textId: !live && s.textId === selected.id ? next[0].id : s.textId,
    }));
    setSelectedId(next[0].id);
    notify(
      live
        ? "Connection removed from this draft. Save to apply."
        : "Connection removed from the sample session.",
    );
  }
  async function confirmRemoval(move: boolean) {
    const r = removal;
    setRemoval(undefined);
    if (!r) return;
    const target = move ? r.target : undefined;
    const next = draft.connections.filter((c) => c.id !== r.id);
    const offline = next.find((c) => c.provider === "mock");
    const defaults = analysisModelDefaults(
      draft.analysisDefaults,
      draft.connections,
    );
    const changed: string[] = [];
    const role = (id: string, model: string, label: string) => {
      if (id !== r.id) return [id, model];
      if (target) return [target.id, model];
      changed.push(label);
      return offline ? [offline.id, OFFLINE_MODEL_ID] : ["", ""];
    };
    const [visionConnectionId, visionModelId] = role(
      defaults.visionConnectionId,
      defaults.visionModelId,
      "Read screens",
    );
    const [textConnectionId, textModelId] = role(
      defaults.textConnectionId,
      defaults.textModelId,
      "Write use cases",
    );
    const general = draft.defaultId === r.id ? (target ?? next[0]) : undefined;
    const data: SettingsData = {
      ...draft,
      connections: next,
      defaultId: general?.id ?? draft.defaultId,
      analysisDefaults: {
        visionConnectionId,
        visionModelId,
        textConnectionId,
        textModelId,
      },
    };
    const projects = r.usage?.projects.length ?? 0;
    const notes = [`Removed ${r.name} and its saved key.`];
    if (target && (r.usage?.readingDefault || r.usage?.writingDefault))
      notes.push(`The analysis defaults now use ${target.name}.`);
    if (changed.length)
      notes.push(
        `The ${changed.join(" and ")} default ${changed.length > 1 ? "are" : "is"} now the Offline demo: choose a model in Analysis defaults.`,
      );
    if (general) notes.push(`${general.name} is now the general default.`);
    setDraft(data);
    setSelectedId(target?.id ?? next[0].id);
    if (!(await save(false, data, notes.join(" ")))) return;
    if (projects && target && onReassign) {
      const { moved, kept } = await onReassign(r.id, target.id).catch(() => ({
        moved: 0,
        kept: projects,
      }));
      notify(
        [
          ...notes,
          moved
            ? `Moved ${moved} project${moved === 1 ? "" : "s"} to ${target.name}.`
            : "",
          kept
            ? `${kept} project${kept === 1 ? "" : "s"} need another connection: choose again in Analysis.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    } else if (projects)
      notify(
        [
          ...notes,
          `${projects} project${projects === 1 ? "" : "s"} need another connection: choose again in Analysis.`,
        ].join(" "),
      );
  }
  async function runTest(label = selected?.name) {
    if (connectionCategory && !validate()) return;
    if (live && connectionCategory && !testModelId.trim()) {
      setServiceMessage(
        "Enter the exact model ID for this explicit test first. No provider request was made.",
      );
      setTestStatus("failure");
      return;
    }
    setTestLabel(label ?? category);
    setTestStatus("testing");
    const sequence = ++testSequence.current;
    if (live && onTest) {
      try {
        const result = await onTest(
          category,
          connectionCategory
            ? { ...selected, model: testModelId.trim() }
            : selected,
          draft,
        );
        if (sequence === testSequence.current) {
          setServiceMessage(result.message);
          setTestStatus(result.ok ? "success" : "failure");
        }
      } catch (error) {
        if (sequence === testSequence.current) {
          setServiceMessage(
            error instanceof Error ? error.message : "Connection test failed.",
          );
          setTestStatus("failure");
        }
      }
    } else {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(
        () => setTestStatus(testOutcome === "success" ? "success" : "failure"),
        900,
      );
    }
  }
  function resetSection() {
    if (connectionCategory) updateConnection({ ...tuningDefaults });
    else if (category === "analysis")
      setDraft((s) => ({
        ...s,
        thoroughness: "standard",
        granularity: "balanced",
        preserveEdits: true,
        embedImages: true,
        reuseAnalysis: true,
        ...(live
          ? {
              analysisDefaults: analysisModelDefaults(undefined, s.connections),
            }
          : {}),
      }));
    else if (category === "appearance")
      setDraft((s) => ({
        ...s,
        theme: "dark",
        ...(!live && { density: "comfortable", reduceMotion: false }),
      }));
    else if (integrationNames[category])
      setDraft((s) => ({
        ...s,
        integrations: {
          ...s.integrations,
          [category]: live
            ? {
                ...s.integrations[category],
                labels: "",
                issueType: category === "azdo" ? "User Story" : "Story",
                parentType: category === "azdo" ? "Feature" : "Epic",
              }
            : clone(initialSettings.integrations[category]),
        },
      }));
    notify(
      connectionCategory
        ? "Advanced tuning reset in the draft."
        : "Defaults restored in the draft.",
    );
  }
  function startDrag(e: PointerEvent<HTMLElement>) {
    if (
      maximized ||
      window.innerWidth < 760 ||
      (e.target as HTMLElement).closest("button,input,select,a")
    )
      return;
    const el = e.currentTarget;
    const box = windowRef.current?.getBoundingClientRect();
    if (!box) return;
    const start = { x: e.clientX, y: e.clientY };
    el.setPointerCapture(e.pointerId);
    const move = (event: globalThis.PointerEvent) => {
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      setPosition({
        x:
          position.x +
          Math.max(
            16 - box.left,
            Math.min(window.innerWidth - 16 - box.right, dx),
          ),
        y:
          position.y +
          Math.max(
            16 - box.top,
            Math.min(window.innerHeight - 16 - box.bottom, dy),
          ),
      });
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }
  function startResize(e: PointerEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const start = e.clientX;
    const width = railWidth;
    const move = (event: globalThis.PointerEvent) =>
      setRailWidth(Math.max(176, Math.min(300, width + event.clientX - start)));
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
  }
  const options = listedConnections.map((c) => ({
    value: c.id,
    label: c.name,
    detail: live
      ? `${providers[c.provider].kind} · ${c.modelIds?.length ?? 0} model IDs`
      : `${providers[c.provider].kind} · ${c.model}`,
  }));
  const testFeedback = (
    <>
      {testStatus !== "idle" && (
        <div className={`connection-result ${testStatus}`} role="status">
          {testStatus === "testing" ? (
            <LoaderCircle size={17} className="spin" />
          ) : testStatus === "success" ? (
            <CheckCheck size={17} />
          ) : (
            <CircleHelp size={17} />
          )}
          <div>
            <strong>
              {live
                ? testStatus === "testing"
                  ? "Testing configured connection…"
                  : testStatus === "success"
                    ? "Connection successful"
                    : "Connection unavailable"
                : testStatus === "testing"
                  ? "Testing sample connection…"
                  : testStatus === "success"
                    ? "Mock connection successful"
                    : "Mock connection unavailable"}
            </strong>
            <span>
              {live
                ? testStatus === "testing"
                  ? "This explicit test contacts the selected provider and may consume tokens."
                  : serviceMessage
                : testStatus === "testing"
                  ? "Running a scripted UI demonstration."
                  : testStatus === "success"
                    ? `${testLabel} · illustrative latency 240 ms · no network request`
                    : "Simulated endpoint error. Check the sample URL or choose a successful mock outcome."}
            </span>
          </div>
          <Badge tone="neutral">{live ? "Provider result" : "Simulated"}</Badge>
        </div>
      )}
    </>
  );
  const testBar = (label?: string) => (
    <div className="connection-test-row">
      <Button
        onClick={() => runTest(label)}
        disabled={testStatus === "testing"}
      >
        {testStatus === "testing" ? (
          <LoaderCircle size={14} className="spin" />
        ) : (
          <FlaskConical size={14} />
        )}
        Test connection
        <Badge tone="neutral">
          {live
            ? connectionCategory && selected?.provider === "mock"
              ? "Offline"
              : "Network"
            : "Mock"}
        </Badge>
      </Button>
      {!live && (
        <div className="mock-outcome">
          <span>Outcome</span>
          <Picker
            value={testOutcome}
            onChange={(v) => {
              setTestOutcome(v);
              setTestStatus("idle");
            }}
            label="Mock test outcome"
            options={[
              { value: "success", label: "Successful" },
              { value: "failure", label: "Unavailable" },
            ]}
          />
        </div>
      )}
    </div>
  );

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && requestClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="settings-overlay" />
        <Dialog.Content
          ref={windowRef}
          className={`settings-window ${live ? "settings-live" : ""} ${maximized ? "maximized" : ""}`}
          style={
            {
              "--rail-width": `${railWidth}px`,
              "--window-x": `${position.x}px`,
              "--window-y": `${position.y}px`,
            } as React.CSSProperties
          }
          onEscapeKeyDown={(e) => {
            if (guard) e.preventDefault();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            returnFocus.current?.focus();
          }}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            returnFocus.current = document.activeElement as HTMLElement;
            windowRef.current
              ?.querySelector<HTMLInputElement>(".settings-search input")
              ?.focus();
          }}
        >
          <header className="window-titlebar" onPointerDown={startDrag}>
            <div className="window-title">
              <span className="window-symbol">
                <Settings2 size={16} />
              </span>
              <Dialog.Title>Settings</Dialog.Title>
              <span className="window-title-divider" />
              <span className="window-project">Coherence workspace</span>
            </div>
            <div className="window-controls">
              <Badge tone="accent">
                <FlaskConical size={11} />
                {live ? "Local application" : "Prototype"}
              </Badge>
              <Tip label="Drag the title bar to reposition. Reset restores the centred window.">
                <span className="drag-hint">
                  <Move size={13} />
                </span>
              </Tip>
              <IconButton
                label="Reset window position"
                onClick={() => {
                  setPosition({ x: 0, y: 0 });
                  setMaximized(false);
                }}
              >
                <RotateCcw size={14} />
              </IconButton>
              <IconButton
                label={
                  maximized ? "Restore window size" : "Expand settings window"
                }
                onClick={() => {
                  setMaximized((v) => !v);
                  setPosition({ x: 0, y: 0 });
                }}
              >
                {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </IconButton>
              <IconButton
                label="Close settings"
                onClick={requestClose}
                showTooltip={false}
              >
                <X size={17} />
              </IconButton>
            </div>
          </header>
          <Dialog.Description className="sr-only">
            {live
              ? "Configure protected local provider settings and integrations. Save applies all sections atomically. Test and Discover contact the configured service."
              : "Configure sample AI connections, analysis and integrations. All tests are simulated. Changes only last for this browser session."}
          </Dialog.Description>
          <div
            inert={saving}
            className={`settings-layout ${railCollapsed ? "rail-collapsed" : ""}`}
          >
            <aside className="settings-nav">
              <div className="settings-search">
                <Search size={14} />
                <input
                  aria-label="Search settings"
                  placeholder="Search settings…"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setRailCollapsed(false);
                  }}
                />
                {query ? (
                  <button
                    aria-label="Clear settings search"
                    onClick={() => setQuery("")}
                  >
                    <X size={12} />
                  </button>
                ) : (
                  <kbd>⌕</kbd>
                )}
              </div>
              <nav
                aria-label="Settings categories"
                className="settings-nav-scroll"
              >
                {sections.map((group) => {
                  const items = group.items.filter(
                    (i) =>
                      !query ||
                      (i.label + " " + i.keywords)
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                  );
                  return (
                    items.length > 0 && (
                      <div className="settings-nav-group" key={group.title}>
                        <div className="nav-group-label">{group.title}</div>
                        {items.map((item) => (
                          <button
                            key={item.id}
                            className={`settings-nav-item ${item.sub ? "sub" : ""} ${category === item.id ? "active" : ""}`}
                            aria-current={
                              category === item.id ? "page" : undefined
                            }
                            onClick={() => {
                              setCategory(item.id);
                            }}
                          >
                            <item.icon size={15} />
                            <span>{item.label}</span>
                            {category === item.id && (
                              <span className="nav-selection-dot" />
                            )}
                          </button>
                        ))}
                      </div>
                    )
                  );
                })}
                {query &&
                  !sections.some((g) =>
                    g.items.some((i) =>
                      (i.label + " " + i.keywords)
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    ),
                  ) && (
                    <div className="settings-no-results">
                      No settings match “{query}”.
                      <button onClick={() => setQuery("")}>Clear search</button>
                    </div>
                  )}
              </nav>
              <div className="settings-nav-foot">
                <BrandMark />
                <div>
                  <strong>Coherence</strong>
                  <span>{live ? "Local application" : "Design preview"}</span>
                </div>
                <IconButton
                  label={
                    railCollapsed
                      ? "Expand settings categories"
                      : "Collapse settings categories"
                  }
                  onClick={() => setRailCollapsed((v) => !v)}
                >
                  <PanelLeftClose size={14} />
                </IconButton>
              </div>
            </aside>
            <div
              className="settings-rail-handle"
              role="separator"
              tabIndex={0}
              aria-label="Resize settings navigation"
              aria-orientation="vertical"
              aria-valuemin={176}
              aria-valuemax={300}
              aria-valuenow={railWidth}
              onPointerDown={startResize}
              onDoubleClick={() => setRailWidth(218)}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  setRailWidth((w) =>
                    Math.max(
                      176,
                      Math.min(300, w + (e.key === "ArrowRight" ? 12 : -12)),
                    ),
                  );
                }
                if (e.key === "Home") setRailWidth(176);
                if (e.key === "End") setRailWidth(300);
              }}
            />
            <div className="settings-main" key={category}>
              {connectionCategory && (
                <>
                  <PanelTitle
                    icon={<Plug size={21} />}
                    title="AI connections"
                    description="Your models. Your keys. Your choice of where work happens."
                    actions={
                      <Menu
                        trigger={
                          <Button
                            compact
                            disabled={!!newConnectionId || saving}
                          >
                            <Plus size={13} />
                            Add connection
                          </Button>
                        }
                        items={(Object.keys(providers) as Provider[])
                          .filter((p) => !live || p !== "mock")
                          .map((p) => ({
                            label: providers[p].label,
                            onSelect: () => addConnection(p),
                          }))}
                      />
                    }
                  />
                  <div className="settings-mini-notice">
                    <FlaskConical size={13} />
                    <span>
                      {live
                        ? "Configuration is saved locally. Test and Discover contact the selected service only when clicked."
                        : "Sample configuration. Connections and model discovery are simulated."}
                    </span>
                  </div>
                  <div
                    className="connection-filters"
                    role="group"
                    aria-label="Filter connections"
                  >
                    {(
                      [
                        ["all", "All"],
                        ["cloud", "Cloud"],
                        ["local", "Local"],
                      ] as const
                    ).map(([value, label]) => (
                      <Button
                        key={value}
                        compact
                        aria-pressed={connectionFilter === value}
                        disabled={!!newConnectionId || saving}
                        onClick={() => filterConnections(value)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                  <div
                    className="connection-tabs"
                    role="group"
                    aria-label={
                      live ? "Saved connections" : "Sample connections"
                    }
                  >
                    {matchingConnections.map((c) => (
                      <button
                        type="button"
                        className={`connection-tab ${!creatingConnection && selected?.id === c.id ? "selected" : ""}`}
                        key={c.id}
                        aria-pressed={
                          !creatingConnection && selected?.id === c.id
                        }
                        disabled={!!newConnectionId || saving}
                        onClick={() => setSelectedId(c.id)}
                      >
                        <span className={`provider-avatar ${c.provider}`}>
                          {providers[c.provider].letter}
                        </span>
                        <span>
                          <strong>{c.name}</strong>
                          <small>
                            {c.provider === "mock"
                              ? "Built-in · Simulated"
                              : providers[c.provider].kind}
                            {live && c.provider !== "mock" && " · Saved"}
                            {live && connectionDirty(c) && " · Unsaved changes"}
                            {!live && c.id === draft.defaultId
                              ? " · Default"
                              : ""}
                          </small>
                        </span>
                        {!creatingConnection && selected?.id === c.id && (
                          <Check size={13} />
                        )}
                      </button>
                    ))}
                  </div>
                  {newConnectionId && (
                    <div className="settings-callout" role="note">
                      <Plus size={20} />
                      <div>
                        <h3>New connection</h3>
                        <p>
                          Not saved yet. Choose a provider and enter its
                          details. Save or cancel this connection before
                          switching accounts.
                        </p>
                        <Button disabled={saving} onClick={cancelNewConnection}>
                          Cancel new connection
                        </Button>
                      </div>
                    </div>
                  )}
                  {!creatingConnection && matchingConnections.length === 0 && (
                    <div className="settings-callout" role="status">
                      <Plug size={22} />
                      <div>
                        <h3>
                          No{" "}
                          {connectionFilter === "all"
                            ? "saved"
                            : connectionFilter}{" "}
                          connections yet
                        </h3>
                        <p>
                          Choose Add connection, then select your provider. You
                          can configure models and advanced settings here after
                          saving.
                        </p>
                      </div>
                    </div>
                  )}
                  {selected &&
                    selectedVisible &&
                    (builtInOffline ? (
                      <div
                        className="settings-callout"
                        role="note"
                        aria-label="Built-in Offline demo"
                      >
                        <FlaskConical size={20} />
                        <div>
                          <h3>Offline demo</h3>
                          <Badge>Built-in · Simulated</Badge>
                          <p>
                            Explore Coherence without an API key or external AI
                            service. Offline demo uses built-in sample results
                            to demonstrate the workflow. It does not analyse
                            your screenshots using a live AI model.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="connection-editor">
                          <div className="subsection-head">
                            <div>
                              <span className="section-kicker">
                                CONNECTION DETAILS
                              </span>
                              <Badge
                                tone={
                                  ["ollama", "compatible"].includes(
                                    selected.provider,
                                  )
                                    ? "green"
                                    : "blue"
                                }
                                dot
                              >
                                {provider.kind}
                              </Badge>
                            </div>
                            {!creatingConnection &&
                              live &&
                              selected.provider !== "mock" && (
                                <Button
                                  compact
                                  variant="ghost"
                                  onClick={() => void removeConnection()}
                                >
                                  <Trash2 size={13} />
                                  Remove
                                </Button>
                              )}
                            {!creatingConnection && (
                              <Menu
                                trigger={
                                  <button
                                    className="icon-button"
                                    aria-label="Connection actions"
                                  >
                                    <MoreHorizontal size={17} />
                                  </button>
                                }
                                items={[
                                  {
                                    label: live
                                      ? "Choose analysis defaults"
                                      : "Use as default",
                                    icon: live ? (
                                      <SlidersHorizontal size={14} />
                                    ) : (
                                      <Star size={14} />
                                    ),
                                    onSelect: () =>
                                      live
                                        ? setCategory("analysis")
                                        : update("defaultId", selected.id),
                                  },
                                  {
                                    label: "Duplicate connection",
                                    icon: <Copy size={14} />,
                                    onSelect: () => {
                                      const c = {
                                        ...selected,
                                        id: `connection-${crypto.randomUUID()}`,
                                        name: `${selected.name} copy`,
                                        apiKey: "",
                                        keyPresent: live
                                          ? false
                                          : selected.keyPresent,
                                      };
                                      setDraft((s) => ({
                                        ...s,
                                        connections: [...s.connections, c],
                                      }));
                                      beginConnection(c);
                                      newConnectionNameEdited.current = true;
                                    },
                                  },
                                  {
                                    label: "Remove connection",
                                    icon: <Trash2 size={14} />,
                                    danger: true,
                                    divider: true,
                                    onSelect: () => void removeConnection(),
                                  },
                                ]}
                              />
                            )}
                          </div>
                          <div className="form-grid">
                            <Field
                              label="Connection name"
                              htmlFor={`${uid}-name`}
                              error={errors.name}
                            >
                              <input
                                id={`${uid}-name`}
                                value={selected.name}
                                onChange={(e) => {
                                  newConnectionNameEdited.current = true;
                                  updateConnection({ name: e.target.value });
                                }}
                                autoComplete="off"
                              />
                            </Field>
                            <Field label="Provider">
                              <Picker
                                value={selected.provider}
                                onChange={(value) => {
                                  const p = value as Provider;
                                  // Only an untouched suggestion follows provider selection.
                                  const followProvider =
                                    creatingConnection &&
                                    !newConnectionNameEdited.current;
                                  updateConnection({
                                    ...(followProvider
                                      ? {
                                          name: `${providers[p].label} connection`,
                                        }
                                      : {}),
                                    provider: p,
                                    model: live
                                      ? ""
                                      : providers[p].models[0].value,
                                    ...(live ? { modelIds: [] } : {}),
                                    pendingModelId: undefined,
                                    endpoint:
                                      live && p === "compatible"
                                        ? ""
                                        : providers[p].endpoint,
                                    apiKey: "",
                                    keyPresent: false,
                                  });
                                  setDiscovered(false);
                                }}
                                label="AI provider"
                                options={(Object.keys(providers) as Provider[])
                                  .filter((p) => !live || p !== "mock")
                                  .map((p) => ({
                                    value: p,
                                    label: providers[p].label,
                                    detail: providers[p].kind,
                                  }))}
                              />
                            </Field>
                          </div>
                          {!live && (
                            <Field
                              label={
                                selected.provider === "azure"
                                  ? "Deployment name"
                                  : "Model"
                              }
                              htmlFor={`${uid}-model`}
                              error={errors.model}
                              hint={
                                <>
                                  <span className="inline-dot" />
                                  {live
                                    ? selected.provider === "mock"
                                      ? "Deterministic fixture generator. No AI model or network endpoint is used."
                                      : "Enter the exact model ID, or discover models from your configured endpoint."
                                    : "Sample model IDs. Availability has not been checked against a provider."}
                                </>
                              }
                            >
                              <div className="input-action">
                                {discovered ? (
                                  <Picker
                                    value={selected.model}
                                    disabled={
                                      live && selected.provider === "mock"
                                    }
                                    onChange={(model) =>
                                      updateConnection({ model })
                                    }
                                    label="Model"
                                    options={
                                      (live
                                        ? discoveredModels
                                        : provider.models
                                      ).some((m) => m.value === selected.model)
                                        ? live
                                          ? discoveredModels
                                          : provider.models
                                        : [
                                            {
                                              value: selected.model,
                                              label: selected.model,
                                            },
                                            ...(live
                                              ? discoveredModels
                                              : provider.models),
                                          ]
                                    }
                                  />
                                ) : (
                                  <input
                                    id={`${uid}-model`}
                                    className="mono"
                                    readOnly={
                                      live && selected.provider === "mock"
                                    }
                                    value={selected.model}
                                    onChange={(e) =>
                                      updateConnection({
                                        model: e.target.value,
                                      })
                                    }
                                    autoComplete="off"
                                  />
                                )}
                                {(!live || selected.provider !== "mock") && (
                                  <Button onClick={() => void discover()}>
                                    <Search size={13} />
                                    {discovered ? "Manual entry" : "Discover"}
                                    <span className="subtle-label">
                                      {live ? "Network" : "Mock"}
                                    </span>
                                  </Button>
                                )}
                              </div>
                            </Field>
                          )}
                          {(!live ||
                            !["anthropic", "openai", "gemini"].includes(
                              selected.provider,
                            ) ||
                            advanced) && (
                            <Field
                              label={
                                live &&
                                ["ollama", "lmstudio"].includes(
                                  selected.provider,
                                )
                                  ? "Local server address"
                                  : live && selected.provider === "azure"
                                    ? "Resource endpoint"
                                    : "Endpoint URL"
                              }
                              htmlFor={`${uid}-endpoint`}
                              error={errors.endpoint}
                              hint={
                                selected.provider === "ollama"
                                  ? live
                                    ? "Use your trusted local endpoint. Remote credentialed connections require HTTPS; loopback HTTP and uncredentialed private LAN models are supported. Keep credentials in the API key field, never in the URL."
                                    : "In the finished app, Ollama would run on your own computer. This prototype does not connect to it."
                                  : live && selected.provider === "compatible"
                                    ? compatibleHint
                                    : live
                                      ? "Use HTTPS remotely. Enter keys in the protected API key field. URL credentials, query parameters, fragments and redirects are not supported; use the final direct endpoint."
                                      : undefined
                              }
                            >
                              <div className="input-with-leading">
                                <span>
                                  <Cloud size={14} />
                                </span>
                                <input
                                  id={`${uid}-endpoint`}
                                  className="mono"
                                  value={selected.endpoint}
                                  placeholder={
                                    live && selected.provider === "compatible"
                                      ? "https://…/v1"
                                      : undefined
                                  }
                                  onChange={(e) =>
                                    updateConnection({
                                      endpoint: e.target.value,
                                    })
                                  }
                                  onBlur={tidyAddress}
                                  autoComplete="off"
                                />
                              </div>
                            </Field>
                          )}
                          {live && selected.provider === "compatible" && (
                            <div
                              className="address-presets"
                              role="group"
                              aria-label="Recognised addresses"
                            >
                              <span className="field-hint">
                                Recognised addresses:
                              </span>
                              {RECOGNISED_SERVICES.map((s) => (
                                <Button
                                  key={s.id}
                                  compact
                                  onClick={() => chooseAddress(s.baseUrl)}
                                >
                                  {s.name}
                                </Button>
                              ))}
                              <Button
                                compact
                                onClick={() =>
                                  chooseAddress(LOCAL_SERVER_ADDRESS)
                                }
                              >
                                A server on this computer
                              </Button>
                            </div>
                          )}
                          {(!live ||
                            !["ollama", "lmstudio"].includes(
                              selected.provider,
                            ) ||
                            advanced ||
                            selected.keyPresent) &&
                            selected.provider !== "mock" && (
                              <Field
                                label="API key"
                                htmlFor={`${uid}-key`}
                                error={
                                  errors.apiKey ??
                                  (live && selectedKey === "saved-elsewhere"
                                    ? `The saved key is only sent to ${savedOf(selected)?.endpoint || "the address it was saved with"}. Enter the key again for this address, or Clear it if this address needs no key.`
                                    : undefined)
                                }
                                hint={
                                  !live
                                    ? "Use a placeholder only. Typed values are discarded on save or close, and never sent."
                                    : selectedKey === "missing"
                                      ? "No API key saved. Analysis with this connection will stop at the first request unless the service needs no key."
                                      : "Stored with Windows account protection. An empty field keeps the saved key; Clear removes it."
                                }
                              >
                                <div
                                  className={`secret-field ${live && selected.keyPresent && !selected.apiKey ? "has-saved-key" : ""}`}
                                >
                                  <input
                                    id={`${uid}-key`}
                                    type={showKey ? "text" : "password"}
                                    value={selected.apiKey}
                                    onChange={(e) =>
                                      updateConnection({
                                        apiKey: e.target.value,
                                      })
                                    }
                                    placeholder={
                                      selected.keyPresent
                                        ? live
                                          ? "Saved key · enter a replacement"
                                          : "Sample key configured · enter a replacement"
                                        : live
                                          ? "Enter your API key"
                                          : "Enter a placeholder API key"
                                    }
                                    autoComplete="off"
                                    spellCheck={false}
                                  />
                                  <div className="secret-actions">
                                    {selected.keyPresent &&
                                      !selected.apiKey && (
                                        <>
                                          {live &&
                                          selectedKey === "saved-elsewhere" ? (
                                            <Badge tone="amber">
                                              Other address
                                            </Badge>
                                          ) : (
                                            <Badge tone="green">
                                              {live ? "Saved" : "Sample"}
                                            </Badge>
                                          )}
                                          {live && (
                                            <Button
                                              compact
                                              onClick={() =>
                                                updateConnection({
                                                  keyPresent: false,
                                                  apiKey: "",
                                                })
                                              }
                                            >
                                              Clear
                                            </Button>
                                          )}
                                        </>
                                      )}
                                    <IconButton
                                      label={
                                        live
                                          ? showKey
                                            ? "Hide API key"
                                            : "Show API key"
                                          : showKey
                                            ? "Hide placeholder key"
                                            : "Show placeholder key"
                                      }
                                      onClick={() => setShowKey((v) => !v)}
                                    >
                                      {showKey ? (
                                        <EyeOff size={15} />
                                      ) : (
                                        <Eye size={15} />
                                      )}
                                    </IconButton>
                                  </div>
                                </div>
                              </Field>
                            )}
                          {live && (
                            <ConnectionModels
                              key={selected.id}
                              connection={{
                                ...selected,
                                catalogue:
                                  catalogueResults.current.get(
                                    catalogueIdentity(selected),
                                  ) ?? selected.catalogue,
                              }}
                              entry={selected.pendingModelId ?? ""}
                              onEntry={(pendingModelId) =>
                                updateConnection({
                                  pendingModelId: pendingModelId || undefined,
                                })
                              }
                              saveError={errors.model}
                              onTest={
                                onCapability ??
                                (async () => {
                                  throw Error("Model testing is unavailable.");
                                })
                              }
                              onChange={updateConnection}
                              onFind={async () => {
                                const asked = selected;
                                const result = onDiscover
                                  ? await onDiscover(asked)
                                  : {
                                      models: [],
                                      error:
                                        "Model listing is unavailable. Enter model IDs manually.",
                                    };
                                // The API answered at the same server's /v1 address: use it (owner test note 2).
                                const moved =
                                  result.baseUrl &&
                                  result.baseUrl !== asked.endpoint
                                    ? result.baseUrl
                                    : undefined;
                                const id = catalogueIdentity(
                                  moved ? { ...asked, endpoint: moved } : asked,
                                );
                                if (moved) {
                                  updateConnection({
                                    endpoint: moved,
                                    catalogue: result.catalogue,
                                  });
                                  notify(
                                    `Found the service's API at ${moved}, and used that address.${keyCheckText(result.keyCheck)}`,
                                  );
                                }
                                if (result.catalogue) {
                                  catalogueResults.current.set(
                                    id,
                                    result.catalogue,
                                  );
                                  if (catalogueResults.current.size > 20)
                                    catalogueResults.current.delete(
                                      catalogueResults.current.keys().next()
                                        .value!,
                                    );
                                }
                                return result;
                              }}
                              testModel={testModelId}
                              onTestModel={(value) => {
                                testSequence.current++;
                                setTestModelId(value);
                                setTestStatus("idle");
                              }}
                            />
                          )}
                          {live &&
                            selected.provider !== "mock" &&
                            !!selected.modelIds?.length && (
                              <div className="settings-section">
                                <p className="field-hint">
                                  Configure your account here, then choose the
                                  model to use for new projects. No AI request
                                  is made when saving.
                                </p>
                                <Button
                                  compact
                                  onClick={() => setCategory("analysis")}
                                >
                                  Next: choose analysis model
                                </Button>
                              </div>
                            )}
                          {(!live || selected.provider !== "mock") && (
                            <button
                              className={`advanced-toggle ${advanced ? "expanded" : ""}`}
                              aria-expanded={advanced}
                              onClick={() => setAdvanced((v) => !v)}
                            >
                              <span>
                                {advanced ? (
                                  <ChevronDown size={14} />
                                ) : (
                                  <ChevronRight size={14} />
                                )}
                                Advanced configuration
                                <span
                                  title={
                                    live
                                      ? "Tune parameters supported by the selected provider."
                                      : "Tune model requests. These controls only affect the sample configuration."
                                  }
                                  className="help-icon"
                                >
                                  <CircleHelp size={13} />
                                </span>
                              </span>
                              <span>
                                {selected.maxTokens === 0
                                  ? "Automatic output"
                                  : Number.isFinite(selected.maxTokens)
                                    ? `${selected.maxTokens.toLocaleString()} token limit`
                                    : "Custom output"}{" "}
                                ·{" "}
                                {live
                                  ? selected.timeout === 0
                                    ? "automatic timeout"
                                    : `${selected.timeout}s timeout`
                                  : `${selected.effort} effort`}
                              </span>
                            </button>
                          )}
                          {advanced &&
                            (!live || selected.provider !== "mock") && (
                              <div className="advanced-panel">
                                <div className="form-grid">
                                  <Field
                                    label="Parallel requests"
                                    htmlFor={`${uid}-concurrency`}
                                    error={errors.concurrency}
                                  >
                                    <input
                                      id={`${uid}-concurrency`}
                                      type="number"
                                      min={1}
                                      max={64}
                                      value={selected.concurrency}
                                      onChange={(e) =>
                                        updateConnection({
                                          concurrency: Number(e.target.value),
                                        })
                                      }
                                    />
                                  </Field>
                                  <Field
                                    label="Request timeout"
                                    htmlFor={`${uid}-timeout`}
                                    error={errors.timeout}
                                    hint={`How long a service may stay silent. An answer that keeps arriving is never stopped. Empty: Automatic (${selectedPreset.defaultTimeoutSec} s for this provider).`}
                                  >
                                    <div className="input-suffix">
                                      <input
                                        id={`${uid}-timeout`}
                                        type="number"
                                        min={5}
                                        max={7200}
                                        placeholder="Automatic"
                                        value={selected.timeout || ""}
                                        onChange={(e) =>
                                          updateConnection({
                                            timeout:
                                              e.target.value === ""
                                                ? 0
                                                : Number(e.target.value),
                                          })
                                        }
                                      />
                                      <span>seconds</span>
                                    </div>
                                  </Field>
                                  <OutputBudgetField
                                    id={`${uid}-tokens`}
                                    value={selected.maxTokens}
                                    onChange={(maxTokens) =>
                                      updateConnection({ maxTokens })
                                    }
                                    error={errors.maxTokens}
                                    live={live}
                                  />
                                  {(!live ||
                                    (selectedPreset.supportsEffort &&
                                      tuningEvidence.reasoning.state ===
                                        "tested")) && (
                                    <Field label="Reasoning effort">
                                      <Picker
                                        label="Reasoning effort"
                                        value={selected.effort}
                                        onChange={(effort) =>
                                          updateConnection({ effort })
                                        }
                                        options={(
                                          selectedPreset.effortLevels ?? [
                                            "low",
                                            "medium",
                                            "high",
                                          ]
                                        ).map((v) => ({
                                          value: v,
                                          label:
                                            v[0].toUpperCase() + v.slice(1),
                                        }))}
                                      />
                                    </Field>
                                  )}
                                  {(!live ||
                                    (selectedPreset.supportsTemperature &&
                                      tuningEvidence.sampling.state ===
                                        "tested")) && (
                                    <Field
                                      label="Temperature"
                                      htmlFor={`${uid}-temperature`}
                                    >
                                      <input
                                        id={`${uid}-temperature`}
                                        type="number"
                                        min={0}
                                        max={2}
                                        step={0.1}
                                        value={selected.temperature}
                                        onChange={(e) =>
                                          updateConnection({
                                            temperature: Number(e.target.value),
                                          })
                                        }
                                      />
                                    </Field>
                                  )}
                                  <Field label="Image support">
                                    <Picker
                                      label="Image support"
                                      value={selected.vision}
                                      onChange={(vision) =>
                                        updateConnection({ vision })
                                      }
                                      options={[
                                        {
                                          value: "auto",
                                          label: "Automatic",
                                          detail: live
                                            ? "Detect model capability when available"
                                            : "Capability is illustrative in this prototype",
                                        },
                                        {
                                          value: "yes",
                                          label: "Supports images",
                                        },
                                        { value: "no", label: "Text only" },
                                      ]}
                                    />
                                  </Field>
                                  <Field label="Structured output">
                                    <Picker
                                      label="Structured output"
                                      value={selected.structured}
                                      onChange={(structured) =>
                                        updateConnection({ structured })
                                      }
                                      options={[
                                        { value: "auto", label: "Automatic" },
                                        {
                                          value: "native",
                                          label: "Native JSON schema",
                                        },
                                        {
                                          value: "prompt",
                                          label: "Prompt and validate",
                                        },
                                      ]}
                                    />
                                    {live && (
                                      <p className="field-hint">
                                        Automatic retains the provider adapter's
                                        existing behaviour. Compatible servers
                                        use prompt-and-validate unless Native is
                                        explicitly selected. A test result does
                                        not change this setting.
                                      </p>
                                    )}
                                  </Field>
                                  {selected.provider === "azure" && (
                                    <Field
                                      label="Azure API version"
                                      htmlFor={`${uid}-azure`}
                                    >
                                      <input
                                        id={`${uid}-azure`}
                                        value={selected.azureVersion}
                                        onChange={(e) =>
                                          updateConnection({
                                            azureVersion: e.target.value,
                                          })
                                        }
                                      />
                                    </Field>
                                  )}
                                </div>
                                <div className="advanced-help">
                                  <ShieldCheck size={14} />
                                  {live
                                    ? "Optional reasoning and sampling controls appear after this exact model accepts them in a test. Untested controls are omitted from analysis requests; saved values are preserved. Test again after changing a value. Image overrides are declarations, not verification."
                                    : "Only supported controls would be sent by a real provider adapter."}
                                </div>
                              </div>
                            )}
                          {!live && testBar()}
                          {!live && testFeedback}
                        </div>
                        <div className="privacy-footnote">
                          <ShieldCheck size={14} />
                          <span>
                            {live
                              ? "Your choice of cloud or local. Generation sends screenshots to the selected vision connection."
                              : "Your choice of cloud or local. This prototype sends neither screenshots nor keys anywhere."}
                          </span>
                        </div>
                      </>
                    ))}
                </>
              )}
              {category === "analysis" && (
                <>
                  <PanelTitle
                    icon={<SlidersHorizontal size={21} />}
                    title="Analysis defaults"
                    description="Default models and processing preferences for new projects."
                  />
                  <div className="settings-callout">
                    <Sparkles size={17} />
                    <div>
                      <strong>Two models. One coherent workflow.</strong>
                      <p>
                        Choose a model to read screens and a model to plan,
                        write and review. The same model can serve both roles.{" "}
                        {live
                          ? "Configure provider accounts once in Connections."
                          : "All roles below are illustrative."}
                      </p>
                    </div>
                  </div>
                  {live ? (
                    <>
                      <AnalysisModelDefaults
                        value={analysisModelDefaults(
                          draft.analysisDefaults,
                          draft.connections,
                        )}
                        connections={listedConnections}
                        onChange={(next) => {
                          update("analysisDefaults", next);
                          setErrors((current) => ({
                            ...current,
                            analysisDefaults: "",
                          }));
                        }}
                        onConnections={(id) => {
                          if (id && !newConnectionId) setSelectedId(id);
                          setConnectionFilter("all");
                          setCategory("connections");
                        }}
                      />
                      {errors.analysisDefaults && (
                        <p role="alert" className="catalogue-message">
                          {errors.analysisDefaults}
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="settings-section">
                      <h3>Model assignments</h3>
                      <Field
                        label="Read screens with"
                        hint="Screen Analyst and the optional Inspector need image support."
                      >
                        <Picker
                          value={draft.visionId}
                          onChange={(v) => update("visionId", v)}
                          options={options}
                          label="Read screens with"
                        />
                      </Field>
                      <Field
                        label="Plan, write and review with"
                        hint="Used for journeys, planning, writing, reviewing and change analysis."
                      >
                        <Picker
                          value={draft.textId}
                          onChange={(v) => update("textId", v)}
                          options={options}
                          label="Write specs with"
                        />
                      </Field>
                      <div className="role-chain">
                        {["Read", "Map", "Plan", "Write", "Review"].map(
                          (role, i) => (
                            <span key={role}>
                              {i > 0 && <ChevronRight size={11} />}
                              <span>{role}</span>
                            </span>
                          ),
                        )}
                      </div>
                    </div>
                  )}
                  <div className="settings-section">
                    <h3>Processing preferences</h3>
                    <div className="form-grid">
                      <Field label="Thoroughness">
                        <Picker
                          label="Default thoroughness"
                          value={draft.thoroughness}
                          onChange={(v) => update("thoroughness", v)}
                          options={[
                            {
                              value: "standard",
                              label: "Standard",
                              detail: "One reading and a review pass",
                            },
                            {
                              value: "thorough",
                              label: "Thorough",
                              detail: "Adds inspection and a repair pass",
                            },
                          ]}
                        />
                      </Field>
                      <Field label="Use-case size">
                        <Picker
                          label="Default use-case size"
                          value={draft.granularity}
                          onChange={(v) => update("granularity", v)}
                          options={[
                            { value: "fine", label: "Fine · smaller tasks" },
                            { value: "balanced", label: "Balanced" },
                            {
                              value: "coarse",
                              label: "Coarse · broader tasks",
                            },
                          ]}
                        />
                      </Field>
                    </div>
                    <Toggle
                      label="Preserve my edits"
                      description="Keep edited and approved use cases when regenerating."
                      checked={draft.preserveEdits}
                      onChange={(v) => update("preserveEdits", v)}
                    />
                    <Toggle
                      label="Include screen images"
                      description="Place screenshot evidence alongside generated documents."
                      checked={draft.embedImages}
                      onChange={(v) => update("embedImages", v)}
                    />
                    <Toggle
                      label="Reuse unchanged analyses"
                      description="Avoid reading the same unchanged screen again."
                      checked={draft.reuseAnalysis}
                      onChange={(v) => update("reuseAnalysis", v)}
                    />
                  </div>
                </>
              )}
              {category === "integrations" && (
                <>
                  <PanelTitle
                    icon={<Layers2 size={21} />}
                    title="Connected tools"
                    description="Bring your reviewed specifications to the tools your team uses."
                  />
                  <div className="settings-mini-notice">
                    <FlaskConical size={13} />
                    {live
                      ? "Destinations are configured locally. Explicit connection tests contact the service; live tracker writes are locked."
                      : "All integrations are examples. No accounts are connected."}
                  </div>
                  <div className="integrations-list">
                    {Object.entries(integrationNames).map(([id, name]) => (
                      <button
                        className="integration-list-item"
                        key={id}
                        onClick={() => setCategory(id)}
                      >
                        <span className={`integration-avatar ${id}`}>
                          {id === "github" ? (
                            <Github size={21} />
                          ) : id === "figma" ? (
                            <Palette size={21} />
                          ) : (
                            <Layers2 size={21} />
                          )}
                        </span>
                        <span>
                          <strong>{name}</strong>
                          <small>
                            {id === "figma"
                              ? "Import design frames as screenshots"
                              : "Export reviewed use cases and dependencies"}
                          </small>
                        </span>
                        <Badge tone="neutral">
                          {live
                            ? draft.integrations[id].hasSecret === "true"
                              ? "Protected token"
                              : "Configure"
                            : "Sample setup"}
                        </Badge>
                        <ChevronRight size={15} />
                      </button>
                    ))}
                  </div>
                  <div className="settings-callout">
                    <ShieldCheck size={17} />
                    <div>
                      <strong>
                        Review before anything leaves your workspace.
                      </strong>
                      <p>
                        {live
                          ? "Preview exact payloads and rehearse with a dry run. Real CSV downloads work; remote tracker writes remain locked pending integration acceptance."
                          : "The export demonstration includes a payload preview and simulated results. It cannot write to a tracker."}
                      </p>
                    </div>
                  </div>
                </>
              )}
              {integrationNames[category] && (
                <>
                  <PanelTitle
                    icon={
                      category === "github" ? (
                        <Github size={21} />
                      ) : (
                        <Layers2 size={21} />
                      )
                    }
                    title={integrationNames[category]}
                    description={
                      category === "figma"
                        ? "Turn selected design frames into screenshot evidence."
                        : "Configure where your reviewed use cases would go."
                    }
                  />
                  <button
                    className="text-button back-button"
                    onClick={() => setCategory("integrations")}
                  >
                    ‹ All integrations
                  </button>
                  <div className="settings-mini-notice">
                    <FlaskConical size={13} />
                    {live
                      ? "Secrets are protected locally with Windows DPAPI. Tracker writes remain locked."
                      : "Illustrative configuration. Do not enter a real credential."}
                  </div>
                  {category === "jira" && (
                    <Field label="Deployment">
                      <Picker
                        label="Jira deployment"
                        value={draft.integrations.jira.deployment}
                        onChange={(v) =>
                          setDraft((s) => ({
                            ...s,
                            integrations: {
                              ...s.integrations,
                              jira: { ...s.integrations.jira, deployment: v },
                            },
                          }))
                        }
                        options={[
                          { value: "cloud", label: "Jira Cloud" },
                          {
                            value: "server",
                            label: "Jira Server / Data Center",
                          },
                        ]}
                      />
                    </Field>
                  )}
                  <div className="form-grid integration-form">
                    {integrationFields[category]
                      .filter(() => !live || category !== "figma")
                      .map((f) => (
                        <Field
                          key={f.key}
                          label={f.label}
                          htmlFor={`${uid}-${category}-${f.key}`}
                          hint={f.help}
                        >
                          <input
                            id={`${uid}-${category}-${f.key}`}
                            value={draft.integrations[category][f.key] ?? ""}
                            onChange={(e) => {
                              setDraft((s) => ({
                                ...s,
                                integrations: {
                                  ...s.integrations,
                                  [category]: {
                                    ...s.integrations[category],
                                    [f.key]: e.target.value,
                                  },
                                },
                              }));
                              setTestStatus("idle");
                            }}
                            autoComplete="off"
                          />
                        </Field>
                      ))}
                  </div>
                  <Field
                    label={
                      category === "azdo"
                        ? "Personal access token"
                        : "API token"
                    }
                    htmlFor={`${uid}-token`}
                    hint={
                      live
                        ? "Leave empty to keep the protected token. Clear the integration to remove its saved credential."
                        : "Placeholder only. Never sent or retained when you save."
                    }
                  >
                    <input
                      id={`${uid}-token`}
                      type="password"
                      value={draft.integrations[category].token}
                      placeholder={
                        live
                          ? draft.integrations[category].hasSecret === "true"
                            ? "Saved securely · enter replacement"
                            : "Enter token"
                          : "Enter a placeholder token"
                      }
                      autoComplete="off"
                      onChange={(e) => {
                        setDraft((s) => ({
                          ...s,
                          integrations: {
                            ...s.integrations,
                            [category]: {
                              ...s.integrations[category],
                              token: e.target.value,
                            },
                          },
                        }));
                        setTestStatus("idle");
                      }}
                    />
                  </Field>
                  {category === "github" && (
                    <Toggle
                      label="Group features as milestones"
                      description="Use milestones instead of feature labels in the sample export."
                      checked={draft.integrations.github.milestones === "yes"}
                      onChange={(v) =>
                        setDraft((s) => ({
                          ...s,
                          integrations: {
                            ...s.integrations,
                            github: {
                              ...s.integrations.github,
                              milestones: v ? "yes" : "no",
                            },
                          },
                        }))
                      }
                    />
                  )}{" "}
                  {live && (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setDraft((s) => ({
                          ...s,
                          integrations: {
                            ...s.integrations,
                            [category]: Object.fromEntries(
                              Object.keys(s.integrations[category]).map(
                                (key) => [
                                  key,
                                  key === "hasSecret" ? "false" : "",
                                ],
                              ),
                            ),
                          },
                        }))
                      }
                    >
                      <Trash2 size={13} />
                      Clear saved integration
                    </Button>
                  )}{" "}
                  {testBar(integrationNames[category])}
                  {testFeedback}
                </>
              )}
              {category === "appearance" && (
                <>
                  <PanelTitle
                    icon={<Palette size={21} />}
                    title={live ? "Appearance" : "Make yourself at home"}
                    description={
                      live
                        ? "Choose a theme and preview it here."
                        : "A workspace that feels right, from the first screen to the last detail."
                    }
                  />
                  <div className="settings-section">
                    <h3>Colour theme</h3>
                    <div className="theme-options">
                      {[
                        {
                          id: "dark",
                          name: "Graphite",
                          icon: <Monitor size={14} />,
                        },
                        {
                          id: "light",
                          name: "Porcelain",
                          icon: <Sun size={14} />,
                        },
                        {
                          id: "system",
                          name: "System",
                          icon: <Monitor size={14} />,
                        },
                        ...(live
                          ? ODYSSEUS_THEMES.map((t) => ({
                              id: t.id,
                              name: t.name,
                              icon: <Palette size={14} />,
                            }))
                          : []),
                      ].map((t) => (
                        <button
                          key={t.id}
                          aria-pressed={draft.theme === t.id}
                          style={
                            isOdysseusTheme(t.id)
                              ? ({
                                  "--theme-bg": ODYSSEUS_PALETTES[t.id].bg,
                                  "--theme-fg": ODYSSEUS_PALETTES[t.id].fg,
                                  "--theme-panel":
                                    ODYSSEUS_PALETTES[t.id].panel,
                                  "--theme-border":
                                    ODYSSEUS_PALETTES[t.id].border,
                                  "--theme-accent": ODYSSEUS_PALETTES[t.id].red,
                                } as CSSProperties)
                              : undefined
                          }
                          className={`theme-option ${t.id} ${draft.theme === t.id ? "selected" : ""}`}
                          onClick={() => update("theme", t.id)}
                        >
                          <div className="theme-mini">
                            <div />
                            <div>
                              <i />
                              <i />
                              <i />
                            </div>
                          </div>
                          <span>
                            {t.icon}
                            {t.name}
                            {draft.theme === t.id && <Check size={13} />}
                          </span>
                        </button>
                      ))}
                    </div>
                    <p className="field-hint">
                      {live
                        ? "Save to keep this theme. Discard changes to restore your saved appearance."
                        : "Previewed live. Save changes to keep this theme for the current session."}
                    </p>
                  </div>
                  {live ? (
                    <>
                      <Toggle
                        checked={draft.backgroundEffects !== false}
                        onChange={(v) => update("backgroundEffects", v)}
                        label="Background effects"
                        description="Original decorative backgrounds for Ocean, Cyberpunk, Retrowave, Terminal, Forest and Cute."
                      />
                      <p className="field-hint">
                        Animations follow your system’s reduced-motion
                        preference. Home also has its own Pause/Resume control.
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="settings-section">
                        <h3>Density & movement</h3>
                        <Field label="Interface density">
                          <Picker
                            label="Interface density"
                            value={draft.density}
                            onChange={(v) => update("density", v)}
                            options={[
                              {
                                value: "comfortable",
                                label: "Comfortable",
                                detail: "Room to think and space to read",
                              },
                              {
                                value: "compact",
                                label: "Compact",
                                detail: "A little more information in view",
                              },
                            ]}
                          />
                        </Field>
                        <Toggle
                          label="Reduce motion"
                          description="Keep transitions minimal. Your operating system preference is also respected."
                          checked={draft.reduceMotion}
                          onChange={(v) => update("reduceMotion", v)}
                        />
                      </div>
                      <div className="type-specimen">
                        <span className="section-kicker">
                          BUILT FOR CLEAR THINKING
                        </span>
                        <strong>The details make the difference.</strong>
                        <p>
                          Inter Variable · self-hosted · SIL Open Font License
                        </p>
                        <span>Aa Bb Cc Dd Ee Ff Gg &nbsp; 0123456789</span>
                      </div>
                    </>
                  )}
                </>
              )}
              {category === "storage" && live && (
                <>
                  <PanelTitle
                    icon={<Folder size={21} />}
                    title="Workspace"
                    description="Your files are saved on this computer."
                  />
                  <div className="settings-callout">
                    <ShieldCheck size={18} />
                    <div>
                      <strong>Projects and screenshots</strong>
                      <p>Saved locally in your Coherence workspace.</p>
                    </div>
                  </div>
                  <div className="settings-section">
                    <h3>Editable specifications</h3>
                    <p className="muted">
                      Specifications are saved as editable Markdown files.
                    </p>
                  </div>
                  <div className="settings-section">
                    <h3>Saved credentials</h3>
                    <p className="muted">
                      Saved API keys and tokens are encrypted for your Windows
                      account.
                    </p>
                  </div>
                </>
              )}
              {category === "storage" && !live && (
                <>
                  <PanelTitle
                    icon={<Folder size={21} />}
                    title="Workspace"
                    description="A local proof of concept, with a deliberately small footprint."
                  />
                  <div className="settings-callout">
                    <FlaskConical size={18} />
                    <div>
                      <strong>Nothing here is a production data store.</strong>
                      <p>
                        Projects, edits and settings live in memory. Refreshing
                        restores the sample workspace. No database, API keys or
                        backend is connected.
                      </p>
                    </div>
                  </div>
                  <div className="settings-section">
                    <h3>Sample output structure</h3>
                    <div className="folder-tree">
                      <span>⌄ northstar-customer-portal</span>
                      {[
                        "use-cases/",
                        "screens/",
                        "features/",
                        "README.md",
                        "BUILD-PLAN.md",
                        "TRACEABILITY.md",
                        "QUESTIONS.md",
                      ].map((f) => (
                        <span key={f}>
                          <Folder size={13} />
                          {f}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="settings-section">
                    <h3>What is real in this prototype?</h3>
                    <p className="muted">
                      Navigation, layout, form drafts, previewing local images,
                      editing sample content, selecting changes and downloading
                      a sample CSV are browser interactions. Analysis,
                      connection tests, Figma import and tracker exports are
                      simulations.
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>
          {saveError && (
            <div className="settings-save-error" role="alert">
              {saveError}
            </div>
          )}
          <footer className="settings-footer">
            <div className={`save-status ${dirty ? "dirty" : ""}`}>
              <span className="status-orb" />
              <span>
                {dirty ? "Unsaved changes" : "All changes saved"}
                <small>
                  {dirty
                    ? newConnectionId
                      ? "Saves this connection and all modified sections."
                      : "Save applies to all modified sections."
                    : live
                      ? "Saved locally in the Coherence data folder."
                      : "In this session only. Refresh restores samples."}
                </small>
              </span>
            </div>
            <div className="settings-footer-actions">
              {!["storage", "integrations"].includes(category) &&
                !(
                  connectionCategory &&
                  (builtInOffline || !selectedVisible)
                ) && (
                  <Button variant="ghost" onClick={resetSection}>
                    <RotateCcw size={13} />
                    <span>
                      {connectionCategory ? "Reset tuning" : "Reset defaults"}
                    </span>
                  </Button>
                )}
              <Button onClick={requestClose}>Cancel</Button>
              <Button
                variant="primary"
                disabled={!dirty || saving}
                onClick={() => void save(false)}
              >
                <Check size={14} />
                <span>
                  {saving
                    ? "Saving…"
                    : newConnectionId
                      ? "Save connection"
                      : "Save all changes"}
                </span>
              </Button>
            </div>
          </footer>
          <Confirm
            open={guard}
            title="Keep your changes?"
            description="You have unsaved settings. Save them before closing, or discard them and return to your workspace."
            onCancel={() => setGuard(false)}
            onDiscard={() => {
              setGuard(false);
              setDraft(clone(settings));
              onClose();
            }}
            onSave={() => save(true)}
          />
          <Confirm
            open={!!removal}
            title={`Remove ${removal?.name ?? "this connection"}?`}
            description={removalText(removal)}
            cancelLabel="Keep it"
            onCancel={() => setRemoval(undefined)}
            discardLabel={
              removal?.target
                ? "Remove; I'll choose later"
                : "Remove connection"
            }
            onDiscard={() => void confirmRemoval(false)}
            {...(removal?.target
              ? {
                  saveLabel: `Move them to ${removal.target.name} and remove`,
                  onSave: () => void confirmRemoval(true),
                }
              : {})}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
