/**
 * REST API contract between the web UI and the local server.
 * All routes are prefixed with /api. JSON in/out unless stated otherwise.
 *
 * Errors: non-2xx responses have body ApiError.
 * CSRF guard: every non-GET request MUST send header `X-ScreenScribe: 1` (the server rejects it otherwise).
 *
 * ── Health & formats ───────────────────────────────────────────────
 * GET    /api/health                                   → HealthResponse
 * GET    /api/formats                                  → OutputFormatInfo[]
 * POST   /api/app/quit                                 → 202 {accepted}; asks the Windows launcher to quit
 *                                                         (409 when not started by the launcher)
 *
 * ── Settings ───────────────────────────────────────────────────────
 * GET    /api/settings                                 → PublicSettings (keysLocked: saved keys cannot be unlocked; writes refused until reset)
 * POST   /api/settings/keys/reset                                                      → PublicSettings (keeps the locked file as settings.json.locked-<time>, continues without its keys)
 * PUT    /api/settings/workspace                       body { baseRevision, connections, analysisDefaults?, preferences, ... } → PublicSettings (atomic; omitted analysisDefaults preserves current choices)
 * POST   /api/settings/connections                     body ConnectionInput            → PublicLLMConnection   (create)
 * PUT    /api/settings/connections/:connId             body ConnectionInput            → PublicLLMConnection   (update; omitted/"" apiKey keeps the stored key)
 * DELETE /api/settings/connections/:connId                                             → { ok: true }
 * PUT    /api/settings/default-connection              body { connectionId: string }   → PublicSettings
 * POST   /api/settings/connections/test                body TestConnectionRequest      → TestConnectionResponse
 * POST   /api/settings/connections/models              body ListModelsRequest          → ListModelsResponse
 * POST   /api/settings/connections/capabilities/test   body CapabilityTestRequest      → CapabilityTestResponse (shared/modelCapabilities)
 * GET    /api/settings/connections/:connId/usage                                       → ConnectionUsage (what removing it affects)
 * POST   /api/settings/connections/:connId/reassign    body { to }                     → { moved, kept } (projects moved to another connection)
 * PUT    /api/settings/integrations/:system            body IntegrationInput           → PublicSettings        (system: jira|azdo|github)
 * DELETE /api/settings/integrations/:system                                            → PublicSettings
 * POST   /api/settings/integrations/:system/test       body IntegrationInput (optional; falls back to stored) → TestConnectionResponse
 *
 * PUT    /api/settings/figma                           body { token: string }          → PublicSettings
 * DELETE /api/settings/figma                                                           → PublicSettings
 * POST   /api/settings/figma/test                      body { token?: string }         → TestConnectionResponse (falls back to stored token)
 *
 * ── Projects ───────────────────────────────────────────────────────
 * GET    /api/projects                                 → ProjectSummary[]
 * POST   /api/projects                                 body CreateProjectRequest       → Project
 * POST   /api/projects/demo                                                            → Project  (sample project with the bundled screens in /samples/screens)
 * GET    /api/projects/:pid                            → ProjectDetail
 * PATCH  /api/projects/:pid                            body UpdateProjectRequest       → Project
 * DELETE /api/projects/:pid                                                            → { ok: true }   (moved to <dataDir>/.trash)
 *
 * ── Screens ────────────────────────────────────────────────────────
 * POST   /api/projects/:pid/screens                    multipart/form-data, field "files" (1..50 images, ≤ 25 MB each) → Screen[]
 * PATCH  /api/projects/:pid/screens/:sid               body UpdateScreenRequest        → Screen
 * PUT    /api/projects/:pid/screens-order              body { screenIds: string[] }    → Screen[]
 * PUT    /api/projects/:pid/screens/:sid/image         multipart/form-data, field "file" → Screen  (new version; old kept)
 * DELETE /api/projects/:pid/screens/:sid                                               → { ok: true }
 * GET    /api/projects/:pid/screens/:sid/image[?version=n]                             → image bytes
 * POST   /api/projects/:pid/screens/:sid/reanalyse     body ReanalyseScreenRequest     → JobStarted  (result: ImpactReport)
 * POST   /api/projects/:pid/figma/frames               body { fileUrl: string }        → FigmaFramesResponse
 * POST   /api/projects/:pid/figma/import               body FigmaImportRequest         → Screen[]
 * POST   /api/projects/:pid/figma/import-job           body FigmaImportRequest         → JobStarted (cancellable downloads; result: imported screen IDs/count)
 *
 * ── Generation & jobs ──────────────────────────────────────────────
 * POST   /api/projects/:pid/generate                   body GenerateRequest            → JobStarted  (result: GenerateResult)
 * POST   /api/projects/:pid/generate/abandon                                           → { ok: true }; discards the finished steps a stopped run kept for Try again
 * GET    /api/projects/:pid/jobs                                                       → Job[]  (most recent first, without logs older than the last 200)
 * GET    /api/jobs/:jobId                                                              → Job
 * GET    /api/jobs/:jobId/events                       text/event-stream of JobEvent (first event is a 'snapshot'); stream ends after a terminal 'status'
 * POST   /api/jobs/:jobId/cancel                                                       → { ok: true }
 *
 * ── Solution model & graph ─────────────────────────────────────────
 * GET    /api/projects/:pid/model                                                      → SolutionModel  (404 if never generated)
 * GET    /api/projects/:pid/graph                                                      → SolutionGraph  (empty graph if never generated)
 * PATCH  /api/projects/:pid/use-cases/:ucId/status     body { status: UseCaseStatus }  → UseCase (also rewrites the .md front matter)
 * POST   /api/projects/:pid/use-cases/:ucId/revise     body ReviseUseCaseRequest       → JobStarted  (result: ReviseUseCaseResult)
 *
 * ── Spec files (.md in project.outputDir) ──────────────────────────
 * GET    /api/projects/:pid/files                                                      → SpecFileNode (root dir node)
 * GET    /api/projects/:pid/files/content?path=<rel>                                   → SpecFileContent
 * PUT    /api/projects/:pid/files/content              body SaveSpecFileRequest        → SaveSpecFileResponse (409 if baseMtimeMs is stale)
 * GET    /api/projects/:pid/files/raw?path=<rel>                                       → raw bytes (images referenced by markdown)
 * POST   /api/projects/:pid/sync                                                       → SyncResult   (re-read every .md from disk into the model)
 * POST   /api/projects/:pid/rerender                   body { force?: boolean }        → RerenderResult (re-write .md from the model)
 * GET    /api/projects/:pid/search?q=<text>                                            → SearchHit[] (max 100, case-insensitive, over .md/.feature files)
 *
 * ── Impact analysis ────────────────────────────────────────────────
 * POST   /api/projects/:pid/impact/preview             body ChangeRequest              → DeterministicImpact (instant, no LLM)
 * POST   /api/projects/:pid/impact                     body AnalyseImpactRequest       → JobStarted  (result: ImpactReport)
 * GET    /api/projects/:pid/impact                                                     → ImpactReport[] (newest first)
 * GET    /api/projects/:pid/impact/:reportId                                           → ImpactReport
 * POST   /api/projects/:pid/impact/:reportId/apply     body ApplyImpactRequest         → JobStarted  (result: ApplyImpactResult)
 * POST   /api/projects/:pid/impact/:reportId/discard                                   → ImpactReport
 *
 * ── Export ─────────────────────────────────────────────────────────
 * GET    /api/projects/:pid/export/preview?target=jira|azdo|github&useCaseId=UC-001    → ExportPreview
 * POST   /api/projects/:pid/export                     body ExportRequest              → JobStarted  (result: ExportResult)
 * GET    /api/projects/:pid/export/csv[?useCaseIds=UC-001,UC-002]                      → text/csv attachment (one row per use case)
 *
 * ── Delivery planning and publishing (Intelligent Delivery Mapping) ──
 * POST   /api/projects/:pid/delivery/plans             body DeliveryPlanRequest        → JobStarted  (result: plan summary; read-only destination discovery)
 * GET    /api/projects/:pid/delivery/plans/:target                                     → DeliveryPlanView (404 when never planned)
 * POST   /api/projects/:pid/delivery/plans/:target/decisions   body DeliveryDecisionRequest   → DeliveryPlanView (local re-plan, no AI)
 * POST   /api/projects/:pid/delivery/plans/:target/attachments body DeliveryAttachmentRequest → DeliveryPlanView
 * POST   /api/projects/:pid/delivery/plans/:target/approve                             → DeliveryPlanView (optional review record; publishing does not need it)
 * POST   /api/projects/:pid/delivery/plans/:target/publish     body DeliveryPublishRequest    → JobStarted  (result: PublishRunSummary; the only tracker writes; Azure DevOps only)
 * POST   /api/projects/:pid/delivery/plans/:target/check                               → JobStarted  (result: PublishRunSummary; settles unknown outcomes with read-only searches)
 * GET    /api/projects/:pid/delivery/plans/:target/items/:itemId/preview               → DeliveryPayloadPreview
 */

