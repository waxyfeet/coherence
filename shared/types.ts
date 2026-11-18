/**
 * ScreenScribe shared domain model.
 * Imported by both the server (Node) and the web UI (browser) — keep it framework-free:
 * types and tiny pure helpers only.
 */

export type ISODate = string;

/* ------------------------------------------------------------------ */
/* Projects & screens                                                  */
/* ------------------------------------------------------------------ */

export interface Screen {
  /** "scr_<nanoid>" */
  id: string;
  /** BA-editable display name; defaults to the file name without extension. */
  name: string;
  /** Optional BA hints for the agents ("this is the admin view", "dropdown has 12 countries"...). */
  notes: string;
  /** 0-based order; also the default journey order the agents assume. */
  order: number;
  /** Starts at 1, incremented every time the image is replaced. Old versions are kept on disk. */
  version: number;
  /** Current version's file, relative to the project's screens dir, e.g. "scr_ab12/v2.png". */
  fileName: string;
  originalFileName: string;
  /** image/png | image/jpeg | image/webp | image/gif */
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  uploadedAt: ISODate;
  /** The screen version reflected in the current SolutionModel (undefined = never analysed). */
  analysedVersion?: number;
}

export type ProjectStatus =
  "draft" | "generating" | "specified" | "needs-review";

export interface ProjectLLMSelection {
  /** Each real-provider role binds an exact connection + model, never a provider default. */
  visionConnectionId?: string;
  visionModelId?: string;
  textConnectionId?: string;
  textModelId?: string;
  /** Explicit user acknowledgement for unverified image input, bound to the reading selection. */
  visionAcknowledged?: boolean;
}

/** Copied into new projects only. Image consent is always a separate per-project choice. */
export interface AnalysisModelDefaults {
  visionConnectionId: string;
  visionModelId: string;
  textConnectionId: string;
  textModelId: string;
}

export interface Project {
  /** Portable project metadata. On disk outputDir is relative; API paths are resolved at runtime. */
  storage?: {
    format: "coherence-project";
    version: 1;
    folderId: string;
    requirements: "specs";
  };
  /** Runtime location only, never persisted in a portable manifest. */
  projectPath?: string;
  /** URL-safe slug derived from the name, made unique. Immutable. */
  id: string;
  name: string;
  /** Optional named library group; absent means Unassigned. */
  areaId?: string;
  /** The BA's one-paragraph description of the project. */
  description: string;
  /** Optional extra context: roles, domain rules, NFRs, tech constraints. */
  additionalContext: string;
  /** Output format id, default DEFAULT_FORMAT_ID. */
  formatId: string;
  /** Absolute path where .md specs are written. Default: <dataDir>/projects/<id>/specs */
  outputDir: string;
  /** Previously configured output locations, retained for owned-output cleanup. */
  outputHistory?: string[];
  llm: ProjectLLMSelection;
  /** Allow analysis only with offline fixtures or loopback Ollama/compatible endpoints. */
  localOnly?: boolean;
  /** Last submitted run configuration, without any generated analysis or results. */
  generationPreferences?: GenerationOptions;
  /** Ordered by `order`. */
  screens: Screen[];
  status: ProjectStatus;
  createdAt: ISODate;
  updatedAt: ISODate;
  lastGeneratedAt?: ISODate;
}

export interface ProjectSummary {
  projectPath?: string;
  availability?: "available" | "unavailable";
  id: string;
  name: string;
  areaId?: string;
  description: string;
  status: ProjectStatus;
  screenCount: number;
  useCaseCount: number;
  /** First screen id, for a thumbnail. */
  thumbnailScreenId?: string;
  updatedAt: ISODate;
  lastGeneratedAt?: ISODate;
}

