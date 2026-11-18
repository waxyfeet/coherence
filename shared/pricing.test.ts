import { describe, expect, it } from "vitest";
import { MODEL_PRICES, priceFor } from "./pricing";
import { PROVIDER_PRESETS } from "./providers";

describe("priceFor", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "does not treat inherited %s as a known model price",
    (id) => {
      expect(priceFor("gemini", id)).toBeUndefined();
    },
  );
  it("prices dated and versioned snapshots like their model", () => {
    expect(priceFor("openai", "gpt-4o-2024-08-06")).toBe(
      MODEL_PRICES["gpt-4o"],
    );
    expect(priceFor("azure-openai", "gpt-4o-mini-2024-07-18")).toBe(
      MODEL_PRICES["gpt-4o-mini"],
    );
    expect(priceFor("openai", "gpt-5-2025-08-07")).toBe(MODEL_PRICES["gpt-5"]);
    expect(priceFor("gemini", "gemini-2.5-flash-preview-05-20")).toBe(
      MODEL_PRICES["gemini-2.5-flash"],
    );
    expect(priceFor("anthropic", "claude-sonnet-4-6@20260101")).toBe(
      MODEL_PRICES["claude-sonnet-4-6"],
    );
  });

  it("never charges a cheaper variant at the flagship price", () => {
    expect(priceFor("openai", "gpt-4o-mini")).toEqual({
      inputPerMTok: 0.15,
      outputPerMTok: 0.6,
    });
    expect(priceFor("openai", "gpt-4.1-nano")).toBe(
      MODEL_PRICES["gpt-4.1-nano"],
    );
    expect(priceFor("openai", "gpt-4.1-mini")).toBe(
      MODEL_PRICES["gpt-4.1-mini"],
    );
    expect(priceFor("openai", "gpt-5-nano")).toBe(MODEL_PRICES["gpt-5-nano"]);
    expect(priceFor("gemini", "gemini-2.5-flash-lite")).toBe(
      MODEL_PRICES["gemini-2.5-flash-lite"],
    );
    // Unknown variants show token counts only rather than a wrong price.
    expect(priceFor("openai", "gpt-4o-search-preview-x")).toBeUndefined();
    expect(priceFor("anthropic", "claude-opus-5-1")).toBeUndefined();
  });

  it("keeps local and offline providers free", () => {
    expect(priceFor("ollama", "qwen2.5vl:7b")).toEqual({
      inputPerMTok: 0,
      outputPerMTok: 0,
    });
    expect(
      priceFor("openai-compatible", "gpt-4o", "http://localhost:1234/v1"),
    ).toEqual({ inputPerMTok: 0, outputPerMTok: 0 });
  });
});

describe("provider presets", () => {
  it("prices every default and suggested model of the paid providers", () => {
    for (const kind of ["anthropic", "openai", "gemini"] as const) {
      const preset = PROVIDER_PRESETS[kind];
      for (const id of [
        preset.defaultModel,
        ...preset.suggestedModels.map((m) => m.id),
      ]) {
        expect(priceFor(kind, id), `${kind} ${id}`).toBeDefined();
      }
    }
  });

  it("keeps the new GPT-5.x and Gemini 3.x models apart from their older namesakes", () => {
    expect(priceFor("openai", "gpt-5.6-luna")).toEqual({
      inputPerMTok: 0.2,
      outputPerMTok: 1.2,
    });
    expect(priceFor("openai", "gpt-5.4-mini")).not.toBe(
      MODEL_PRICES["gpt-5.4"],
    );
    expect(priceFor("gemini", "gemini-3.5-flash-lite")).toEqual({
      inputPerMTok: 0.3,
      outputPerMTok: 2.5,
    });
    expect(priceFor("gemini", "gemini-3.1-flash-lite")).not.toBe(
      MODEL_PRICES["gemini-3.8-flash"],
    );
  });

  it("suggests only vision models for Ollama, and prices them as free", () => {
    const ollama = PROVIDER_PRESETS.ollama;
    expect(ollama.suggestedModels.map((m) => m.id)).toEqual([
      "qwen3-vl:8b-instruct",
      "qwen3-vl:30b-a3b-instruct",
      "gemma3:27b",
    ]);
    expect(ollama.suggestedModels.every((m) => m.vision)).toBe(true);
    expect(priceFor("ollama", ollama.defaultModel)).toEqual({
      inputPerMTok: 0,
      outputPerMTok: 0,
    });
  });
});