import type {
  AzdoSettings,
  ChangeRequest,
  Effort,
  ExternalSystem,
  GenerationOptions,
  GitHubSettings,
  Job,
  JiraSettings,
  Project,
  ProviderKind,
  ReviewFinding,
  SolutionModel,
  UseCase,
  UseCaseDiff,
} from "./types";
import type { DeliveryPlan, PublishingState } from "./delivery";

export const CSRF_HEADER = "X-ScreenScribe";
export const API_PREFIX = "/api";

export interface ApiError {
  error: string;
  /** Optional machine-readable code, e.g. "NOT_FOUND", "CONFLICT", "VALIDATION", "LLM_ERROR". */
  code?: string;
  details?: unknown;
}

export interface HealthResponse {
  ok: true;
  version: string;
  dataDir: string;
}

/* ── Settings ── */

export interface ConnectionInput {
  name: string;
  provider: ProviderKind;
  /** Deprecated v1 form input, retained only for explicit compatibility submissions. */
  model?: string;
  modelIds?: string[];
  visibleModelIds?: string[];
  manualModelIds?: string[];
  presetId?: "lm-studio";
  baseUrl?: string;
  /** Omit or "" to keep the stored key on update. */
  apiKey?: string;
  /** true removes the stored key. */
  clearApiKey?: boolean;
  azureApiVersion?: string;
  effort?: Effort;
  maxOutputTokens?: number;
  temperature?: number;
  concurrency?: number;
  requestTimeoutSec?: number;
  structuredOutput?: "auto" | "native" | "prompt";
  vision?: "auto" | "yes" | "no";
  refusalFallback?: boolean;
}