export interface ProjectArea {
  id: string;
  name: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface ProjectDeletionPreview {
  /** Legacy external/current/historic outputs are retained, never deletion authority. */
  retainedPaths?: string[];
  projectId: string;
  name: string;
  updatedAt: ISODate;
  paths: string[];
}

export interface TrashDeletionPreview extends ProjectDeletionPreview {
  trashId: string;
  revision: string;
}

/* ------------------------------------------------------------------ */
/* Screen analysis (output of the Screen Analyst agent)                */
/* ------------------------------------------------------------------ */

export const ELEMENT_TYPES = [
  "button",
  "icon_button",
  "link",
  "text_input",
  "email_input",
  "password_input",
  "number_input",
  "phone_input",
  "currency_input",
  "textarea",
  "search_input",
  "dropdown",
  "multi_select",
  "combobox",
  "checkbox",
  "radio_group",
  "toggle",
  "date_picker",
  "time_picker",
  "date_range_picker",
  "slider",
  "file_upload",
  "rich_text_editor",
  "table",
  "list",
  "card",
  "tile",
  "tabs",
  "accordion",
  "menu",
  "navigation_bar",
  "sidebar",
  "breadcrumb",
  "pagination",
  "stepper",
  "modal",
  "drawer",
  "toast",
  "alert",
  "banner",
  "tooltip",
  "badge",
  "tag",
  "chip",
  "avatar",
  "image",
  "icon",
  "logo",
  "video",
  "map",
  "chart",
  "progress_bar",
  "spinner",
  "heading",
  "label",
  "text",
  "divider",
  "form",
  "header",
  "footer",
  "container",
  "other",
] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

/** Approximate element position in PERCENT (0-100) of the full screen image (not of a tile). */
export interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UIElement {
  /** Globally unique & stable within a model: "<screenKey>.<elementKey>", e.g. "login.email". */
  id: string;
  /** Short snake/kebab key unique within the screen, e.g. "email", "sign_in_button". */
  key: string;
  screenId: string;
  /** Id of the ScreenRegion this element sits in. */
  regionId: string;
  type: ElementType;
  /** Visible label / text, verbatim from the design ("" if none). */
  label: string;
  /** What the element is and where it sits, in one or two plain sentences. */
  description: string;
  placeholder?: string;
  defaultValue?: string;
  /** Helper / hint text shown near the element, verbatim. */
  helperText?: string;
  /** Options for dropdowns, radios, tabs, menus, segmented controls, table columns — verbatim, in order. */
  options?: string[];
  required?: boolean;
  /** Validation rules: observed (asterisk, inline error) or inferred from type/context. */
  validation?: string[];
  /** Visual / interaction states: disabled, selected, loading, error, empty, hover... */
  states?: string[];
  /** What happens when the user interacts with it. */
  behavior?: string;
  /** Target screen id when this element navigates to another uploaded screen. */
  navigatesToScreenId?: string;
  /** Free-text navigation target when it is not one of the uploaded screens ("external help site"). */
  navigatesToHint?: string;
  /** Data the element displays or captures ("customer.email", "order total"). */
  dataBinding?: string;
  /** Which of the facts above were inferred rather than directly visible. */
  inferred: string[];
  /** Approximate position on the screen image, for the visual inspector overlay (omitted when unknown). */
  bounds?: ElementBounds;
}

export interface ScreenRegion {
  /** "<screenKey>.<regionKey>", e.g. "login.form" */
  id: string;
  key: string;
  screenId: string;
  name: string;
  purpose: string;
  /** Short layout description: "centered card, 400px", "left sidebar", "3-column grid". */
  layout: string;
  /** Element ids in reading order. */
  elementIds: string[];
}

export const SCREEN_TYPES = [
  "auth",
  "landing",
  "dashboard",
  "list",
  "detail",
  "form",
  "wizard_step",
  "search_results",
  "settings",
  "modal",
  "checkout",
  "report",
  "empty_state",
  "error",
  "other",
] as const;
export type ScreenType = (typeof SCREEN_TYPES)[number];

export interface ScreenAnalysis {
  /** Durable scope of this reading; absent on historical analyses means unknown, not inspected. */
  reading?: {
    version: 1;
    parts: number;
    inspection: "not-requested" | "pending" | "passed" | "failed";
  };
  inputFingerprint?: string;
  screenId: string;
  screenVersion: number;
  /** Slug used in element ids and file names, unique per model, e.g. "login". */
  screenKey: string;
  title: string;
  purpose: string;
  screenType: ScreenType;
  /** Persona names who use this screen. */
  personas: string[];
  regions: ScreenRegion[];
  elements: UIElement[];
  /** Business entities visible on the screen ("Order", "Customer"). */
  dataEntities: string[];
  /** Things the analyst could not determine from the design. */
  openQuestions: string[];
  /** ISO time of analysis. */
  analysedAt: ISODate;
}

/* ------------------------------------------------------------------ */
/* Solution model                                                      */
/* ------------------------------------------------------------------ */

export interface Persona {
  /** "persona-<slug>" */
  id: string;
  name: string;
  description: string;
  goals: string[];
}

export interface FlowLink {
  /** "flow-<n>" */
  id: string;
  fromScreenId: string;
  toScreenId: string;
  /** "Click 'Sign in'", "Select a row" */
  trigger: string;
  elementId?: string;
  condition?: string;
}

export interface FeatureGroup {
  /** "FEAT-01" */
  id: string;
  name: string;
  description: string;
  useCaseIds: string[];
}

export type UseCaseSize = "S" | "M" | "L";
export type UseCaseStatus = "generated" | "edited" | "stale" | "approved";

export interface UserStory {
  /** Persona / role, without the "As a" prefix: "registered customer". */
  asA: string;
  /** Without the "I want to" prefix: "sign in with my email and password". */
  iWant: string;
  /** Without the "so that" prefix: "I can access my account securely". */
  soThat: string;
}

export interface BusinessRule {
  /** "BR-01" — unique within the use case. */
  id: string;
  /** UIElement.id this rule governs; omitted for screen-level / general rules. */
  elementId?: string;
  /** Human element name, e.g. "Email address". For general rules: a short topic name. */
  element: string;
  /** ElementType, or 'screen' / 'general'. */
  elementType: ElementType | "screen" | "general";
  /** Describes the element: what it is, its visible label text, placeholder, position. */
  description: string;
  /** Every rule governing it: validation, options (list them all), defaults, states, behaviour, messages. */
  rules: string[];
}

export type ScenarioType = "happy" | "alternate" | "negative" | "edge";

export interface BddScenario {
  /** "SC-01" — unique within the use case. */
  id: string;
  title: string;
  type: ScenarioType;
  /** First entry renders as GIVEN, the rest as AND. */
  given: string[];
  /** First entry renders as WHEN, the rest as AND. */
  when: string[];
  /** Every entry renders as THEN (the user's chosen format repeats THEN). */
  then: string[];
  /** Elements exercised by this scenario. */
  elementIds: string[];
}

export type ExternalSystem = "jira" | "azdo" | "github";

export interface ExternalLink {
  system: ExternalSystem;
  /** "ABC-123", "4711", "#42" */
  key: string;
  url: string;
  exportedAt: ISODate;
  /** UseCase.revision that was exported — lets the UI show "changed since export". */
  revision: number;
}

export interface UseCase {
  internalId?: string;
  /** "UC-001" — assigned in build order. */
  id: string;
  /** kebab-case, used in the file name: "sign-in-with-email". */
  slug: string;
  title: string;
  formatId: string;
  /** FeatureGroup.id */
  featureId: string;
  personaId: string;
  screenIds: string[];
  regionIds: string[];
  /** UIElement ids this use case is responsible for. */
  elementIds: string[];
  /** Use cases whose postconditions establish this one's preconditions. */
  dependsOn: string[];
  /** 1-based build order (topological). */
  order: number;
  size: UseCaseSize;
  /** One or two sentences: what is in scope for this use case. */
  scope: string;
  story: UserStory;
  /** State that must hold before the use case starts — chained from predecessors' postconditions. */
  preconditions: string[];
  /** State that holds after success — becomes successors' preconditions. */
  postconditions: string[];
  businessRules: BusinessRule[];
  scenarios: BddScenario[];
  assumptions: string[];
  openQuestions: string[];
  notes: string;
  status: UseCaseStatus;
  /** Incremented on every content change (generation, edit, impact apply). */
  revision: number;
  updatedAt: ISODate;
  external: ExternalLink[];
  /** POSIX path of the .md file relative to project.outputDir, e.g. "use-cases/UC-001-sign-in.md". */
  filePath?: string;
  /** Set when status === 'stale': the impact report that flagged it. */
  staleReason?: string;
}

export type ReviewSeverity = "error" | "warning" | "info";
export type ReviewCategory =
  "chain" | "coverage" | "consistency" | "size" | "ambiguity" | "other";

export interface ReviewFinding {
  /** "RV-01" */
  id: string;
  severity: ReviewSeverity;
  category: ReviewCategory;
  useCaseIds: string[];
  message: string;
  /** Suggested fix in plain language. */
  suggestion?: string;
  resolved: boolean;
}

export type ChangeLogKind =
  | "generated"
  | "edited"
  | "synced"
  | "impact-analysed"
  | "impact-applied"
  | "screen-replaced"
  | "screen-reanalysed"
  | "exported"
  | "rerendered";

export interface ChangeLogEntry {
  at: ISODate;
  kind: ChangeLogKind;
  summary: string;
  useCaseIds: string[];
  reportId?: string;
}

export type Thoroughness = "standard" | "thorough";
export type Granularity = "fine" | "balanced" | "coarse";

export interface GenerationOptions {
  visionConnectionId?: string;
  textConnectionId?: string;
  visionModelId?: string;
  textModelId?: string;
  visionAcknowledged?: boolean;
  /** 'thorough' adds a verification pass per screen and a self-repair pass for review findings. */
  thoroughness: Thoroughness;
  /** How finely screens are broken into use cases. */
  granularity: Granularity;
  /** Do not overwrite .md files whose use case status is 'edited' or 'approved'. */
  preserveEdited: boolean;
  /** Embed screen images in the generated markdown. */
  embedScreenImages: boolean;
  /** Reuse the previous ScreenAnalysis for screens whose image version has not changed (saves cost). */
  reuseScreenAnalyses: boolean;
}

export const DEFAULT_GENERATION_OPTIONS: GenerationOptions = {
  thoroughness: "standard",
  granularity: "balanced",
  preserveEdited: true,
  embedScreenImages: true,
  reuseScreenAnalyses: true,
};

export interface SolutionModel {
  nextUseCaseNumber?: number;
  schemaVersion: 1;
  projectId: string;
  formatId: string;
  generatedAt: ISODate;
  updatedAt: ISODate;
  /** "provider/model" strings, for traceability. */
  generator: { vision: string; text: string };
  options: GenerationOptions;
  /** Short overview of the solution as a whole. */
  summary: string;
  personas: Persona[];
  /** One per analysed screen, ordered like project.screens. */
  screens: ScreenAnalysis[];
  flows: FlowLink[];
  features: FeatureGroup[];
  /** Ordered by `order`. */
  useCases: UseCase[];
  review: ReviewFinding[];
  changeLog: ChangeLogEntry[];
}

/* ------------------------------------------------------------------ */
/* Knowledge graph & impact analysis                                   */
/* ------------------------------------------------------------------ */

export type GraphNodeKind =
  | "screen"
  | "region"
  | "element"
  | "usecase"
  | "rule"
  | "scenario"
  | "persona"
  | "feature";

export interface GraphNode {
  /** Domain id. Rules and scenarios are namespaced: "UC-003/BR-02", "UC-003/SC-01". */
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** Kind-specific extras for display (type, status, size, etc.). JSON-safe. */
  meta?: Record<string, string | number | boolean | string[] | undefined>;
}

export type GraphEdgeKind =
  | "contains" // screen→region, region→element, usecase→rule, usecase→scenario
  | "covers" // usecase→element
  | "appears_on" // usecase→screen
  | "depends_on" // usecase→usecase (this one needs the other's postconditions)
  | "navigates_to" // element→screen, screen→screen (flows)
  | "governs" // rule→element
  | "exercises" // scenario→element
  | "performed_by" // usecase→persona
  | "groups"; // feature→usecase

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  label?: string;
}

