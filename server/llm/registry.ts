/**
 * OWNER: llm builder.
 * Provider factory, connection resolution and connection tests.
 */
import { createHash } from "node:crypto";
import { redactDiagnostic } from "../security/diagnostics";
import { loadSharp } from "./sharpLoader";
import type {
  ListModelsRequest,
  ListModelsResponse,
  TestConnectionResponse,
} from "@shared/api";
import { PROVIDER_PRESETS } from "@shared/providers";
import { recognisedService } from "@shared/compatibleServices";
import type { LLMConnection, ProviderConnection } from "@shared/types";
import {
  OFFLINE_MODEL_ID,
  validModelId,
  imageInputEvidence,
} from "@shared/modelSelection";
import { BadRequestError, NotFoundError, errorMessage } from "../errors";
import {
  getConnection,
  getSettings,
  reusableApiKey,
} from "../storage/settingsStore";
import { AnthropicProvider } from "./providers/anthropic";
import { GeminiProvider } from "./providers/gemini";
import { MockProvider } from "./providers/mock";
import { OllamaProvider } from "./providers/ollama";
import { OpenAIProvider, treatAsReasoningModel } from "./providers/openai";
import type { LLMProvider, LLMResponse } from "./types";
import { checkServiceKey, discoverCatalogue } from "./catalogue";
import { resolveVision } from "./vision";

/** Build a fresh adapter (no caching) — used for tests and model listing with unsaved settings. */
export function instantiateProvider(connection: LLMConnection): LLMProvider {
  const vision = resolveVision(connection);
  switch (connection.provider) {
    case "anthropic":
      return new AnthropicProvider(connection, vision);
    case "openai":
    case "azure-openai":
    case "openai-compatible":
      return new OpenAIProvider(connection, vision);
    case "gemini":
      return new GeminiProvider(connection, vision);
    case "ollama":
      return new OllamaProvider(connection, vision);
    case "mock":
      return new MockProvider(connection);
  }
}

/**
 * Everything that changes adapter behaviour. updatedAt alone is not enough: an unsaved connection built
 * for "Test" can reuse a stored id. Hashed to keep the cache key compact and free of the raw API key.
 */
export function providerFingerprint(c: LLMConnection): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        c.updatedAt,
        c.provider,
        c.model,
        c.baseUrl ?? "",
        c.apiKey ?? "",
        c.azureApiVersion ?? "",
        c.effort ?? "",
        c.maxOutputTokens ?? "",
        c.modelContextWindow,
        c.modelInputTokenLimit,
        c.modelOutputTokenLimit,
        c.modelFactsAt,
        c.modelStructuredMode,
        c.modelReasoning,
        c.temperature ?? "",
        c.requestTimeoutSec,
        c.structuredOutput,
        c.vision,
        c.refusalFallback,
      ]),
    )
    .digest("hex");
}

/** Least recently used first (Map insertion order). */
const providers = new Map<string, LLMProvider>();
const MAX_CACHED_PROVIDERS = 32;

/**
 * Instantiate the adapter for a connection, cached per connection id + fingerprint. Jobs keep the
 * connection version they started with, so two versions of one connection can be in use at once: each
 * keeps its own adapter (and what it learned about the endpoint) instead of replacing the other's.
 */
export function createProvider(connection: LLMConnection): LLMProvider {
  const key = `${connection.id}|${providerFingerprint(connection)}`;
  const cached = providers.get(key);
  if (cached) {
    providers.delete(key);
    providers.set(key, cached);
    return cached;
  }
  const provider = instantiateProvider(connection);
  providers.set(key, provider);
  if (providers.size > MAX_CACHED_PROVIDERS)
    providers.delete(providers.keys().next().value!);
  return provider;
}

/**
 * Resolve a connection id (or undefined → settings.defaultConnectionId → first connection).
 * @throws BadRequestError "No AI connection configured — add one in Settings" when none exist.
 * @throws NotFoundError when the id does not exist.
 */
