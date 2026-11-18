import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LLMConnection, LogLevel } from "@shared/types";
import { CancelledError, LLMError } from "../errors";
import { ProviderError } from "./errors";
import type { LLMProvider, LLMRequest, LLMResponse, ModelInfo } from "./types";

const registry = vi.hoisted(() => ({ provider: undefined as unknown }));

vi.mock("./registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./registry")>();
  return { ...actual, createProvider: () => registry.provider };
});

const {
  configureLLMRuntime,
  generateStructured,
  generateText,
  parseStructured,
  tokenBudget,
  usageReportFor,
} = await import("./structured");

type Step =
  | LLMResponse
  | Error
  | ((req: LLMRequest) => LLMResponse | Promise<LLMResponse>);

class FakeProvider implements LLMProvider {
  readonly calls: LLMRequest[] = [];
  active = 0;
  maxActive = 0;

  constructor(
    readonly connection: LLMConnection,
    private readonly script: Step[],
    readonly supportsNativeSchema = true,
    readonly supportsVision = true,
  ) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    // Snapshot: generateStructured appends repair turns to the same array afterwards.
    this.calls.push({ ...req, messages: [...req.messages] });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const step = this.script.shift();
      if (!step) throw new Error("fake provider: script exhausted");
      if (step instanceof Error) throw step;
      return typeof step === "function" ? await step(req) : step;
    } finally {
      this.active -= 1;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
}

let seq = 0;
function connection(partial: Partial<LLMConnection> = {}): LLMConnection {
  seq += 1;
  return {
    id: `conn_test_${seq}`,
    name: "Test connection",
    provider: "anthropic",
    model: "claude-opus-5-5",
    concurrency: 4,
    requestTimeoutSec: 60,
    structuredOutput: "auto",
    vision: "auto",
    refusalFallback: true,
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
    ...partial,
  };
}

function reply(text: string, extra: Partial<LLMResponse> = {}): LLMResponse {
  return {
    text,
    model: "claude-opus-5-5",
    usage: { inputTokens: 1000, outputTokens: 500 },
    stopReason: "end",
    ...extra,
  };
}

const Schema = z.object({
  title: z.string(),
  items: z.array(z.object({ key: z.string(), required: z.boolean() })),
  note: z.string().optional(),
});
type Out = z.infer<typeof Schema>;
const GOOD: Out = { title: "Login", items: [{ key: "email", required: true }] };

function setup(
  conn: LLMConnection,
  script: Step[],
  native = true,
  vision = true,
) {
  const provider = new FakeProvider(conn, script, native, vision);
  registry.provider = provider;
  const logs: { level: LogLevel; message: string }[] = [];
  const usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
  }[] = [];
  const base = {
    connection: conn,
    system: "You are a senior business analyst.",
    content: [{ type: "text" as const, text: "Analyse the Login screen." }],
    purpose: "screen-analysis:Login",
    schema: Schema,
    schemaName: "screen_analysis",
    mock: () => GOOD,
    log: (level: LogLevel, message: string) => logs.push({ level, message }),
    onUsage: (u: {
      inputTokens: number;
      outputTokens: number;
      costUsd?: number;
    }) => usage.push(u),
  };
  return { provider, logs, usage, base };
}

beforeAll(() => {
  configureLLMRuntime({
    baseDelayMs: 1,
    maxDelayMs: 5,
    maxRetryAfterMs: 20,
    mockDelayMs: 0,
  });
});
afterAll(() => {
  configureLLMRuntime({
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    maxRetryAfterMs: 120_000,
  });
});