export interface SolutionGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type ChangeTargetKind =
  | "feature"
  | "element"
  | "screen"
  | "region"
  | "usecase"
  | "rule"
  | "scenario"
  | "persona"
  | "free";
export type ChangeSource = "manual" | "md-edit" | "screen-replace";

export interface ElementChange {
  before: UIElement;
  after: UIElement;
  /** Human-readable list: "label: 'Login' → 'Sign in'", "options: added 'Other'". */
  changes: string[];
}

export interface ScreenDiff {
  screenId: string;
  fromVersion: number;
  toVersion: number;
  added: UIElement[];
  removed: UIElement[];
  modified: ElementChange[];
  /** Plain-language summary of the visual change. */
  summary: string;
}

export type UseCaseSection =
  | "title"
  | "story"
  | "scope"
  | "preconditions"
  | "postconditions"
  | "rules"
  | "scenarios"
  | "assumptions"
  | "openQuestions"
  | "notes"
  | "dependencies"
  | "elements"
  | "status";

export interface UseCaseDiff {
  useCaseId: string;
  changedSections: UseCaseSection[];
  /** Plain-language summary of what changed, e.g. "BR-02 password min length 8 → 12; added SC-05". */
  summary: string;
  /** Line-level details per section (human readable). */
  details: string[];
}

