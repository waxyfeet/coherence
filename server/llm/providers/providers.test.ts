/**
 * Adapters against a local HTTP server that imitates the provider: the real SDKs and Node's fetch run,
 * only the far end is fake.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { LLMConnection } from "@shared/types";
import { ProviderError } from "../errors";
import { defaultMaxOutputTokens } from "../structured";
import type { LLMRequest } from "../types";
import {
  AnthropicProvider,
  anthropicBaseUrl,
  isFirstPartyAnthropic,
} from "./anthropic";
import { GeminiProvider, geminiRetryAfterMs } from "./gemini";
import { OllamaProvider } from "./ollama";
import { OpenAIProvider } from "./openai";

interface Seen {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

type Handler = (seen: Seen, res: http.ServerResponse, index: number) => void;

const servers: http.Server[] = [];

async function serve(
  handler: Handler,
): Promise<{ url: string; requests: Seen[] }> {
  const requests: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      const seen: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
      };
      requests.push(seen);
      handler(seen, res, requests.length - 1);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function connection(partial: Partial<LLMConnection>): LLMConnection {
  return {
    id: "conn_providers_test",
    name: "Test",
    provider: "openai-compatible",
    model: "local-model",
    concurrency: 1,
    requestTimeoutSec: 30,
    structuredOutput: "auto",
    vision: "no",
    refusalFallback: false,
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
    ...partial,
  };
}

const REQUEST: LLMRequest = {
  system: "You are a test.",
  messages: [{ role: "user", content: [{ type: "text", text: "Say OK" }] }],
  maxOutputTokens: 100,
  purpose: "test",
};

const OPENAI_OK = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 0,
  model: "local-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "OK" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
}

describe("Ollama thinking", () => {
  const OK = {
    model: "qwen3-vl:8b",
    message: { role: "assistant", content: "{}" },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 1,
    eval_count: 1,
  };
  const structured: LLMRequest = { ...REQUEST, json: true };

  it("turns thinking off for structured answers (it would eat the output budget) but not for plain text", async () => {
    const { url, requests } = await serve((_seen, res) => json(res, 200, OK));
    const ollama = new OllamaProvider(
      connection({ provider: "ollama", model: "qwen3-vl:8b", baseUrl: url }),
      false,
    );
    await ollama.complete(structured);
    await ollama.complete(REQUEST);
    expect(requests[0]?.body?.think).toBe(false);
    expect(requests[1]?.body).not.toHaveProperty("think");
  });

  it("asks again without the field when the model rejects it", async () => {
    const { url, requests } = await serve((seen, res, i) =>
      i === 0
        ? json(res, 400, { error: '"qwen3-vl:8b" does not support thinking' })
        : json(res, 200, OK),
    );
    const ollama = new OllamaProvider(
      connection({ provider: "ollama", model: "qwen3-vl:8b", baseUrl: url }),
      false,
    );
    const reply = await ollama.complete(structured);
    expect(reply.text).toBe("{}");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body?.think).toBe(false);
    expect(requests[1]?.body).not.toHaveProperty("think");
  });
  it("fails fast, with advice, when the whole output budget went on thinking", async () => {
    const { url } = await serve((_seen, res) =>
      json(res, 200, {
        model: "qwen3-vl:8b",
        message: {
          role: "assistant",
          content: "",
          thinking: "Let me think about this…",
        },
        done: true,
        done_reason: "length",
        prompt_eval_count: 10,
        eval_count: 100,
      }),
    );
    const ollama = new OllamaProvider(
      connection({ provider: "ollama", model: "qwen3-vl:8b", baseUrl: url }),
      false,
    );
    const err = await ollama.complete(structured).then(
      () => undefined,
      (e: unknown) => e as ProviderError,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err?.retryable).toBe(false);
    expect(err?.message).toMatch(
      /used all 100 output tokens thinking.*instruct/s,
    );
  });
});

/* ------------------------------------------------------------------ */