describe("generateStructured — native mode", () => {
  it("sends the sanitised schema natively and returns validated data with priced usage", async () => {
    const { provider, usage, logs, base } = setup(connection(), [
      reply(JSON.stringify(GOOD)),
    ]);
    const result = await generateStructured(base);
    expect(result).toEqual(GOOD);
    const req = provider.calls[0];
    expect(req.jsonSchema?.name).toBe("screen_analysis");
    expect(req.jsonSchema?.schema.additionalProperties).toBe(false);
    expect(req.system).toBe(base.system);
    expect(req.maxOutputTokens).toBe(8192);
    // claude-opus-5-5: $4 in / $20 out per MTok → 1000 in + 500 out = $0.014
    expect(usage).toHaveLength(1);
    expect(usage[0].costUsd).toBeCloseTo(0.014, 6);
    expect(
      logs.some(
        (l) =>
          l.level === "debug" && l.message.includes("screen-analysis:Login"),
      ),
    ).toBe(true);
  });

  it("prices Anthropic prompt-cache reads at a discount", () => {
    const conn = connection();
    const report = usageReportFor(
      conn,
      reply("{}", {
        usage: {
          inputTokens: 1000,
          outputTokens: 0,
          cacheReadInputTokens: 800,
          cacheWriteInputTokens: 0,
        },
      }),
    );
    expect(report.inputTokens).toBe(1000);
    expect(report.costUsd).toBeCloseTo(((200 + 80) * 4) / 1_000_000, 9);
  });

  it("reports undefined cost for unknown models and 0 for local ones", () => {
    expect(
      usageReportFor(
        connection({ provider: "openai", model: "mystery-model" }),
        reply("{}", { model: "mystery-model" }),
      ).costUsd,
    ).toBeUndefined();
    expect(
      usageReportFor(
        connection({ provider: "ollama", model: "qwen2.5vl:7b" }),
        reply("{}", { model: "qwen2.5vl:7b" }),
      ).costUsd,
    ).toBe(0);
  });
});

describe("generateStructured — repair", () => {
  it("sends one repair turn with the zod issues, then succeeds", async () => {
    const bad = JSON.stringify({ title: "Login", items: [{ key: "email" }] });
    const { provider, logs, base } = setup(connection(), [
      reply(bad),
      reply(JSON.stringify(GOOD)),
    ]);
    expect(await generateStructured(base)).toEqual(GOOD);
    expect(provider.calls).toHaveLength(2);
    const second = provider.calls[1].messages;
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second[1].content[0]).toEqual({ type: "text", text: bad });
    const repairText = (second[2].content[0] as { text: string }).text;
    expect(repairText).toContain("items.0.required");
    expect(repairText).toContain("corrected JSON object only");
    expect(
      logs.some(
        (l) => l.level === "warn" && l.message.includes("correct it (1 of 2)"),
      ),
    ).toBe(true);
  });

  it("repairs invalid JSON too", async () => {
    const { provider, base } = setup(connection(), [
      reply('Sorry, here: {"title": '),
      reply(`\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\``),
    ]);
    expect(await generateStructured(base)).toEqual(GOOD);
    expect(
      (provider.calls[1].messages[2].content[0] as { text: string }).text,
    ).toContain("not a valid JSON object");
  });

  it("gives up after 2 repair turns with a readable error", async () => {
    const bad = reply(JSON.stringify({ title: 1 }));
    const { provider, base } = setup(connection(), [bad, bad, bad]);
    await expect(generateStructured(base)).rejects.toThrow(
      /did not match the expected structure after 2 correction attempt/,
    );
    expect(provider.calls).toHaveLength(3);
  });

  it("accepts null for optional fields (OpenAI strict makes them nullable)", async () => {
    const { base } = setup(connection(), [
      reply(JSON.stringify({ ...GOOD, note: null })),
    ]);
    expect(await generateStructured(base)).toEqual(GOOD);
  });
});

describe("generateStructured — retries", () => {
  it("retries retryable errors honouring retry-after, then succeeds", async () => {
    const rateLimited = new ProviderError(
      "Anthropic rate limit reached (429).",
      { failure: "rate_limit", retryable: true, status: 429, retryAfterMs: 5 },
    );
    const { provider, logs, usage, base } = setup(connection(), [
      rateLimited,
      reply(JSON.stringify(GOOD)),
    ]);
    expect(await generateStructured(base)).toEqual(GOOD);
    expect(provider.calls).toHaveLength(2);
    expect(usage).toHaveLength(1);
    expect(
      logs.some(
        (l) => l.level === "warn" && l.message.includes("attempt 2 of 4"),
      ),
    ).toBe(true);
  });

  it("stops after 4 attempts", async () => {
    const overloaded = () =>
      new ProviderError("Anthropic is temporarily unavailable (529).", {
        failure: "server",
        retryable: true,
        status: 529,
      });
    const { provider, base } = setup(connection(), [
      overloaded(),
      overloaded(),
      overloaded(),
      overloaded(),
      reply("{}"),
    ]);
    await expect(generateStructured(base)).rejects.toThrow(
      /temporarily unavailable/,
    );
    expect(provider.calls).toHaveLength(4);
  });

  it("does not retry non-retryable errors", async () => {
    const auth = new ProviderError("Anthropic rejected the API key (401).", {
      failure: "auth",
      status: 401,
    });
    const { provider, base } = setup(connection(), [auth, reply("{}")]);
    await expect(generateStructured(base)).rejects.toBe(auth);
    expect(provider.calls).toHaveLength(1);
  });

  it("counts the tokens of an attempt that failed midway", async () => {
    const stalled = new ProviderError(
      "Anthropic started answering but then sent nothing for 600 s",
      {
        failure: "timeout",
        partial: {
          model: "claude-opus-5-5",
          usage: { inputTokens: 1000, outputTokens: 500 },
        },
      },
    );
    const { usage, base } = setup(connection(), [stalled]);
    await expect(generateStructured(base)).rejects.toBe(stalled);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: 1000, outputTokens: 500 });
    expect(usage[0].costUsd).toBeCloseTo(0.014, 6);
  });

  it("wraps unexpected adapter errors in LLMError", async () => {
    const { base } = setup(connection(), [new TypeError("boom")]);
    const err = await generateStructured(base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as Error).message).not.toContain("boom");
    expect((err as Error).message).toContain("Reference");
  });
});

