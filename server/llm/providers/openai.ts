/**
 * OpenAI, Azure OpenAI and OpenAI-compatible servers (LM Studio, vLLM, LocalAI, OpenRouter…) via the
 * `openai` SDK's Chat Completions API — the one API every compatible server implements.
 * Reasoning models (o-series, gpt-5*) take max_completion_tokens + reasoning_effort and no temperature.
 */
import { listCatalogueModels } from "../catalogue";
import OpenAI, { AzureOpenAI, type ClientOptions } from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { readEventStream } from "./eventStream";
import { PROVIDER_PRESETS } from "@shared/providers";
import { providerFetch } from "../../security/endpointPolicy";
import { quietSdkLogger } from "../../security/diagnostics";
import type { Effort, LLMConnection } from "@shared/types";
import { CancelledError } from "../../errors";
import { ProviderError, cleanProviderMessage, isAbortError } from "../errors";
import { noteRemaining, waitFromHeaders } from "../rateLimit";
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
  PROVIDER_NAMES,
  RequestGuard,
  hasImages,
  httpFailure,
  isTransportTimeout,
  looksLikeFormatError,
  explicitlyRejectsStructuredOutput,
  missingKeyError,
  networkError,
  normaliseBaseUrl,
  resolveApiKey,
  textOf,
  timeoutError,
  timeoutMs,
  untimedDispatcher,
} from "./common";

type OpenAIKind = "openai" | "azure-openai" | "openai-compatible";

export const AZURE_DEFAULT_API_VERSION = "2025-04-01-preview";

/** o1/o3/o4…, gpt-5* — reasoning models with different parameters. */
export function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/i.test(model.trim());
}

/**
 * Send reasoning parameters for this connection? An Azure deployment name says nothing about the model
 * behind it, so there an effort chosen by the BA marks a reasoning deployment (if it is not one, the
 * adapter drops the rejected reasoning_effort and treats it as a normal model from then on).
 */
export function treatAsReasoningModel(connection: LLMConnection): boolean {
  return (
    isReasoningModel(connection.model) ||
    (connection.provider === "azure-openai" && !!connection.effort)
  );
}

/** Chat Completions only accepts low/medium/high everywhere we care about. */
export function openAIReasoningEffort(
  effort: Effort | undefined,
): "low" | "medium" | "high" | undefined {
  if (!effort) return undefined;
  return effort === "xhigh" || effort === "max" ? "high" : effort;
}

function imageUrl(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}

/** A 400 saying a parameter is not accepted at all (not, e.g., that its value is too large). */
const UNSUPPORTED_PARAM =
  /unsupported|not supported|unrecogni[sz]ed|unknown (?:parameter|argument|field)|not permitted|not allowed|extra (?:inputs|fields)/i;

const CONTEXT_LIMIT = /maximum context length|context (?:window|length|size)/i;

/** The 400 is about the max_tokens / max_completion_tokens value (too large for the model or its context). */
function rejectsOutputBudget(message: string): boolean {
  return (
    /max_(?:completion_)?tokens/i.test(message) &&
    /too large|at most|maximum|exceed|greater than/i.test(message)
  );
}

/** The SDK types `dispatcher` as undici's full Dispatcher; Node's fetch only calls dispatch(). */
const UNTIMED_FETCH_OPTIONS = {
  dispatcher: untimedDispatcher,
} as unknown as ClientOptions["fetchOptions"];

/**
 * Endpoints (provider kind + base URL) that refused streaming, or its usage report, for the rest of this process.
 * Learnt from the endpoint's own 400, never assumed per provider or model.
 */
const plainEndpoints = new Set<string>();
const endpointsWithoutStreamUsage = new Set<string>();

/** A 400 about the stream_options / include_usage parameter itself. */
const STREAM_OPTIONS = /stream_options|include_usage/i;

export class OpenAIProvider implements LLMProvider {
  readonly supportsNativeSchema: boolean;
  private readonly kind: OpenAIKind;
  private readonly client: OpenAI;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly baseUrl: string | undefined;
  /** Parameters this endpoint turned out to reject (dropped for the rest of this provider's life). */
  private dropTemperature = false;
  private dropReasoningEffort = false;
  private dropGatewayReasoning = false;
  private useLegacyMaxTokens: boolean;