export interface TestConnectionRequest {
  modelId?: string;
  /** Test a stored connection... */
  connectionId?: string;
  /** ...or an unsaved one (apiKey may be omitted when connectionId is also given, to reuse the stored key). */
  connection?: ConnectionInput;
}

export interface TestConnectionResponse {
  ok: boolean;
  message: string;
  latencyMs?: number;
  /** Model reported by the provider, if any. */
  model?: string;
  /** Whether a tiny image round-trip succeeded (LLM tests only; undefined if not attempted). */
  visionOk?: boolean;
}

export interface ListModelsRequest {
  provider: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  /** Reuse the stored key of this connection when apiKey is not given. */
  connectionId?: string;
  azureApiVersion?: string;
  presetId?: "lm-studio" | null;
  clearApiKey?: boolean;
}

export interface ListModelsResponse {
  models: import("./modelCatalogue").CatalogueModel[];
  catalogue?: import("./modelCatalogue").ModelCatalogue;
  cached?: boolean;
  partial?: boolean;
  unsupported?: boolean;
  errorCode?: import("./modelCatalogue").CatalogueFailure;
  /** Fixed safe explanation; no automatic preset/model replacement. */
  error?: string;
  /** Set when the API answered at a corrected address on the same server (the entered one plus /v1). */
  baseUrl?: string;
  /** A recognised service's documented key check, without inference; "missing" when no key was given. */
  keyCheck?: "accepted" | "refused" | "missing";
}

