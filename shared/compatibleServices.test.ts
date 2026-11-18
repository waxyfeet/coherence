import { describe, expect, it } from "vitest";
import {
  RECOGNISED_SERVICES,
  normaliseCompatibleAddress,
  recognisedService,
} from "./compatibleServices";

describe("normaliseCompatibleAddress", () => {
  it.each([
    // What people paste for OpenRouter (owner test note 2).
    ["openrouter.ai", "https://openrouter.ai/api/v1"],
    ["https://openrouter.ai", "https://openrouter.ai/api/v1"],
    ["https://openrouter.ai/api/v1/", "https://openrouter.ai/api/v1"],
    [
      "https://openrouter.ai/api/v1/chat/completions",
      "https://openrouter.ai/api/v1",
    ],
    ["http://openrouter.ai/api/v1", "https://openrouter.ai/api/v1"],
    ["  api.groq.com/openai/v1/models ", "https://api.groq.com/openai/v1"],
    ["https://api.x.ai/v1/completions", "https://api.x.ai/v1"],
    // Unrecognised services keep their host and path; only the copied endpoint goes.
    [
      "https://llm.example.com/v1/chat/completions",
      "https://llm.example.com/v1",
    ],
    ["llm.example.com/v1", "https://llm.example.com/v1"],
    // A server on this computer or network gets http.
    ["localhost:1234/v1", "http://localhost:1234/v1"],
    ["192.168.1.20:8000/v1/", "http://192.168.1.20:8000/v1"],
    ["http://127.0.0.1:11434/v1", "http://127.0.0.1:11434/v1"],
  ])("turns %j into %j", (input, expected) => {
    expect(normaliseCompatibleAddress(input)?.url).toBe(expected);
  });

  it("says what it changed, and nothing when the address was already final", () => {
    expect(
      normaliseCompatibleAddress("openrouter.ai/api/v1/chat/completions")
        ?.changes,
    ).toEqual(["added https://", "removed /chat/completions"]);
    expect(
      normaliseCompatibleAddress("https://openrouter.ai/api/v1")?.changes,
    ).toEqual([]);
  });

  it("recognises a service without calling it verified", () => {
    expect(normaliseCompatibleAddress("openrouter.ai")?.service?.name).toBe(
      "OpenRouter",
    );
    expect(
      normaliseCompatibleAddress("https://llm.example.com/v1")?.service,
    ).toBeUndefined();
  });

  it("never moves an address to another host", () => {
    for (const input of [
      "https://eu.openrouter.ai/api/v1",
      "https://openrouter.ai.example.com/api/v1",
      "https://api.together.xyz/v1",
    ]) {
      const result = normaliseCompatibleAddress(input)!;
      expect(new URL(result.url).hostname).toBe(new URL(input).hostname);
    }
  });

  it("leaves text that is not an address yet alone", () => {
    expect(normaliseCompatibleAddress("")).toBeUndefined();
    expect(normaliseCompatibleAddress("   ")).toBeUndefined();
    expect(normaliseCompatibleAddress("ftp://example.com")).toBeUndefined();
  });
});

describe("recognised services", () => {
  it("have documented https base URLs on their own hosts", () => {
    for (const s of RECOGNISED_SERVICES) {
      const url = new URL(s.baseUrl);
      expect(url.protocol).toBe("https:");
      expect(s.hosts).toContain(url.hostname);
      expect(recognisedService(s.baseUrl)).toBe(s);
    }
  });
});
