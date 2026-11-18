/**
 * Anthropic (Claude) adapter — @anthropic-ai/sdk, beta Messages API, streamed (finalMessage) so long
 * structured outputs never hit HTTP idle timeouts.
 * Deliberately NOT sent: `temperature` and `thinking` with budget_tokens (current Claude models reject
 * them; omitting `thinking` gives adaptive thinking). Native structured output via output_config.format.
 */
import { listCatalogueModels } from "../catalogue";
import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaOutputConfig,
  MessageCreateParamsBase,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { PROVIDER_PRESETS } from "@shared/providers";
import { providerFetch } from "../../security/endpointPolicy";
import { quietSdkLogger } from "../../security/diagnostics";
import type { LLMConnection } from "@shared/types";
import { CancelledError } from "../../errors";
import {
  ProviderError,
  cleanProviderMessage,
  isAbortError,
  type ProviderErrorInit,
} from "../errors";
import { waitFromHeaders } from "../rateLimit";
import type {
  LLMContentPart,
  LLMMessage,
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
  stallError,
  timeoutError,
  timeoutMs,
  untimedDispatcher,
} from "./common";

export const ANTHROPIC_DEFAULT_MAX_TOKENS = 32000;

/** Models that support the server-side refusal fallback on the first-party API. */
export const REFUSAL_FALLBACK_MODELS = [
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-sonnet-5-5",
];
export const REFUSAL_FALLBACK_BETA = "server-side-fallback-2026-07-01";

const FIRST_PARTY_URL = "https://api.anthropic.com";

/** The SDK's paths already start with /v1, so a base URL typed as ".../v1" would request /v1/v1/messages. */
export function anthropicBaseUrl(
  baseUrl: string | undefined,
): string | undefined {
  return normaliseBaseUrl(baseUrl)?.replace(/\/v1$/i, "") || undefined;
}

export function isFirstPartyAnthropic(baseUrl: string | undefined): boolean {
  const url = anthropicBaseUrl(baseUrl);
  return !url || url === FIRST_PARTY_URL;
}

/** The SDK types `dispatcher` as undici's full Dispatcher; Node's fetch only calls dispatch(). */
const UNTIMED_FETCH_OPTIONS = {
  dispatcher: untimedDispatcher,
} as unknown as ClientOptions["fetchOptions"];

/** Rough output tokens of a stream stopped midway (the real count only arrives with message_delta). */
function partialUsage(
  snapshot: BetaMessage | undefined,
  model: string,
): ProviderErrorInit["partial"] {
  if (!snapshot) return undefined;
  const usage = snapshot.usage;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  let chars = 0;
  for (const block of snapshot.content) {
    if (block.type === "text") chars += block.text.length;
    else if (block.type === "thinking") chars += block.thinking.length;
  }
  return {
    model: snapshot.model || model,
    usage: {
      inputTokens: usage.input_tokens + cacheRead + cacheWrite,
      outputTokens: Math.max(usage.output_tokens, Math.ceil(chars / 4)),
      cacheReadInputTokens: cacheRead,
      cacheWriteInputTokens: cacheWrite,
    },
  };
}

export function usesRefusalFallback(
  connection: LLMConnection,
  model: string,
): boolean {
  return (
    connection.refusalFallback &&
    REFUSAL_FALLBACK_MODELS.includes(model) &&
    isFirstPartyAnthropic(connection.baseUrl)
  );
}

export function toAnthropicContent(
  parts: LLMContentPart[],
): BetaContentBlockParam[] {
  const blocks: BetaContentBlockParam[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      // The API rejects empty text blocks.
      if (part.text.trim()) blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.image.label) blocks.push({ type: "text", text: part.image.label });
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: part.image.mimeType,
        data: part.image.base64,
      },
    });
  }
  if (!blocks.length) blocks.push({ type: "text", text: "(no content)" });
  return blocks;
}

function toAnthropicMessages(messages: LLMMessage[]): BetaMessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: toAnthropicContent(m.content),
  }));
}

function mapStopReason(reason: BetaMessage["stop_reason"]): LLMStopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

/** The API's own message from an SDK error ("{type:'error', error:{type, message}}" body). */
function apiMessage(err: InstanceType<typeof Anthropic.APIError>): string {
  const body = err.error as
    { error?: { message?: unknown }; message?: unknown } | undefined;
  const nested = body?.error?.message ?? body?.message;
  if (typeof nested === "string" && nested) return nested;
  return err.message.replace(/^\d{3}\s+/, "");
}