/** What uses an AI connection (owner test notes 1 and 6): the analysis defaults and the projects that chose it. */
export interface ConnectionUsage {
  readingDefault: boolean;
  writingDefault: boolean;
  projects: { id: string; name: string; roles: ("reading" | "writing")[] }[];
  /** The exact model IDs those uses chose: a connection to move them to must list all of them. */
  modelIds: string[];
}

/** Integration settings as sent by the UI: the secret may be omitted/"" to keep the stored one. */
export type IntegrationInput =
  | ({ system: "jira" } & Omit<JiraSettings, "apiToken"> & {
        apiToken?: string;
      })
  | ({ system: "azdo" } & Omit<AzdoSettings, "pat"> & { pat?: string })
  | ({ system: "github" } & Omit<GitHubSettings, "token"> & { token?: string });

/* ── Projects & screens ── */

/** POST /api/system/output-folder; cancelling leaves the draft unchanged. */
export interface PickOutputFolderResponse {
  path: string | null;
}

export interface CreateProjectRequest {
  /** Parent workspace for a new dedicated portable project, not an output destination. */
  workspaceDir?: string;
  localOnly?: boolean;
  name: string;
  description: string;
  additionalContext?: string;
  /** Absolute path; default <dataDir>/projects/<id>/specs */
  outputDir?: string;
  formatId?: string;
  areaId?: string | null;
}

export interface UpdateProjectRequest {
  localOnly?: boolean;
  areaId?: string | null;
  name?: string;
  description?: string;
  additionalContext?: string;
  outputDir?: string;
  formatId?: string;
  llm?: {
    visionConnectionId?: string | null;
    textConnectionId?: string | null;
    visionModelId?: string | null;
    textModelId?: string | null;
    visionAcknowledged?: boolean;
  };
}

/** Project plus derived info for the project workspace header. */
export interface ProjectDetail extends Project {
  useCaseCount: number;
  hasModel: boolean;
  /** Number of use cases with status 'stale'. */
  staleCount: number;
  /** Screens whose current version differs from analysedVersion (replaced since generation). */
  changedScreenIds: string[];
  /** Id of a currently running job for this project, if any. */
  activeJobId?: string;
}

export interface UpdateScreenRequest {
  name?: string;
  notes?: string;
}

export interface ReanalyseScreenRequest {
  connectionId?: string;
  modelId?: string;
  visionAcknowledged?: boolean;
}

/* ── Generation ── */

export type GenerateRequest = Partial<GenerationOptions>;

export interface JobStarted {
  jobId: string;
  job: Job;
}

export interface GenerateResult {
  useCaseCount: number;
  featureCount: number;
  screenCount: number;
  fileCount: number;
  outputDir: string;
  /** Files not overwritten because preserveEdited was on. */
  preservedFiles: string[];
  warnings: string[];
  review: ReviewFinding[];
}

/* ── Spec files ── */

export interface SpecFileContent {
  contentHash?: string;
  path: string;
  content: string;
  mtimeMs: number;
  useCaseId?: string;
}

export interface SaveSpecFileRequest {
  baseHash?: string;
  path: string;
  content: string;
  /** mtime the editor loaded; server answers 409 when the file changed on disk since. */
  baseMtimeMs?: number;
}

export interface SaveSpecFileResponse {
  path: string;
  mtimeMs: number;
  useCaseId?: string;
  /** True when the file was a use case and parsed back into the model. */
  parsed: boolean;
  parseErrors: string[];
  /** Present when a use case's content changed — the UI offers "Analyse knock-on effects". */
  diff?: UseCaseDiff;
}

export interface SyncResult {
  changed: UseCaseDiff[];
  parseErrors: { path: string; errors: string[] }[];
  /** Use cases whose .md file no longer exists. */
  missingFiles: { useCaseId: string; path: string }[];
}

export interface RerenderResult {
  fileCount: number;
  preservedFiles: string[];
}

/* ── Impact ── */

export interface AnalyseImpactRequest {
  change: ChangeRequest;
  connectionId?: string;
  modelId?: string;
}

export interface ApplyImpactRequest {
  /** Use cases to rewrite; default = every item with severity high|medium|low. */
  useCaseIds?: string[];
  connectionId?: string;
  modelId?: string;
}

