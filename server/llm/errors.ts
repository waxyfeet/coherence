import {
  redactDiagnostic,
  rememberSecret,
  remoteDetail,
} from "../security/diagnostics";
/**
 * LLM-layer error helpers shared by the provider adapters and generateStructured.
 * ProviderError is still an LLMError (callers catch LLMError) but carries the facts the retry and
 * fallback logic needs: why it failed, the HTTP status and any Retry-After hint.
 */
import { CancelledError, LLMError } from "../errors";
import type { LLMResponse } from "./types";

export type ProviderFailure =
  | "image_unsupported"
  | "auth"
  | "forbidden"
  | "not_found"
  | "rate_limit"
  | "quota"
  | "timeout"
  | "network"
  | "unreachable"
  | "server"
  | "bad_request"
  /** The server rejected the JSON schema / JSON mode — the caller should fall back to prompt mode. */
  | "format_unsupported"
  | "too_large"
  | "other";

export interface ProviderErrorInit {
  definitiveCapability?: "image" | "structured";
  failure: ProviderFailure;
  retryable?: boolean;
  status?: number;
  retryAfterMs?: number;
  /**
   * format_unsupported only: false when the 400 may not be about the format at all — the caller falls
   * back for this call but does not remember the downgrade for the connection. Default true.
   */
  rememberFallback?: boolean;
  /** Tokens the provider already billed for this failed attempt (e.g. a stream stopped midway). */
  partial?: { model: string; usage: LLMResponse["usage"] };
}

export class ProviderError extends LLMError {
  readonly definitiveCapability?: "image" | "structured";
  readonly failure: ProviderFailure;
  readonly providerStatus?: number;
  readonly retryAfterMs?: number;
  readonly rememberFallback: boolean;
  readonly partial?: { model: string; usage: LLMResponse["usage"] };

  constructor(message: string, init: ProviderErrorInit) {
    super(message, init.retryable ?? false);
    this.name = "ProviderError";
    this.definitiveCapability = init.definitiveCapability;
    this.failure = init.failure;
    this.providerStatus = init.status;
    this.retryAfterMs = init.retryAfterMs;
    this.rememberFallback = init.rememberFallback ?? true;
    this.partial = init.partial;
  }
}

/** The model declined the request (a refusal) rather than failing it. */
export class ModelDeclinedError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "ModelDeclinedError";
  }
}

/**
 * A rate limit or used-up quota that retries did not clear: the service will not answer for a while, so the run
 * stops with its finished work kept, instead of spending more retries or substituting a lower-quality result
 * (owner test note 5). Substitutes stay for genuine model failures.
 */
export function stopsTheRun(err: unknown): boolean {
  return (
    err instanceof ProviderError &&
    (err.failure === "rate_limit" || err.failure === "quota")
  );
}

/** 408 / 409 / 429 / 5xx (incl. Anthropic's 529 "overloaded") are worth retrying. */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status >= 500 && status !== 501)
  );
}

type HeaderSource =
  Headers | Record<string, string | string[] | undefined> | undefined | null;

function readHeader(headers: HeaderSource, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function")
    return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  const value = key ? record[key] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** Retry-After (seconds or HTTP date) or retry-after-ms, in milliseconds. */
export function retryAfterMsFromHeaders(
  headers: HeaderSource,
): number | undefined {
  const ms = readHeader(headers, "retry-after-ms");
  if (ms && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const value = readHeader(headers, "retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * Remove anything that looks like a secret from text that may reach the BA or the logs.
 * Providers sometimes echo (partially masked) keys in auth errors.
 */
export function redactSecrets(text: string, apiKey?: string): string {
  rememberSecret(apiKey);
  return redactDiagnostic(text);
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return (
    name === "AbortError" ||
    name === "APIUserAbortError" ||
    err instanceof CancelledError
  );
}

/** Throws CancelledError when the caller's signal has been aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CancelledError();
}

/** Short, single-line message from an arbitrary provider error body. */
export function cleanProviderMessage(
  raw: string,
  apiKey?: string,
  max = 400,
): string {
  rememberSecret(apiKey);
  const single = remoteDetail(raw);
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}
