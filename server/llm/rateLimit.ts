/**
 * Rate limits, read from what the service says and shared between the calls of a connection and model.
 *
 * - The wait comes from Retry-After / retry-after-ms or, for a 429, the common X-RateLimit-* and RateLimit-Reset
 *   headers, in whichever form the service uses: seconds, epoch seconds or milliseconds, an HTTP date, or a
 *   duration such as "6m0s". There are no per-service rules.
 * - A short wait holds every call to that connection and model until it passes. A long one (a used-up daily
 *   allowance, say) pauses them: calls fail at once, without a request, until the reset, so parallel tasks stop
 *   together instead of each spending its retries.
 */
import type { LLMConnection } from "@shared/types";
import { ProviderError, retryAfterMsFromHeaders } from "./errors";
import { sleep } from "./retry";

type HeaderSource =
  Headers | Record<string, string | string[] | undefined> | undefined | null;

/** A wait longer than this pauses the connection and model instead of retrying inside the run. */
export const LONG_WAIT_MS = 60_000;
/** How long calls stop when retries ran out and the service gave no reset time. */
export const UNKNOWN_PAUSE_MS = 60_000;

function header(headers: HeaderSource, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function")
    return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  const value = key ? record[key] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/** Milliseconds until a reset value, or undefined when it can't be read. */
export function resetDelayMs(
  value: string,
  now = Date.now(),
): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(text)) {
    let total = 0;
    for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g))
      total += Number(amount) * UNITS[unit];
    return Math.round(total);
  }
  const n = Number(text);
  if (Number.isFinite(n)) {
    if (n > 1e12) return Math.max(0, n - now); // epoch milliseconds
    if (n > 1e9) return Math.max(0, n * 1000 - now); // epoch seconds
    return Math.max(0, n * 1000); // seconds from now
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

const RESETS: [reset: string, remaining: string][] = [
  ["x-ratelimit-reset", "x-ratelimit-remaining"],
  ["x-ratelimit-reset-requests", "x-ratelimit-remaining-requests"],
  ["x-ratelimit-reset-tokens", "x-ratelimit-remaining-tokens"],
  ["x-rate-limit-reset", "x-rate-limit-remaining"],
  ["ratelimit-reset", "ratelimit-remaining"],
];

/**
 * How long to wait after an error response. Retry-After always counts; the X-RateLimit-* resets only for a 429,
 * preferring a limit whose remaining count is 0 (the one that was hit) and otherwise the latest reset.
 */
export function waitFromHeaders(
  headers: HeaderSource,
  status: number | undefined,
  now = Date.now(),
): number | undefined {
  const retryAfter = retryAfterMsFromHeaders(headers);
  if (retryAfter !== undefined || status !== 429) return retryAfter;
  const resets = RESETS.flatMap(([resetName, remainingName]) => {
    const raw = header(headers, resetName);
    const delay = raw === undefined ? undefined : resetDelayMs(raw, now);
    if (delay === undefined) return [];
    const remaining = Number(header(headers, remainingName));
    return [{ delay, exhausted: Number.isFinite(remaining) && remaining <= 0 }];
  });
  const hit = resets.filter((r) => r.exhausted);
  const pool = hit.length ? hit : resets;
  return pool.length ? Math.max(...pool.map((r) => r.delay)) : undefined;
}

interface Pause {
  until: number;
  /** Set for a long pause: calls fail at once with it. A short pause only holds them. */
  error?: ProviderError;
}

const pauses = new Map<string, Pause>();
const keyOf = (connection: LLMConnection) =>
  `${connection.id}\u0000${connection.model}`;

/** A non-retryable rate-limit error saying how long the pause lasts. */
function pausedError(err: ProviderError, waitMs: number): ProviderError {
  return new ProviderError(err.message, {
    failure: "rate_limit",
    retryable: false,
    status: err.providerStatus,
    retryAfterMs: waitMs,
  });
}

/**
 * Before a call: fails at once while the connection and model are paused, and waits out a short hold.
 * `onHold` is told how long the call waits.
 */
export async function beforeCall(
  connection: LLMConnection,
  signal: AbortSignal | undefined,
  onHold?: (ms: number) => void,
  now = Date.now,
): Promise<void> {
  const key = keyOf(connection);
  const pause = pauses.get(key);
  if (!pause) return;
  const left = pause.until - now();
  if (left <= 0) {
    pauses.delete(key);
    return;
  }
  if (pause.error) throw pausedError(pause.error, left);
  onHold?.(left);
  await sleep(left, signal);
}

export interface RateLimitNote {
  /** What the caller throws: the original (retryable) error, or a non-retryable one for a long pause. */
  error: ProviderError;
  /** Set when this call started a pause or hold that other calls will see. */
  started?: { untilMs: number; long: boolean };
}

/** After a 429: share its wait with the other calls of this connection and model. */
export function noteRateLimit(
  connection: LLMConnection,
  err: ProviderError,
  now = Date.now(),
): RateLimitNote {
  const wait = err.retryAfterMs;
  if (wait === undefined || wait <= 0) return { error: err };
  const key = keyOf(connection);
  const until = now + wait;
  const current = pauses.get(key);
  const long = wait > LONG_WAIT_MS;
  const error = long ? pausedError(err, wait) : err;
  // Already paused (or held, for a short wait): keep the later end, but it is not news.
  if (current && current.until > now && (current.error || !long)) {
    if (until > current.until) pauses.set(key, { ...current, until });
    return { error };
  }
  pauses.set(key, { until, ...(long ? { error } : {}) });
  return { error, started: { untilMs: until, long } };
}

/**
 * Retries ran out on a 429. Pause the connection and model for the time the service gave, or briefly when it
 * gave none, so the run's other calls stop instead of repeating the same attempts.
 */
export function rateLimitExhausted(
  connection: LLMConnection,
  err: ProviderError,
  now = Date.now(),
): ProviderError {
  const wait =
    err.retryAfterMs && err.retryAfterMs > 0
      ? err.retryAfterMs
      : UNKNOWN_PAUSE_MS;
  const error = pausedError(err, wait);
  const key = keyOf(connection);
  const current = pauses.get(key);
  if (!current?.error || current.until < now + wait)
    pauses.set(key, { until: now + wait, error });
  // The run reports a reset time only when the service gave one.
  return err.retryAfterMs && err.retryAfterMs > 0 ? error : pausedError(err, 0);
}

/**
 * A successful answer said few requests remain: hold the next calls until the window resets, when that is
 * soon. Nothing happens when the service doesn't say.
 */
export function noteRemaining(
  connection: LLMConnection,
  headers: HeaderSource,
  now = Date.now(),
): void {
  for (const [resetName, remainingName] of RESETS) {
    const remaining = Number(header(headers, remainingName));
    const raw = header(headers, resetName);
    if (!Number.isFinite(remaining) || remaining > 0 || raw === undefined)
      continue;
    const delay = resetDelayMs(raw, now);
    if (delay === undefined || delay <= 0 || delay > LONG_WAIT_MS) continue;
    const key = keyOf(connection);
    const current = pauses.get(key);
    // A long pause already stops every call; a hold only ever grows.
    if (!current?.error && (!current || current.until < now + delay))
      pauses.set(key, { until: now + delay });
  }
}

/** Tests only. */
export function resetRateLimits(): void {
  pauses.clear();
}
