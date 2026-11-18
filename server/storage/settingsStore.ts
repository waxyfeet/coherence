import { validModelId } from "../../shared/modelSelection";
import {
  analysisModelDefaults,
  sameAnalysisDefaults,
  defaultRoleIssue,
} from "@shared/analysisDefaults";
import { cachedCatalogue } from "../llm/catalogue";
import { cachedCapabilities } from "../llm/capabilities";
import { rememberCredentials } from "../security/diagnostics";
import {
  archiveSettingsRecovery,
  migrateLegacyEndpoints,
  protectLegacySettingsBackups,
} from "../security/legacySettings";
/**
 * OWNER: server-core builder.
 * Settings metadata is local JSON; named secrets and legacy URL recovery use Windows DPAPI.
 * On first load with no connections: create an "Offline demo (no AI)" mock connection, and if
 * SCREENSCRIBE_V2_ANTHROPIC_API_KEY / SCREENSCRIBE_V2_OPENAI_API_KEY / SCREENSCRIBE_V2_GEMINI_API_KEY are set in the environment, a connection for each
 * (without storing the key — the LLM layer falls back to the env var). The first real connection becomes default.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type { ConnectionInput, IntegrationInput } from "@shared/api";
import { EXTERNAL_SYSTEM_LABEL } from "@shared/api";
import { PROVIDER_PRESETS } from "@shared/providers";
import type {
  AppSettings,
  AnalysisModelDefaults,
  AzdoSettings,
  Effort,
  ExternalSystem,
  GitHubSettings,
  IntegrationSettings,
  JiraSettings,
  ProviderConnection,
  ProviderKind,
  PublicIntegration,
  PublicLLMConnection,
  PublicSettings,
} from "@shared/types";
import { INTEGRATION_SECRET_FIELD } from "@shared/types";
import {
  validateEndpoint,
  validateProviderEndpoint,
  mayUseEnvironmentKey,
  publicEndpoint,
} from "../security/endpointPolicy";
import { config, paths } from "../config";
import { protectSettings, unprotectSettings } from "./protectedSecrets";
import { BadRequestError, ConflictError, NotFoundError } from "../errors";
import { StartupError } from "../startupErrors";
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  ensureDir,
  fileTimestamp,
  isNotFound,
  writeFileAtomic,
  writeJsonAtomic,
} from "./fsUtils";

/** Providers auto-added on first run when their API key is in the environment (in this order). */
const ENV_AUTO_PROVIDERS: ProviderKind[] = ["anthropic", "openai", "gemini"];
const ENV_CONNECTION_NAMES: Partial<Record<ProviderKind, string>> = {
  anthropic: "Claude",
  openai: "OpenAI",
  gemini: "Gemini",
};

let cache: AppSettings | null = null;
let loading: Promise<AppSettings> | null = null;
// Serialises read-modify-write cycles so two quick edits from the UI cannot lose one another.
let writeChain: Promise<unknown> = Promise.resolve();

const now = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);

/* ------------------------------------------------------------------ */
/* Load / save                                                         */
/* ------------------------------------------------------------------ */

function envKey(provider: ProviderKind): string | undefined {
  const envVar = PROVIDER_PRESETS[provider].apiKeyEnvVar;
  if (!envVar?.startsWith("SCREENSCRIBE_V2_")) return undefined;
  const value = envVar ? process.env[envVar]?.trim() : undefined;
  return value || undefined;
}

function newConnectionId(): string {
  return `conn_${nanoid(10)}`;
}

