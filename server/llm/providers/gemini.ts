/**
 * Google Gemini adapter — @google/genai generateContentStream (generateContent where an endpoint cannot stream).
 * Native structured output: responseMimeType application/json + responseJsonSchema; if the endpoint
 * rejects that field we fall back once to the older responseSchema (OpenAPI subset, no $ref).
 */
import { listCatalogueModels } from "../catalogue";
import { ApiError, FinishReason, GoogleGenAI } from "@google/genai";
import type {
  Content,
  GenerateContentConfig,
  GenerateContentResponse,
  Part,
} from "@google/genai";
import { PROVIDER_PRESETS } from "@shared/providers";
import { providerFetch, providerEndpoint } from "../../security/endpointPolicy";
import type { LLMConnection } from "@shared/types";
import { CancelledError } from "../../errors";
import { ProviderError, cleanProviderMessage, isAbortError } from "../errors";
import { inlineRefs } from "../schema";
import type {
  LLMContentPart,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStopReason,
  ModelInfo,
} from "../types";
import {
  RequestGuard,
  httpFailure,
  looksLikeFormatError,
  explicitlyRejectsStructuredOutput,
  missingKeyError,
  networkError,
  normaliseBaseUrl,
  resolveApiKey,
  timeoutMs,
} from "./common";

/**
 * Endpoint + model pairs that turned out not to stream (a gateway in front of Gemini, say), remembered for the
 * process. Learnt from the endpoint's own answer, never assumed.
 */
const plainEndpoints = new Set<string>();

/** The streaming attempt failed because this endpoint does not stream, not because of the request itself. */
function streamingUnavailable(err: unknown): boolean {
  if (err instanceof ApiError)
    return (
      // Google answers a wrong model with its own error (status "NOT_FOUND"); a gateway without the streaming
      // route answers with an ordinary HTTP error, which the SDK wraps with the HTTP status text ("Not Found").
      ([404, 405, 501].includes(err.status) && !isGoogleError(err)) ||
      (err.status === 400 && /stream/i.test(err.message))
    );
  // The SDK's parser met a plain JSON answer instead of server-sent events.
  return (
    err instanceof Error &&
    /Incomplete JSON segment|Response body is empty/i.test(err.message)
  );
}

/** A google.rpc error body: its status is a code such as NOT_FOUND or INVALID_ARGUMENT. */
function isGoogleError(err: ApiError): boolean {
  const raw = err.message ?? "";
  const start = raw.indexOf("{");
  if (start < 0) return false;
  try {
    const status = (
      JSON.parse(raw.slice(start)) as { error?: { status?: unknown } }
    ).error?.status;
    return typeof status === "string" && /^[A-Z][A-Z_]+$/.test(status);
  } catch {
    return false;
  }
}

const REFUSAL_REASONS = new Set<string>([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
  FinishReason.IMAGE_SAFETY,
  FinishReason.LANGUAGE,
]);

export function toGeminiParts(parts: LLMContentPart[]): Part[] {
  const out: Part[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text.trim()) out.push({ text: part.text });
      continue;
    }
    if (part.image.label) out.push({ text: part.image.label });
    out.push({
      inlineData: { mimeType: part.image.mimeType, data: part.image.base64 },
    });
  }
  if (!out.length) out.push({ text: "(no content)" });
  return out;
}