export interface ApplyImpactResult {
  updatedUseCaseIds: string[];
  writtenFiles: string[];
  warnings: string[];
}

/* ── Revise one use case with AI ── */

export interface ReviseUseCaseRequest {
  proposalOnly?: boolean;
  /** BA instructions, e.g. "split the address fields into their own rules", "add a scenario for expired passwords". */
  instructions: string;
  connectionId?: string;
  modelId?: string;
}

export interface ReviseUseCaseResult {
  proposalId?: string;
  proposedMarkdown?: string;
  baselineMarkdown?: string;
  useCase: UseCase;
  diff: UseCaseDiff;
  writtenFiles: string[];
}

/** Complete canonical review artifact, separate from job diagnostics. */
export interface RevisionProposal {
  id: string;
  projectId: string;
  useCaseId: string;
  revision: number;
  path: string;
  baselineHash: string;
  baselineMarkdown: string;
  proposedMarkdown: string;
  status: "pending" | "applied" | "discarded";
  createdAt: string;
}
export interface RevisionProposalReview extends RevisionProposal {
  /** Binds complete proposal content and the current specification state. */
  reviewToken: string;
}

/* ── Search ── */

export interface SearchHit {
  /** POSIX path relative to outputDir. */
  path: string;
  useCaseId?: string;
  /** File title (H1) or file name. */
  title: string;
  /** 1-based line number of the match. */
  line: number;
  /** The matching line, trimmed to ~200 chars. */
  preview: string;
}

/* ── Figma import ── */

export interface FigmaFrame {
  /** Figma node id, e.g. "12:345". */
  id: string;
  name: string;
  /** Page (canvas) name. */
  page: string;
  width: number;
  height: number;
  /** Short-lived Figma CDN thumbnail URL, when available. */
  thumbnailUrl?: string;
}

export interface FigmaFramesResponse {
  fileKey: string;
  fileName: string;
  frames: FigmaFrame[];
}

export interface FigmaImportRequest {
  fileUrl: string;
  frameIds: string[];
  /** Render scale (default 2). */
  scale?: 1 | 2;
}

/* ── Export ── */

export type { ExportRequest, ExportResult, ExportPreview } from "./types";

/* ── Delivery planning ── */

export interface DeliveryPlanRequest {
  target: ExternalSystem;
  /** Omit to plan every approved use case. */
  useCaseIds?: string[];
  includeUnapproved?: boolean;
  groupByFeature?: boolean;
  linkDependencies?: boolean;
  /** Ask the project's writing model about open mapping questions (explicit consent; may use tokens). */
  useAi?: boolean;
  /** Re-read the destination's structure instead of using the saved snapshot. */
  refreshDestination?: boolean;
}

export interface DeliveryDecisionRequest {
  decisionId: string;
  /** One of the decision's option values, or "text:<value>" when it allows typing; null clears the answer. */
  value: string | null;
  /** Remember a type-level answer for future plans to this destination (default false). */
  saveAsRule?: boolean;
}

/** The plan the BA confirmed; the server refuses to publish when the stored plan differs. */
export interface DeliveryPublishRequest {
  revision: number;
  fingerprint: string;
}

export interface DeliveryAttachmentRequest {
  attachmentId: string;
  include: boolean;
}

export interface DeliveryPlanView {
  plan: DeliveryPlan;
  /** Why the stored plan no longer matches the project or destination; empty when current. */
  stale: string[];
  /** Fingerprint of the plan's content, sent back with a publish request. */
  fingerprint: string;
  publishing: PublishingState;
}

export interface DeliveryPayloadPreview {
  itemId: string;
  system: ExternalSystem;
  operation: "create" | "update" | "keep";
  format: "html" | "adf" | "jira-wiki" | "markdown";
  request: string;
  body: unknown;
  relationships: { description: string; body: unknown }[];
  notes: string[];
}

/** Convenience: the model as returned by GET /model. */
export type ModelResponse = SolutionModel;

export const EXTERNAL_SYSTEM_LABEL: Record<ExternalSystem, string> = {
  jira: "Jira",
  azdo: "Azure DevOps",
  github: "GitHub",
};
