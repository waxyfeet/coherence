/**
 * Helpers shared by the provider adapters: API keys, timeouts + cancellation, error wording.
 * Error messages are written for a business analyst: say what happened and what to do about it.
 */
import { PROVIDER_PRESETS } from "@shared/providers";
import type { LLMConnection, ProviderKind } from "@shared/types";
import { rememberSecret } from "../../security/diagnostics";
import { CancelledError } from "../../errors";
import {
  mayUseEnvironmentKey,
  validateProviderEndpoint,
} from "../../security/endpointPolicy";
import {
  ProviderError,
  cleanProviderMessage,
  isRetryableStatus,
  type ProviderErrorInit,
  type ProviderFailure,
} from "../errors";
import type { LLMContentPart } from "../types";

export const PROVIDER_NAMES: Record<ProviderKind, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "azure-openai": "Azure OpenAI",
  gemini: "Google Gemini",
  ollama: "Ollama",
  "openai-compatible": "The OpenAI-compatible server",
  mock: "The offline demo provider",
};

/** Stored key, else the provider's environment variable (keys are never logged or echoed). */
export function resolveApiKey(
  connection: Pick<LLMConnection, "provider" | "baseUrl" | "apiKey">,
  ...extraEnvVars: string[]
): string | undefined {
  validateProviderEndpoint(connection);
  const stored = connection.apiKey?.trim();
  if (stored) {
    rememberSecret(stored);
    return stored;
  }
  if (!mayUseEnvironmentKey(connection)) return undefined;
  const envVars = [
    PROVIDER_PRESETS[connection.provider].apiKeyEnvVar,
    ...(connection.provider === "gemini"
      ? ["SCREENSCRIBE_V2_GOOGLE_API_KEY"]
      : []),
    ...extraEnvVars,
  ].filter(Boolean) as string[];
  for (const name of envVars) {
    const safeName = name.startsWith("SCREENSCRIBE_V2_")
      ? name
      : `SCREENSCRIBE_V2_${name}`;
    const value = process.env[safeName]?.trim();
    if (value) {
      rememberSecret(value);
      return value;
    }
  }
  return undefined;
}

export function missingKeyError(connection: LLMConnection): ProviderError {
  const preset = PROVIDER_PRESETS[connection.provider];
  const env =
    preset.apiKeyEnvVar && mayUseEnvironmentKey(connection)
      ? ` or set the ${preset.apiKeyEnvVar} environment variable`
      : "";
  return new ProviderError(
    `No API key for ${PROVIDER_NAMES[connection.provider]} — add one to the "${connection.name}" connection in Settings${env}.`,
    { failure: "auth" },
  );
}

export function timeoutMs(connection: LLMConnection): number {
  const seconds =
    connection.requestTimeoutSec > 0
      ? connection.requestTimeoutSec
      : PROVIDER_PRESETS[connection.provider].defaultTimeoutSec;
  return Math.round(seconds * 1000);
}

/**
 * One AbortSignal that fires when the caller cancels OR the request exceeds the connection timeout,
 * remembering which of the two happened so errors can be worded correctly.
 * Streaming adapters call touch() on every event, which turns the timeout into an inactivity timeout:
 * a long answer that keeps arriving is never cut off, a stream that goes quiet still is.
 */
export class RequestGuard {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timedOutFlag = false;
  private lastActivity: number | undefined;
  private readonly onCallerAbort = () => this.controller.abort();

  constructor(
    private readonly callerSignal: AbortSignal | undefined,
    readonly timeoutMs: number,
  ) {
    if (callerSignal?.aborted) this.controller.abort();
    callerSignal?.addEventListener("abort", this.onCallerAbort, { once: true });
    this.arm(timeoutMs);
  }

  private arm(ms: number): void {
    this.timer = setTimeout(() => {
      // touch() only records the time (cheap per stream event); the timer catches up here.
      const quietMs =
        this.lastActivity === undefined
          ? Infinity
          : Date.now() - this.lastActivity;
      if (quietMs < this.timeoutMs) {
        this.arm(this.timeoutMs - quietMs);
        return;
      }
      this.timedOutFlag = true;
      this.controller.abort();
    }, ms);
    this.timer.unref?.();
  }

  /** The provider sent something: the timeout now counts from here. */
  touch(): void {
    this.lastActivity = Date.now();
  }

