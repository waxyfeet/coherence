import type http from "node:http";
import { afterEach, expect, it } from "vitest";
import { closeServers, connection, json, serve } from "../reliabilityFixtures";
import { ProviderError } from "../errors";
import type { LLMRequest } from "../types";
import { OllamaProvider } from "./ollama";

// Synthetic behaviour profiles of a local model server, not any particular model (owner test note 4).
afterEach(closeServers);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (value: Record<string, unknown>) => JSON.stringify(value) + "\n";
const piece = (content: string) =>
  line({
    model: "synthetic-local",
    message: { role: "assistant", content },
    done: false,
  });
const done = (extra: Record<string, unknown> = {}) =>
  line({
    model: "synthetic-local",
    message: { role: "assistant", content: "" },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 21,
    eval_count: 9,
    ...extra,
  });
/** Strings are sent, numbers are pauses (ms). */
async function ndjson(res: http.ServerResponse, steps: (string | number)[]) {
  res.writeHead(200, { "content-type": "application/x-ndjson" });
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
const ollama = (url: string, extra = {}) =>
  new OllamaProvider(
    connection({
      provider: "ollama",
      model: "synthetic-local",
      baseUrl: url,
      ...extra,
    }),
    true,
  );

it("streams the answer and reports the final counts", async () => {
  const endpoint = await serve((_req, res) =>
    ndjson(res, [piece("Hel"), piece("lo"), done()]),
  );
  const response = await ollama(endpoint.url).complete(request);
  expect(response.text).toBe("Hello");
  expect(response.stopReason).toBe("end");
  expect(response.usage).toMatchObject({ inputTokens: 21, outputTokens: 9 });
  expect(endpoint.requests[0].body.stream).toBe(true);
});

it("keeps a slow local answer that keeps arriving past the timeout", async () => {
  const endpoint = await serve((_req, res) =>
    ndjson(res, [
      ...Array.from({ length: 7 }, (_, i) => [piece(`${i}`), 300]).flat(),
      done(),
    ]),
  );
  const response = await ollama(endpoint.url, {
    requestTimeoutSec: 1,
  }).complete(request);
  expect(response.text).toBe("0123456");
});

it("reports a streamed cut-off", async () => {
  const endpoint = await serve((_req, res) =>
    ndjson(res, [piece("Partial"), done({ done_reason: "length" })]),
  );
  expect((await ollama(endpoint.url).complete(request)).stopReason).toBe(
    "max_tokens",
  );
});

it("treats a stream that ends without its final line as a retryable failure", async () => {
  const endpoint = await serve((_req, res) => ndjson(res, [piece("Partial")]));
  const err = await ollama(endpoint.url)
    .complete(request)
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect((err as ProviderError).retryable).toBe(true);
});

it("explains an error sent mid-answer", async () => {
  const endpoint = await serve((_req, res) =>
    ndjson(res, [
      piece("Start"),
      line({ error: "model requires more system memory" }),
    ]),
  );
  const err = await ollama(endpoint.url)
    .complete(request)
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect((err as Error).message).toMatch(/does not have enough memory/);
});

it("accepts a proxy that answers with one complete JSON body", async () => {
  const endpoint = await serve((_req, res) =>
    json(res, {
      model: "synthetic-local",
      message: { role: "assistant", content: "Whole" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 5,
      eval_count: 2,
    }),
  );
  const response = await ollama(endpoint.url).complete(request);
  expect(response.text).toBe("Whole");
  expect(endpoint.requests).toHaveLength(1);
});