describe("answers that take longer than Node fetch’s own header timeout", () => {
  const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");
  type Dispatcher = {
    dispatch(options: Record<string, unknown>, handler: unknown): boolean;
  };
  const globals = globalThis as unknown as Record<symbol, Dispatcher>;
  let real: Dispatcher;

  beforeAll(() => {
    new Headers();
    real = globals[GLOBAL_DISPATCHER];
    // Node's fetch gives up after 300 s without response headers; the same default, scaled to 300 ms.
    globals[GLOBAL_DISPATCHER] = {
      dispatch: (options, handler) =>
        real.dispatch(
          {
            ...options,
            headersTimeout: options.headersTimeout ?? 300,
            bodyTimeout: options.bodyTimeout ?? 300,
          },
          handler,
        ),
    };
  });
  afterAll(() => {
    globals[GLOBAL_DISPATCHER] = real;
  });

  it("Ollama and OpenAI-compatible wait as long as the connection timeout allows", async () => {
    const { url } = await serve((seen, res) => {
      // A non-streamed answer: no headers until generation has finished.
      setTimeout(() => {
        if (seen.url.startsWith("/api/chat")) {
          json(res, 200, {
            model: "qwen2.5vl:7b",
            message: { role: "assistant", content: "OK" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 10,
            eval_count: 2,
          });
        } else {
          json(res, 200, OPENAI_OK);
        }
      }, 2500);
    });

    // The stand-in really does cut plain fetch off.
    const plain = await fetch(`${url}/probe`).then(
      () => undefined,
      (e: unknown) => e as { cause?: { code?: string } },
    );
    expect(plain?.cause?.code).toBe("UND_ERR_HEADERS_TIMEOUT");

    const ollama = new OllamaProvider(
      connection({ provider: "ollama", model: "qwen2.5vl:7b", baseUrl: url }),
      false,
    );
    const compatible = new OpenAIProvider(
      connection({ baseUrl: `${url}/v1` }),
      false,
    );
    const [a, b] = await Promise.all([
      ollama.complete(REQUEST),
      compatible.complete(REQUEST),
    ]);
    expect(a.text).toBe("OK");
    expect(b.text).toBe("OK");
  });
});

/* ------------------------------------------------------------------ */

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function startMessage(res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  sse(res, "message_start", {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1200, output_tokens: 1 },
    },
  });
  sse(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
}

function delta(res: http.ServerResponse, text: string): void {
  sse(res, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
}

function finishMessage(res: http.ServerResponse): void {
  sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 40 },
  });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

function anthropic(url: string, requestTimeoutSec: number): AnthropicProvider {
  return new AnthropicProvider(
    connection({
      provider: "anthropic",
      model: "claude-opus-5-5",
      apiKey: "sk-ant-test-0000000000",
      baseUrl: url,
      requestTimeoutSec,
    }),
    true,
  );
}

describe("Anthropic streaming", () => {
  it("does not cut off an answer that keeps arriving, however long it takes in total", async () => {
    const chunks = ['{"title":', ' "Lo', "gin", '", "items"', ": []", "}"];
    const { url, requests } = await serve((_seen, res) => {
      startMessage(res);
      let i = 0;
      const timer = setInterval(() => {
        if (res.destroyed) return clearInterval(timer);
        if (i < chunks.length) {
          delta(res, chunks[i]);
          i += 1;
          return;
        }
        clearInterval(timer);
        finishMessage(res);
      }, 300);
    });
    // 6 × 300 ms ≈ 2 s of streaming with a 0.8 s timeout: only the gaps between events count.
    const response = await anthropic(url, 0.8).complete(REQUEST);
    expect(response.text).toBe('{"title": "Login", "items": []}');
    expect(response.stopReason).toBe("end");
    expect(requests).toHaveLength(1);
  });

  it("stops a stream that goes quiet, without a retry, and reports the tokens already used", async () => {
    const { url } = await serve((_seen, res) => {
      startMessage(res);
      delta(res, "x".repeat(400));
      // …then nothing more.
    });
    const err = await failure(anthropic(url, 0.5).complete(REQUEST));
    expect(err.failure).toBe("timeout");
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/started answering but then sent nothing for/);
    expect(err.partial?.usage.inputTokens).toBe(1200);
    expect(err.partial?.usage.outputTokens).toBeGreaterThanOrEqual(100);
  });

  it("still times out (retryably) when the answer never starts", async () => {
    const { url } = await serve(() => {
      // No headers, no events.
    });
    const err = await failure(anthropic(url, 0.5).complete(REQUEST));
    expect(err.failure).toBe("timeout");
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/did not answer within/);
  });

  it("accepts a base URL that ends in /v1", async () => {
    expect(anthropicBaseUrl("https://api.anthropic.com/v1/")).toBe(
      "https://api.anthropic.com",
    );
    expect(isFirstPartyAnthropic("https://api.anthropic.com/v1")).toBe(true);
    expect(isFirstPartyAnthropic("https://proxy.example.com/v1")).toBe(false);
    const { url, requests } = await serve((_seen, res) => {
      startMessage(res);
      delta(res, "OK");
      finishMessage(res);
    });
    const response = await anthropic(`${url}/v1`, 30).complete(REQUEST);
    expect(response.text).toBe("OK");
    expect(requests[0].url).toMatch(/^\/v1\/messages/);
  });
});

/* ------------------------------------------------------------------ */

