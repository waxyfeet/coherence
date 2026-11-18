import { describe, expect, it } from "vitest";
import {
  CapacityError,
  estimateInput,
  fitRequest,
  RequestBudget,
  workLimits,
} from "./capacity";
import type { LLMConnection } from "@shared/types";
import type { LLMRequest } from "./types";
import { tokenBudget } from "./structured";

const connection = (extra: Partial<LLMConnection> = {}): LLMConnection => ({
  id: "synthetic-capacity",
  name: "Synthetic",
  provider: "openai-compatible",
  model: "unknown-exact-id",
  concurrency: 2,
  requestTimeoutSec: 5,
  structuredOutput: "auto",
  vision: "yes",
  refusalFallback: false,
  createdAt: "2026-10-31T00:00:00Z",
  updatedAt: "2026-10-31T00:00:00Z",
  ...extra,
});
const req = (extra: Partial<LLMRequest> = {}): LLMRequest => ({
  system: "Read exact labels.",
  messages: [
    { role: "user", content: [{ type: "text", text: "Synthetic task" }] },
  ],
  purpose: "synthetic",
  maxOutputTokens: 32768,
  ...extra,
});

describe("capacity-aware automatic requests", () => {
  it("allows compatible Automatic to recover beyond its initial allowance", () => {
    const b = tokenBudget(connection({ modelOutputTokenLimit: 131072 }));
    expect(b.initial).toBeLessThan(b.ceiling);
    expect(b.ceiling).toBeLessThanOrEqual(131072);
    expect(b.initial).toBeGreaterThan(8192);
  });
  it.each([1024, 4096, 16384])(
    "honours a smaller real model limit %i",
    (limit) => {
      const b = tokenBudget(connection({ modelOutputTokenLimit: limit }));
      expect(b.initial).toBeLessThanOrEqual(limit);
      expect(b.ceiling).toBe(limit);
    },
  );
  it("does not promote unknown capacity into a discovered fact", () => {
    const fit = fitRequest(connection(), req());
    expect(fit.source).toContain("unknown");
  });
  it("honours deliberate caps even with a larger per-call request", () => {
    expect(
      tokenBudget(
        connection({ maxOutputTokens: 4096, modelOutputTokenLimit: 131072 }),
        65536,
      ),
    ).toEqual({ initial: 4096, ceiling: 4096 });
  });
  it("reserves combined context for both input and answer", () => {
    const c = connection({ modelContextWindow: 4096 });
    const fit = fitRequest(c, req());
    expect(fit.output).toBeGreaterThan(0);
    expect(fit.input + fit.output).toBeLessThan(4096);
  });
  it("does not subtract completion from a separate input-only limit", () => {
    const fit = fitRequest(connection({ modelInputTokenLimit: 4096 }), req());
    expect(fit.output).toBe(32768);
  });
  it("rejects an oversized known input before inference", () =>
    expect(() =>
      fitRequest(
        connection({ modelInputTokenLimit: 200 }),
        req({ system: "large ".repeat(1000) }),
      ),
    ).toThrow(CapacityError));
  it("includes schema and repair history in the estimate", () => {
    const r = req(),
      initial = estimateInput(r);
    expect(
      estimateInput({
        ...r,
        jsonSchema: {
          name: "x",
          schema: { description: "schema ".repeat(100) },
        },
      }),
    ).toBeGreaterThan(initial);
    expect(
      estimateInput({
        ...r,
        messages: [
          ...r.messages,
          {
            role: "assistant",
            content: [{ type: "text", text: "answer ".repeat(100) }],
          },
        ],
      }),
    ).toBeGreaterThan(initial);
  });
  it("treats images as image overhead, not base64 token text", () => {
    const image = (base64: string) =>
      req({
        messages: [
          {
            role: "user",
            content: [
              { type: "image", image: { mimeType: "image/png", base64 } },
            ],
          },
        ],
      });
    expect(estimateInput(image("x"))).toBe(
      estimateInput(image("x".repeat(100000))),
    );
    expect(estimateInput(image("x"))).toBeGreaterThan(2000);
  });
  it("atomically limits concurrent attempt admission", async () => {
    const b = new RequestBudget({ requests: 2, outputAllowance: 100 });
    const outcomes = await Promise.allSettled(
      [40, 40, 40].map(async (n) => b.admit(n)),
    );
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(2);
    expect(b.snapshot()).toEqual({ requests: 2, reservedOutputAllowance: 80 });
  });
  it("retains unknown usage reservations and rejects without consuming an extra allowance", () => {
    const b = new RequestBudget({ requests: 10, outputAllowance: 100 });
    b.admit(80);
    expect(() => b.admit(21)).toThrow(/allowance/);
    expect(b.snapshot()).toEqual({ requests: 1, reservedOutputAllowance: 80 });
  });
  it("replaces a settled reservation with the reported usage, once", () => {
    const b = new RequestBudget({
      requests: 10,
      outputAllowance: 100,
      inputAllowance: 1000,
    });
    const r = b.admit(80, 600);
    r.settle({ inputTokens: 350, outputTokens: 20 });
    expect(b.snapshot()).toEqual({
      requests: 1,
      reservedOutputAllowance: 20,
      reservedInputEstimate: 350,
    });
    r.settle({ inputTokens: 1, outputTokens: 1 });
    expect(b.snapshot().reservedOutputAllowance).toBe(20);
    expect(() => b.admit(80, 600)).not.toThrow();
  });
  it("keeps a reservation when the provider reported no usage, and each dimension it did not report", () => {
    const b = new RequestBudget({
      requests: 10,
      outputAllowance: 100,
      inputAllowance: 1000,
    });
    b.admit(80, 600).settle({ inputTokens: 0, outputTokens: 0 });
    expect(b.snapshot()).toEqual({
      requests: 1,
      reservedOutputAllowance: 80,
      reservedInputEstimate: 600,
    });
    const c = new RequestBudget({
      requests: 10,
      outputAllowance: 100,
      inputAllowance: 1000,
    });
    c.admit(80, 600).settle({ inputTokens: 0, outputTokens: 30 });
    expect(c.snapshot()).toEqual({
      requests: 1,
      reservedOutputAllowance: 30,
      reservedInputEstimate: 600,
    });
  });
  it("grows the run limits with the work and never lowers them", () => {
    const b = new RequestBudget();
    b.expectWork(4);
    expect(b.limits).toEqual(workLimits(4));
    b.expectWork(40);
    expect(b.limits).toEqual(workLimits(40));
    b.expectWork(2);
    expect(b.limits).toEqual(workLimits(40));
    const generous = new RequestBudget({
      requests: 100000,
      outputAllowance: 10,
      inputAllowance: 10,
    });
    generous.expectWork(1);
    expect(generous.limits.requests).toBe(100000);
    expect(generous.limits.outputAllowance).toBe(workLimits(1).outputAllowance);
  });
  it("sizes work limits generously above a reasoning-heavy run of the same size", () => {
    // Observed on 3 Nov 2026 (4 screens, a reasoning-heavy model): 48 requests, about 490,000 output tokens.
    const four = workLimits(4);
    expect(four.requests).toBeGreaterThanOrEqual(4 * 48);
    expect(four.outputAllowance).toBeGreaterThanOrEqual(4 * 490_000);
    // Never smaller than the fixed limits it replaces.
    expect(workLimits(0)).toEqual(workLimits(1));
    expect(workLimits(1).requests).toBeGreaterThanOrEqual(64);
    expect(workLimits(1).outputAllowance).toBeGreaterThanOrEqual(2_000_000);
  });
});
