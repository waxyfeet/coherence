import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  closeServers,
  completion,
  connection,
  json,
  serve,
} from "./reliabilityFixtures";
import {
  configureLLMRuntime,
  generateStructured,
  generateText,
} from "./structured";
import { CapacityError, RequestBudget, estimateInput } from "./capacity";
import { OpenAIProvider } from "./providers/openai";
import { GeminiProvider } from "./providers/gemini";

const schema = z.object({ answer: z.string() }),
  good = { answer: "Exact synthetic answer" };
afterEach(async () => {
  await closeServers();
  vi.unstubAllGlobals();
});
const opts = (c: ReturnType<typeof connection>) => ({
  connection: c,
  system: "Synthetic contract",
  content: [{ type: "text" as const, text: "Return the exact answer" }],
  purpose: "synthetic-transport",
  schema,
  schemaName: "synthetic_contract",
  mock: () => good,
});
const textOpts = (c: ReturnType<typeof connection>) => ({
  ...opts(c),
  mock: () => "Exact synthetic text",
});

it("refuses a plain-text request before transport when its shared input allowance is exhausted", async () => {
  const endpoint = await serve((_req, res) =>
    json(res, completion("Exact synthetic text")),
  );
  const resources = new RequestBudget({
    requests: 5,
    outputAllowance: 100000,
    inputAllowance: 1,
  });
  await expect(
    generateText({
      ...textOpts(connection({ baseUrl: endpoint.url + "/v1" })),
      resources,
    }),
  ).rejects.toThrow(/automatic request allowance/);
  expect(endpoint.requests).toHaveLength(0);
  expect(resources.snapshot().requests).toBe(0);
});

it("reserves the actual fitted plain-text output and estimated input while the attempt runs, then counts the reported usage", async () => {
  const endpoint = await serve((_req, res) =>
    json(res, completion("Exact synthetic text")),
  );
  const args = textOpts(
    connection({ baseUrl: endpoint.url + "/v1", modelContextWindow: 1024 }),
  );
  const input = estimateInput({
    system: args.system,
    messages: [{ role: "user", content: args.content }],
  });
  const resources = new RequestBudget({
    requests: 5,
    outputAllowance: 100000,
    inputAllowance: 100000,
  });
  const admit = vi.spyOn(resources, "admit");
  expect(await generateText({ ...args, resources })).toBe(
    "Exact synthetic text",
  );
  const actual = endpoint.requests[0].body.max_tokens;
  expect(actual).toBeGreaterThan(0);
  expect(actual).toBeLessThan(1024);
  expect(admit).toHaveBeenCalledWith(actual, input);
  // The fixture reports 100 input and 50 output tokens: the finished attempt counts those, not its reservation.
  expect(resources.snapshot()).toEqual({
    requests: 1,
    reservedOutputAllowance: 50,
    reservedInputEstimate: 100,
  });
});

it("counts reported usage for a finished structured request, so later requests are not refused", async () => {
  const endpoint = await serve((_req, res) =>
    json(res, completion(JSON.stringify(good))),
  );
  const c = connection({
    baseUrl: endpoint.url + "/v1",
    maxOutputTokens: 30000,
  });
  // Room for one 30,000 reservation at a time: without settling, the second request would be refused.
  const resources = new RequestBudget({
    requests: 10,
    outputAllowance: 40000,
    inputAllowance: 1000000,
  });
  expect(await generateStructured({ ...opts(c), resources })).toEqual(good);
  expect(await generateStructured({ ...opts(c), resources })).toEqual(good);
  expect(endpoint.requests).toHaveLength(2);
  expect(resources.snapshot()).toEqual({
    requests: 2,
    reservedOutputAllowance: 100,
    reservedInputEstimate: 200,
  });
});

it("keeps the full reservation of an attempt whose usage is unknown", async () => {
  const endpoint = await serve((_req, res) =>
    json(res, completion(JSON.stringify(good), "stop", {})),
  );
  const c = connection({
    baseUrl: endpoint.url + "/v1",
    maxOutputTokens: 30000,
  });
  const resources = new RequestBudget({
    requests: 10,
    outputAllowance: 40000,
    inputAllowance: 1000000,
  });
  expect(await generateStructured({ ...opts(c), resources })).toEqual(good);
  expect(resources.snapshot().reservedOutputAllowance).toBe(
    endpoint.requests[0].body.max_tokens,
  );
  await expect(generateStructured({ ...opts(c), resources })).rejects.toThrow(
    /automatic request allowance/,
  );
  expect(endpoint.requests).toHaveLength(1);
});