describe("Gemini rate limits", () => {
  const gemini = (url: string) =>
    new GeminiProvider(
      connection({
        provider: "gemini",
        model: "gemini-2.5-pro",
        apiKey: "test-gemini-key",
        baseUrl: url,
      }),
      true,
    );

  it("passes Google’s RetryInfo delay on as Retry-After", async () => {
    const { url } = await serve((_seen, res) =>
      json(res, 429, {
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "You exceeded your current quota. Please retry in 41.2s.",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.QuotaFailure",
              violations: [
                {
                  quotaId:
                    "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
                },
              ],
            },
            {
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: "41s",
            },
          ],
        },
      }),
    );
    const err = await failure(gemini(url).complete(REQUEST));
    expect(err.failure).toBe("rate_limit");
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(41_000);
  });

  it("reports a used-up daily quota instead of retrying it", async () => {
    const { url, requests } = await serve((_seen, res) =>
      json(res, 429, {
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "You exceeded your current quota.",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.QuotaFailure",
              violations: [
                {
                  quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
                },
              ],
            },
            {
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: "3600s",
            },
          ],
        },
      }),
    );
    const err = await failure(gemini(url).complete(REQUEST));
    expect(err.failure).toBe("quota");
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/daily quota/);
    expect(requests).toHaveLength(1);
  });

  it('falls back to the "retry in" text', () => {
    expect(
      geminiRetryAfterMs([], "Resource exhausted. Please retry in 12.5s."),
    ).toBe(12_500);
    expect(geminiRetryAfterMs([], "Resource exhausted.")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */

describe("OpenAI-compatible 400 handling", () => {
  const compatible = (url: string) =>
    new OpenAIProvider(connection({ baseUrl: `${url}/v1` }), false);
  const JSON_REQUEST: LLMRequest = {
    ...REQUEST,
    json: true,
    maxOutputTokens: 16_384,
  };

  it("does not flip the token parameter on vLLM’s “too large” error, and reports the output budget", async () => {
    const { url, requests } = await serve((_seen, res) =>
      json(res, 400, {
        object: "error",
        message:
          "'max_tokens' or 'max_completion_tokens' is too large: 16384. This model's maximum context length is 16384 tokens and your request has 120 input tokens (16384 > 16384 - 120).",
        type: "BadRequestError",
        param: null,
        code: 400,
      }),
    );
    const err = await failure(compatible(url).complete(JSON_REQUEST));
    expect(requests).toHaveLength(1);
    expect(err.failure).toBe("too_large");
    expect(err.message).toMatch(/output budget/);
  });

  it("does not take a context-length 400 for a JSON-mode problem", async () => {
    const { url } = await serve((_seen, res) =>
      json(res, 400, {
        error: {
          message:
            "The number of tokens to keep from the initial prompt is greater than the context length.",
        },
      }),
    );
    const err = await failure(compatible(url).complete(JSON_REQUEST));
    expect(err.failure).toBe("too_large");
  });

  it("falls back from JSON mode on a vague 400 without remembering it, and remembers a clear format error", async () => {
    const vague = await serve((_seen, res) =>
      json(res, 400, { error: { message: "Bad Request" } }),
    );
    const err1 = await failure(compatible(vague.url).complete(JSON_REQUEST));
    expect(err1.failure).toBe("format_unsupported");
    expect(err1.rememberFallback).toBe(false);

    const clear = await serve((_seen, res) =>
      json(res, 400, {
        error: {
          message: "'response_format.type' must be 'json_schema' or 'text'",
        },
      }),
    );
    const err2 = await failure(compatible(clear.url).complete(JSON_REQUEST));
    expect(err2.failure).toBe("format_unsupported");
    expect(err2.rememberFallback).toBe(true);
  });

  it("switches to max_completion_tokens when the server says max_tokens is unsupported", async () => {
    const { url, requests } = await serve((_seen, res, index) => {
      if (index === 0) {
        json(res, 400, {
          error: {
            message:
              "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          },
        });
      } else {
        json(res, 200, OPENAI_OK);
      }
    });
    expect((await compatible(url).complete(REQUEST)).text).toBe("OK");
    expect(
      requests.map((r) => [r.body?.max_tokens, r.body?.max_completion_tokens]),
    ).toEqual([
      [100, undefined],
      [undefined, 100],
    ]);
  });
});

describe("Azure OpenAI reasoning deployments", () => {
  it("sends the chosen effort whatever the deployment is called, and drops it if the model rejects it", async () => {
    const { url, requests } = await serve((_seen, res, index) => {
      if (index === 0) {
        json(res, 400, {
          error: {
            message: "Unrecognized request argument supplied: reasoning_effort",
            code: "invalid_request_error",
          },
        });
      } else {
        json(res, 200, OPENAI_OK);
      }
    });
    const conn = connection({
      provider: "azure-openai",
      model: "chat-prod",
      apiKey: "azure-test-key",
      baseUrl: url,
      effort: "high",
      temperature: 0.2,
    });
    // Exact deployment/effort routing remains; unknown capacity is not a discovered model maximum.
    expect(defaultMaxOutputTokens(conn)).toBe(8192);
    expect((await new OpenAIProvider(conn, false).complete(REQUEST)).text).toBe(
      "OK",
    );
    expect(requests[0].url).toContain(
      "/openai/deployments/chat-prod/chat/completions",
    );
    expect(requests[0].body).toMatchObject({
      reasoning_effort: "high",
      max_completion_tokens: 100,
    });
    expect(requests[0].body?.temperature).toBeUndefined();
    expect(requests[1].body?.reasoning_effort).toBeUndefined();
    expect(requests[1].body?.temperature).toBe(0.2);
  });

  it("keeps the normal budget for an Azure deployment without an effort", () => {
    expect(
      defaultMaxOutputTokens(
        connection({ provider: "azure-openai", model: "chat-prod" }),
      ),
    ).toBe(8192);
  });
});