describe("generateStructured — truncation and refusal", () => {
  it("does not blame the saved cap when remaining context imposed the smaller request", async () => {
    const c = connection({
      provider: "openai-compatible",
      modelContextWindow: 4096,
      maxOutputTokens: 16384,
    });
    const { provider, base } = setup(c, [
      reply("{", { stopReason: "max_tokens" }),
    ]);
    const error = await generateStructured(base).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LLMError);
    expect((error as Error).message).not.toContain("saved output cap");
    expect(provider.calls[0].maxOutputTokens).toBeLessThan(4096);
    expect(provider.calls).toHaveLength(1);
  });
  it("Automatic has bounded recovery for unknown capacity; request fitting separately enforces reported local context", () => {
    expect(tokenBudget(connection({ provider: "ollama" }))).toEqual({
      initial: 8192,
      ceiling: 64000,
    });
    expect(tokenBudget(connection({ provider: "openai-compatible" }))).toEqual({
      initial: 8192,
      ceiling: 64000,
    });
    expect(
      tokenBudget(
        connection({ provider: "openai-compatible", maxOutputTokens: 20000 }),
      ),
    ).toEqual({ initial: 20000, ceiling: 20000 });
  });
  it("Automatic Gemini can grow once within the bounded application and documented model ceilings", async () => {
    const { provider, base } = setup(
      connection({ provider: "gemini", model: "gemini-3.5-flash-lite" }),
      [reply("{", { stopReason: "max_tokens" }), reply(JSON.stringify(GOOD))],
    );
    await expect(generateStructured(base)).resolves.toEqual(GOOD);
    expect(provider.calls.map((c) => c.maxOutputTokens)).toEqual([
      32768, 65536,
    ]);
  });
  it("a smaller discovered model limit bounds both the initial request and retry", async () => {
    const c = connection({
      provider: "gemini",
      model: "synthetic-small-model",
      modelOutputTokenLimit: 4096,
    });
    expect(tokenBudget(c)).toEqual({ initial: 4096, ceiling: 4096 });
    const { provider, base } = setup(c, [
      reply("{", { stopReason: "max_tokens" }),
    ]);
    await expect(generateStructured(base)).rejects.toThrow(
      /bounded automatic recovery/,
    );
    expect(provider.calls).toHaveLength(1);
  });
  it("model limits also bound an intentionally larger manual cap without lifting it", () => {
    expect(
      tokenBudget(
        connection({ modelOutputTokenLimit: 8192, maxOutputTokens: 16000 }),
      ),
    ).toEqual({ initial: 8192, ceiling: 8192 });
    expect(
      tokenBudget(
        connection({ modelOutputTokenLimit: 64000, maxOutputTokens: 1000 }),
      ),
    ).toEqual({ initial: 1000, ceiling: 1000 });
  });
  it("retries once with doubled max tokens after a truncated answer", async () => {
    const { provider, base } = setup(connection(), [
      reply('{"title": "Lo', { stopReason: "max_tokens" }),
      reply(JSON.stringify(GOOD)),
    ]);
    expect(
      await generateStructured({ ...base, maxOutputTokens: 8000 }),
    ).toEqual(GOOD);
    expect(provider.calls.map((c) => c.maxOutputTokens)).toEqual([8000, 16000]);
  });

  it("caps the doubled budget at 64000 and fails readably when still truncated", async () => {
    const cut = reply('{"title": "Lo', { stopReason: "max_tokens" });
    const { provider, base } = setup(connection(), [cut, cut]);
    await expect(
      generateStructured({ ...base, maxOutputTokens: 40_000 }),
    ).rejects.toThrow(/bounded automatic recovery/);
    expect(provider.calls.map((c) => c.maxOutputTokens)).toEqual([
      40_000, 64_000,
    ]);
  });

  it("treats the connection max output tokens as a hard limit", async () => {
    const conn = connection({ maxOutputTokens: 1000 });
    expect(tokenBudget(conn, 5000)).toEqual({ initial: 1000, ceiling: 1000 });
    const { provider, base } = setup(conn, [
      reply("{", { stopReason: "max_tokens" }),
    ]);
    await expect(
      generateStructured({ ...base, maxOutputTokens: 5000 }),
    ).rejects.toThrow(/saved output cap/);
    expect(provider.calls).toHaveLength(1);
  });

  it("explains a Gemini screenshot cap without suggesting use-case granularity or making another paid attempt", async () => {
    const { provider, usage, base } = setup(
      connection({
        provider: "gemini",
        model: "gemini-3.5-flash-lite",
        maxOutputTokens: 16_384,
      }),
      [
        reply('{"title": "Or', {
          stopReason: "max_tokens",
          usage: { inputTokens: 4553, outputTokens: 16367 },
        }),
      ],
    );
    const error = await generateStructured({
      ...base,
      purpose: "screen-analysis:Orders",
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(LLMError);
    expect((error as Error).message).toContain("saved output cap");
    expect((error as Error).message).toContain("respected that cap");
    expect((error as Error).message).toContain("completed readings");
    expect((error as Error).message).not.toContain("use finer granularity");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].maxOutputTokens).toBe(16_384);
    expect(usage).toEqual([
      expect.objectContaining({ inputTokens: 4553, outputTokens: 16367 }),
    ]);
  });

  it("reports the cut-off answer when the model refuses the doubled budget", async () => {
    const conn = connection({ provider: "openai", model: "gpt-4o" });
    const tooLarge = new ProviderError(
      "OpenAI rejected the request (400): max_tokens is too large: 32768. This model supports at most 16384 completion tokens, whereas you provided 32768.",
      { failure: "bad_request", status: 400 },
    );
    const { provider, base } = setup(conn, [
      reply('{"title": "Lo', { stopReason: "max_tokens" }),
      tooLarge,
    ]);
    await expect(generateStructured(base)).rejects.toThrow(
      /bounded automatic recovery/,
    );
    expect(provider.calls.map((c) => c.maxOutputTokens)).toEqual([8192, 16384]);
  });

  it("reduces an unknown-capacity budget rejected before generation, without lifting the saved cap", async () => {
    const tooLarge = new ProviderError(
      "Anthropic rejected the request (400): max_tokens: 64000 > 32000, which is the maximum allowed",
      { failure: "bad_request", status: 400 },
    );
    const { base, provider } = setup(connection(), [
      tooLarge,
      reply(JSON.stringify(GOOD)),
    ]);
    await expect(
      generateStructured({ ...base, maxOutputTokens: 64_000 }),
    ).resolves.toEqual(GOOD);
    expect(provider.calls.map((c) => c.maxOutputTokens)).toEqual([
      64000, 32000,
    ]);
  });

  it("reports refusal without echoing the external explanation", async () => {
    const { base } = setup(connection(), [
      reply("", {
        stopReason: "refusal",
        refusalMessage: "This request may enable cyber harm.",
      }),
    ]);
    await expect(generateStructured(base)).rejects.toThrow(
      /declined the "screen-analysis:Login" request\./,
    );
  });
});

