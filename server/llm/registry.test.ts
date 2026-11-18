import { describe, expect, it } from "vitest";
import type { LLMConnection } from "@shared/types";
import { createProvider } from "./registry";

function connection(updatedAt: string, model: string): LLMConnection {
  return {
    id: "conn_registry_test",
    name: "Test",
    provider: "openai",
    model,
    apiKey: "sk-test-registry-000000",
    concurrency: 2,
    requestTimeoutSec: 60,
    structuredOutput: "auto",
    vision: "auto",
    refusalFallback: false,
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt,
  };
}

describe("createProvider", () => {
  it("keeps one adapter per connection version instead of replacing it on every alternation", () => {
    const v1 = connection("2026-10-15T10:00:00.000Z", "gpt-4.1");
    const v2 = connection("2026-10-15T11:00:00.000Z", "gpt-5");
    const first = createProvider(v1);
    const second = createProvider(v2);
    expect(second).not.toBe(first);
    // The older job's next call gets its own adapter back (with what it learned about the endpoint).
    expect(createProvider(v1)).toBe(first);
    expect(createProvider(v2)).toBe(second);
    expect(createProvider({ ...v1 })).toBe(first);
  });
});