/** A streamed answer collected into the shape of a complete one (parts in order, the latest finish and usage). */
async function collect(
  stream: AsyncGenerator<GenerateContentResponse>,
  onActivity: () => void,
  onStream?: LLMRequest["onStream"],
): Promise<GenerateContentResponse> {
  const parts: Part[] = [];
  let answered = false;
  let finishReason: FinishReason | undefined;
  let finishMessage: string | undefined;
  let usageMetadata: GenerateContentResponse["usageMetadata"];
  let promptFeedback: GenerateContentResponse["promptFeedback"];
  let modelVersion: string | undefined;
  for await (const chunk of stream) {
    onActivity();
    modelVersion = chunk.modelVersion ?? modelVersion;
    usageMetadata = chunk.usageMetadata ?? usageMetadata;
    if (chunk.promptFeedback?.blockReason)
      promptFeedback = chunk.promptFeedback;
    const candidate = chunk.candidates?.[0];
    if (!candidate) continue;
    answered = true;
    for (const part of candidate.content?.parts ?? []) {
      parts.push(part);
      if (part.thought) onStream?.({ thinking: true });
      else if (part.text) onStream?.({ text: part.text.length });
    }
    finishReason = candidate.finishReason ?? finishReason;
    finishMessage = candidate.finishMessage ?? finishMessage;
  }
  return {
    candidates: answered
      ? [{ content: { role: "model", parts }, finishReason, finishMessage }]
      : [],
    usageMetadata,
    promptFeedback,
    modelVersion,
  } as unknown as GenerateContentResponse;
}

interface GeminiErrorBody {
  message: string;
  /** google.rpc detail objects (RetryInfo, QuotaFailure…), each with an "@type". */
  details: Record<string, unknown>[];
}

/** Gemini errors carry the JSON body in the message: {"error":{"code":400,"message":"…","status":"…","details":[…]}}. */
function geminiError(err: ApiError): GeminiErrorBody {
  const raw = err.message ?? "";
  const start = raw.indexOf("{");
  if (start >= 0) {
    try {
      const body = JSON.parse(raw.slice(start)) as {
        error?: { message?: unknown; details?: unknown };
      };
      if (typeof body.error?.message === "string") {
        const details = Array.isArray(body.error.details)
          ? body.error.details.filter(
              (d): d is Record<string, unknown> => !!d && typeof d === "object",
            )
          : [];
        return { message: body.error.message, details };
      }
    } catch {
      // Not JSON — use the raw text below.
    }
  }
  return { message: raw, details: [] };
}

function detailsOfType(
  details: Record<string, unknown>[],
  type: string,
): Record<string, unknown>[] {
  return details.filter(
    (d) =>
      typeof d["@type"] === "string" &&
      d["@type"].endsWith(`google.rpc.${type}`),
  );
}

/**
 * How long Google asks us to wait: RetryInfo.retryDelay ("41s"), else "Please retry in 41.2s" in the
 * text. The SDK's ApiError has no headers, so this is the only Retry-After there is.
 */
export function geminiRetryAfterMs(
  details: Record<string, unknown>[],
  message: string,
): number | undefined {
  for (const info of detailsOfType(details, "RetryInfo")) {
    const match = /^(\d+(?:\.\d+)?)s$/.exec(
      String(info.retryDelay ?? "").trim(),
    );
    if (match) return Math.round(Number(match[1]) * 1000);
  }
  const match = /retry in (\d+(?:\.\d+)?)\s*s\b/i.exec(message);
  return match ? Math.round(Number(match[1]) * 1000) : undefined;
}

/** A QuotaFailure on a per-day quota: waiting seconds will not help. */
export function isGeminiDailyQuota(
  details: Record<string, unknown>[],
): boolean {
  return detailsOfType(details, "QuotaFailure").some(
    (failure) =>
      Array.isArray(failure.violations) &&
      failure.violations.some((v: unknown) =>
        /PerDay/i.test(
          String((v as { quotaId?: unknown } | null)?.quotaId ?? ""),
        ),
      ),
  );
}

export class GeminiProvider implements LLMProvider {
  readonly supportsNativeSchema = true;
  private readonly client: GoogleGenAI;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  /** Base URL + model: what plainEndpoints remembers. */
  private readonly endpointKey: string;
  /** Set when this endpoint rejected responseJsonSchema: use the legacy responseSchema instead. */
  private useLegacySchema = false;