export interface ChangeRequest {
  targetKind: ChangeTargetKind;
  /** Domain id of the target (element id, screen id, "UC-003", "UC-003/BR-02"...). Omitted for 'free'. */
  targetId?: string;
  /** What is changing, in the BA's words or generated from a diff. */
  description: string;
  source: ChangeSource;
  screenDiff?: ScreenDiff;
  useCaseDiff?: UseCaseDiff;
}

export interface DeterministicImpact {
  /** Graph node ids the change starts from. */
  seedNodeIds: string[];
  /** Use cases that directly own/cover the changed thing. */
  directUseCaseIds: string[];
  /** Use cases reachable by following depends_on forwards (they consume postconditions). */
  downstreamUseCaseIds: string[];
  /** Use cases the direct ones depend on (their postconditions may need to change too). */
  upstreamUseCaseIds: string[];
  /** Use cases sharing elements/screens with the direct ones (weaker relation). */
  relatedUseCaseIds: string[];
  affectedElementIds: string[];
  affectedScreenIds: string[];
  /** Shortest path (node ids) from a seed to each impacted use case. */
  paths: { useCaseId: string; path: string[] }[];
}

export type ImpactRelation = "direct" | "downstream" | "upstream" | "related";
export type ImpactSeverity = "high" | "medium" | "low" | "none";