export async function resolveConnection(
  connectionId?: string,
): Promise<ProviderConnection> {
  const settings = await getSettings();
  if (connectionId) {
    const found = settings.connections.find((c) => c.id === connectionId);
    if (!found) {
      throw new NotFoundError(
        `The selected AI connection no longer exists (${connectionId}). Choose another connection in the project overview or Settings.`,
      );
    }
    return found;
  }
  if (!settings.connections.length)
    throw new BadRequestError(
      "No AI connection configured — add one in Settings",
    );
  return (
    settings.connections.find((c) => c.id === settings.defaultConnectionId) ??
    settings.connections[0]
  );
}

/** "anthropic/claude-opus-5-5" — used in logs, model.generator and ImpactReport.analysedBy. */
export function connectionLabel(connection: LLMConnection): string {
  const model = connection.model || "unselected-model";
  return `${connection.provider}/${model}`;
}

/** Sole account/model composition point; legacy model metadata is never an execution fallback. */
export function resolveModelSelection(
  connection: ProviderConnection,
  modelId: string | undefined,
  options: {
    reading?: boolean;
    acknowledged?: boolean;
    test?: boolean;
    reportedVision?: boolean;
    imageEvidence?: import("@shared/modelCapabilities").EvidenceState;
    textEvidence?: import("@shared/modelCapabilities").EvidenceState;
    modelOutputTokenLimit?: number;
  } = {},
): LLMConnection {
  if (connection.provider === "mock") {
    if (modelId && modelId !== OFFLINE_MODEL_ID)
      throw new BadRequestError(
        "Offline demo has one built-in simulated model. Choose Offline demo again.",
      );
    return { ...connection, model: OFFLINE_MODEL_ID };
  }
  if (!validModelId(modelId))
    throw new BadRequestError(
      "Choose an exact model ID for this connection in Analysis before continuing. No replacement model was selected.",
    );
  if (!options.test && !connection.modelIds.includes(modelId))
    throw new BadRequestError(
      "The selected model ID is no longer configured on this connection. Add it in Settings or explicitly select another model. No replacement was selected.",
    );
  if (
    !options.test &&
    !options.reading &&
    options.textEvidence === "unsupported"
  )
    throw new BadRequestError(
      "The selected writing model is reported as unable to generate text. Choose a text model; no replacement was selected.",
    );
  const configuredEvidence = imageInputEvidence(
    connection.provider,
    modelId,
    connection.vision,
    options.reportedVision,
  );
  const evidence =
    connection.vision === "no"
      ? "unsupported"
      : (options.imageEvidence ??
        (options.reportedVision === false
          ? "unsupported"
          : configuredEvidence === "provider-suggested" ||
              configuredEvidence === "user-declared"
            ? "unknown"
            : configuredEvidence));
  if (options.reading && evidence === "unsupported")
    throw new BadRequestError(
      "The selected reading model is configured as text-only. Select an image-input model.",
    );
  if (
    options.reading &&
    evidence === "unknown" &&
    !options.acknowledged &&
    connection.vision !== "yes"
  )
    throw new BadRequestError(
      "Image input is unverified for this model. Confirm that it accepts screenshots in Analysis, or explicitly test/select another model.",
    );
  return {
    ...connection,
    model: modelId,
    modelOutputTokenLimit: options.modelOutputTokenLimit,
    vision: options.reading
      ? "yes"
      : evidence === "unsupported"
        ? "no"
        : connection.vision === "auto"
          ? evidence === "tested" || evidence === "provider-reported"
            ? "yes"
            : "no"
          : connection.vision,
    // Exact project model identity excludes provider-side automatic model substitution.
    refusalFallback: false,
  };
}

/** connection.vision resolved against the provider preset. */
export function connectionSupportsVision(connection: LLMConnection): boolean {
  return resolveVision(connection);
}

/* ------------------------------------------------------------------ */
/* Connection test                                                     */
/* ------------------------------------------------------------------ */

/** A test should not hang for the full (possibly 30-minute) generation timeout. */
const TEST_TIMEOUT_CAP_SEC = 180;

