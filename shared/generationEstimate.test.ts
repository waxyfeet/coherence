import { expect, it } from "vitest";
import { estimateGeneration } from "./generationEstimate";
it("keeps an unknown writer price unknown rather than presenting a partial total", () => {
  const known = {
    provider: "openai" as const,
    model: "gpt-4o",
    concurrency: 2,
  };
  const unknown = {
    provider: "openai-compatible" as const,
    model: "unknown",
    baseUrl: "https://fixture.invalid/v1",
    concurrency: 2,
  };
  expect(
    estimateGeneration({
      screenCount: 3,
      screensToRead: 3,
      thoroughness: "standard",
      vision: known,
      text: unknown,
    }).costUsd,
  ).toBeUndefined();
});
it("accounts for thorough passes and preserves an explicit zero-charge offline estimate", () => {
  const c = {
    provider: "ollama" as const,
    model: "fixture-vl",
    concurrency: 1,
  };
  const standard = estimateGeneration({
    screenCount: 4,
    screensToRead: 4,
    thoroughness: "standard",
    vision: c,
  });
  const thorough = estimateGeneration({
    screenCount: 4,
    screensToRead: 4,
    thoroughness: "thorough",
    vision: c,
  });
  expect(thorough.inputTokens).toBeGreaterThan(standard.inputTokens);
  const mock = { ...c, provider: "mock" as const };
  expect(
    estimateGeneration({
      screenCount: 4,
      screensToRead: 4,
      thoroughness: "standard",
      vision: mock,
    }).costUsd,
  ).toBe(0);
});
