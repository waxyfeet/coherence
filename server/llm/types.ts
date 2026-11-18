/**
 * OWNER: llm builder (this file is a frozen contract — extend, don't change existing members).
 * Provider-neutral request/response shapes. Every provider adapter in ./providers implements LLMProvider.
 */
import type { LLMConnection } from "@shared/types";

export type LLMImageMime =
  "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface LLMImage {
  mimeType: LLMImageMime;
  /** Base64 without the data: prefix and without newlines. */
  base64: string;
  /** Optional caption placed as text right before the image, e.g. "Login — part 2 of 3". */
  label?: string;
  /**
   * (Extension) Which part of the FULL screen image this image shows, in percent (0-100).
   * Set by prepareImageForLLM for tiles so callers can convert tile-relative positions back to
   * full-image percentages: fullY = topPct + tileY × (bottomPct − topPct) / 100.
   */
  region?: LLMImageRegion;
}

/** Percent (0-100) of the full screen image covered by a tile. */
export interface LLMImageRegion {
  /** 1-based tile index and tile count (1 of 1 for an untiled image). */
  index: number;
  count: number;
  leftPct: number;
  topPct: number;
  rightPct: number;
  bottomPct: number;
}

export type LLMContentPart =
  { type: "text"; text: string } | { type: "image"; image: LLMImage };

export interface LLMMessage {
  role: "user" | "assistant";
  content: LLMContentPart[];
}

export interface JsonSchemaSpec {
  /** [a-zA-Z0-9_-], ≤ 64 chars (OpenAI requirement). */
  name: string;
  /** JSON Schema (draft 2020-12 subset) produced from a zod schema and sanitised per provider. */
  schema: Record<string, unknown>;
  description?: string;
}

export interface LLMRequest {
  system: string;
  messages: LLMMessage[];
  maxOutputTokens?: number;
  /** Enforce this schema natively when the provider supports it. */
  jsonSchema?: JsonSchemaSpec;
  /** Ask for a JSON object response (JSON mode) without schema enforcement. */
  json?: boolean;
  signal?: AbortSignal;
  /** Short tag for logs, e.g. "screen-analysis:Login". */
  purpose: string;
  /** Called immediately before EACH physical inference attempt, including adapter parameter fallbacks. */
  beforeAttempt?: () => void;
  /** Preserve structured-task policy across native/JSON/prompt format fallback. */
  structuredTask?: boolean;
  /** Told about each streamed piece of the answer, for live progress. Adapters that cannot stream never call it. */
  onStream?: (delta: StreamDelta) => void;
}

/** One streamed piece: answer characters, or a sign the model is reasoning. */
export interface StreamDelta {
  text?: number;
  thinking?: boolean;
}

/** The AI requests in flight for a job (live progress; tester build WP6). */
export interface LiveCalls {
  start(purpose: string, model: string): LiveCall;
}
export interface LiveCall {
  stream(delta: StreamDelta): void;
  end(): void;
}

export type LLMStopReason = "end" | "max_tokens" | "refusal" | "other";

export interface LLMResponse {
  /** Optional controls actually accepted on this successful request, not guessed from model names. */
  acceptedControls?: ("temperature" | "reasoning-effort")[];
  /** Concatenated text output (thinking excluded). */
  text: string;
  /** Model that actually served the request (may differ under refusal fallback). */
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    visibleOutputTokens?: number;
    /** (Extension) Part of inputTokens read from the provider's prompt cache (billed at a discount). */
    cacheReadInputTokens?: number;
    /** (Extension) Part of inputTokens written to the provider's prompt cache (billed at a premium). */
    cacheWriteInputTokens?: number;
  };
  stopReason: LLMStopReason;
  /** Explanation when stopReason === 'refusal'. */
  refusalMessage?: string;
}

export interface ModelInfo {
  id: string;
  label?: string;
  vision?: boolean;
}

export interface LLMProvider {
  readonly connection: LLMConnection;
  /** Effective image support (connection.vision resolved against the preset). */
  readonly supportsVision: boolean;
  /** Whether this adapter can enforce a JSON schema natively. */
  readonly supportsNativeSchema: boolean;
  /**
   * One completion. Implementations must: honour req.signal; apply connection.requestTimeoutSec;
   * throw LLMError (from ../errors) with a BA-readable message and `retryable` set for 408/409/429/5xx/network.
   * Never include the API key in error messages.
   */
  complete(req: LLMRequest): Promise<LLMResponse>;
  listModels(): Promise<ModelInfo[]>;
}