export class AnthropicProvider implements LLMProvider {
  readonly supportsNativeSchema = true;
  private readonly client: Anthropic;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  /** Features this endpoint turned out not to accept (dropped for the rest of this provider's life). */
  private dropEffort = false;
  private dropFallback = false;

  constructor(
    readonly connection: LLMConnection,
    readonly supportsVision: boolean,
  ) {
    this.apiKey = resolveApiKey(connection);
    this.model = connection.model || PROVIDER_PRESETS.anthropic.defaultModel;
    this.client = new Anthropic({
      fetch: providerFetch(connection, this.apiKey),
      authToken: null,
      webhookKey: null,
      logger: quietSdkLogger,
      logLevel: "off",
      apiKey: this.apiKey ?? "missing-key",
      baseURL: anthropicBaseUrl(connection.baseUrl) ?? FIRST_PARTY_URL,
      // Retries are handled (and logged) by generateStructured.
      maxRetries: 0,
      timeout: timeoutMs(connection),
      // The RequestGuard's inactivity timeout bounds the stream, not undici's fixed 300 s.
      fetchOptions: UNTIMED_FETCH_OPTIONS,
    });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (!this.apiKey) throw missingKeyError(this.connection);
    // Two extra tries cover dropping `effort` and the refusal-fallback beta if this endpoint rejects them.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.send(req);
      } catch (err) {
        if (
          attempt < 2 &&
          err instanceof Anthropic.BadRequestError &&
          this.dropUnsupportedFeature(apiMessage(err))
        )
          continue;
        throw this.mapError(err, req);
      }
    }
  }

  /** Returns true when the 400 was about an optional feature we can drop and retry without. */
  private dropUnsupportedFeature(message: string): boolean {
    if (!this.dropEffort && this.connection.effort && /effort/i.test(message)) {
      this.dropEffort = true;
      return true;
    }
    if (
      !this.dropFallback &&
      usesRefusalFallback(this.connection, this.model) &&
      /fallback/i.test(message)
    ) {
      this.dropFallback = true;
      return true;
    }
    return false;
  }

  private buildParams(req: LLMRequest): MessageCreateParamsBase {
    const params: MessageCreateParamsBase = {
      model: this.model,
      max_tokens:
        req.maxOutputTokens ??
        this.connection.maxOutputTokens ??
        ANTHROPIC_DEFAULT_MAX_TOKENS,
      messages: toAnthropicMessages(req.messages),
    };
    if (req.system.trim()) {
      // cache_control on the static system prompt: repeated agent calls hit the prompt cache.
      params.system = [
        {
          type: "text",
          text: req.system,
          cache_control: { type: "ephemeral" },
        },
      ];
    }
    const outputConfig: BetaOutputConfig = {};
    if (this.connection.effort && !this.dropEffort)
      outputConfig.effort = this.connection.effort;
    if (req.jsonSchema)
      outputConfig.format = {
        type: "json_schema",
        schema: req.jsonSchema.schema,
      };
    if (outputConfig.effort || outputConfig.format)
      params.output_config = outputConfig;
    if (
      !this.dropFallback &&
      usesRefusalFallback(this.connection, this.model)
    ) {
      params.betas = [REFUSAL_FALLBACK_BETA];
      params.fallbacks = "default";
    }
    return params;
  }

  private async send(req: LLMRequest): Promise<LLMResponse> {
    const guard = new RequestGuard(req.signal, timeoutMs(this.connection));
    try {
      req.beforeAttempt?.();
      const stream = this.client.beta.messages.stream(this.buildParams(req), {
        signal: guard.signal,
      });
      // Every event restarts the timeout: a long answer that keeps arriving is never cut off.
      let snapshot: BetaMessage | undefined;
      stream.on("streamEvent", (event, current) => {
        snapshot = current;
        guard.touch();
        if (event.type !== "content_block_delta") return;
        if (event.delta.type === "text_delta")
          req.onStream?.({ text: event.delta.text.length });
        else if (event.delta.type === "thinking_delta")
          req.onStream?.({ thinking: true });
      });
      let message: BetaMessage;
      try {
        message = await stream.finalMessage();
      } catch (err) {
        if (guard.timedOut && guard.progressed) {
          throw stallError(
            "anthropic",
            guard.timeoutMs,
            partialUsage(snapshot, this.model),
          );
        }
        throw guard.abortError("anthropic") ?? err;
      }
      return {
        ...this.toResponse(message),
        acceptedControls:
          this.connection.effort && !this.dropEffort
            ? ["reasoning-effort"]
            : [],
      };
    } finally {
      guard.dispose();
    }
  }

  private toResponse(message: BetaMessage): LLMResponse {
    const usage = message.usage;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const base = {
      model: message.model || this.model,
      usage: {
        inputTokens: usage.input_tokens + cacheRead + cacheWrite,
        outputTokens: usage.output_tokens,
        cacheReadInputTokens: cacheRead,
        cacheWriteInputTokens: cacheWrite,
      },
    };
    // Check why it stopped before trusting the content.
    const stopReason = mapStopReason(message.stop_reason);
    if (stopReason === "refusal") {
      return {
        ...base,
        text: "",
        stopReason,
        refusalMessage: message.stop_details?.explanation ?? undefined,
      };
    }
    const text = message.content
      .filter(
        (block): block is Extract<typeof block, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("");
    return { ...base, text, stopReason };
  }

  private mapError(err: unknown, req: LLMRequest): Error {
    if (err instanceof CancelledError || err instanceof ProviderError)
      return err;
    if (req.signal?.aborted) return new CancelledError();
    if (err instanceof Anthropic.APIConnectionTimeoutError)
      return timeoutError("anthropic", timeoutMs(this.connection));
    if (err instanceof Anthropic.APIUserAbortError || isAbortError(err)) {
      return networkError(
        "anthropic",
        this.connection.baseUrl,
        err,
        this.apiKey,
      );
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return networkError(
        "anthropic",
        normaliseBaseUrl(this.connection.baseUrl),
        err.cause ?? err,
        this.apiKey,
      );
    }
    if (err instanceof Anthropic.APIError) {
      const message = apiMessage(err);
      const status = err.status;
      const retryAfterMs = waitFromHeaders(err.headers, status);
      if (status === undefined) {
        // Error event in the middle of the stream (e.g. overloaded_error).
        const transient = [
          "overloaded_error",
          "api_error",
          "rate_limit_error",
          "timeout_error",
        ].includes(String(err.type));
        return new ProviderError(
          `Anthropic stopped the answer midway: ${cleanProviderMessage(message, this.apiKey)}`,
          { failure: transient ? "server" : "other", retryable: transient },
        );
      }
      if (status === 401) {
        return new ProviderError(
          "Anthropic rejected the API key (401). Check the key of this connection in Settings → AI connections.",
          { failure: "auth", status },
        );
      }
      if (status === 404) {
        return new ProviderError(
          `Model '${this.model}' not found at Anthropic. Check the model name in Settings (use "List models").`,
          { failure: "not_found", status },
        );
      }
      if (
        status === 400 &&
        req.jsonSchema &&
        looksLikeFormatError(message) &&
        !/credit|billing/i.test(message)
      ) {
        return new ProviderError(
          `Anthropic could not use the JSON schema: ${cleanProviderMessage(message, this.apiKey)}`,
          {
            failure: "format_unsupported",
            status,
            definitiveCapability: explicitlyRejectsStructuredOutput(message)
              ? "structured"
              : undefined,
          },
        );
      }
      if (status === 400 && /credit balance/i.test(message)) {
        return new ProviderError(
          `Anthropic says the account's credit balance is too low — add credits in the Claude Console (Plans & Billing).`,
          { failure: "quota", status },
        );
      }
      return httpFailure({
        provider: "anthropic",
        status,
        message,
        model: this.model,
        retryAfterMs,
        apiKey: this.apiKey,
      });
    }
    if (err instanceof Anthropic.AnthropicError) {
      // e.g. "stream ended without producing a Message" — a dropped connection; worth another try.
      return new ProviderError(
        `Anthropic connection problem: ${cleanProviderMessage(err.message, this.apiKey)}`,
        {
          failure: "network",
          retryable: true,
        },
      );
    }
    return new ProviderError(
      `Unexpected error calling Anthropic: ${cleanProviderMessage(err instanceof Error ? err.message : String(err), this.apiKey)}`,
      { failure: "other" },
    );
  }

  async listModels(): Promise<ModelInfo[]> {
    return listCatalogueModels(this.connection);
  }
}