export interface ImpactItem {
  useCaseId: string;
  relation: ImpactRelation;
  severity: ImpactSeverity;
  reason: string;
  suggestedChanges: string[];
  affectedSections: UseCaseSection[];
  affectedRuleIds: string[];
  affectedScenarioIds: string[];
}

export type ImpactStatus =
  "analysed" | "applied" | "partially-applied" | "discarded";

export interface ImpactReport {
  /** "IR-<yyyymmdd>-<nanoid6>" */
  id: string;
  projectId: string;
  createdAt: ISODate;
  change: ChangeRequest;
  deterministic: DeterministicImpact;
  /** One per use case worth looking at (severity 'none' items may be omitted). */
  items: ImpactItem[];
  summary: string;
  risks: string[];
  suggestedNewUseCases: {
    title: string;
    reason: string;
    screenIds: string[];
  }[];
  status: ImpactStatus;
  appliedAt?: ISODate;
  appliedUseCaseIds?: string[];
  /** "provider/model" used for the analysis. */
  analysedBy: string;
  /** Statuses of use cases before this report marked them 'stale' — restored on discard. */
  previousStatuses: Record<string, UseCaseStatus>;
  /** For screen-replace changes: the new analysis, merged into the model on apply. */
  pendingScreenAnalysis?: ScreenAnalysis;
}

/* ------------------------------------------------------------------ */
/* LLM connections & integrations (settings)                           */
/* ------------------------------------------------------------------ */

export type ProviderKind =
  | "anthropic"
  | "openai"
  | "azure-openai"
  | "gemini"
  | "ollama"
  | "openai-compatible"
  | "mock";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Temporary resolved runtime configuration. Provider adapters receive the exact selected model. */