it("counts plain-text adapter adjustment input before a second physical request", async () => {
  const endpoint = await serve((_req, res) =>
    json(
      res,
      {
        error: {
          message: "Unsupported parameter: temperature",
          param: "temperature",
          type: "invalid_request_error",
        },
      },
      400,
    ),
  );
  const args = textOpts(
    connection({ baseUrl: endpoint.url + "/v1", temperature: 0.2 }),
  );
  const input = estimateInput({
    system: args.system,
    messages: [{ role: "user", content: args.content }],
  });
  const resources = new RequestBudget({
    requests: 5,
    outputAllowance: 100000,
    inputAllowance: input,
  });
  await expect(generateText({ ...args, resources })).rejects.toThrow(
    /automatic request allowance/,
  );
  expect(endpoint.requests).toHaveLength(1);
  expect(resources.snapshot().reservedInputEstimate).toBe(input);
});

it("does not rebuy a truncated plain-text answer when context leaves no larger allowance", async () => {
  const endpoint = await serve((_req, res) =>
    json(res, completion("Partial", "length")),
  );
  const args = textOpts(
    connection({
      baseUrl: endpoint.url + "/v1",
      modelContextWindow: 1024,
      maxOutputTokens: 5000,
    }),
  );
  await expect(generateText(args)).rejects.toThrow(
    /bounded automatic recovery/,
  );
  expect(endpoint.requests).toHaveLength(1);
});

it("recovers a compatible cutoff with actual wire allowances determined by model metadata", async () => {
  const endpoint = await serve((_req, res, index) =>
    json(
      res,
      index === 0
        ? completion("{", "length", {
            prompt_tokens: 5478,
            completion_tokens: 8192,
          })
        : completion(JSON.stringify(good)),
    ),
  );
  const c = connection({
    baseUrl: endpoint.url + "/v1",
    modelOutputTokenLimit: 131072,
    modelContextWindow: 1000000,
  });
  await expect(generateStructured(opts(c))).resolves.toEqual(good);
  expect(endpoint.requests.map((r) => r.body.max_tokens)).toEqual([
    32768, 65536,
  ]);
  expect(endpoint.requests.every((r) => r.body.model === c.model)).toBe(true);
});
it("rejects a truncated response even when its JSON parses", async () => {
  const endpoint = await serve((_req, res) =>
    json(res, completion(JSON.stringify(good), "length")),
  );
  const c = connection({ baseUrl: endpoint.url + "/v1", maxOutputTokens: 100 });
  await expect(generateStructured(opts(c))).rejects.toBeInstanceOf(
    CapacityError,
  );
  expect(endpoint.requests).toHaveLength(1);
});
it("does not accept a schema-valid answer with unknown termination", async () => {
  const endpoint = await serve((_req, res) =>
    json(res, completion(JSON.stringify(good), "future_unknown_stop")),
  );
  await expect(
    generateStructured(opts(connection({ baseUrl: endpoint.url + "/v1" }))),
  ).rejects.toThrow(/did not confirm/);
  expect(endpoint.requests).toHaveLength(1);
});
it("isolates format fallback between models on one unchanged account", async () => {
  const endpoint = await serve((r, res) =>
    r.body.model === "model-a" && r.body.response_format?.type === "json_schema"
      ? json(
          res,
          {
            error: {
              message: "response_format json_schema is unsupported",
              type: "invalid_request_error",
            },
          },
          400,
        )
      : json(res, completion(JSON.stringify(good))),
  );
  const a = connection({
    baseUrl: endpoint.url + "/v1",
    model: "model-a",
    structuredOutput: "native",
  });
  await generateStructured(opts(a));
  await generateStructured(opts({ ...a, model: "constructor" }));
  expect(endpoint.requests.map((r) => r.body.response_format.type)).toEqual([
    "json_schema",
    "json_object",
    "json_schema",
  ]);
});
it("counts parameter adjustment attempts against the same admission guard", async () => {
  const endpoint = await serve((_r, res) =>
    json(
      res,
      {
        error: {
          message: "Unsupported parameter: temperature",
          type: "invalid_request_error",
        },
      },
      400,
    ),
  );
  const c = connection({ baseUrl: endpoint.url + "/v1", temperature: 0.2 });
  const budget = new RequestBudget({ requests: 1, outputAllowance: 100000 });
  await expect(
    generateStructured({ ...opts(c), resources: budget }),
  ).rejects.toThrow(/allowance/);
  expect(endpoint.requests).toHaveLength(1);
  expect(budget.snapshot().requests).toBe(1);
});
it("keeps repair history bounded while retaining the original task", async () => {
  const endpoint = await serve((_r, res, index) =>
    json(res, completion(index < 2 ? '{"wrong":true}' : JSON.stringify(good))),
  );
  const c = connection({ baseUrl: endpoint.url + "/v1" });
  await generateStructured(opts(c));
  expect(endpoint.requests.map((r) => r.body.messages.length)).toEqual([
    2, 4, 4,
  ]);
  expect(endpoint.requests[2].body.messages[1].content).toBe(
    "Return the exact answer",
  );
});
it("retains reasoning counts without logging or returning reasoning text", async () => {
  const endpoint = await serve((_r, res) =>
    json(
      res,
      completion(JSON.stringify(good), "stop", {
        prompt_tokens: 100,
        completion_tokens: 50,
        completion_tokens_details: { reasoning_tokens: 30 },
      }),
    ),
  );
  const reports: unknown[] = [];
  await generateStructured({
    ...opts(connection({ baseUrl: endpoint.url + "/v1" })),
    onUsage: (u) => reports.push(u),
  });
  expect(reports[0]).toMatchObject({
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 30,
    visibleOutputTokens: 20,
  });
});

