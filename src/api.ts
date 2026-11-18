import type {
  ConnectionInput,
  IntegrationInput,
  ListModelsResponse,
} from "../shared/api";
import type { ProviderKind, PublicSettings } from "../shared/types";
import { analysisModelDefaults } from "../shared/analysisDefaults";
import { sessionFetch } from "./localSession";
import {
  initialSettings,
  type Connection,
  type Provider,
  type SettingsData,
} from "./data";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const form = body instanceof FormData;
  const response = await sessionFetch("/api" + path, {
    signal,
    method,
    headers: {
      ...(method === "GET" ? {} : { "X-ScreenScribe": "1" }),
      ...(!form && body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({
    error:
      "The local API did not return JSON. Check that the Coherence server is running.",
  }));
  if (!response.ok)
    throw new ApiError(
      data.error ?? `Request failed (${response.status})`,
      response.status,
    );
  return data as T;
}
const toProvider = (p: ProviderKind): Provider =>
  p === "azure-openai" ? "azure" : p === "openai-compatible" ? "compatible" : p;
const fromProvider = (p: Provider): ProviderKind =>
  p === "azure"
    ? "azure-openai"
    : p === "compatible" || p === "lmstudio"
      ? "openai-compatible"
      : p;
export function connectionInput(c: Connection): ConnectionInput {
  const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
  return {
    name: c.name,
    provider: fromProvider(c.provider),
    ...(c.modelIds !== undefined
      ? { modelIds: c.modelIds }
      : { model: c.model }),
    visibleModelIds: c.visibleModelIds,
    manualModelIds: c.manualModelIds,
    presetId: c.provider === "lmstudio" ? "lm-studio" : undefined,
    baseUrl: c.endpoint || undefined,
    apiKey: c.apiKey || undefined,
    clearApiKey: !c.keyPresent && !c.apiKey,
    azureApiVersion: c.azureVersion,
    effort: efforts.includes(c.effort as (typeof efforts)[number])
      ? (c.effort as (typeof efforts)[number])
      : undefined,
    maxOutputTokens: c.maxTokens === 0 ? undefined : c.maxTokens,
    // 0 = Automatic: the server applies the provider's default.
    requestTimeoutSec: c.timeout || undefined,
    concurrency: c.concurrency,
    vision: c.vision as "auto" | "yes" | "no",
    structuredOutput: (c.structured === "off" ? "prompt" : c.structured) as
      "auto" | "native" | "prompt",
    temperature: c.temperature,
  };
}
export function settingsFromPublic(s: PublicSettings): SettingsData {
  const fallback = structuredClone(initialSettings);
  const connections = s.connections.map((c) => ({
    id: c.id,
    name: c.name,
    provider:
      c.presetId === "lm-studio"
        ? ("lmstudio" as const)
        : toProvider(c.provider),
    model: c.model ?? "",
    modelIds: c.modelIds,
    visibleModelIds: c.visibleModelIds,
    manualModelIds: c.manualModelIds,
    catalogue: c.catalogue,
    capabilities: c.capabilities,
    endpoint:
      c.baseUrl ??
      (
        {
          anthropic: "https://api.anthropic.com",
          openai: "https://api.openai.com/v1",
          gemini: "https://generativelanguage.googleapis.com",
          mock: "http://127.0.0.1",
          ollama: "http://127.0.0.1:11434",
        } as Record<string, string>
      )[c.provider] ??
      "",
    apiKey: "",
    keyPresent: c.hasApiKey,
    maxTokens: c.maxOutputTokens ?? 0,
    timeout: c.requestTimeoutSec,
    concurrency: c.concurrency,
    effort: c.effort ?? "medium",
    vision: c.vision,
    structured: c.structuredOutput,
    temperature: c.temperature ?? 0.2,
    azureVersion: c.azureApiVersion ?? "2025-04-01-preview",
  }));
  const defaultId = s.defaultConnectionId ?? connections[0]?.id ?? "";
  const integrations = Object.fromEntries(
    Object.entries(fallback.integrations).map(([system, fields]) => [
      system,
      Object.fromEntries(Object.keys(fields).map((k) => [k, ""])),
    ]),
  );
  Object.assign(integrations.jira, {
    deployment: "cloud",
    issueType: "Story",
    parentType: "Epic",
    linkType: "Blocks",
  });
  Object.assign(integrations.azdo, {
    issueType: "User Story",
    parentType: "Feature",
  });
  Object.assign(integrations.github, {
    url: "https://api.github.com",
    milestones: "yes",
  });
  const j = s.integrations.jira;
  if (j)
    Object.assign(integrations.jira, {
      deployment: j.deployment,
      url: j.baseUrl,
      email: j.email,
      project: j.projectKey,
      issueType: j.issueType,
      parentType: j.epicIssueType,
      linkType: j.linkType,
      labels: j.labels.join(", "),
      pointsField: j.storyPointsFieldId ?? "",
      hasSecret: String(j.hasSecret),
    });
  const a = s.integrations.azdo;
  if (a)
    Object.assign(integrations.azdo, {
      url: a.orgUrl,
      project: a.project,
      issueType: a.workItemType,
      parentType: a.parentWorkItemType,
      area: a.areaPath ?? "",
      iteration: a.iterationPath ?? "",
      labels: a.tags.join(", "),
      hasSecret: String(a.hasSecret),
    });
  const g = s.integrations.github;
  if (g)
    Object.assign(integrations.github, {
      owner: g.owner,
      repo: g.repo,
      url: g.apiBaseUrl,
      labels: g.labels.join(", "),
      milestones: g.useMilestonesForFeatures ? "yes" : "no",
      hasSecret: String(g.hasSecret),
    });
  integrations.figma.hasSecret = String(s.figma?.hasToken ?? false);
  const settings = {
    ...fallback,
    ...s.preferences,
    connections,
    defaultId,
    analysisDefaults: analysisModelDefaults(s.analysisDefaults, connections),
    visionId: String(
      s.preferences?.visionId ??
        connections.find((c) => c.provider === "mock")?.id ??
        "",
    ),
    textId: String(
      s.preferences?.textId ??
        connections.find((c) => c.provider === "mock")?.id ??
        "",
    ),
    integrations,
  } as SettingsData;
  return settings;
}
const list = (value: string) =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
export function integrationInput(
  system: string,
  settings: SettingsData,
): IntegrationInput {
  const i = settings.integrations[system];
  if (system === "jira")
    return {
      system,
      baseUrl: i.url,
      email: i.email,
      projectKey: i.project,
      issueType: i.issueType,
      epicIssueType: i.parentType,
      linkType: i.linkType,
      labels: list(i.labels),
      storyPointsFieldId: i.pointsField || undefined,
      apiToken: i.token || undefined,
      deployment: i.deployment as "cloud" | "server",
    };
  if (system === "azdo")
    return {
      system,
      orgUrl: i.url,
      project: i.project,
      workItemType: i.issueType,
      parentWorkItemType: i.parentType,
      areaPath: i.area,
      iterationPath: i.iteration,
      tags: list(i.labels),
      pat: i.token || undefined,
    };
  return {
    system: "github",
    owner: i.owner,
    repo: i.repo,
    apiBaseUrl: i.url,
    labels: list(i.labels),
    useMilestonesForFeatures: i.milestones === "yes",
    token: i.token || undefined,
  };
}
export async function saveSettings(s: SettingsData, revision: number) {
  const {
    connections,
    integrations,
    defaultId,
    analysisDefaults,
    ...preferences
  } = s;
  const configured = ["jira", "azdo", "github"].filter((k) =>
    k === "github"
      ? integrations[k].owner || integrations[k].repo
      : integrations[k].url || integrations[k].project,
  );
  return api<PublicSettings>("/settings/workspace", "PUT", {
    baseRevision: revision,
    connections: connections.map((c) => ({ ...connectionInput(c), id: c.id })),
    defaultConnectionId: defaultId,
    analysisDefaults,
    integrations: configured.map((k) => integrationInput(k, s)),
    figmaToken: integrations.figma.token || undefined,
    clearFigma:
      integrations.figma.hasSecret === "false" && !integrations.figma.token,
    preferences,
  });
}
export async function testSettings(
  category: string,
  c: Connection,
  s: SettingsData,
) {
  if (["jira", "azdo", "github"].includes(category))
    return api<{ ok: boolean; message: string }>(
      `/settings/integrations/${category}/test`,
      "POST",
      integrationInput(category, s),
    );
  if (category === "figma")
    return api<{ ok: boolean; message: string }>(
      "/settings/figma/test",
      "POST",
      { token: s.integrations.figma.token || undefined },
    );
  const saved = await api<PublicSettings>("/settings");
  if (c.keyPresent && !saved.connections.some((v) => v.id === c.id))
    throw Error(
      "This saved connection was removed. Reopen Settings and explicitly reconfigure it before testing.",
    );
  return api<{ ok: boolean; message: string }>(
    "/settings/connections/test",
    "POST",
    {
      connection: connectionInput(c),
      modelId: c.model,
      connectionId: saved.connections.some((v) => v.id === c.id)
        ? c.id
        : undefined,
    },
  );
}
export async function testCapability(
  c: Connection,
  modelId: string,
  capability: import("../shared/modelCapabilities").Capability,
  mode?: import("../shared/modelCapabilities").StructuredTestMode,
  signal?: AbortSignal,
) {
  const saved = await api<PublicSettings>(
    "/settings",
    "GET",
    undefined,
    signal,
  );
  if (c.keyPresent && !saved.connections.some((v) => v.id === c.id))
    throw Error(
      "This saved connection was removed. Reopen Settings and configure it explicitly.",
    );
  return api<import("../shared/modelCapabilities").CapabilityTestResponse>(
    "/settings/connections/capabilities/test",
    "POST",
    {
      connection: connectionInput(c),
      connectionId: saved.connections.some((v) => v.id === c.id)
        ? c.id
        : undefined,
      modelId,
      capability,
      mode,
    },
    signal,
  );
}
export async function discoverModels(c: Connection) {
  const input = connectionInput(c);
  const saved = await api<PublicSettings>("/settings");
  if (c.keyPresent && !saved.connections.some((v) => v.id === c.id))
    throw Error(
      "This saved connection was removed. Reopen Settings and explicitly reconfigure it before listing models.",
    );
  const result = await api<ListModelsResponse>(
    "/settings/connections/models",
    "POST",
    {
      provider: input.provider,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      azureApiVersion: input.azureApiVersion,
      connectionId: saved.connections.some((v) => v.id === c.id)
        ? c.id
        : undefined,
      presetId: c.provider === "lmstudio" ? "lm-studio" : null,
      clearApiKey: input.clearApiKey,
    },
  );
  return result;
}