  constructor(
    readonly connection: LLMConnection,
    readonly supportsVision: boolean,
  ) {
    this.kind = connection.provider as OpenAIKind;
    this.model = connection.model || PROVIDER_PRESETS[this.kind].defaultModel;
    this.baseUrl =
      normaliseBaseUrl(connection.baseUrl) ??
      PROVIDER_PRESETS[this.kind].defaultBaseUrl;
    // Compatible servers: schema enforcement only when the BA explicitly asked for native mode.
    this.supportsNativeSchema =
      this.kind === "openai-compatible"
        ? connection.structuredOutput === "native" ||
          connection.modelStructuredMode === "native"
        : true;
    this.useLegacyMaxTokens = this.kind === "openai-compatible";
    // An endpoint that does not stream sends no headers until generation ends: without this, Node's fetch
    // gives up after 300 s whatever the connection timeout says.
    const common = {
      fetch: providerFetch(
        connection,
        this.kind === "openai-compatible"
          ? connection.apiKey?.trim()
          : resolveApiKey(connection),
      ),
      logger: quietSdkLogger,
      logLevel: "off" as const,
      organization: null,
      project: null,
      adminAPIKey: null,
      webhookSecret: null,
      maxRetries: 0,
      timeout: timeoutMs(connection),
      fetchOptions: UNTIMED_FETCH_OPTIONS,
    };

    if (this.kind === "azure-openai") {
      this.apiKey = resolveApiKey(connection);
      this.client = new AzureOpenAI({
        endpoint: this.baseUrl,
        apiKey: this.apiKey ?? "missing-key",
        apiVersion:
          connection.azureApiVersion?.trim() || AZURE_DEFAULT_API_VERSION,
        deployment: this.model || undefined,
        ...common,
      });
    } else if (this.kind === "openai-compatible") {
      // Local servers usually need no key, but the SDK insists on one.
      this.apiKey = connection.apiKey?.trim() || undefined;
      this.client = new OpenAI({
        apiKey: this.apiKey ?? "not-needed",
        baseURL: this.baseUrl,
        ...common,
      });
    } else {
      this.apiKey = resolveApiKey(connection);
      this.client = new OpenAI({
        apiKey: this.apiKey ?? "missing-key",
        baseURL: this.baseUrl,
        ...common,
      });
    }
  }

  private get name(): string {
    return PROVIDER_NAMES[this.kind];
  }

  private get endpointKey(): string {
    return `${this.kind} ${this.baseUrl ?? ""}`;
  }

  private checkReady(): void {
    if (this.kind !== "openai-compatible" && !this.apiKey)
      throw missingKeyError(this.connection);
    if (this.kind === "azure-openai" && !this.baseUrl) {
      throw new ProviderError(
        "Azure OpenAI needs the resource endpoint as Base URL, e.g. https://<resource>.openai.azure.com.",
        { failure: "bad_request" },
      );
    }
    if (!this.model) {
      throw new ProviderError(
        this.kind === "azure-openai"
          ? "Enter your Azure OpenAI deployment name as the model of this connection."
          : `Enter a model name for the "${this.connection.name}" connection (use "List models").`,
        { failure: "bad_request" },
      );
    }
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.checkReady();
    // Up to three parameter adjustments (temperature, reasoning effort, token parameter name).
    for (let attempt = 0; ; attempt += 1) {
      const body = this.buildBody(req);
      try {
        return await this.send(body, req);
      } catch (err) {
        if (
          attempt < 3 &&
          err instanceof OpenAI.BadRequestError &&
          this.adjustForRejectedParam(errorText(err), body)
        )
          continue;
        throw this.mapError(err, req, body);
      }
    }
  }

  private toContent(
    parts: LLMContentPart[],
  ): string | ChatCompletionContentPart[] {
    // Many compatible servers only accept plain strings when there are no images.
    if (!hasImages(parts)) return textOf(parts);
    const content: ChatCompletionContentPart[] = [];
    for (const part of parts) {
      if (part.type === "text") {
        if (part.text.trim()) content.push({ type: "text", text: part.text });
        continue;
      }
      if (part.image.label)
        content.push({ type: "text", text: part.image.label });
      content.push({
        type: "image_url",
        image_url:
          this.kind === "openai-compatible"
            ? { url: imageUrl(part.image.mimeType, part.image.base64) }
            : {
                url: imageUrl(part.image.mimeType, part.image.base64),
                detail: "high",
              },
      });
    }
    return content;
  }