describe("generateStructured — modes", () => {
  it("prompt mode embeds the schema and extracts JSON from prose", async () => {
    const conn = connection({
      provider: "ollama",
      model: "qwen2.5vl:7b",
      structuredOutput: "prompt",
    });
    const { provider, base } = setup(conn, [
      reply(`Here you go:\n\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\``),
    ]);
    expect(await generateStructured(base)).toEqual(GOOD);
    const req = provider.calls[0];
    expect(req.jsonSchema).toBeUndefined();
    expect(req.json).toBeUndefined();
    expect(req.system.startsWith(base.system)).toBe(true);
    expect(req.system).toContain("Respond with ONLY a JSON object");
    expect(req.system).toContain('"title"');
  });

  it("uses JSON mode when the adapter cannot enforce a schema", async () => {
    const conn = connection({
      provider: "openai-compatible",
      model: "local-model",
      baseUrl: "http://localhost:1234/v1",
    });
    const { provider, base } = setup(
      conn,
      [reply(JSON.stringify(GOOD))],
      false,
    );
    await generateStructured(base);
    expect(provider.calls[0].json).toBe(true);
    expect(provider.calls[0].jsonSchema).toBeUndefined();
    expect(provider.calls[0].system).toContain("JSON Schema (screen_analysis)");
  });

  it("falls back native → JSON mode → prompt when the server rejects the format, and remembers it", async () => {
    const conn = connection({
      provider: "openai-compatible",
      model: "local-model",
      structuredOutput: "native",
    });
    const unsupported = () =>
      new ProviderError("no json_schema here", {
        failure: "format_unsupported",
        status: 400,
      });
    const { provider, logs, base } = setup(conn, [
      unsupported(),
      unsupported(),
      reply(JSON.stringify(GOOD)),
      reply(JSON.stringify(GOOD)),
    ]);
    expect(await generateStructured(base)).toEqual(GOOD);
    expect(provider.calls[0].jsonSchema).toBeDefined();
    expect(provider.calls[1].json).toBe(true);
    expect(provider.calls[2].json).toBeUndefined();
    expect(provider.calls[2].jsonSchema).toBeUndefined();
    expect(logs.filter((l) => l.message.includes("switching to"))).toHaveLength(
      2,
    );
    // The next call on the same connection goes straight to prompt mode.
    await generateStructured(base);
    expect(provider.calls[3].jsonSchema).toBeUndefined();
    expect(provider.calls[3].json).toBeUndefined();
  });

  it("does not remember a fallback after a 400 that may not be about the format", async () => {
    const conn = connection({
      provider: "openai-compatible",
      model: "local-model",
    });
    const vague = new ProviderError(
      "The OpenAI-compatible server did not accept the requested JSON output format: Bad Request",
      {
        failure: "format_unsupported",
        status: 400,
        rememberFallback: false,
      },
    );
    const stillBad = new ProviderError(
      "The OpenAI-compatible server rejected the request (400): Bad Request",
      { failure: "bad_request", status: 400 },
    );
    const { provider, logs, base } = setup(
      conn,
      [vague, stillBad, reply(JSON.stringify(GOOD))],
      false,
    );
    await expect(generateStructured(base)).rejects.toBe(stillBad);
    expect(provider.calls[1].json).toBeUndefined();
    expect(
      logs.some((l) =>
        l.message.includes("prompt-based JSON for this request"),
      ),
    ).toBe(true);
    // Prompt mode failed too, so JSON mode was not the problem: the next call tries it again.
    await generateStructured(base);
    expect(provider.calls[2].json).toBe(true);
  });

  it("remembers a vague-400 fallback once the simpler mode has worked", async () => {
    const conn = connection({
      provider: "openai-compatible",
      model: "local-model",
    });
    const vague = new ProviderError("Bad Request", {
      failure: "format_unsupported",
      status: 400,
      rememberFallback: false,
    });
    const { provider, base } = setup(
      conn,
      [vague, reply(JSON.stringify(GOOD)), reply(JSON.stringify(GOOD))],
      false,
    );
    expect(await generateStructured(base)).toEqual(GOOD);
    await generateStructured(base);
    expect(provider.calls.map((c) => c.json)).toEqual([
      true,
      undefined,
      undefined,
    ]);
  });

  it("drops images for connections that cannot read them", async () => {
    const conn = connection({ provider: "ollama", model: "qwen3:14b" });
    const { provider, logs, base } = setup(
      conn,
      [reply(JSON.stringify(GOOD))],
      true,
      false,
    );
    await generateStructured({
      ...base,
      content: [
        {
          type: "image",
          image: { mimeType: "image/png", base64: "AAAA", label: "Login" },
        },
        { type: "text", text: "Analyse it." },
      ],
    });
    const parts = provider.calls[0].messages[0].content;
    expect(parts.every((p) => p.type === "text")).toBe(true);
    expect(
      parts.some((p) => p.type === "text" && p.text.includes("omitted")),
    ).toBe(true);
    expect(
      logs.some(
        (l) => l.level === "warn" && l.message.includes("cannot read images"),
      ),
    ).toBe(true);
  });
});