function defaultSettings(): AppSettings {
  const timestamp = now();
  const connections: ProviderConnection[] = [];
  for (const provider of ENV_AUTO_PROVIDERS) {
    if (!envKey(provider)) continue;
    const preset = PROVIDER_PRESETS[provider];
    connections.push({
      id: newConnectionId(),
      name: `${ENV_CONNECTION_NAMES[provider] ?? preset.label} (from ${preset.apiKeyEnvVar})`,
      provider,
      modelIds: [],
      effort: preset.supportsEffort ? preset.defaultEffort : undefined,
      concurrency: preset.defaultConcurrency,
      requestTimeoutSec: preset.defaultTimeoutSec,
      structuredOutput: "auto",
      vision: "auto",
      refusalFallback: preset.supportsRefusalFallback,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
  const mockPreset = PROVIDER_PRESETS.mock;
  connections.push({
    id: newConnectionId(),
    name: mockPreset.label,
    provider: "mock",
    modelIds: [mockPreset.defaultModel],
    concurrency: mockPreset.defaultConcurrency,
    requestTimeoutSec: mockPreset.defaultTimeoutSec,
    structuredOutput: "auto",
    vision: "auto",
    refusalFallback: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return {
    version: 1,
    connections,
    defaultConnectionId: pickDefaultConnectionId(connections),
    analysisDefaults: analysisModelDefaults(undefined, connections),
    integrations: {},
  };
}

/** First real (non-mock) connection, else the first one. */
function pickDefaultConnectionId(
  connections: ProviderConnection[],
): string | undefined {
  return (connections.find((c) => c.provider !== "mock") ?? connections[0])?.id;
}

function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === "string" && value in PROVIDER_PRESETS;
}

/** The settings format this version writes. A newer file is refused, never rewritten (installer review ST-06). */
export const SETTINGS_FORMAT_VERSION = 1;
const KNOWN_SETTINGS_FIELDS = new Set([
  "version",
  "connections",
  "defaultConnectionId",
  "integrations",
  "revision",
  "preferences",
  "analysisDefaults",
  "figma",
  "_protectedSecrets",
]);

/**
 * Parts of settings.json this version does not understand — fields and connections added by a newer version —
 * kept aside so a save never discards them. They are never used here; secrets inside are protected again on save.
 */
let preserved: { fields: Record<string, unknown>; connections: unknown[] } = {
  fields: {},
  connections: [],
};
function preservedParts(raw: Record<string, unknown>): typeof preserved {
  return structuredClone({
    fields: Object.fromEntries(
      Object.entries(raw).filter(([key]) => !KNOWN_SETTINGS_FIELDS.has(key)),
    ),
    connections: Array.isArray(raw.connections)
      ? raw.connections.filter(
          (c) =>
            c &&
            typeof c === "object" &&
            typeof c.id === "string" &&
            !isProviderKind(c.provider),
        )
      : [],
  });
}

/** Tolerates older / hand-edited files: fills defaults, drops connections that cannot work. */
function normaliseSettings(raw: unknown): AppSettings {
  rememberCredentials(raw);
  if (
    !raw ||
    typeof raw !== "object" ||
    !Array.isArray((raw as AppSettings).connections)
  ) {
    throw new Error("settings.json does not contain a connections list");
  }
  const input = raw as Partial<AppSettings>;
  const timestamp = now();
  const connections: ProviderConnection[] = [];
  for (const c of input.connections ?? []) {
    if (
      !c ||
      typeof c !== "object" ||
      typeof c.id !== "string" ||
      !isProviderKind(c.provider)
    )
      continue;
    const preset = PROVIDER_PRESETS[c.provider];
    connections.push({
      ...c,
      name: typeof c.name === "string" && c.name.trim() ? c.name : preset.label,
      modelIds: Array.isArray(c.modelIds)
        ? c.modelIds.filter(validModelId)
        : c.provider === "mock"
          ? [preset.defaultModel]
          : typeof c.model === "string" && validModelId(c.model)
            ? [c.model]
            : [],
      visibleModelIds: Array.isArray(c.visibleModelIds)
        ? c.visibleModelIds.filter(validModelId)
        : undefined,
      manualModelIds: Array.isArray(c.manualModelIds)
        ? c.manualModelIds.filter(validModelId)
        : undefined,
      presetId:
        c.provider === "openai-compatible" && c.presetId === "lm-studio"
          ? c.presetId
          : undefined,
      concurrency:
        Number.isInteger(c.concurrency) && c.concurrency > 0
          ? c.concurrency
          : preset.defaultConcurrency,
      requestTimeoutSec:
        Number.isFinite(c.requestTimeoutSec) && c.requestTimeoutSec > 0
          ? c.requestTimeoutSec
          : preset.defaultTimeoutSec,
      structuredOutput: c.structuredOutput ?? "auto",
      vision: c.vision ?? "auto",
      refusalFallback:
        typeof c.refusalFallback === "boolean"
          ? c.refusalFallback
          : preset.supportsRefusalFallback,
      createdAt: c.createdAt ?? timestamp,
      updatedAt: c.updatedAt ?? timestamp,
    });
  }
  const defaultConnectionId = connections.some(
    (c) => c.id === input.defaultConnectionId,
  )
    ? input.defaultConnectionId
    : pickDefaultConnectionId(connections);
  const integrations: IntegrationSettings =
    input.integrations && typeof input.integrations === "object"
      ? input.integrations
      : {};
  return {
    version: 1,
    connections,
    defaultConnectionId,
    integrations,
    revision: input.revision ?? 0,
    preferences: input.preferences,
    analysisDefaults:
      input.analysisDefaults === undefined
        ? undefined
        : analysisModelDefaults(input.analysisDefaults, connections),
    figma: input.figma?.token ? { token: input.figma.token } : undefined,
  };
}

/**
 * Saved keys that Windows could not unlock for this account — a new PC or Windows account, a restored profile, a
 * password reset. Coherence still starts, without those keys, and writes nothing until the user resets them; the
 * original file is then kept as settings.json.locked-<time>, so the keys stay readable for the account that saved
 * them (installer finding ST-05).
 */
let lockedOriginal: Buffer | undefined;
const KEYS_LOCKED =
  "Windows could not unlock the AI keys saved in Coherence for this account. Reset the saved keys in Settings to enter them again; nothing else is lost.";

export function savedKeysLocked(): boolean {
  return lockedOriginal !== undefined;
}

/** Keeps the locked file aside and starts again without its keys. Other settings are kept. */
export async function resetLockedKeys(): Promise<void> {
  const run = writeChain.then(async () => {
    const current = await load();
    const original = lockedOriginal;
    if (!original) return;
    const file = paths.settingsFile();
    await writeFileAtomic(
      `${file}.locked-${fileTimestamp()}`,
      original,
      PRIVATE_FILE_MODE,
    );
    lockedOriginal = undefined;
    const draft = clone(current);
    draft.revision = (current.revision ?? 0) + 1;
    await saveSettings(file, draft);
    cache = draft;
    console.warn(
      "[settings] Locked saved keys were reset; the previous settings file was kept beside the new one.",
    );
  });
  writeChain = run.catch(() => {});
  return run;
}

/** Named credentials are protected before the atomic private write; no plaintext fallback. */
async function saveSettings(
  file: string,
  settings: AppSettings,
): Promise<void> {
  if (lockedOriginal) throw new ConflictError(KEYS_LOCKED);
  await writeJsonAtomic(
    file,
    await protectSettings({
      ...preserved.fields,
      ...settings,
      connections: [...settings.connections, ...preserved.connections],
    }),
    PRIVATE_FILE_MODE,
  );
}

/**
 * Earlier versions wrote settings.json (and its damaged-file backups) with default permissions, readable by
 * other local users on macOS/Linux. Tighten whatever is already there; best effort.
 */
async function restrictExistingSettingsFiles(file: string): Promise<void> {
  if (process.platform === "win32") return;
  const dir = path.dirname(file);
  const base = path.basename(file);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((name) => name === base || name.startsWith(`${base}.bak-`))
      .map((name) =>
        fs.chmod(path.join(dir, name), PRIVATE_FILE_MODE).catch(() => {}),
      ),
  );
}

async function loadFromDisk(): Promise<AppSettings> {
  preserved = { fields: {}, connections: [] };
  lockedOriginal = undefined;
  const file = paths.settingsFile();
  await ensureDir(path.dirname(file), PRIVATE_DIR_MODE);
  await restrictExistingSettingsFiles(file);
  await protectLegacySettingsBackups();
  let text: string | undefined;
  let original: Buffer | undefined;
  try {
    original = await fs.readFile(file);
    text = new TextDecoder("utf-8", { fatal: true }).decode(original);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  if (text !== undefined) {
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(text.replace(/^﻿/, ""));
    } catch (err) {
      if (text.includes('"_protectedSecrets"')) throw err;
      await archiveSettingsRecovery(
        `${file}.bak-${fileTimestamp()}`,
        original!,
      );
      console.warn(
        "[settings] Damaged settings were retained in encrypted local recovery storage; starting with fresh settings.",
      );
    }
    if (parsed !== undefined) {
      if (
        typeof parsed.version === "number" &&
        parsed.version > SETTINGS_FORMAT_VERSION
      )
        throw new StartupError(
          "DATA_NEWER",
          "Your settings were saved by a newer version of Coherence. Install that version or a later one; nothing was changed.",
        );
      const envelope = parsed._protectedSecrets as
        { version?: unknown } | undefined;
      if (
        envelope &&
        typeof envelope.version === "number" &&
        envelope.version > 1
      )
        throw new StartupError(
          "DATA_NEWER",
          "Your saved keys were stored by a newer version of Coherence. Install that version or a later one; nothing was changed.",
        );
      // A locked/wrong-account protected file is never replaced: start without its keys and write nothing.
      let unlocked: Record<string, unknown> = parsed;
      if (envelope)
        try {
          unlocked = await unprotectSettings(parsed);
        } catch {
          lockedOriginal = original;
          const { _protectedSecrets: _locked, ...withoutKeys } = parsed;
          unlocked = withoutKeys;
          console.warn(
            "[settings] Windows could not unlock the saved keys for this account. Coherence started without them and changed nothing; they can be reset in Settings.",
          );
        }
      // While keys are locked, unsafe legacy endpoints are still disabled, in memory only.
      const migration = await migrateLegacyEndpoints(unlocked, !lockedOriginal);
      preserved = preservedParts(migration.value as Record<string, unknown>);
      const settings = normaliseSettings(migration.value);
      if (migration.changed && !lockedOriginal) {
        await saveSettings(file, settings);
        console.warn(
          "[settings] Unsafe legacy endpoints were disabled. Re-enter their URLs and credentials in Settings. Original URL values are retained only in protected local recovery storage.",
        );
      }
      return settings;
    }
  }
  const fresh = defaultSettings();
  await saveSettings(file, fresh);
  return fresh;
}

async function load(): Promise<AppSettings> {
  if (cache) return cache;
  loading ??= loadFromDisk()
    .then((s) => {
      cache = s;
      return s;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Run a read-modify-write on the settings, serialised and persisted atomically. */
async function mutate<T>(
  fn: (settings: AppSettings) => T | Promise<T>,
): Promise<T> {
  const run = writeChain.then(async () => {
    const current = await load();
    const draft = clone(current);
    const result = await fn(draft);
    draft.revision = (current.revision ?? 0) + 1;
    await saveSettings(paths.settingsFile(), draft);
    cache = draft;
    return result;
  });
  writeChain = run.catch(() => {});
  return run;
}

export async function getSettings(): Promise<AppSettings> {
  const settings = await load();
  rememberCredentials(settings);
  return clone(settings);
}

/* ------------------------------------------------------------------ */
/* Masking                                                             */
/* ------------------------------------------------------------------ */

/** "…a1b2" for secrets long enough that the last 4 characters reveal nothing useful. */
export function secretHint(secret: string | undefined): string | undefined {
  if (!secret) return undefined;
  return secret.length >= 8 ? `…${secret.slice(-4)}` : undefined;
}

export function toPublicConnection(c: ProviderConnection): PublicLLMConnection {
  const { apiKey, ...raw } = c;
  const fields = new Set([
    "id",
    "name",
    "provider",
    "model",
    "modelIds",
    "visibleModelIds",
    "manualModelIds",
    "presetId",
    "baseUrl",
    "azureApiVersion",
    "effort",
    "maxOutputTokens",
    "temperature",
    "concurrency",
    "requestTimeoutSec",
    "structuredOutput",
    "vision",
    "refusalFallback",
    "createdAt",
    "updatedAt",
  ]);
  const rest = {
    ...Object.fromEntries(
      Object.entries(raw).filter(([key]) => fields.has(key)),
    ),
    baseUrl: publicEndpoint(raw.baseUrl),
  } as Omit<ProviderConnection, "apiKey">;
  if (apiKey)
    return { ...rest, hasApiKey: true, apiKeyHint: secretHint(apiKey) };
  // No stored key, but the LLM layer will use the provider's env var — tell the UI the key is covered.
  const envVar = PROVIDER_PRESETS[c.provider]?.apiKeyEnvVar;
  if (envVar && mayUseEnvironmentKey(c) && envKey(c.provider))
    return { ...rest, hasApiKey: true, apiKeyHint: `from ${envVar}` };
  return { ...rest, hasApiKey: false };
}

function toPublicIntegration<T extends object>(
  settings: T,
  secretField: string,
): PublicIntegration<T> {
  const secret = (settings as Record<string, unknown>)[secretField];
  const value = typeof secret === "string" ? secret : "";
  const safe = { ...settings } as Record<string, unknown>;
  for (const key of Object.keys(safe))
    if (
      /^(apiKey|apiToken|token|pat|authorization|headers|request|response|_protectedSecrets)$/i.test(
        key,
      )
    )
      delete safe[key];
  for (const key of ["baseUrl", "orgUrl", "apiBaseUrl"])
    if (typeof safe[key] === "string")
      safe[key] = publicEndpoint(safe[key] as string);
  return {
    ...(safe as T),
    [secretField]: "",
    hasSecret: value.length > 0,
    secretHint: secretHint(value),
  };
}

/** Secrets stripped; see PublicSettings. */
export async function getPublicSettings(): Promise<PublicSettings> {
  const s = await load();
  rememberCredentials(s);
  const integrations: PublicSettings["integrations"] = {};
  if (s.integrations.jira)
    integrations.jira = toPublicIntegration(
      s.integrations.jira,
      INTEGRATION_SECRET_FIELD.jira,
    );
  if (s.integrations.azdo)
    integrations.azdo = toPublicIntegration(
      s.integrations.azdo,
      INTEGRATION_SECRET_FIELD.azdo,
    );
  if (s.integrations.github)
    integrations.github = toPublicIntegration(
      s.integrations.github,
      INTEGRATION_SECRET_FIELD.github,
    );

  const storedFigma = s.figma?.token;
  const envFigma = process.env.SCREENSCRIBE_V2_FIGMA_TOKEN?.trim();
  const figma = storedFigma
    ? { hasToken: true, tokenHint: secretHint(storedFigma) }
    : envFigma
      ? { hasToken: true, tokenHint: "from SCREENSCRIBE_V2_FIGMA_TOKEN" }
      : { hasToken: false };

  return {
    ...(savedKeysLocked() ? { keysLocked: true } : {}),
    connections: await Promise.all(
      s.connections.map(async (c) => {
        const catalogue =
          c.provider === "mock" ? undefined : await cachedCatalogue(c);
        return {
          ...toPublicConnection(c),
          ...(catalogue ? { catalogue } : {}),
          ...(c.provider !== "mock"
            ? { capabilities: await cachedCapabilities(c) }
            : {}),
        };
      }),
    ),
    revision: s.revision ?? 0,
    preferences: s.preferences,
    defaultConnectionId: s.defaultConnectionId,
    analysisDefaults: analysisModelDefaults(s.analysisDefaults, s.connections),
    integrations,
    figma,
    dataDir: config.dataDir,
    settingsPath: paths.settingsFile(),
  };
}

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

const optionalText = (value: string | undefined | null): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

function checkBaseUrl(value: string, providerLabel: string): string {
  validateEndpoint(value, { localModel: true });
  return value.replace(/\/+$/, "");
}

/** "https://API.example.com/v1/" and "https://api.example.com/v1" are the same endpoint. */
function normaliseUrl(value: string): string {
  const trimmed = value.trim();
  try {
    return new URL(trimmed).href.replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

/** Where a connection's requests go: its base URL, else the provider's default. */
function connectionEndpoint(
  provider: ProviderKind,
  baseUrl: string | undefined,
): string {
  return normaliseUrl(
    optionalText(baseUrl) ?? PROVIDER_PRESETS[provider].defaultBaseUrl ?? "",
  );
}

/**
 * The stored API key of `existing`, when the form left the key empty, for a request to `baseUrl`.
 * A stored secret is only ever sent to the endpoint it was saved for: otherwise anything that can call the API
 * could point "Test" / "List models" at its own server and read the key. A different provider gets no key
 * (it belongs to another vendor); a different URL must re-enter it.
 * @throws BadRequestError when the endpoint changed and a stored key would otherwise be reused.
 */
export function reusableApiKey(
  existing: ProviderConnection | undefined,
  provider: ProviderKind,
  baseUrl: string | undefined,
): string | undefined {
  if (!existing?.apiKey || existing.provider !== provider) return undefined;
  if (
    connectionEndpoint(provider, baseUrl) !==
    connectionEndpoint(existing.provider, existing.baseUrl)
  ) {
    throw new BadRequestError(
      "Re-enter the API key to use a different base URL — the saved key is only sent to the URL it was saved with.",
    );
  }
  return existing.apiKey;
}

/**
 * Builds a full connection from form input, applying the provider preset's defaults.
 * PUT semantics: optional fields that are omitted fall back to defaults — except the API key, which is
 * kept when omitted/"" (unless the provider changed or clearApiKey is set; a changed base URL needs the key again).
 */
function buildConnection(
  input: ConnectionInput,
  existing?: ProviderConnection,
): ProviderConnection {
  if (!isProviderKind(input.provider))
    throw new BadRequestError(
      `Unknown AI provider "${String(input.provider)}".`,
    );
  const preset = PROVIDER_PRESETS[input.provider];
  const timestamp = now();

  const modelIds =
    input.provider === "mock"
      ? [preset.defaultModel]
      : [
          ...new Set(
            input.modelIds ??
              (optionalText(input.model)
                ? [input.model!.trim()]
                : (existing?.modelIds ?? [])),
          ),
        ];
  if (modelIds.length > 200 || !modelIds.every(validModelId))
    throw new BadRequestError(
      "Enter model IDs without control characters, up to 300 characters each (maximum 200 IDs).",
    );
  if (input.presetId && input.provider !== "openai-compatible")
    throw new BadRequestError(
      "LM Studio requires an OpenAI-compatible provider account.",
    );
  const subset = (
    values: string[] | undefined,
    previous: string[] | undefined,
  ) => {
    if (
      values &&
      (values.length > 200 ||
        !values.every((id) => validModelId(id) && modelIds.includes(id)))
    )
      throw new BadRequestError(
        "Visible and manual model IDs must be configured on this connection.",
      );
    return values
      ? [...new Set(values)]
      : previous?.filter((id) => modelIds.includes(id));
  };

  let baseUrl = optionalText(input.baseUrl);
  if (!baseUrl && preset.baseUrlRequired) baseUrl = preset.defaultBaseUrl;
  if (!baseUrl && preset.baseUrlRequired) {
    throw new BadRequestError(
      `${preset.label} needs a base URL${preset.baseUrlHint ? ` (${preset.baseUrlHint})` : ""}.`,
    );
  }
  if (baseUrl) baseUrl = checkBaseUrl(baseUrl, preset.label);

  let apiKey: string | undefined;
  if (!input.clearApiKey) {
    apiKey =
      optionalText(input.apiKey) ??
      reusableApiKey(existing, input.provider, baseUrl);
  }

  rememberCredentials({ apiKey });
  validateProviderEndpoint({ provider: input.provider, baseUrl, apiKey });

  let effort: Effort | undefined;
  if (preset.supportsEffort) {
    const allowed = preset.effortLevels ?? [];
    if (input.effort && !allowed.includes(input.effort)) {
      throw new BadRequestError(
        `${preset.label} supports effort ${allowed.join(", ")} — "${input.effort}" is not one of them.`,
      );
    }
    effort = input.effort ?? preset.defaultEffort;
  }

  const positiveInt = (
    value: number | undefined | null,
    what: string,
  ): number | undefined => {
    if (value === undefined || value === null) return undefined;
    if (!Number.isInteger(value) || value <= 0)
      throw new BadRequestError(`${what} must be a whole number above 0.`);
    return value;
  };

  const temperature = input.temperature ?? undefined;
  if (
    temperature !== undefined &&
    (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
  ) {
    throw new BadRequestError("Temperature must be between 0 and 2.");
  }

  return {
    id: existing?.id ?? newConnectionId(),
    name: optionalText(input.name) ?? preset.label,
    provider: input.provider,
    ...(optionalText(input.model)
      ? { model: input.model!.trim() }
      : existing?.model !== undefined
        ? { model: existing.model }
        : {}),
    modelIds,
    visibleModelIds: subset(input.visibleModelIds, existing?.visibleModelIds),
    manualModelIds: subset(input.manualModelIds, existing?.manualModelIds),
    presetId:
      input.provider === "openai-compatible" ? input.presetId : undefined,
    baseUrl,
    apiKey,
    azureApiVersion:
      input.provider === "azure-openai"
        ? optionalText(input.azureApiVersion)
        : undefined,
    effort,
    maxOutputTokens: positiveInt(input.maxOutputTokens, "Max output tokens"),
    temperature: preset.supportsTemperature ? temperature : undefined,
    concurrency:
      positiveInt(input.concurrency, "Concurrency") ??
      preset.defaultConcurrency,
    requestTimeoutSec:
      positiveInt(input.requestTimeoutSec, "Request timeout") ??
      preset.defaultTimeoutSec,
    structuredOutput: input.structuredOutput ?? "auto",
    vision: input.vision ?? "auto",
    refusalFallback: preset.supportsRefusalFallback
      ? (input.refusalFallback ?? true)
      : false,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

/** Removes undefined keys so settings.json stays tidy. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}

/** Applies preset defaults (concurrency, timeout, structuredOutput 'auto', vision 'auto', refusalFallback true for anthropic). */
export async function createConnection(
  input: ConnectionInput,
): Promise<ProviderConnection> {
  const connection = compact(buildConnection(input));
  return mutate((s) => {
    const isFirstReal =
      connection.provider !== "mock" &&
      !s.connections.some((c) => c.provider !== "mock");
    s.connections.push(connection);
    // The first real connection replaces the offline demo as the default — that is what a BA expects
    // after "Connect an AI model". Later additions leave the BA's chosen default alone.
    const current = s.connections.find((c) => c.id === s.defaultConnectionId);
    if (!current || (isFirstReal && current.provider === "mock"))
      s.defaultConnectionId = connection.id;
    return clone(connection);
  });
}

/** Omitted/"" apiKey keeps the stored key; clearApiKey removes it. @throws NotFoundError */
export async function updateConnection(
  id: string,
  input: ConnectionInput,
): Promise<ProviderConnection> {
  return mutate((s) => {
    const index = s.connections.findIndex((c) => c.id === id);
    if (index < 0)
      throw new NotFoundError(
        "That AI connection no longer exists. Refresh the page.",
      );
    const updated = compact(buildConnection(input, s.connections[index]));
    s.connections[index] = updated;
    return clone(updated);
  });
}

/** Updates only connection metadata/default; saved project references remain dangling and fail closed. */
export async function deleteConnection(id: string): Promise<void> {
  await mutate((s) => {
    if (!s.connections.some((c) => c.id === id))
      throw new NotFoundError(
        "That AI connection no longer exists. Refresh the page.",
      );
    s.connections = s.connections.filter((c) => c.id !== id);
    if (
      s.defaultConnectionId === id ||
      !s.connections.some((c) => c.id === s.defaultConnectionId)
    ) {
      s.defaultConnectionId = pickDefaultConnectionId(s.connections);
    }
  });
}

/** @throws NotFoundError */
export async function getConnection(id: string): Promise<ProviderConnection> {
  const s = await load();
  rememberCredentials(s);
  const connection = s.connections.find((c) => c.id === id);
  if (!connection)
    throw new NotFoundError(
      `AI connection "${id}" was not found — it may have been deleted. Pick another one in Settings.`,
    );
  return clone(connection);
}

export async function setDefaultConnection(id: string): Promise<void> {
  await mutate((s) => {
    if (!s.connections.some((c) => c.id === id))
      throw new NotFoundError(
        "That AI connection no longer exists. Refresh the page.",
      );
    s.defaultConnectionId = id;
  });
}

/** One Settings Save is a single validated, protected, atomic disk write. */
export async function replaceWorkspaceSettings(input: {
  baseRevision: number;
  connections: (ConnectionInput & { id: string })[];
  defaultConnectionId: string;
  analysisDefaults?: AnalysisModelDefaults;
  integrations: IntegrationInput[];
  figmaToken?: string;
  clearFigma?: boolean;
  preferences: Record<string, string | boolean>;
}): Promise<PublicSettings> {
  await mutate(async (s) => {
    if ((s.revision ?? 0) !== input.baseRevision)
      throw new ConflictError(
        "Settings changed in another window. Reopen Settings before saving this draft.",
      );
    const ids = new Set(input.connections.map((c) => c.id));
    if (ids.size !== input.connections.length)
      throw new BadRequestError("Connection IDs must be unique.");
    const connections = input.connections.map((c) => ({
      ...compact(
        buildConnection(
          c,
          s.connections.find((v) => v.id === c.id),
        ),
      ),
      id: c.id,
    }));
    if (!ids.has(input.defaultConnectionId))
      throw new BadRequestError("Choose an existing default connection.");
    if (input.analysisDefaults !== undefined) {
      const current = analysisModelDefaults(s.analysisDefaults, s.connections);
      const next = analysisModelDefaults(input.analysisDefaults, connections);
      // Unchanged stale defaults must not block unrelated Settings saves or be silently repaired. A default whose
      // connection this very save removes must be dealt with explicitly, though (owner test note 6).
      const removesDefault = [
        next.visionConnectionId,
        next.textConnectionId,
      ].some((id) => !ids.has(id) && s.connections.some((c) => c.id === id));
      if (removesDefault || !sameAnalysisDefaults(current, next)) {
        const selected = await Promise.all(
          connections
            .filter((c) =>
              [next.visionConnectionId, next.textConnectionId].includes(c.id),
            )
            .map(async (c) => ({
              ...c,
              capabilities: await cachedCapabilities(c),
              catalogue: await cachedCatalogue(c),
            })),
        );
        const issue =
          defaultRoleIssue(next, selected, true) ??
          defaultRoleIssue(next, selected, false);
        if (issue) throw new BadRequestError(issue);
      }
      s.analysisDefaults = next;
    }
    const integrations: IntegrationSettings = {};
    for (const item of input.integrations) {
      const merged = mergeIntegration(item, s.integrations);
      Object.assign(integrations, { [item.system]: merged });
    }
    s.connections = connections;
    s.defaultConnectionId = input.defaultConnectionId;
    s.integrations = integrations;
    s.preferences = input.preferences;
    if (input.clearFigma) s.figma = undefined;
    else if (input.figmaToken?.trim())
      s.figma = { token: input.figmaToken.trim() };
  });
  return getPublicSettings();
}

/**
 * Build a full ProviderConnection from form input without saving it (for "Test" / "List models").
 * When existingId is given and input.apiKey is empty, the stored key of that connection is used — for its saved
 * endpoint only (see reusableApiKey).
 */
export async function resolveConnectionInput(
  input: ConnectionInput,
  existingId?: string,
): Promise<ProviderConnection> {
  let existing: ProviderConnection | undefined;
  if (existingId) existing = await getConnection(existingId);
  const built = buildConnection(input, existing);
  // Unsaved connections get a recognisable id so provider caches never collide with stored ones.
  return compact(
    existing ? built : { ...built, id: `conn_unsaved_${nanoid(6)}` },
  );
}

/* ------------------------------------------------------------------ */
/* Integrations                                                        */
/* ------------------------------------------------------------------ */

type AnyIntegration = JiraSettings | AzdoSettings | GitHubSettings;

const cleanList = (items: string[] | undefined): string[] => [
  ...new Set((items ?? []).map((x) => x.trim()).filter(Boolean)),
];

const GITHUB_API_URL = "https://api.github.com";

const trimUrl = (value: string): string => value.trim().replace(/\/+$/, "");

/**
 * The stored secret, when the form left it empty — only for the URL it was saved with (same reason as
 * reusableApiKey: a test against another URL would hand the token to that server).
 */
function storedSecret(
  system: ExternalSystem,
  stored: { url: string; secret: string } | undefined,
  url: string,
): string | undefined {
  if (!stored?.secret) return undefined;
  if (normaliseUrl(stored.url) !== normaliseUrl(url)) {
    throw new BadRequestError(
      `Re-enter the ${SECRET_LABEL[system]} to use a different URL — the saved one is only sent to the URL it was saved with.`,
    );
  }
  return stored.secret;
}

/** Strips `system`, trims values and fills the secret from storage when the form left it empty. */
function mergeIntegration(
  input: IntegrationInput,
  stored: IntegrationSettings,
): AnyIntegration {
  switch (input.system) {
    case "jira": {
      const { system: _system, apiToken, ...rest } = input;
      const baseUrl = trimUrl(rest.baseUrl);
      validateEndpoint(baseUrl, { credentialed: true });
      const saved = stored.jira && {
        url: stored.jira.baseUrl,
        secret: stored.jira.apiToken,
      };
      return compact<JiraSettings>({
        ...rest,
        baseUrl,
        email: rest.email.trim(),
        projectKey: rest.projectKey.trim(),
        issueType: rest.issueType.trim() || "Story",
        epicIssueType: rest.epicIssueType.trim() || "Epic",
        labels: cleanList(rest.labels),
        linkType: rest.linkType.trim() || "Blocks",
        storyPointsFieldId: optionalText(rest.storyPointsFieldId),
        apiToken:
          optionalText(apiToken) ?? storedSecret("jira", saved, baseUrl) ?? "",
      });
    }
    case "azdo": {
      const { system: _system, pat, ...rest } = input;
      const orgUrl = trimUrl(rest.orgUrl);
      validateEndpoint(orgUrl, { credentialed: true });
      const saved = stored.azdo && {
        url: stored.azdo.orgUrl,
        secret: stored.azdo.pat,
      };
      return compact<AzdoSettings>({
        ...rest,
        orgUrl,
        project: rest.project.trim(),
        workItemType: rest.workItemType.trim() || "User Story",
        parentWorkItemType: rest.parentWorkItemType.trim() || "Feature",
        areaPath: optionalText(rest.areaPath),
        iterationPath: optionalText(rest.iterationPath),
        tags: cleanList(rest.tags),
        pat: optionalText(pat) ?? storedSecret("azdo", saved, orgUrl) ?? "",
      });
    }
    case "github": {
      const { system: _system, token, ...rest } = input;
      const apiBaseUrl = trimUrl(rest.apiBaseUrl || GITHUB_API_URL);
      validateEndpoint(apiBaseUrl, { credentialed: true });
      const saved = stored.github && {
        url: stored.github.apiBaseUrl || GITHUB_API_URL,
        secret: stored.github.token,
      };
      return compact<GitHubSettings>({
        ...rest,
        owner: rest.owner.trim(),
        repo: rest.repo.trim(),
        labels: cleanList(rest.labels),
        apiBaseUrl,
        token:
          optionalText(token) ??
          storedSecret("github", saved, apiBaseUrl) ??
          "",
      });
    }
    default: {
      const system: never = input;
      throw new BadRequestError(
        `Unknown integration "${String((system as { system?: string }).system)}".`,
      );
    }
  }
}

function secretOf(system: ExternalSystem, settings: AnyIntegration): string {
  return String(
    (settings as unknown as Record<string, unknown>)[
      INTEGRATION_SECRET_FIELD[system]
    ] ?? "",
  );
}

const SECRET_LABEL: Record<ExternalSystem, string> = {
  jira: "Jira API token",
  azdo: "Azure DevOps personal access token",
  github: "GitHub token",
};

/** Omitted/"" secret keeps the stored one. */
export async function setIntegration(input: IntegrationInput): Promise<void> {
  await mutate((s) => {
    const merged = mergeIntegration(input, s.integrations);
    if (!secretOf(input.system, merged))
      throw new BadRequestError(
        `Enter the ${SECRET_LABEL[input.system]} before saving.`,
      );
    switch (input.system) {
      case "jira":
        s.integrations.jira = merged as JiraSettings;
        break;
      case "azdo":
        s.integrations.azdo = merged as AzdoSettings;
        break;
      case "github":
        s.integrations.github = merged as GitHubSettings;
        break;
    }
  });
}

export async function deleteIntegration(system: ExternalSystem): Promise<void> {
  await mutate((s) => {
    delete s.integrations[system];
  });
}

export async function getIntegration<S extends ExternalSystem>(
  system: S,
): Promise<IntegrationSettings[S] | undefined> {
  const s = await load();
  rememberCredentials(s);
  const value = s.integrations[system];
  return value ? clone(value) : undefined;
}

/** Merge form input with the stored secret (for "Test" before saving). */
export async function resolveIntegrationInput(
  input: IntegrationInput,
): Promise<JiraSettings | AzdoSettings | GitHubSettings> {
  const s = await load();
  rememberCredentials(s);
  const merged = mergeIntegration(input, s.integrations);
  if (!secretOf(input.system, merged)) {
    throw new BadRequestError(
      `Enter the ${SECRET_LABEL[input.system]} to test the ${EXTERNAL_SYSTEM_LABEL[input.system]} connection.`,
    );
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* Figma                                                               */
/* ------------------------------------------------------------------ */

export async function setFigmaToken(token: string): Promise<void> {
  const value = token.trim();
  if (!value) throw new BadRequestError("Paste a Figma personal access token.");
  await mutate((s) => {
    s.figma = { token: value };
  });
}

export async function deleteFigmaToken(): Promise<void> {
  await mutate((s) => {
    delete s.figma;
  });
}

/** Stored token, else SCREENSCRIBE_V2_FIGMA_TOKEN env var, else undefined. */
export async function getFigmaToken(): Promise<string | undefined> {
  const s = await load();
  rememberCredentials(s);
  return (
    s.figma?.token ||
    process.env.SCREENSCRIBE_V2_FIGMA_TOKEN?.trim() ||
    undefined
  );
}