  /** True once touch() was called, i.e. the provider had started answering. */
  get progressed(): boolean {
    return this.lastActivity !== undefined;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancelled(): boolean {
    return this.callerSignal?.aborted ?? false;
  }

  get timedOut(): boolean {
    return this.timedOutFlag && !this.cancelled;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.callerSignal?.removeEventListener("abort", this.onCallerAbort);
  }

  /** CancelledError / timeout ProviderError when the guard fired, else undefined. */
  abortError(provider: ProviderKind): Error | undefined {
    if (this.cancelled) return new CancelledError();
    if (this.timedOut)
      return this.progressed
        ? stallError(provider, this.timeoutMs)
        : timeoutError(provider, this.timeoutMs);
    return undefined;
  }
}

export function timeoutError(
  provider: ProviderKind,
  ms: number,
): ProviderError {
  const seconds = Math.round(ms / 1000);
  return new ProviderError(
    `${PROVIDER_NAMES[provider]} did not answer within ${seconds} s. Large screens or slow/local models may need a longer request timeout (Settings → AI connections → Advanced).`,
    { failure: "timeout", retryable: true },
  );
}

/**
 * The answer had started streaming, then nothing arrived for the whole timeout. Usually long silent
 * thinking, which an identical retry would only repeat (and be billed for again), so not retryable.
 */
export function stallError(
  provider: ProviderKind,
  ms: number,
  partial?: ProviderErrorInit["partial"],
): ProviderError {
  const seconds = Math.round(ms / 1000);
  return new ProviderError(
    `${PROVIDER_NAMES[provider]} started answering but then sent nothing for ${seconds} s, so the request was stopped. Long thinking on large screens can take this long — raise the request timeout (Settings → AI connections → Advanced) or lower the effort.`,
    { failure: "timeout", retryable: false, partial },
  );
}

const UNDICI_GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

interface UndiciDispatcher {
  dispatch(options: object, handler: unknown): boolean;
}

/**
 * fetch `dispatcher` that switches off undici's own 300 s headers/body timeouts for one request.
 * Node's fetch would otherwise drop any answer that is not streamed and takes over 5 minutes (local
 * models, high reasoning effort) whatever requestTimeoutSec says; the RequestGuard and the SDK
 * timeout bound the request instead. Same approach as @google/genai, so no undici dependency.
 */
export const untimedDispatcher: UndiciDispatcher = {
  dispatch(options, handler) {
    const globals = globalThis as unknown as Record<
      symbol,
      UndiciDispatcher | undefined
    >;
    // Node creates its undici dispatcher lazily.
    if (!globals[UNDICI_GLOBAL_DISPATCHER]) new Headers();
    const dispatcher = globals[UNDICI_GLOBAL_DISPATCHER];
    if (typeof dispatcher?.dispatch !== "function")
      throw new Error("The Node.js fetch dispatcher is not available.");
    return dispatcher.dispatch(
      { ...options, headersTimeout: 0, bodyTimeout: 0 },
      handler,
    );
  },
};

/** fetch() init carrying untimedDispatcher (Node's fetch accepts `dispatcher`; RequestInit does not declare it). */
export const UNTIMED_FETCH_INIT = {
  dispatcher: untimedDispatcher,
} as unknown as RequestInit;

const TRANSPORT_TIMEOUT_CODES = new Set([
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** Node's HTTP client (undici) gave up waiting, as opposed to our own request timeout. */
export function isTransportTimeout(err: unknown): boolean {
  const code = errorCode(err);
  return code !== undefined && TRANSPORT_TIMEOUT_CODES.has(code);
}

/** Network-level failure (DNS, refused, reset). Connection refused on a local server is not worth retrying. */
export function networkError(
  provider: ProviderKind,
  baseUrl: string | undefined,
  err: unknown,
  apiKey?: string,
): ProviderError {
  const code = errorCode(err);
  const where = baseUrl ? ` at ${baseUrl}` : "";
  const detail = cleanProviderMessage(describeCause(err), apiKey, 200);
  if (code && TRANSPORT_TIMEOUT_CODES.has(code)) {
    return new ProviderError(
      `${PROVIDER_NAMES[provider]}${where} sent no data for too long, so Node's HTTP client closed the connection (${detail || code}).`,
      { failure: "timeout", retryable: true },
    );
  }
  if (code === "ECONNREFUSED") {
    const hint =
      provider === "ollama"
        ? 'Start Ollama (open the Ollama app or run "ollama serve") and try again.'
        : provider === "openai-compatible"
          ? "Make sure the server (LM Studio, vLLM, LocalAI…) is running and the base URL is correct."
          : "Check the base URL and your network connection.";
    return new ProviderError(
      `Could not connect to ${PROVIDER_NAMES[provider]}${where}. ${hint}`,
      { failure: "unreachable" },
    );
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new ProviderError(
      `Could not find ${PROVIDER_NAMES[provider]}${where} (DNS lookup failed). Check the base URL and your internet connection.`,
      { failure: "network", retryable: code === "EAI_AGAIN" },
    );
  }
  return new ProviderError(
    `Could not reach ${PROVIDER_NAMES[provider]}${where}: ${detail || "network error"}. Check your network connection.`,
    { failure: "network", retryable: true },
  );
}

function errorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object";
    depth += 1
  ) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function describeCause(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) {
      if (current.message && !parts.includes(current.message))
        parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(": ");
}

export interface HttpFailureContext {
  provider: ProviderKind;
  status: number;
  /** Provider's own error text (already extracted from the body). */
  message: string;
  model: string;
  baseUrl?: string;
  retryAfterMs?: number;
  apiKey?: string;
}

/** Generic HTTP status → BA-readable ProviderError. Adapters special-case before calling this. */
export function httpFailure(ctx: HttpFailureContext): ProviderError {
  if (ctx.status === 400 && explicitlyRejectsImageInput(ctx.message))
    return new ProviderError("This model explicitly rejects image input.", {
      failure: "image_unsupported",
      status: ctx.status,
      definitiveCapability: "image",
    });
  const name = PROVIDER_NAMES[ctx.provider];
  const detail = cleanProviderMessage(ctx.message, ctx.apiKey);
  const suffix = detail ? `: ${detail}` : ".";
  const make = (message: string, failure: ProviderFailure, retryable = false) =>
    new ProviderError(message, {
      failure,
      retryable,
      status: ctx.status,
      retryAfterMs: ctx.retryAfterMs,
    });

  switch (ctx.status) {
    case 401:
      return make(
        `${name} rejected the API key (401). Check the key of this connection in Settings → AI connections.`,
        "auth",
      );
    case 403:
      return make(
        `${name} refused access (403)${suffix} The key may not have access to this model or feature.`,
        "forbidden",
      );
    case 404:
      return make(
        `Model '${ctx.model}' not found at ${name} (404)${suffix} Check the model name in Settings (use "List models").`,
        "not_found",
      );
    case 413:
      return make(
        `The request is too large for ${name} (413) — the screen images or prompt exceed its limits.`,
        "too_large",
      );
    case 429:
      return make(
        `${name} rate limit reached (429)${suffix}`,
        "rate_limit",
        true,
      );
    default:
      if (isRetryableStatus(ctx.status)) {
        return make(
          `${name} is temporarily unavailable (${ctx.status})${suffix}`,
          "server",
          true,
        );
      }
      return make(
        `${name} rejected the request (${ctx.status})${suffix}`,
        ctx.status >= 400 && ctx.status < 500 ? "bad_request" : "other",
      );
  }
}

/** True when a 400 error text is about the JSON schema / response format rather than the prompt. */
export function looksLikeFormatError(message: string): boolean {
  return /response_format|json_schema|output_config|output_format|responseJsonSchema|response_json_schema|responseSchema|response_schema|structured output|schema|format/i.test(
    message,
  );
}

/** Only a capability-specific negative declaration, never an arbitrary HTTP 400 or invalid schema. */
export function explicitlyRejectsStructuredOutput(message: string): boolean {
  return /\b(?:response[_ ]format(?:\s+(?:of type\s+)?json[_ ]schema)?|json[_ ]schema|structured outputs?)\s+(?:is\s+|are\s+)?(?:not supported|unsupported|not available)\b|\b(?:does not support|doesn't support)\s+(?:native\s+)?(?:json[_ ]schema|structured outputs?)\s*(?:[.!;]|$)/i.test(
    message,
  );
}
export function explicitlyRejectsImageInput(message: string): boolean {
  return /\b(?:model|deployment)\b.{0,80}\b(?:does not support|doesn't support|cannot accept)\s+(?:images?(?:\s+inputs?)?|vision(?:\s+inputs?)?)\s*(?:[.!;]|$)|\b(?:image|vision) inputs?\s+(?:is\s+|are\s+)?(?:not supported|unsupported)\b/i.test(
    message,
  );
}

/** Join the text parts (used by adapters whose servers prefer plain-string content). */
export function textOf(parts: LLMContentPart[]): string {
  return parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
}

export function hasImages(parts: LLMContentPart[]): boolean {
  return parts.some((p) => p.type === "image");
}

/** Trailing slashes removed; empty → undefined. */
export function normaliseBaseUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : undefined;
}