describe("generateStructured — cancellation and concurrency", () => {
  it("throws CancelledError when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider, base } = setup(connection(), [
      reply(JSON.stringify(GOOD)),
    ]);
    await expect(
      generateStructured({ ...base, signal: controller.signal }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(provider.calls).toHaveLength(0);
  });

  it("cancels while waiting to retry", async () => {
    configureLLMRuntime({ maxRetryAfterMs: 60_000 });
    try {
      const controller = new AbortController();
      const slow = new ProviderError("rate limited", {
        failure: "rate_limit",
        retryable: true,
        retryAfterMs: 30_000,
      });
      const { base } = setup(connection(), [slow, reply(JSON.stringify(GOOD))]);
      const started = Date.now();
      const pending = generateStructured({
        ...base,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 20);
      await expect(pending).rejects.toBeInstanceOf(CancelledError);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      configureLLMRuntime({ maxRetryAfterMs: 20 });
    }
  });

  it("keeps at most connection.concurrency calls in flight", async () => {
    const conn = connection({ concurrency: 2 });
    const slowReply = async () => {
      await new Promise((r) => setTimeout(r, 15));
      return reply(JSON.stringify(GOOD));
    };
    const { provider, base } = setup(
      conn,
      Array.from({ length: 6 }, () => slowReply),
    );
    await Promise.all(
      Array.from({ length: 6 }, () => generateStructured(base)),
    );
    expect(provider.calls).toHaveLength(6);
    expect(provider.maxActive).toBe(2);
  });
});

