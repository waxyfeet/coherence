/**
 * Retry with exponential backoff + jitter for retryable LLM errors (429 / 408 / 409 / 5xx / network).
 * Honours the provider's Retry-After hint when it gives one. Sleeping is abortable.
 */
import { CancelledError, LLMError } from "../errors";
import { ProviderError } from "./errors";

export interface RetryPolicy {
  /** Total attempts including the first. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Upper bound for a provider-supplied Retry-After. */
  maxRetryAfterMs: number;
}

export interface RetryInfo {
  /** The attempt that just failed (1-based). */
  attempt: number;
  attempts: number;
  delayMs: number;
  error: LLMError;
}

/** Abortable sleep: rejects with CancelledError when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CancelledError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Delay before retrying after `attempt` failed. */
export function retryDelayMs(
  attempt: number,
  error: LLMError,
  policy: RetryPolicy,
  random = Math.random,
): number {
  const retryAfter =
    error instanceof ProviderError ? error.retryAfterMs : undefined;
  if (retryAfter !== undefined) {
    // Small jitter so parallel calls that were rate-limited together don't return in lock-step.
    return (
      Math.min(retryAfter, policy.maxRetryAfterMs) + Math.floor(random() * 250)
    );
  }
  const exp = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** (attempt - 1),
  );
  return Math.min(
    policy.maxDelayMs,
    Math.floor(exp / 2 + (random() * exp) / 2) +
      Math.floor(random() * policy.baseDelayMs * 0.25),
  );
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  options: { signal?: AbortSignal; onRetry?: (info: RetryInfo) => void } = {},
): Promise<T> {
  const { signal, onRetry } = options;
  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted) throw new CancelledError();
    try {
      return await fn(attempt);
    } catch (err) {
      if (err instanceof CancelledError || signal?.aborted)
        throw err instanceof CancelledError ? err : new CancelledError();
      if (
        !(err instanceof LLMError) ||
        !err.retryable ||
        attempt >= policy.attempts
      )
        throw err;
      const delayMs = retryDelayMs(attempt, err, policy);
      onRetry?.({ attempt, attempts: policy.attempts, delayMs, error: err });
      await sleep(delayMs, signal);
    }
  }
}
