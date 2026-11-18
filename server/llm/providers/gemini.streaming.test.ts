import type http from "node:http";
import { afterEach, expect, it } from "vitest";
import {
  closeServers,
  connection,
  geminiReply,
  json,
  serve,
} from "../reliabilityFixtures";
import { ProviderError } from "../errors";
import type { LLMRequest } from "../types";
import { GeminiProvider } from "./gemini";

// Synthetic behaviour profiles on a loopback server, not any particular Gemini model (owner test note 4).
afterEach(closeServers);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const part = (
  parts: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
) =>
  `data: ${JSON.stringify({
    candidates: [{ content: { role: "model", parts }, ...extra }],
    modelVersion: "synthetic-gemini",
  })}\n\n`;
/** Strings are sent, numbers are pauses (ms). */
async function sse(res: http.ServerResponse, steps: (string | number)[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const step of steps) {
    if (typeof step === "number") await sleep(step);
    else if (!res.destroyed) res.write(step);
  }
  if (!res.destroyed) res.end();
}
const request: LLMRequest = {
  system: "Synthetic contract",
  messages: [{ role: "user", content: [{ type: "text", text: "Answer" }] }],
  maxOutputTokens: 200,
  purpose: "synthetic-stream",
};
const gemini = (url: string, extra = {}) =>
  new GeminiProvider(
    connection({
      provider: "gemini",
      model: "synthetic-gemini",
      baseUrl: url,
      ...extra,
    }),
    true,
  );

it("streams the answer, leaves out thoughts and reports usage with thinking counted as output", async () => {
  const endpoint = await serve((_req, res) =>
    sse(res, [
      part([{ text: "Considering", thought: true }]),
      part([{ text: "Hel" }]),
      part([{ text: "lo" }], {
        finishReason: "STOP",
      }).replace(
        '"modelVersion"',
        '"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":4,"thoughtsTokenCount":6},"modelVersion"',
      ),
    ]),
  );
  const response = await gemini(endpoint.url).complete(request);
  expect(response.text).toBe("Hello");
  expect(response.stopReason).toBe("end");
  expect(response.usage).toMatchObject({
    inputTokens: 12,
    outputTokens: 10,
    reasoningTokens: 6,
    visibleOutputTokens: 4,
  });
  expect(endpoint.requests).toHaveLength(1);
  expect(endpoint.requests[0].url).toMatch(/:streamGenerateContent/);
});

it("keeps a long answer that keeps arriving past the timeout", async () => {
  const endpoint = await serve((_req, res) =>
    sse(res, [
      ...Array.from({ length: 7 }, (_, i) => [
        part([{ text: `${i}` }]),
        300,
      ]).flat(),
      part([{ text: "!" }], { finishReason: "STOP" }),
    ]),
  );
  const response = await gemini(endpoint.url, {
    requestTimeoutSec: 1,
  }).complete(request);
  expect(response.text).toBe("0123456!");
});

it("stops a stream that goes silent as a stall, which is not retried", async () => {
  const endpoint = await serve((_req, res) =>
    sse(res, [part([{ text: "Partial" }]), 3000]),
  );
  const err = await gemini(endpoint.url, { requestTimeoutSec: 1 })
    .complete(request)
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect((err as ProviderError).retryable).toBe(false);
});

it("reports a streamed cut-off", async () => {
  const endpoint = await serve((_req, res) =>
    sse(res, [part([{ text: "Partial" }], { finishReason: "MAX_TOKENS" })]),
  );
  expect((await gemini(endpoint.url).complete(request)).stopReason).toBe(
    "max_tokens",
  );
});

it("falls back to plain requests for a gateway without the streaming route, and remembers that", async () => {
  const endpoint = await serve((req, res) => {
    if (req.url.includes(":streamGenerateContent")) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
      return;
    }
    json(res, geminiReply("Plain"));
  });
  expect((await gemini(endpoint.url).complete(request)).text).toBe("Plain");
  expect((await gemini(endpoint.url).complete(request)).text).toBe("Plain");
  expect(
    endpoint.requests.map((r) => r.url.split("?")[0].split(":").pop()),
  ).toEqual(["streamGenerateContent", "generateContent", "generateContent"]);
});

it("falls back once when the endpoint answers the streaming route with plain JSON", async () => {
  const endpoint = await serve((_req, res) => json(res, geminiReply("Plain")));
  expect((await gemini(endpoint.url).complete(request)).text).toBe("Plain");
  expect(endpoint.requests).toHaveLength(2);
  expect((await gemini(endpoint.url).complete(request)).text).toBe("Plain");
  expect(endpoint.requests).toHaveLength(3);
});

it("does not fall back for a wrong model, which Google reports with a JSON error", async () => {
  const endpoint = await serve((_req, res) =>
    json(
      res,
      {
        error: {
          code: 404,
          message:
            "models/synthetic-gemini is not found for API version v1beta",
          status: "NOT_FOUND",
        },
      },
      404,
    ),
  );
  const err = await gemini(endpoint.url)
    .complete(request)
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect((err as ProviderError).failure).toBe("not_found");
  expect(endpoint.requests).toHaveLength(1);
});
