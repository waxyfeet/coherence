import type http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import {
  closeServers,
  completion,
  connection,
  json,
  serve,
} from "../reliabilityFixtures";
import { CancelledError } from "../../errors";
import { ProviderError } from "../errors";
import type { LLMRequest } from "../types";
import { OpenAIProvider } from "./openai";

// Synthetic model profiles on a loopback server: behaviour, not any particular model (owner test note 4).
afterEach(closeServers);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chunk = (
  delta: Record<string, unknown>,
  finish: string | null = null,
) => ({
  id: "synthetic-chunk",
  object: "chat.completion.chunk",
  created: 1,
  model: "synthetic-model",
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const data = (value: unknown) =>
  `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
const usage = (prompt: number, completionTokens: number, reasoning?: number) =>
  data({
    id: "synthetic-chunk",
    object: "chat.completion.chunk",
    created: 1,
    model: "synthetic-model",
    choices: [],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completionTokens,
      ...(reasoning !== undefined
        ? { completion_tokens_details: { reasoning_tokens: reasoning } }
        : {}),
    },
  });
/** Writes the steps in order: strings are sent, numbers are pauses (ms). */
async function sse(res: http.ServerResponse, steps: (string | number)[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const step of steps) {
    if (typeof step === "number") await sleep(step);
    else if (!res.destroyed) res.write(step);
  }
  if (!res.destroyed) res.end();
}
const request = (extra: Partial<LLMRequest> = {}): LLMRequest => ({
  system: "Synthetic contract",
  messages: [{ role: "user", content: [{ type: "text", text: "Answer" }] }],
  maxOutputTokens: 200,
  purpose: "synthetic-stream",
  ...extra,
});
const provider = (url: string, extra = {}) =>
  new OpenAIProvider(connection({ baseUrl: url + "/v1", ...extra }), true);

it("streams the answer, asks for its usage and reports it, reasoning included", async () => {
  const endpoint = await serve((_req, res) =>
    sse(res, [
      data(chunk({ role: "assistant" })),
      data(chunk({ content: "Hel" })),
      data(chunk({ content: "lo" }, "stop")),
      usage(12, 7, 3),
      data("[DONE]"),
    ]),
  );
  const response = await provider(endpoint.url).complete(request());
  expect(response.text).toBe("Hello");
  expect(response.stopReason).toBe("end");
  expect(response.usage).toMatchObject({
    inputTokens: 12,
    outputTokens: 7,
    reasoningTokens: 3,
    visibleOutputTokens: 4,
  });
  expect(endpoint.requests).toHaveLength(1);
  expect(endpoint.requests[0].body).toMatchObject({
    stream: true,
    stream_options: { include_usage: true },
  });
});

it("keeps a long answer that keeps arriving past the timeout", async () => {
  const endpoint = await serve((_req, res) =>
    sse(res, [
      ...Array.from({ length: 8 }, (_, i) => [
        data(chunk({ content: `${i}` })),
        300,
      ]).flat(),
      data(chunk({}, "stop")),
      data("[DONE]"),
    ]),
  );
  const response = await provider(endpoint.url, {
    requestTimeoutSec: 1,
  }).complete(request());
  expect(response.text).toBe("01234567");
  expect(response.stopReason).toBe("end");
});

it("counts keep-alive comments while a model thinks silently as activity", async () => {
  const endpoint = await serve((_req, res) =>
    sse(res, [
      ...Array.from({ length: 6 }, () => [": PROCESSING\n\n", 400]).flat(),
      data(chunk({ content: "Thought it through" }, "stop")),
      data("[DONE]"),
    ]),
  );
  const response = await provider(endpoint.url, {
    requestTimeoutSec: 1,
  }).complete(request());
  expect(response.text).toBe("Thought it through");
});

it("stops a stream that goes silent as a stall, which is not retried", async () => {
  const endpoint = await serve((_req, res) =>
    sse(res, [data(chunk({ content: "Partial" })), 3000]),
  );
  const err = await provider(endpoint.url, { requestTimeoutSec: 1 })
    .complete(request())
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect((err as ProviderError).retryable).toBe(false);
  expect((err as Error).message).toMatch(
    /started answering but then sent nothing/,
  );
});

it("treats silence before anything arrives as a retryable timeout", async () => {
  const endpoint = await serve(async (_req, res) => {
    await sleep(3000);
    if (!res.destroyed) json(res, completion("Too late"));
  });
  const err = await provider(endpoint.url, { requestTimeoutSec: 1 })
    .complete(request())
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect((err as ProviderError).retryable).toBe(true);
  expect((err as Error).message).toMatch(/did not answer within 1 s/);
});

it("accepts a server that ignores streaming and answers with plain JSON, in one request", async () => {
  const endpoint = await serve((_req, res) => json(res, completion("Plain")));
  const before = vi.fn();
  const response = await provider(endpoint.url).complete(
    request({ beforeAttempt: before }),
  );
  expect(response.text).toBe("Plain");
  expect(response.usage).toMatchObject({ inputTokens: 100, outputTokens: 50 });
  expect(endpoint.requests).toHaveLength(1);
  expect(before).toHaveBeenCalledTimes(1);
});

it("reports a streamed cut-off and a streamed refusal", async () => {
  const cut = await serve((_req, res) =>
    sse(res, [data(chunk({ content: "Partial" }, "length")), data("[DONE]")]),
  );
  expect((await provider(cut.url).complete(request())).stopReason).toBe(
    "max_tokens",
  );
  const refused = await serve((_req, res) =>
    sse(res, [data(chunk({ refusal: "Declined" }, "stop")), data("[DONE]")]),
  );
  const response = await provider(refused.url).complete(request());
  expect(response.stopReason).toBe("refusal");
});

it("fails the attempt on an error sent inside the stream, as a retryable server error", async () => {
  const endpoint = await serve((_req, res) =>
    sse(res, [
      data(chunk({ content: "Start" })),
      data({
        ...chunk({ content: "" }, "error"),
        error: { code: "server_error", message: "Upstream disconnected" },
      }),
    ]),
  );
  const err = await provider(endpoint.url)
    .complete(request())
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect((err as ProviderError).retryable).toBe(true);
  // The provider's own wording is withheld, as for every provider error.
  expect((err as Error).message).toMatch(/reported an error while answering/);
  expect((err as Error).message).not.toMatch(/Upstream disconnected/);
});

it("asks without the usage report where the endpoint rejects it, and remembers that", async () => {
  const endpoint = await serve((req, res, index) => {
    if (index === 0)
      return json(
        res,
        {
          error: {
            message: "Unrecognized request argument supplied: stream_options",
          },
        },
        400,
      );
    sse(res, [data(chunk({ content: "Fine" }, "stop")), data("[DONE]")]);
  });
  expect((await provider(endpoint.url).complete(request())).text).toBe("Fine");
  expect((await provider(endpoint.url).complete(request())).text).toBe("Fine");
  expect(endpoint.requests.map((r) => r.body.stream_options)).toEqual([
    { include_usage: true },
    undefined,
    undefined,
  ]);
  expect(endpoint.requests.every((r) => r.body.stream === true)).toBe(true);
});

it("falls back to plain requests where the endpoint rejects streaming, and remembers that", async () => {
  const endpoint = await serve((_req, res, index) => {
    if (index === 0)
      return json(
        res,
        { error: { message: "Streaming is not supported for this model" } },
        400,
      );
    json(res, completion("Plain"));
  });
  expect((await provider(endpoint.url).complete(request())).text).toBe("Plain");
  expect((await provider(endpoint.url).complete(request())).text).toBe("Plain");
  expect(endpoint.requests.map((r) => r.body.stream)).toEqual([
    true,
    undefined,
    undefined,
  ]);
});

it("stops at once when the run is cancelled mid-stream", async () => {
  const endpoint = await serve((_req, res) =>
    sse(res, [data(chunk({ content: "Start" })), 5000]),
  );
  const controller = new AbortController();
  const pending = provider(endpoint.url).complete(
    request({ signal: controller.signal }),
  );
  setTimeout(() => controller.abort(), 300);
  const started = Date.now();
  await expect(pending).rejects.toBeInstanceOf(CancelledError);
  expect(Date.now() - started).toBeLessThan(3000);
});

it("reports each streamed piece for live progress, reasoning as thinking (tester build WP6)", async () => {
  const endpoint = await serve((_req, res) =>
    sse(res, [
      data(chunk({ role: "assistant" })),
      data(chunk({ reasoning: "Considering the screen" })),
      data(chunk({ reasoning_content: "More thought" })),
      data(chunk({ content: "Hel" })),
      data(chunk({ content: "lo there" }, "stop")),
      data("[DONE]"),
    ]),
  );
  const pieces: unknown[] = [];
  const response = await provider(endpoint.url).complete(
    request({ onStream: (delta) => pieces.push(delta) }),
  );
  expect(response.text).toBe("Hello there");
  expect(pieces).toEqual([
    { thinking: true },
    { thinking: true },
    { text: 3 },
    { text: 8 },
  ]);
});

it("tells the job's live tracker about a whole call and always ends it", async () => {
  const { generateStructured } = await import("../structured");
  const { z } = await import("zod");
  const endpoint = await serve((_req, res) =>
    sse(res, [
      data(chunk({ role: "assistant" })),
      data(chunk({ content: '{"answer":' })),
      data(chunk({ content: '"ok"}' }, "stop")),
      data("[DONE]"),
    ]),
  );
  const events: string[] = [];
  const live = {
    start: (purpose: string, model: string) => {
      events.push(`start ${purpose} ${model}`);
      return {
        stream: (d: { text?: number; thinking?: boolean }) =>
          events.push(d.text ? `text ${d.text}` : "thinking"),
        end: () => events.push("end"),
      };
    },
  };
  const value = await generateStructured({
    connection: connection({ baseUrl: endpoint.url + "/v1" }),
    system: "Synthetic contract",
    content: [{ type: "text", text: "Answer" }],
    purpose: "use-case-writer:UC-001",
    schema: z.object({ answer: z.string() }),
    schemaName: "synthetic_answer",
    mock: () => ({ answer: "mock" }),
    live,
  });
  expect(value).toEqual({ answer: "ok" });
  expect(events[0]).toMatch(/^start use-case-writer:UC-001 /);
  expect(events.slice(1)).toEqual(["text 10", "text 5", "end"]);
});
