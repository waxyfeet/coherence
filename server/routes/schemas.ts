/**
 * OWNER: server-core builder.
 * zod schemas for every JSON request body (shared/api.ts). They check shape and obvious limits; semantic
 * checks (does this connection exist, is this path absolute…) live in the stores with BA-readable messages.
 */
import { z } from "zod";
import type {
  AnalyseImpactRequest,
  ApplyImpactRequest,
  ConnectionInput,
  CreateProjectRequest,
  FigmaImportRequest,
  GenerateRequest,
  IntegrationInput,
  ListModelsRequest,
  ReanalyseScreenRequest,
  ReviseUseCaseRequest,
  SaveSpecFileRequest,
  TestConnectionRequest,
  UpdateProjectRequest,
  UpdateScreenRequest,
} from "@shared/api";
import type {
  ChangeRequest,
  ExportRequest,
  ProviderKind,
  UseCaseStatus,
} from "@shared/types";
import { PROVIDER_ORDER } from "@shared/providers";

const providerKinds = PROVIDER_ORDER as [ProviderKind, ...ProviderKind[]];
const text = (max: number) =>
  z.string().max(max, `Must be at most ${max} characters`);
/** Optional string where the UI may send null for "not set". */
const optText = (max: number) =>
  text(max)
    .nullish()
    .transform((v) => v ?? undefined);
const optNumber = (schema: z.ZodNumber) =>
  schema.nullish().transform((v) => v ?? undefined);
const id = text(200).min(1, "Required");
const optId = id
  .nullish()
  .or(z.literal(""))
  .transform((v) => (v ? v : undefined));
const optModelId = text(300)
  .nullish()
  .transform((v) => v || undefined);

const httpUrl = (example: string) =>
  z
    .string()
    .trim()
    .min(1, `Enter the URL, e.g. ${example}`)
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    }, `Enter a full URL starting with https://, e.g. ${example}`);

/* ── Settings ── */

export const connectionInputSchema = z.object({
  name: text(120).default(""),
  provider: z.enum(providerKinds),
  model: text(300).default(""),
  modelIds: z
    .array(
      text(300)
        .trim()
        .min(1)
        .refine(
          (v) => !/[\r\n\u0000-\u001f]/.test(v),
          "Use a model ID without control characters",
        ),
    )
    .max(200)
    .optional(),
  visibleModelIds: z.array(text(300)).max(200).optional(),
  manualModelIds: z.array(text(300)).max(200).optional(),
  presetId: z.literal("lm-studio").optional(),
  baseUrl: optText(2000),
  apiKey: optText(10_000),
  clearApiKey: z.boolean().optional(),
  azureApiVersion: optText(100),
  effort: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .nullish()
    .transform((v) => v ?? undefined),
  maxOutputTokens: optNumber(z.number().int().positive().max(1_000_000)),
  temperature: optNumber(z.number().min(0).max(2)),
  concurrency: optNumber(z.number().int().min(1).max(64)),
  requestTimeoutSec: optNumber(z.number().int().min(5).max(7200)),
  structuredOutput: z.enum(["auto", "native", "prompt"]).optional(),
  vision: z.enum(["auto", "yes", "no"]).optional(),
  refusalFallback: z.boolean().optional(),
}) satisfies z.ZodType<ConnectionInput>;

export const testConnectionSchema = z
  .object({
    modelId: optModelId,
    connectionId: optId,
    connection: connectionInputSchema.optional(),
  })
  .refine(
    (v) => v.connectionId || v.connection,
    "Give a connectionId or a connection to test",
  ) satisfies z.ZodType<TestConnectionRequest>;

export const listModelsSchema = z.object({
  provider: z.enum(providerKinds),
  baseUrl: optText(2000),
  apiKey: optText(10_000),
  connectionId: optId,
  azureApiVersion: optText(100),
  presetId: z.literal("lm-studio").nullable().optional(),
  clearApiKey: z.boolean().optional(),
}) satisfies z.ZodType<ListModelsRequest>;

export const defaultConnectionSchema = z.object({ connectionId: id });

/** Move the projects that use a connection to another one (removing a connection, owner test note 1). */
export const reassignSchema = z.object({ to: id });

const labelList = z.array(text(100)).max(50).default([]);