export interface LLMConnection {
  /** "conn_<nanoid>" */
  id: string;
  name: string;
  provider: ProviderKind;
  /** Model id (or Azure deployment name when provider === 'azure-openai'). */
  model: string;
  /** Override endpoint: Ollama "http://localhost:11434", LM Studio "http://localhost:1234/v1", Azure resource URL... */
  baseUrl?: string;
  apiKey?: string;
  /** Azure OpenAI only. */
  azureApiVersion?: string;
  /** Anthropic: output_config.effort. OpenAI reasoning models: reasoning_effort (low/medium/high). */
  effort?: Effort;
  maxOutputTokens?: number;
  /** Model-specific runtime ceiling from trusted metadata; never an account setting. */
  modelOutputTokenLimit?: number;
  /** Execution-only facts for the exact selected model; never account settings. */
  modelContextWindow?: number;
  modelInputTokenLimit?: number;
  modelFactsAt?: string;
  modelStructuredMode?: "native" | "prompt";
  modelReasoning?: {
    mandatory?: boolean;
    supportedEfforts?: string[];
    automaticExtraction: boolean;
  };
  /** Ignored by providers/models that reject sampling params (e.g. current Claude models). */
  temperature?: number;
  /** Max concurrent requests the pipeline may issue on this connection. */
  concurrency: number;
  requestTimeoutSec: number;
  /** auto = native JSON-schema output when the provider supports it, else prompt-and-validate. */
  structuredOutput: "auto" | "native" | "prompt";
  /** Whether the model can read images. auto = provider preset default. */
  vision: "auto" | "yes" | "no";
  /** Anthropic only: send `fallbacks: "default"` so a refused request is retried server-side. */
  refusalFallback: boolean;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** One provider/account/endpoint, with one protected credential shared by its model IDs. */
export interface ProviderConnection extends Omit<
  LLMConnection,
  | "model"
  | "modelOutputTokenLimit"
  | "modelContextWindow"
  | "modelInputTokenLimit"
  | "modelFactsAt"
  | "modelStructuredMode"
  | "modelReasoning"
> {
  modelIds: string[];
  /** Optional UI subset. Hiding a model never changes its saved execution eligibility. */
  visibleModelIds?: string[];
  manualModelIds?: string[];
  /** LM Studio uses the existing compatible inference adapter, with native catalogue discovery. */
  presetId?: "lm-studio";
  /** Read-only compatibility metadata from older records; never an execution fallback. */
  model?: string;
}

/** Provider connection as returned to the browser: secret removed. */
export type PublicLLMConnection = Omit<ProviderConnection, "apiKey"> & {
  capabilities?: import("./modelCapabilities").CapabilityInventory;
  /** Local cache only; reading Settings never contacts a provider. */
  catalogue?: import("./modelCatalogue").ModelCatalogue;
  hasApiKey: boolean;
  /** Last 4 chars, e.g. "…a1b2". */
  apiKeyHint?: string;
};

export interface JiraSettings {
  /** "https://yourcompany.atlassian.net" */
  baseUrl: string;
  /** Cloud: account email (basic auth with API token). Server/DC: leave empty and use a PAT as apiToken. */
  email: string;
  apiToken: string;
  projectKey: string;
  /** "Story" */
  issueType: string;
  /** "Epic" — used for feature groups when createFeatureParents is on. */
  epicIssueType: string;
  labels: string[];
  /** Issue link type name used for dependencies, e.g. "Blocks". */
  linkType: string;
  deployment: "cloud" | "server";
  /** Custom field id for story points, e.g. "customfield_10016" (optional). */
  storyPointsFieldId?: string;
}

export interface AzdoSettings {
  /** "https://dev.azure.com/yourorg" */
  orgUrl: string;
  project: string;
  pat: string;
  /** "User Story" (Agile) / "Product Backlog Item" (Scrum) / "Requirement" (CMMI) */
  workItemType: string;
  /** "Feature" — used for feature groups when createFeatureParents is on. */
  parentWorkItemType: string;
  areaPath?: string;
  iterationPath?: string;
  tags: string[];
}

export interface GitHubSettings {
  owner: string;
  repo: string;
  token: string;
  labels: string[];
  /** "https://api.github.com" or GHE "https://ghe.example.com/api/v3" */
  apiBaseUrl: string;
  /** Feature groups become milestones (true) or labels "feature: <name>" (false). */
  useMilestonesForFeatures: boolean;
}

export interface IntegrationSettings {
  jira?: JiraSettings;
  azdo?: AzdoSettings;
  github?: GitHubSettings;
}

/** Secret field names per integration — used for masking. */
export const INTEGRATION_SECRET_FIELD = {
  jira: "apiToken",
  azdo: "pat",
  github: "token",
} as const satisfies Record<ExternalSystem, string>;

/** Figma import (personal access token with file read scope). */
export interface FigmaSettings {
  token: string;
}

export interface AppSettings {
  analysisDefaults?: AnalysisModelDefaults;
  revision?: number;
  preferences?: Record<string, string | boolean>;
  version: 1;
  connections: ProviderConnection[];
  defaultConnectionId?: string;
  integrations: IntegrationSettings;
  figma?: FigmaSettings;
}

/** Integration settings as returned to the browser: secret field is "" plus has/hint flags. */
export type PublicIntegration<T> = T & {
  hasSecret: boolean;
  secretHint?: string;
};

export interface PublicSettings {
  /** Windows could not unlock the saved keys for this account: settings are read-only until they are reset. */
  keysLocked?: boolean;
  analysisDefaults?: AnalysisModelDefaults;
  revision?: number;
  preferences?: Record<string, string | boolean>;
  connections: PublicLLMConnection[];
  defaultConnectionId?: string;
  integrations: {
    jira?: PublicIntegration<JiraSettings>;
    azdo?: PublicIntegration<AzdoSettings>;
    github?: PublicIntegration<GitHubSettings>;
  };
  figma?: { hasToken: boolean; tokenHint?: string };
  /** Where ScreenScribe stores projects on disk. */
  dataDir: string;
  /** Path of the settings file; saved secrets are protected server-side, never included in this response. */
  settingsPath: string;
}

/* ------------------------------------------------------------------ */
/* Output formats & spec files                                         */
/* ------------------------------------------------------------------ */

export const DEFAULT_FORMAT_ID = "use-case-bdd";

export interface OutputFormatInfo {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
}

export type SpecFileKind =
  | "use-case"
  | "index"
  | "screen"
  | "changelog"
  | "review"
  /** QUESTIONS.md, TRACEABILITY.md, DATA-DICTIONARY.md, BUILD-PLAN.md */
  | "report"
  /** features/*.feature (Gherkin for test automation) */
  | "gherkin"
  | "image"
  | "other";

export interface SpecFileNode {
  name: string;
  /** POSIX path relative to project.outputDir ("" for the root). */
  path: string;
  type: "file" | "dir";
  kind?: SpecFileKind;
  /** Set for use-case files. */
  useCaseId?: string;
  mtimeMs?: number;
  children?: SpecFileNode[];
}

/* ------------------------------------------------------------------ */
/* Jobs (long-running work with live progress)                         */
/* ------------------------------------------------------------------ */

export type JobKind =
  | "figma-import"
  | "generate"
  | "impact-analysis"
  | "impact-apply"
  | "screen-reanalysis"
  | "export"
  | "delivery-plan"
  | "delivery-publish"
  | "revise";
export type JobStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface JobLogEntry {
  at: ISODate;
  level: LogLevel;
  message: string;
  stage?: string;
}

export interface JobProgress {
  /** Current stage name, e.g. "Reading screens". */
  stage: string;
  /** 0-based index of the current stage. */
  stageIndex: number;
  stageCount: number;
  /** Units done / total in the current stage (e.g. screens analysed). */
  current: number;
  total: number;
  /** What is being worked on right now, e.g. "Login". */
  label?: string;
}

export interface LLMUsage {
  estimateSource?: string;
  pricingAsOf?: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated USD cost (shared/pricing.ts); absent when no price is known for the model(s). Local models = 0. */
  costUsd?: number;
}

/** Why a job stopped, as a category the app can act on. */
export type JobFailureKind =
  /** A cloud connection has no saved API key, so nothing was sent. */
  | "no-key"
  /** The service refused the key that was sent (401). */
  | "key-refused"
  /** The key was accepted but may not reach this model or feature (403). */
  | "access-refused"
  /** The service does not know this model ID (404). */
  | "model-not-found"
  /** The service's rate limit was reached (429). */
  | "rate-limited"
  /** The account's quota or credits are used up. */
  | "quota"
  /** The reading model cannot accept screenshots. */
  | "cannot-read-images"
  /** The request or answer did not fit the model's limits. */
  | "too-large"
  /** The model declined the request. */
  | "declined"
  /** The service stopped responding. */
  | "timeout"
  /** The service could not be reached. */
  | "unreachable"
  /** The service had a temporary problem (5xx). */
  | "service-error"
  /** The service rejected the request (another 4xx). */
  | "request-rejected"
  | "other";

/** The one next step the app suggests for a failure. */
export type JobFailureAction =
  "try-again" | "change-model" | "fix-connection" | "wait";

/**
 * A failed job in words the BA can act on (server/jobs/failure.ts). The message is Coherence's own wording,
 * never provider response text; `Job.error` keeps the technical line for the activity log and older readers.
 */
export interface JobFailure {
  kind: JobFailureKind;
  action: JobFailureAction;
  /** One or two sentences: what happened and what to do next. */
  message: string;
  /** The connection and exact model the failing request went to, when known. */
  connectionId?: string;
  connectionName?: string;
  model?: string;
  /** When the service said its limit resets. */
  resetAt?: ISODate;
}

export interface Job<R = unknown> {
  /** Older free-text diagnostics are withheld; domain artifacts are retained intact. */
  diagnosticsVersion?: number;
  eventSequence?: number;
  id: string;
  kind: JobKind;
  projectId: string;
  status: JobStatus;
  progress: JobProgress;
  logs: JobLogEntry[];
  usage: LLMUsage;
  result?: R;
  error?: string;
  /** Set when status is "failed". */
  failure?: JobFailure;
  /** AI requests in flight, from "live" events. Never saved; the server's snapshots leave it out. */
  live?: JobLiveCall[];
  createdAt: ISODate;
  startedAt?: ISODate;
  finishedAt?: ISODate;
}

/** An AI request in flight, for the activity panel (tester build WP6). Counts describe work, never time. */
export interface JobLiveCall {
  id: number;
  /** What the request is for, e.g. "use-case-writer:UC-007". */
  purpose: string;
  model: string;
  /** Thinking: the service reports reasoning and no answer has arrived yet. Writing: the answer is arriving. */
  phase: "waiting" | "thinking" | "writing";
  /** Characters of the answer received so far. */
  received: number;
}

export type JobEvent =
  | { type: "snapshot"; job: Job }
  | { type: "live"; calls: JobLiveCall[] }
  | { type: "log"; entry: JobLogEntry }
  | { type: "progress"; progress: JobProgress }
  | { type: "usage"; usage: LLMUsage }
  | {
      type: "status";
      status: JobStatus;
      error?: string;
      failure?: JobFailure;
      result?: unknown;
    };

/* ------------------------------------------------------------------ */
/* Export to work-item trackers                                        */
/* ------------------------------------------------------------------ */

export interface ExportRequest {
  target: ExternalSystem;
  useCaseIds: string[];
  /** Build payloads and report what would happen without calling the tracker. */
  dryRun: boolean;
  /** Create/reuse an Epic (Jira) / Feature (AzDO) / milestone-or-label (GitHub) per feature group. */
  createFeatureParents: boolean;
  /** Link items according to depends_on (Jira issue links, AzDO predecessor links, GitHub "Depends on #n"). */
  linkDependencies: boolean;
  /** Update items already exported to this target instead of creating duplicates. */
  updateExisting: boolean;
  /** Map size to story points (S=3, M=5, L=8): AzDO Microsoft.VSTS.Scheduling.StoryPoints, Jira storyPointsFieldId. */
  includeStoryPoints: boolean;
}

export type ExportAction =
  | "created"
  | "updated"
  | "skipped"
  | "failed"
  | "would-create"
  | "would-update";

export interface ExportItemResult {
  useCaseId: string;
  title: string;
  action: ExportAction;
  key?: string;
  url?: string;
  error?: string;
}

export interface ExportResult {
  target: ExternalSystem;
  dryRun: boolean;
  items: ExportItemResult[];
  parents: {
    featureId: string;
    name: string;
    action: ExportAction;
    key?: string;
    url?: string;
    error?: string;
  }[];
  links: {
    fromUseCaseId: string;
    toUseCaseId: string;
    ok: boolean;
    error?: string;
  }[];
}

export interface ExportPreview {
  target: ExternalSystem;
  useCaseId: string;
  title: string;
  /** Format of `description` / `acceptanceCriteria`. */
  bodyFormat: "markdown" | "html" | "jira-wiki";
  description: string;
  /** AzDO puts BDD scenarios here; Jira/GitHub keep everything in the description (this is then ""). */
  acceptanceCriteria: string;
  /** Other fields that will be set (labels, tags, area path, issue type...). */
  fields: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* Tiny pure helpers (safe for both sides)                             */
/* ------------------------------------------------------------------ */

export function slugify(input: string, maxLength = 60): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "item";
}

/** S=3, M=5, L=8 */
export const STORY_POINTS: Record<UseCaseSize, number> = { S: 3, M: 5, L: 8 };

export function formatUseCaseId(n: number): string {
  return `UC-${String(n).padStart(3, "0")}`;
}

/** "UC-003/BR-02" */
export function ruleNodeId(useCaseId: string, ruleId: string): string {
  return `${useCaseId}/${ruleId}`;
}

/** "UC-003/SC-01" */
export function scenarioNodeId(useCaseId: string, scenarioId: string): string {
  return `${useCaseId}/${scenarioId}`;
}
