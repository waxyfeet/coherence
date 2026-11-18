import { afterEach, describe, expect, it } from "vitest";
import type { LLMConnection } from "@shared/types";
import { ProviderError } from "./errors";
import {
  LONG_WAIT_MS,
  UNKNOWN_PAUSE_MS,
  beforeCall,
  noteRateLimit,
  noteRemaining,
  rateLimitExhausted,
  resetDelayMs,
  resetRateLimits,
  waitFromHeaders,
} from "./rateLimit";

afterEach(resetRateLimits);

const NOW = Date.parse("2026-11-03T00:00:00.000Z");
const conn = (model = "vendor/model:free"): LLMConnection => ({
  id: "conn_rl",
  name: "Gateway",
  provider: "openai-compatible",
  model,
  baseUrl: "https://gateway.example/v1",
  concurrency: 2,
  requestTimeoutSec: 0,
  structuredOutput: "auto",
  vision: "auto",
  refusalFallback: false,
  createdAt: "",
  updatedAt: "",
});
const limited = (retryAfterMs?: number) =>
  new ProviderError("rate limit reached (429)", {
    failure: "rate_limit",
    retryable: true,
    status: 429,
    retryAfterMs,
  });

describe("reading the wait", () => {
  it.each([
    ["epoch milliseconds", String(NOW + 90_000), 90_000],
    ["epoch seconds", String(NOW / 1000 + 90), 90_000],
    ["seconds from now", "90", 90_000],
    ["a duration", "1m30s", 90_000],
    ["a short duration", "250ms", 250],
    ["an HTTP date", new Date(NOW + 90_000).toUTCString(), 90_000],
  ])("reads a reset given as %s", (_label, value, expected) => {
    expect(resetDelayMs(value, NOW)).toBe(expected);
  });

  it("ignores what it can't read", () => {
    expect(resetDelayMs("soon", NOW)).toBeUndefined();
    expect(resetDelayMs("", NOW)).toBeUndefined();
  });

  it("prefers Retry-After, and reads X-RateLimit resets only for a 429", () => {
    const headers = {
      "retry-after": "30",
      "x-ratelimit-reset": String(NOW + 10 * 3_600_000),
    };
    expect(waitFromHeaders(headers, 429, NOW)).toBe(30_000);
    const resetOnly = { "X-RateLimit-Reset": String(NOW + 10 * 3_600_000) };
    expect(waitFromHeaders(resetOnly, 429, NOW)).toBe(10 * 3_600_000);
    expect(waitFromHeaders(resetOnly, 500, NOW)).toBeUndefined();
  });

  it("uses the limit that ran out when several are reported", () => {
    const headers = new Headers({
      "x-ratelimit-remaining-requests": "12",
      "x-ratelimit-reset-requests": "20m",
      "x-ratelimit-remaining-tokens": "0",
      "x-ratelimit-reset-tokens": "6s",
    });
    expect(waitFromHeaders(headers, 429, NOW)).toBe(6000);
  });

  it("takes the latest reset when none says it ran out", () => {
    const headers = {
      "x-ratelimit-reset-requests": "2s",
      "x-ratelimit-reset-tokens": "40s",
    };
    expect(waitFromHeaders(headers, 429, NOW)).toBe(40_000);
  });
});

describe("sharing a limit between calls", () => {
  it("holds other calls through a short wait, then lets them go", async () => {
    let clock = NOW;
    const note = noteRateLimit(conn(), limited(20), clock);
    expect(note.error.retryable).toBe(true);
    expect(note.started).toEqual({ untilMs: NOW + 20, long: false });
    const held: number[] = [];
    await beforeCall(
      conn(),
      undefined,
      (ms) => held.push(ms),
      () => clock,
    );
    expect(held).toEqual([20]);
    clock += 25;
    await expect(
      beforeCall(conn(), undefined, undefined, () => clock),
    ).resolves.toBeUndefined();
  });

  it("pauses the connection and model for a long wait, failing calls without a request", async () => {
    const wait = 10 * 3_600_000;
    const note = noteRateLimit(conn(), limited(wait), NOW);
    expect(note.error.retryable).toBe(false);
    expect(note.started).toEqual({ untilMs: NOW + wait, long: true });
    const err = await beforeCall(
      conn(),
      undefined,
      undefined,
      () => NOW + 1000,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({
      failure: "rate_limit",
      retryable: false,
      retryAfterMs: wait - 1000,
    });
    // Another model on the same connection is not paused.
    await expect(
      beforeCall(conn("vendor/paid"), undefined, undefined, () => NOW + 1000),
    ).resolves.toBeUndefined();
    // After the reset, calls go through again.
    await expect(
      beforeCall(conn(), undefined, undefined, () => NOW + wait + 1),
    ).resolves.toBeUndefined();
  });

  it("only the first call that hits a long limit reports starting the pause", () => {
    const wait = LONG_WAIT_MS * 10;
    expect(noteRateLimit(conn(), limited(wait), NOW).started).toBeDefined();
    expect(
      noteRateLimit(conn(), limited(wait), NOW + 5).started,
    ).toBeUndefined();
  });

  it("leaves a 429 without a wait to the ordinary retries", () => {
    const note = noteRateLimit(conn(), limited(undefined), NOW);
    expect(note.error.retryable).toBe(true);
    expect(note.started).toBeUndefined();
  });

  it("pauses briefly when retries ran out and the service gave no reset time", async () => {
    const err = rateLimitExhausted(conn(), limited(undefined), NOW);
    expect(err).toMatchObject({ retryable: false, retryAfterMs: 0 });
    await expect(
      beforeCall(
        conn(),
        undefined,
        undefined,
        () => NOW + UNKNOWN_PAUSE_MS - 1,
      ),
    ).rejects.toMatchObject({ failure: "rate_limit" });
    await expect(
      beforeCall(
        conn(),
        undefined,
        undefined,
        () => NOW + UNKNOWN_PAUSE_MS + 1,
      ),
    ).resolves.toBeUndefined();
  });

  it("holds the next calls when a success says no requests remain until a reset soon", async () => {
    noteRemaining(
      conn(),
      {
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "15ms",
      },
      NOW,
    );
    const held: number[] = [];
    await beforeCall(
      conn(),
      undefined,
      (ms) => held.push(ms),
      () => NOW,
    );
    expect(held).toEqual([15]);
  });

  it("does nothing when a success has requests left or a far reset", async () => {
    noteRemaining(
      conn(),
      { "x-ratelimit-remaining": "3", "x-ratelimit-reset": "5" },
      NOW,
    );
    noteRemaining(
      conn(),
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3600" },
      NOW,
    );
    const held: number[] = [];
    await beforeCall(
      conn(),
      undefined,
      (ms) => held.push(ms),
      () => NOW,
    );
    expect(held).toEqual([]);
  });
});