async function captureGateway(
  extra: Partial<ReturnType<typeof connection>>,
  purpose = "screen-analysis:Synthetic",
) {
  let body: Record<string, any> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify(completion(JSON.stringify(good))), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const c = connection({ baseUrl: "https://openrouter.ai/api/v1", ...extra });
  const p = new OpenAIProvider(c, true);
  await p.complete({
    system: "Synthetic",
    messages: [
      { role: "user", content: [{ type: "text", text: "Synthetic" }] },
    ],
    purpose,
    maxOutputTokens: 1024,
  });
  return body;
}
it("uses optional extraction-only reasoning control from exact gateway facts", async () => {
  expect(
    (
      await captureGateway({
        modelReasoning: { mandatory: false, automaticExtraction: true },
      })
    ).reasoning,
  ).toEqual({ enabled: false });
});
it.each(["journey-map", "use-case-plan", "write:UC-001", "review"])(
  "preserves provider reasoning for %s",
  async (purpose) => {
    expect(
      (
        await captureGateway(
          { modelReasoning: { mandatory: false, automaticExtraction: true } },
          purpose,
        )
      ).reasoning,
    ).toBeUndefined();
  },
);
it("respects mandatory thinking and explicit effort preferences", async () => {
  expect(
    (
      await captureGateway({
        modelReasoning: { mandatory: true, automaticExtraction: true },
      })
    ).reasoning,
  ).toBeUndefined();
  expect(
    (
      await captureGateway({
        effort: "high",
        modelReasoning: {
          mandatory: false,
          automaticExtraction: false,
          supportedEfforts: ["high"],
        },
      })
    ).reasoning,
  ).toEqual({ effort: "high" });
});
it("never exports the gateway dialect to a custom compatible endpoint", async () => {
  expect(
    (
      await captureGateway({
        baseUrl: "http://127.0.0.1:11435/v1",
        modelReasoning: { mandatory: false, automaticExtraction: true },
      })
    ).reasoning,
  ).toBeUndefined();
});
it("disables hidden Gemini SDK retries so every physical attempt is admitted", async () => {
  const endpoint = await serve((_r, res) =>
    json(
      res,
      {
        error: {
          code: 503,
          message: "Synthetic unavailable",
          status: "UNAVAILABLE",
        },
      },
      503,
    ),
  );
  const c = connection({
    provider: "gemini",
    model: "synthetic-gemini",
    baseUrl: endpoint.url,
  });
  const provider = new GeminiProvider(c, true);
  let admitted = 0;
  await expect(
    provider.complete({
      system: "Synthetic",
      messages: [
        { role: "user", content: [{ type: "text", text: "Synthetic" }] },
      ],
      purpose: "synthetic",
      maxOutputTokens: 100,
      beforeAttempt: () => {
        admitted++;
      },
    }),
  ).rejects.toThrow();
  expect(endpoint.requests).toHaveLength(1);
  expect(admitted).toBe(1);
});