/** Solid red square for the vision round-trip. Local VLMs (Qwen-VL…) reject images below ~28 px. */
async function testImage(connection: LLMConnection): Promise<string> {
  const size =
    connection.provider === "ollama" ||
    connection.provider === "openai-compatible"
      ? 64
      : 16;
  const sharp = await loadSharp();
  const png = await sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: { r: 220, g: 20, b: 20 },
    },
  })
    .png()
    .toBuffer();
  return png.toString("base64");
}

function testTokens(connection: LLMConnection): number {
  // Reasoning models spend tokens thinking before they answer even trivial prompts.
  if (
    connection.provider === "ollama" ||
    connection.provider === "openai-compatible"
  )
    return 256;
  if (
    (connection.provider === "openai" ||
      connection.provider === "azure-openai") &&
    treatAsReasoningModel(connection)
  )
    return 4096;
  return 1024;
}

/** Tiny text round-trip, then a tiny image round-trip if vision is expected. Never throws. */
export async function testConnection(
  connection: LLMConnection,
): Promise<TestConnectionResponse> {
  const started = Date.now();
  try {
    if (connection.provider === "mock") {
      return {
        ok: true,
        message:
          "Offline demo connection — no AI model is called; specs are generated from screen names and BA notes.",
        latencyMs: 0,
        model: connection.model || "demo",
        visionOk: true,
      };
    }
    const testConn: LLMConnection = {
      ...connection,
      requestTimeoutSec: Math.min(
        connection.requestTimeoutSec || TEST_TIMEOUT_CAP_SEC,
        TEST_TIMEOUT_CAP_SEC,
      ),
    };
    const provider = instantiateProvider(testConn);
    const maxOutputTokens = testTokens(connection);

    const text: LLMResponse = await provider.complete({
      system: "You are a connectivity check. Follow the instruction exactly.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Reply with the single word OK" }],
        },
      ],
      maxOutputTokens,
      purpose: "connection-test",
    });
    const latencyMs = Date.now() - started;
    // Connection checks are diagnostics, not a channel for arbitrary successful response excerpts.
    const diagnosticModel =
      text.model === connection.model
        ? redactDiagnostic(text.model)
        : undefined;
    if (text.stopReason === "refusal") {
      return {
        ok: false,
        message:
          "The model declined the connection test. Response details were withheld.",
        latencyMs,
        model: diagnosticModel,
      };
    }
    let message = `Connected to ${redactDiagnostic(connectionLabel(connection))} in ${latencyMs} ms.`;

    if (!provider.supportsVision) {
      return {
        ok: true,
        message: `${message} Image reading is off for this connection.`,
        latencyMs,
        model: diagnosticModel,
      };
    }

    let visionOk: boolean;
    try {
      const image = await provider.complete({
        system: "You are a connectivity check. Follow the instruction exactly.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                image: {
                  mimeType: "image/png",
                  base64: await testImage(connection),
                },
              },
              {
                type: "text",
                text: "What is the dominant colour of this image? Reply with one word.",
              },
            ],
          },
        ],
        maxOutputTokens,
        purpose: "connection-test:vision",
      });
      const answer = image.text.trim();
      visionOk = /red|crimson|scarlet|rouge|rot|rojo/i.test(answer);
      message += visionOk
        ? " Image test passed."
        : " The model did not identify the red test image. Check that the model supports image reading.";
    } catch (err) {
      visionOk = false;
      message += ` The image test failed: ${errorMessage(err)} Pick a vision model or set Vision to "No".`;
    }
    return {
      ok: true,
      message,
      latencyMs: Date.now() - started,
      model: diagnosticModel,
      visionOk,
    };
  } catch (err) {
    return {
      ok: false,
      message: errorMessage(err),
      latencyMs: Date.now() - started,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Model listing                                                       */
/* ------------------------------------------------------------------ */

/** Never throws: on failure returns { models: [], error }. */
/** The same server's address plus /v1, when the address does not end in /v1 already. */
function v1Address(baseUrl: string | undefined): string | undefined {
  try {
    const url = new URL(baseUrl ?? "");
    const path = url.pathname.replace(/\/+$/, "");
    return /\/v1$/i.test(path) ? undefined : `${url.origin}${path}/v1`;
  } catch {
    return undefined;
  }
}

function notTheApi(alternative?: string, tried = false): string {
  return tried
    ? `This address isn't the service's API, and neither is ${alternative}. Check the service's documentation for its API address; it usually ends in /v1.`
    : `This address isn't the service's API: it didn't answer with a model list. API addresses usually end in /v1${alternative ? `. Try ${alternative}` : ", for example https://openrouter.ai/api/v1"}.`;
}

/**
 * Lists the models of a connection being set up. For OpenAI-compatible services (owner test notes 2 and 3) it also
 * tries the same server's /v1 address once when the entered one is not the API, explains failures in plain words,
 * and runs a recognised service's documented key check. `savedKey`: the key came from storage, so it is only ever
 * sent to the address it was saved with.
 */
export async function listModelsFor(
  req: ListModelsRequest,
  opts: { savedKey?: boolean } = {},
): Promise<ListModelsResponse> {
  try {
    const preset = PROVIDER_PRESETS[req.provider];
    let apiKey = req.apiKey?.trim() || undefined;
    let baseUrl = req.baseUrl?.trim() || undefined;
    let azureApiVersion = req.azureApiVersion?.trim() || undefined;
    let presetId = req.presetId;
    if (req.connectionId) {
      const stored = await getConnection(req.connectionId);
      if (stored.provider === req.provider) {
        baseUrl ??= stored.baseUrl || undefined;
        if (!req.clearApiKey)
          apiKey ??= reusableApiKey(stored, req.provider, baseUrl);
        azureApiVersion ??= stored.azureApiVersion || undefined;
        if (presetId === undefined) presetId = stored.presetId;
      }
    }
    const now = new Date().toISOString();
    const connection: ProviderConnection = {
      id: req.connectionId ?? "conn_list_models",
      name: preset.label,
      provider: req.provider,
      modelIds: [],
      presetId: presetId ?? undefined,
      baseUrl: baseUrl ?? preset.defaultBaseUrl,
      apiKey: req.clearApiKey ? undefined : apiKey,
      azureApiVersion:
        req.provider === "azure-openai" ? azureApiVersion : undefined,
      concurrency: 1,
      requestTimeoutSec: 30,
      structuredOutput: "auto",
      vision: "auto",
      refusalFallback: false,
      createdAt: now,
      updatedAt: now,
    };
    let result = await discoverCatalogue(connection);
    if (connection.provider !== "openai-compatible") return result;
    const savedKey = opts.savedKey || (!req.apiKey?.trim() && !!apiKey);
    // A cached list from earlier does not make this address the API.
    const missing =
      result.errorCode === "unsupported" || result.errorCode === "malformed";
    const alternative = missing ? v1Address(connection.baseUrl) : undefined;
    if (alternative && !savedKey) {
      const second = await discoverCatalogue({
        ...connection,
        baseUrl: alternative,
      });
      result = second.error
        ? { ...result, error: notTheApi(alternative, true) }
        : { ...second, baseUrl: alternative };
    } else if (missing) result = { ...result, error: notTheApi(alternative) };
    else if (result.errorCode === "auth")
      result = {
        ...result,
        error: connection.apiKey
          ? "The service refused the API key. Check the key, then find models again."
          : "The service needs an API key. Enter it, then find models again.",
      };
    if (!result.error) {
      const answered = result.baseUrl ?? connection.baseUrl;
      const service = recognisedService(answered);
      if (service?.keyCheckPath) {
        const keyCheck = connection.apiKey
          ? await checkServiceKey(
              { ...connection, baseUrl: answered },
              service.keyCheckPath,
            )
          : "missing";
        if (keyCheck) result = { ...result, keyCheck };
      }
    }
    return result;
  } catch (err) {
    return { models: [], error: errorMessage(err) };
  }
}