describe("generateStructured — offline mock", () => {
  it("returns the validated mock output without calling a provider", async () => {
    const { provider, usage, base } = setup(
      connection({ provider: "mock", model: "demo" }),
      [],
    );
    expect(await generateStructured(base)).toEqual(GOOD);
    expect(provider.calls).toHaveLength(0);
    expect(usage).toEqual([{ inputTokens: 0, outputTokens: 0, costUsd: 0 }]);
  });

  it("throws a clear error when the mock output does not match the schema", async () => {
    const { base } = setup(connection({ provider: "mock", model: "demo" }), []);
    const invalid = {
      ...base,
      mock: () => ({ title: "x", items: [{ key: 1 }] }) as unknown as Out,
    };
    await expect(generateStructured(invalid)).rejects.toThrow(
      /offline demo output for "screen-analysis:Login" does not match the screen_analysis schema: items\.0\.key/,
    );
  });
});

describe("generateText", () => {
  it("returns trimmed text and retries a truncated answer once", async () => {
    const { provider, base } = setup(connection(), [
      reply("partial", { stopReason: "max_tokens" }),
      reply("  Full summary.  "),
    ]);
    const text = await generateText({
      ...base,
      maxOutputTokens: 1000,
      mock: () => "mock",
    });
    expect(text).toBe("Full summary.");
    expect(provider.calls.map((c) => c.maxOutputTokens)).toEqual([1000, 2000]);
    expect(provider.calls[0].jsonSchema).toBeUndefined();
  });

  it("rejects cut-off text when the model refuses the larger allowance", async () => {
    const tooLarge = new ProviderError(
      "max_tokens is too large: 2000. This model supports at most 1000 completion tokens.",
      { failure: "bad_request", status: 400 },
    );
    const { provider, logs, base } = setup(connection(), [
      reply(" partial summary ", { stopReason: "max_tokens" }),
      tooLarge,
    ]);
    await expect(
      generateText({ ...base, maxOutputTokens: 1000, mock: () => "mock" }),
    ).rejects.toThrow(/bounded automatic recovery/);
    expect(provider.calls.map((c) => c.maxOutputTokens)).toEqual([1000, 2000]);
    expect(
      logs.some((l) =>
        l.message.includes("incomplete (cut off at 1000 tokens)"),
      ),
    ).toBe(true);
  });

  it("uses the mock for the offline provider", async () => {
    const { base } = setup(connection({ provider: "mock" }), []);
    expect(await generateText({ ...base, mock: () => "Offline summary" })).toBe(
      "Offline summary",
    );
  });
});

describe("parseStructured", () => {
  it("reports JSON and schema problems separately", () => {
    expect(parseStructured("nope", Schema)).toMatchObject({
      ok: false,
      kind: "json",
    });
    const result = parseStructured('{"title": 3, "items": []}', Schema);
    expect(result).toMatchObject({ ok: false, kind: "schema" });
    if (!result.ok && result.kind === "schema")
      expect(result.issues[0].path).toBe("title");
  });
});