  private toMessages(req: LLMRequest): ChatCompletionMessageParam[] {
    const messages: ChatCompletionMessageParam[] = [];
    if (req.system.trim())
      messages.push({ role: "system", content: req.system });
    for (const message of req.messages as LLMMessage[]) {
      if (message.role === "assistant")
        messages.push({
          role: "assistant",
          content: textOf(message.content) || "(empty)",
        });
      else
        messages.push({
          role: "user",
          content: this.toContent(message.content),
        });
    }
    return messages;
  }

  private buildBody(req: LLMRequest): ChatCompletionCreateParamsNonStreaming {
    const reasoning =
      isReasoningModel(this.model) ||
      (treatAsReasoningModel(this.connection) && !this.dropReasoningEffort);
    const body: ChatCompletionCreateParamsNonStreaming & {
      reasoning?: { enabled?: boolean; effort?: string };
    } = {
      model: this.model,
      messages: this.toMessages(req),
    };
    // Only the approved OpenRouter dialect, only an optional extractive reading task.
    // Reasoning remains available to planning/writing/review and mandatory-thinking models.
    let openRouter = false;
    try {
      const url = new URL(this.baseUrl!);
      openRouter =
        this.kind === "openai-compatible" &&
        url.origin === "https://openrouter.ai" &&
        /^\/api\/v1\/?$/.test(url.pathname);
    } catch {
      /* Custom compatible endpoints keep their own dialect. */
    }
    if (openRouter && !this.dropGatewayReasoning) {
      const facts = this.connection.modelReasoning;
      if (
        this.connection.effort &&
        facts?.supportedEfforts?.includes(this.connection.effort)
      )
        body.reasoning = { effort: this.connection.effort };
      else if (
        facts?.automaticExtraction &&
        facts.mandatory === false &&
        /^screen-analysis:/.test(req.purpose)
      )
        body.reasoning = { enabled: false };
    }
    const maxTokens = req.maxOutputTokens ?? this.connection.maxOutputTokens;
    if (maxTokens) {
      if (this.useLegacyMaxTokens && !reasoning) body.max_tokens = maxTokens;
      else body.max_completion_tokens = maxTokens;
    }
    if (reasoning) {
      const effort = openAIReasoningEffort(this.connection.effort);
      if (effort && !this.dropReasoningEffort) body.reasoning_effort = effort;
    } else if (
      this.connection.temperature !== undefined &&
      !this.dropTemperature
    ) {
      body.temperature = this.connection.temperature;
    }
    if (req.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: req.jsonSchema.name,
          strict: true,
          schema: req.jsonSchema.schema,
          ...(req.jsonSchema.description
            ? { description: req.jsonSchema.description }
            : {}),
        },
      };
    } else if (req.json) {
      body.response_format = { type: "json_object" };
    }
    return body;
  }

  /** Returns true when a 400 was about an optional parameter we can drop or rename and retry. */
  private adjustForRejectedParam(
    message: string,
    body: ChatCompletionCreateParamsNonStreaming,
  ): boolean {
    // Before the other checks: "Unrecognized request argument supplied: stream_options" is about streaming.
    if (
      !plainEndpoints.has(this.endpointKey) &&
      UNSUPPORTED_PARAM.test(message)
    ) {
      if (
        STREAM_OPTIONS.test(message) &&
        !endpointsWithoutStreamUsage.has(this.endpointKey)
      ) {
        endpointsWithoutStreamUsage.add(this.endpointKey);
        return true;
      }
      if (
        /\bstream(?:ing)?\b/i.test(message) &&
        !STREAM_OPTIONS.test(message)
      ) {
        plainEndpoints.add(this.endpointKey);
        return true;
      }
    }
    if (
      !this.dropGatewayReasoning &&
      "reasoning" in body &&
      /reasoning/i.test(message) &&
      UNSUPPORTED_PARAM.test(message)
    ) {
      this.dropGatewayReasoning = true;
      return true;
    }
    if (body.temperature !== undefined && /temperature/i.test(message)) {
      this.dropTemperature = true;
      return true;
    }
    if (
      body.reasoning_effort !== undefined &&
      /reasoning[_ ]effort/i.test(message)
    ) {
      this.dropReasoningEffort = true;
      return true;
    }
    // Only when the parameter itself is refused: vLLM's "'max_tokens' or 'max_completion_tokens' is too
    // large" names both and would otherwise flip the name back and forth.
    const useCompletionTokens = /use '?max_completion_tokens'? instead/i.test(
      message,
    );
    if (
      body.max_completion_tokens !== undefined &&
      /max_completion_tokens/i.test(message) &&
      UNSUPPORTED_PARAM.test(message) &&
      !useCompletionTokens
    ) {
      this.useLegacyMaxTokens = true;
      return true;
    }
    if (
      body.max_tokens !== undefined &&
      /max_tokens/i.test(message) &&
      (UNSUPPORTED_PARAM.test(message) || useCompletionTokens)
    ) {
      this.useLegacyMaxTokens = false;
      return true;
    }
    return false;
  }

  private send(
    body: ChatCompletionCreateParamsNonStreaming,
    req: LLMRequest,
  ): Promise<LLMResponse> {
    return plainEndpoints.has(this.endpointKey)
      ? this.sendPlain(body, req)
      : this.sendStreaming(body, req);
  }

  /**
   * The answer is streamed, so the connection timeout measures silence rather than total time: a long answer that
   * keeps arriving is never cut off (owner test note 4). A server that ignores `stream` and answers with plain JSON
   * is accepted as it is, without a second request.
   */
  private async sendStreaming(
    body: ChatCompletionCreateParamsNonStreaming,
    req: LLMRequest,
  ): Promise<LLMResponse> {
    const guard = new RequestGuard(req.signal, timeoutMs(this.connection));
    try {
      let completion: ChatCompletion;
      try {
        req.beforeAttempt?.();
        const response = await this.client.chat.completions
          .create(
            {
              ...body,
              stream: true,
              ...(endpointsWithoutStreamUsage.has(this.endpointKey)
                ? {}
                : { stream_options: { include_usage: true } }),
            },
            { signal: guard.signal },
          )
          .asResponse();
        noteRemaining(this.connection, response.headers);
        completion = /text\/event-stream/i.test(
          response.headers.get("content-type") ?? "",
        )
          ? await this.readStream(response, guard, req.onStream)
          : ((await response.json()) as ChatCompletion);
      } catch (err) {
        throw guard.abortError(this.kind) ?? err;
      }
      return {
        ...this.toResponse(completion),
        acceptedControls: controlsOf(body),
      };
    } finally {
      guard.dispose();
    }
  }

  /** Collects a streamed answer into the shape of a complete one. */
  private async readStream(
    response: Response,
    guard: RequestGuard,
    onStream?: LLMRequest["onStream"],
  ): Promise<ChatCompletion> {
    let text = "";
    let refusal = "";
    let finish: string | null = null;
    let answered = false;
    let model = "";
    let usage: ChatCompletion["usage"];
    await readEventStream(
      response.body,
      () => guard.touch(),
      (data) => {
        if (data.trim() === "[DONE]") return true;
        let chunk: ChatCompletionChunk & { error?: unknown };
        try {
          chunk = JSON.parse(data);
        } catch {
          return false; // Not JSON: some gateways interleave status lines.
        }
        if (chunk.error) throw this.streamError(chunk.error);
        model ||= chunk.model ?? "";
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) return false;
        answered = true;
        // Gateways name streamed reasoning differently (reasoning, reasoning_content); either means "thinking".
        const delta = choice.delta as
          | (typeof choice.delta & {
              reasoning?: unknown;
              reasoning_content?: unknown;
            })
          | undefined;
        if (delta?.content) {
          text += delta.content;
          onStream?.({ text: delta.content.length });
        } else if (delta?.reasoning || delta?.reasoning_content)
          onStream?.({ thinking: true });
        if (choice.delta?.refusal) refusal += choice.delta.refusal;
        if (choice.finish_reason) finish = choice.finish_reason;
        return false;
      },
    );
    return {
      id: "streamed",
      object: "chat.completion",
      created: 0,
      model,
      choices: answered
        ? [
            {
              index: 0,
              // null when the stream ended without one: toResponse treats that as complete, as for plain answers.
              finish_reason:
                finish as unknown as ChatCompletion.Choice["finish_reason"],
              logprobs: null,
              message: {
                role: "assistant",
                content: text,
                refusal: refusal || null,
              },
            },
          ]
        : [],
      ...(usage ? { usage } : {}),
    };
  }

  /** An error the server sent inside the stream (gateways report upstream failures this way, after a 200). */
  private streamError(error: unknown): ProviderError {
    const e = (error && typeof error === "object" ? error : {}) as {
      code?: unknown;
      message?: unknown;
    };
    const message =
      typeof e.message === "string" && e.message
        ? e.message
        : "The server reported an error while answering.";
    const status = Number(e.code);
    if (Number.isInteger(status) && status >= 400 && status <= 599)
      return httpFailure({
        provider: this.kind,
        status,
        message,
        model: this.model,
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
      });
    return new ProviderError(
      `${this.name} reported an error while answering: ${cleanProviderMessage(message, this.apiKey)}`,
      { failure: "server", retryable: true },
    );
  }

  private async sendPlain(
    body: ChatCompletionCreateParamsNonStreaming,
    req: LLMRequest,
  ): Promise<LLMResponse> {
    const guard = new RequestGuard(req.signal, timeoutMs(this.connection));
    try {
      let completion: ChatCompletion;
      try {
        req.beforeAttempt?.();
        completion = await this.client.chat.completions.create(body, {
          signal: guard.signal,
        });
      } catch (err) {
        throw guard.abortError(this.kind) ?? err;
      }
      return {
        ...this.toResponse(completion),
        acceptedControls: controlsOf(body),
      };
    } finally {
      guard.dispose();
    }
  }

  private toResponse(completion: ChatCompletion): LLMResponse {
    const choice = completion.choices?.[0];
    const usage = completion.usage;
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const base = {
      model: completion.model || this.model,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        ...(Number.isSafeInteger(
          usage?.completion_tokens_details?.reasoning_tokens,
        ) && usage!.completion_tokens_details!.reasoning_tokens! >= 0
          ? {
              reasoningTokens:
                usage!.completion_tokens_details!.reasoning_tokens!,
              visibleOutputTokens: Math.max(
                0,
                (usage?.completion_tokens ?? 0) -
                  usage!.completion_tokens_details!.reasoning_tokens!,
              ),
            }
          : {}),
        ...(cached ? { cacheReadInputTokens: cached } : {}),
      },
    };
    if (!choice) {
      throw new ProviderError(`${this.name} returned no answer.`, {
        failure: "server",
        retryable: true,
      });
    }
    if (choice.message?.refusal) {
      return {
        ...base,
        text: "",
        stopReason: "refusal",
        refusalMessage: choice.message.refusal,
      };
    }
    let stopReason: LLMStopReason;
    switch (choice.finish_reason) {
      case "stop":
        stopReason = "end";
        break;
      case "length":
        stopReason = "max_tokens";
        break;
      case "content_filter":
        return {
          ...base,
          text: "",
          stopReason: "refusal",
          refusalMessage: `${this.name}'s content filter blocked the answer.`,
        };
      default:
        stopReason = choice.finish_reason ? "other" : "end";
    }
    return { ...base, text: choice.message?.content ?? "", stopReason };
  }

  private mapError(
    err: unknown,
    req: LLMRequest,
    body?: ChatCompletionCreateParamsNonStreaming,
  ): Error {
    if (err instanceof CancelledError || err instanceof ProviderError)
      return err;
    if (req.signal?.aborted) return new CancelledError();
    if (err instanceof OpenAI.APIConnectionTimeoutError) {
      return isTransportTimeout(err)
        ? networkError(this.kind, this.baseUrl, err, this.apiKey)
        : timeoutError(this.kind, timeoutMs(this.connection));
    }
    if (err instanceof OpenAI.APIUserAbortError || isAbortError(err))
      return networkError(this.kind, this.baseUrl, err, this.apiKey);
    if (err instanceof OpenAI.APIConnectionError)
      return networkError(
        this.kind,
        this.baseUrl,
        err.cause ?? err,
        this.apiKey,
      );
    if (err instanceof OpenAI.APIError && err.status !== undefined) {
      const status = err.status;
      const message = errorText(err);
      const code = errorCode(err);
      const detail = cleanProviderMessage(message, this.apiKey);
      // Before the format checks: another output format never makes a request fit the context.
      if (
        status === 400 &&
        (code === "context_length_exceeded" || CONTEXT_LIMIT.test(message))
      ) {
        return new ProviderError(
          rejectsOutputBudget(message)
            ? `The requested output budget does not fit this model's context window — lower "Max output tokens" for this connection in Settings: ${detail}`
            : `The request is too long for this model's context window: ${detail}`,
          { failure: "too_large", status },
        );
      }
      if (
        status === 400 &&
        body?.response_format &&
        looksLikeFormatError(message)
      ) {
        return new ProviderError(
          `${this.name} did not accept the requested JSON output format: ${detail}`,
          {
            failure: "format_unsupported",
            status,
            definitiveCapability: explicitlyRejectsStructuredOutput(message)
              ? "structured"
              : undefined,
          },
        );
      }
      if (
        code === "insufficient_quota" ||
        /exceeded your current quota/i.test(message)
      ) {
        return new ProviderError(
          `${this.name} says the account has no remaining quota — check billing for this API key.`,
          { failure: "quota", status },
        );
      }
      if (
        status === 400 &&
        body?.response_format &&
        this.kind === "openai-compatible" &&
        !rejectsOutputBudget(message)
      ) {
        // Compatible servers often refuse JSON mode with a vague 400 (ARCHITECTURE §7): try prompt mode for
        // this call, but do not downgrade the connection for good on an error that may be about anything.
        return new ProviderError(
          `${this.name} did not accept the requested JSON output format: ${detail}`,
          { failure: "format_unsupported", status, rememberFallback: false },
        );
      }
      if (status === 404) {
        const msg =
          this.kind === "azure-openai"
            ? `Azure OpenAI deployment '${this.model}' was not found at ${this.baseUrl}. Check the deployment name, the endpoint and the API version.`
            : this.kind === "openai-compatible"
              ? `The server at ${this.baseUrl} has no model '${this.model}' (or the base URL is wrong — it usually ends with /v1).`
              : `Model '${this.model}' not found at OpenAI. Check the model name in Settings (use "List models").`;
        return new ProviderError(msg, { failure: "not_found", status });
      }
      return httpFailure({
        provider: this.kind,
        status,
        message,
        model: this.model,
        baseUrl: this.baseUrl,
        retryAfterMs: waitFromHeaders(err.headers, status),
        apiKey: this.apiKey,
      });
    }
    if (err instanceof OpenAI.OpenAIError) {
      return new ProviderError(
        `${this.name} error: ${cleanProviderMessage(err.message, this.apiKey)}`,
        { failure: "other" },
      );
    }
    return new ProviderError(
      `Unexpected error calling ${this.name}: ${cleanProviderMessage(err instanceof Error ? err.message : String(err), this.apiKey)}`,
      { failure: "other" },
    );
  }

  async listModels(): Promise<ModelInfo[]> {
    return listCatalogueModels(this.connection);
  }
}

/** Optional controls the request carried (the server accepted them if it answered). */
function controlsOf(
  body: ChatCompletionCreateParamsNonStreaming,
): LLMResponse["acceptedControls"] {
  return [
    ...(body.temperature !== undefined ? ["temperature" as const] : []),
    ...(body.reasoning_effort !== undefined ||
    (body as { reasoning?: { effort?: string } }).reasoning?.effort !==
      undefined
      ? ["reasoning-effort" as const]
      : []),
  ];
}

/** The server's own error text: OpenAI nests it as {error:{message}}; some compatible servers send a string. */
function errorText(err: InstanceType<typeof OpenAI.APIError>): string {
  const body = err.error as unknown;
  if (typeof body === "string" && body) return body;
  if (body && typeof body === "object") {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
    const nested = (body as { error?: { message?: unknown } }).error?.message;
    if (typeof nested === "string" && nested) return nested;
  }
  return err.message.replace(/^\d{3}\s+/, "");
}

function errorCode(
  err: InstanceType<typeof OpenAI.APIError>,
): string | undefined {
  const body = err.error as { code?: unknown } | undefined;
  return typeof body?.code === "string" ? body.code : undefined;
}