  constructor(
    readonly connection: LLMConnection,
    readonly supportsVision: boolean,
  ) {
    this.apiKey = resolveApiKey(connection, "GOOGLE_API_KEY");
    this.model = (
      connection.model || PROVIDER_PRESETS.gemini.defaultModel
    ).replace(/^models\//, "");
    const baseUrl = normaliseBaseUrl(providerEndpoint(connection));
    this.endpointKey = `${baseUrl ?? ""} ${this.model}`;
    this.client = new GoogleGenAI({
      enterprise: false,
      apiKey: this.apiKey ?? "missing-key",
      // No SDK-level retries (generateStructured retries). No SDK timeout either: it would stay armed while a
      // streamed answer arrives and cap its total time. The RequestGuard (config.abortSignal) times attempts.
      httpOptions: {
        fetch: providerFetch(connection, this.apiKey),
        // The SDK otherwise retries up to five times outside Coherence's shared admission policy.
        retryOptions: { attempts: 1 },
        ...(baseUrl ? { baseUrl } : {}),
      },
    });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (!this.apiKey) throw missingKeyError(this.connection);
    let schemaRetried = false;
    for (;;) {
      const streamed = !plainEndpoints.has(this.endpointKey);
      try {
        return await this.send(req);
      } catch (err) {
        // Once per endpoint and model: the same request again, unstreamed.
        if (streamed && !req.signal?.aborted && streamingUnavailable(err)) {
          plainEndpoints.add(this.endpointKey);
          continue;
        }
        const mapped = this.mapError(err, req);
        const retryWithLegacySchema =
          !schemaRetried &&
          req.jsonSchema !== undefined &&
          !this.useLegacySchema &&
          mapped instanceof ProviderError &&
          mapped.failure === "format_unsupported";
        if (retryWithLegacySchema) {
          this.useLegacySchema = true;
          schemaRetried = true;
          continue;
        }
        throw mapped;
      }
    }
  }

  private buildConfig(
    req: LLMRequest,
    signal: AbortSignal,
  ): GenerateContentConfig {
    const config: GenerateContentConfig = { abortSignal: signal };
    if (req.system.trim()) config.systemInstruction = req.system;
    const maxTokens = req.maxOutputTokens ?? this.connection.maxOutputTokens;
    if (maxTokens) config.maxOutputTokens = maxTokens;
    if (this.connection.temperature !== undefined)
      config.temperature = this.connection.temperature;
    if (req.jsonSchema) {
      config.responseMimeType = "application/json";
      if (this.useLegacySchema)
        config.responseSchema = inlineRefs(req.jsonSchema.schema);
      else config.responseJsonSchema = req.jsonSchema.schema;
    } else if (req.json) {
      config.responseMimeType = "application/json";
    }
    return config;
  }

  /**
   * Streamed by default, so the connection timeout measures silence rather than total time: a long answer that
   * keeps arriving is never cut off (owner test note 4).
   */
  private async send(req: LLMRequest): Promise<LLMResponse> {
    const guard = new RequestGuard(req.signal, timeoutMs(this.connection));
    try {
      const contents: Content[] = req.messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: toGeminiParts(m.content),
      }));
      let response: GenerateContentResponse;
      try {
        req.beforeAttempt?.();
        const params = {
          model: this.model,
          contents,
          config: this.buildConfig(req, guard.signal),
        };
        response = plainEndpoints.has(this.endpointKey)
          ? await this.client.models.generateContent(params)
          : await collect(
              await this.client.models.generateContentStream(params),
              () => guard.touch(),
              req.onStream,
            );
      } catch (err) {
        throw guard.abortError("gemini") ?? err;
      }
      return {
        ...this.toResponse(response),
        acceptedControls:
          this.connection.temperature !== undefined ? ["temperature"] : [],
      };
    } finally {
      guard.dispose();
    }
  }

  private toResponse(response: GenerateContentResponse): LLMResponse {
    const meta = response.usageMetadata;
    const base = {
      model: response.modelVersion || this.model,
      usage: {
        inputTokens: meta?.promptTokenCount ?? 0,
        // Thinking tokens are billed as output.
        outputTokens:
          (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
        ...(meta?.thoughtsTokenCount !== undefined
          ? { reasoningTokens: meta.thoughtsTokenCount }
          : {}),
        ...(meta?.candidatesTokenCount !== undefined
          ? { visibleOutputTokens: meta.candidatesTokenCount }
          : {}),
        ...(meta?.cachedContentTokenCount
          ? { cacheReadInputTokens: meta.cachedContentTokenCount }
          : {}),
      },
    };
    const blocked = response.promptFeedback?.blockReason;
    if (blocked) {
      return {
        ...base,
        text: "",
        stopReason: "refusal",
        refusalMessage:
          response.promptFeedback?.blockReasonMessage ||
          `Gemini blocked the request (${blocked}).`,
      };
    }
    const candidate = response.candidates?.[0];
    if (!candidate)
      throw new ProviderError("Gemini returned no answer.", {
        failure: "server",
        retryable: true,
      });
    const finish = candidate.finishReason;
    if (finish && REFUSAL_REASONS.has(finish)) {
      return {
        ...base,
        text: "",
        stopReason: "refusal",
        refusalMessage:
          candidate.finishMessage || `Gemini stopped the answer (${finish}).`,
      };
    }
    const text = (candidate.content?.parts ?? [])
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text)
      .join("");
    let stopReason: LLMStopReason = "end";
    if (finish === FinishReason.MAX_TOKENS) stopReason = "max_tokens";
    else if (
      finish &&
      finish !== FinishReason.STOP &&
      finish !== FinishReason.FINISH_REASON_UNSPECIFIED
    )
      stopReason = "other";
    return { ...base, text, stopReason };
  }

  private mapError(err: unknown, req: LLMRequest): Error {
    if (err instanceof CancelledError || err instanceof ProviderError)
      return err;
    if (req.signal?.aborted) return new CancelledError();
    if (err instanceof ApiError) {
      const { message, details } = geminiError(err);
      const status = err.status;
      if (/API key not valid|API_KEY_INVALID/i.test(message)) {
        return new ProviderError(
          "Google rejected the Gemini API key. Check the key of this connection in Settings → AI connections.",
          { failure: "auth", status },
        );
      }
      if (
        status === 400 &&
        (req.jsonSchema || req.json) &&
        looksLikeFormatError(message)
      ) {
        return new ProviderError(
          `Gemini could not use the JSON schema: ${cleanProviderMessage(message, this.apiKey)}`,
          {
            failure: "format_unsupported",
            status,
            definitiveCapability: explicitlyRejectsStructuredOutput(message)
              ? "structured"
              : undefined,
          },
        );
      }
      if (status === 404) {
        return new ProviderError(
          `Model '${this.model}' not found at Google Gemini. Check the model name in Settings (use "List models").`,
          { failure: "not_found", status },
        );
      }
      if (status === 429 && isGeminiDailyQuota(details)) {
        return new ProviderError(
          `Google Gemini's daily quota for '${this.model}' is used up (429): ${cleanProviderMessage(message, this.apiKey)} Try again tomorrow, use another model, or enable billing for this API key.`,
          { failure: "quota", status },
        );
      }
      return httpFailure({
        provider: "gemini",
        status,
        message,
        model: this.model,
        apiKey: this.apiKey,
        retryAfterMs: geminiRetryAfterMs(details, message),
      });
    }
    if (isAbortError(err))
      return networkError("gemini", this.connection.baseUrl, err, this.apiKey);
    if (
      err instanceof TypeError ||
      (err instanceof Error &&
        /fetch failed|ECONN|ENOTFOUND|socket/i.test(err.message))
    ) {
      return networkError(
        "gemini",
        normaliseBaseUrl(this.connection.baseUrl),
        err,
        this.apiKey,
      );
    }
    return new ProviderError(
      `Unexpected error calling Google Gemini: ${cleanProviderMessage(err instanceof Error ? err.message : String(err), this.apiKey)}`,
      { failure: "other" },
    );
  }

  async listModels(): Promise<ModelInfo[]> {
    return listCatalogueModels(this.connection);
  }
}