const jiraInput = z.object({
  system: z.literal("jira"),
  baseUrl: httpUrl("https://yourcompany.atlassian.net"),
  email: text(320).default(""),
  apiToken: optText(10_000),
  projectKey: text(50).trim().min(1, "Enter the Jira project key, e.g. ABC"),
  issueType: text(100).default("Story"),
  epicIssueType: text(100).default("Epic"),
  labels: labelList,
  linkType: text(100).default("Blocks"),
  deployment: z.enum(["cloud", "server"]).default("cloud"),
  storyPointsFieldId: optText(100),
});

const azdoInput = z.object({
  system: z.literal("azdo"),
  orgUrl: httpUrl("https://dev.azure.com/yourorg"),
  project: text(200).trim().min(1, "Enter the Azure DevOps project name"),
  pat: optText(10_000),
  workItemType: text(100).default("User Story"),
  parentWorkItemType: text(100).default("Feature"),
  areaPath: optText(500),
  iterationPath: optText(500),
  tags: labelList,
});

const githubInput = z.object({
  system: z.literal("github"),
  owner: text(100)
    .trim()
    .min(1, "Enter the repository owner (user or organisation)"),
  repo: text(100).trim().min(1, "Enter the repository name"),
  token: optText(10_000),
  labels: labelList,
  apiBaseUrl: z
    .string()
    .trim()
    .default("https://api.github.com")
    .refine((value) => {
      if (!value) return true;
      try {
        return ["http:", "https:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }, "Enter a full API URL, e.g. https://api.github.com"),
  useMilestonesForFeatures: z.boolean().default(true),
});

export const integrationInputSchema = z.discriminatedUnion("system", [
  jiraInput,
  azdoInput,
  githubInput,
]) satisfies z.ZodType<IntegrationInput>;

export const externalSystemSchema = z.enum(["jira", "azdo", "github"]);

export const figmaTokenSchema = z.object({
  token: text(1000).trim().min(1, "Paste a Figma personal access token"),
});
export const figmaTestSchema = z.object({ token: optText(1000) });

/* ── Projects & screens ── */

export const createProjectSchema = z.object({
  workspaceDir: optText(1000),
  localOnly: z.boolean().optional(),
  areaId: id.nullable().optional(),
  name: text(200).trim().min(1, "Enter a project name"),
  description: text(20_000).default(""),
  additionalContext: optText(50_000),
  outputDir: optText(1000),
  formatId: optText(100),
}) satisfies z.ZodType<CreateProjectRequest>;

export const updateProjectSchema = z.object({
  localOnly: z.boolean().optional(),
  areaId: id.nullable().optional(),
  name: text(200).optional(),
  description: text(20_000).optional(),
  additionalContext: text(50_000).optional(),
  outputDir: text(1000).optional(),
  formatId: text(100).optional(),
  llm: z
    .object({
      visionConnectionId: text(200).nullable().optional(),
      textConnectionId: text(200).nullable().optional(),
      visionModelId: text(300).nullable().optional(),
      textModelId: text(300).nullable().optional(),
      visionAcknowledged: z.boolean().optional(),
    })
    .optional(),
}) satisfies z.ZodType<UpdateProjectRequest>;

export const updateScreenSchema = z.object({
  name: text(200).optional(),
  notes: text(20_000).optional(),
}) satisfies z.ZodType<UpdateScreenRequest>;

export const reorderScreensSchema = z.object({
  screenIds: z.array(id).max(1000),
});

export const reanalyseScreenSchema = z.object({
  connectionId: optId,
  modelId: optModelId,
  visionAcknowledged: z.boolean().optional(),
}) satisfies z.ZodType<ReanalyseScreenRequest>;

export const figmaFramesSchema = z.object({
  fileUrl: text(2000).trim().min(1, "Paste the Figma file URL"),
});

export const figmaImportSchema = z.object({
  fileUrl: text(2000).trim().min(1, "Paste the Figma file URL"),
  frameIds: z
    .array(text(200).min(1))
    .min(1, "Select at least one frame")
    .max(50, "Import at most 50 frames at a time"),
  scale: z.union([z.literal(1), z.literal(2)]).optional(),
}) satisfies z.ZodType<FigmaImportRequest>;

/* ── Generation ── */

export const generateSchema = z.object({
  visionConnectionId: optId,
  textConnectionId: optId,
  visionModelId: optModelId,
  textModelId: optModelId,
  visionAcknowledged: z.boolean().optional(),
  thoroughness: z.enum(["standard", "thorough"]).optional(),
  granularity: z.enum(["fine", "balanced", "coarse"]).optional(),
  preserveEdited: z.boolean().optional(),
  embedScreenImages: z.boolean().optional(),
  reuseScreenAnalyses: z.boolean().optional(),
}) satisfies z.ZodType<GenerateRequest>;

/* ── Model ── */

export const useCaseStatusSchema = z.object({
  status: z.enum(["generated", "edited", "stale", "approved"]),
}) satisfies z.ZodType<{ status: UseCaseStatus }>;

export const reviseUseCaseSchema = z.object({
  instructions: text(20_000)
    .trim()
    .min(3, "Describe what should change in this use case"),
  connectionId: optId,
  modelId: optModelId,
}) satisfies z.ZodType<ReviseUseCaseRequest>;

/* ── Spec files ── */

export const saveSpecFileSchema = z.object({
  baseHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  path: text(1000).min(1, "Required"),
  content: z.string().max(4_000_000, "The file is too large (max 4 MB)"),
  baseMtimeMs: z.number().nonnegative().optional(),
}) satisfies z.ZodType<SaveSpecFileRequest>;

export const rerenderSchema = z.object({ force: z.boolean().optional() });

/* ── Impact ── */

const useCaseSections = z.enum([
  "title",
  "story",
  "scope",
  "preconditions",
  "postconditions",
  "rules",
  "scenarios",
  "assumptions",
  "openQuestions",
  "notes",
  "dependencies",
  "elements",
  "status",
]);

// The diffs are produced by the server itself and echoed back by the UI; check the essentials and pass the rest.
const screenDiffSchema = z.looseObject({
  screenId: id,
  fromVersion: z.number(),
  toVersion: z.number(),
  added: z.array(z.any()),
  removed: z.array(z.any()),
  modified: z.array(z.any()),
  summary: z.string(),
});

const useCaseDiffSchema = z.object({
  useCaseId: id,
  changedSections: z.array(useCaseSections),
  summary: z.string(),
  details: z.array(z.string()),
});

const changeRequestFields = {
  targetKind: z.enum([
    "feature",
    "element",
    "screen",
    "region",
    "usecase",
    "rule",
    "scenario",
    "persona",
    "free",
  ]),
  targetId: optText(300),
  source: z.enum(["manual", "md-edit", "screen-replace"]).default("manual"),
  screenDiff: screenDiffSchema.optional(),
  useCaseDiff: useCaseDiffSchema.optional(),
};
const hasTarget = (c: { targetKind: string; targetId?: string }) =>
  c.targetKind === "free" || !!c.targetId;
const targetRequired = {
  message: "Pick what is changing (targetId), or describe a free-form change",
  path: ["targetId"],
};

export const changeRequestSchema = z
  .object({
    ...changeRequestFields,
    description: text(20_000).trim().min(3, "Describe the change"),
  })
  .refine(hasTarget, targetRequired)
  .transform((c) => c as ChangeRequest);

/**
 * The instant trace of a concrete target does not depend on the description, so the change dialog asks
 * for it before the BA has typed anything — an empty description must not be rejected here.
 */
export const previewChangeSchema = z
  .object({
    ...changeRequestFields,
    description: text(20_000).trim().default(""),
  })
  .refine(hasTarget, targetRequired)
  .transform((c) => c as ChangeRequest);

export const analyseImpactSchema = z.object({
  change: changeRequestSchema,
  connectionId: optId,
  modelId: optModelId,
}) satisfies z.ZodType<AnalyseImpactRequest>;

export const applyImpactSchema = z.object({
  useCaseIds: z.array(id).max(2000).optional(),
  connectionId: optId,
  modelId: optModelId,
}) satisfies z.ZodType<ApplyImpactRequest>;

/* ── Export ── */

export const exportRequestSchema = z.object({
  target: externalSystemSchema,
  useCaseIds: z
    .array(id)
    .min(1, "Select at least one use case to export")
    .max(2000),
  dryRun: z.boolean().default(false),
  createFeatureParents: z.boolean().default(true),
  linkDependencies: z.boolean().default(true),
  updateExisting: z.boolean().default(true),
  includeStoryPoints: z.boolean().default(false),
}) satisfies z.ZodType<ExportRequest>;

export const exportPreviewQuerySchema = z.object({
  target: externalSystemSchema,
  useCaseId: id,
});
