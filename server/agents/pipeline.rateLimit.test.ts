/**
 * Owner test note 5: a used-up rate limit stops the run once, with its reset time, instead of every task
 * spending retries and the run swapping in lower-quality substitutes. Replies are synthetic fixtures.
 */
import http from "node:http";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_GENERATION_OPTIONS } from "@shared/types";
import { removeDir, useTempDataDir } from "../storage/testUtils";
import { recordingContext } from "./testContext";

let dir: string,
  base: string,
  server: http.Server,
  counter = 0;
const replies = new Map<string, { value: unknown; schema: string }>();
const received: string[] = [];
/** Schemas the fake service refuses with a daily-limit 429. */
let limited = new Set<string>();
/** When set, use cases the fake service writes before its limit runs out. */
let useCaseAllowance: number | undefined;
const RESET_MS = 10 * 60 * 60 * 1000;
let store: typeof import("../storage/projectStore"),
  settings: typeof import("../storage/settingsStore"),
  demo: typeof import("../storage/demo"),
  pipeline: typeof import("./pipeline"),
  rateLimit: typeof import("../llm/rateLimit"),
  failure: typeof import("../jobs/failure"),
  cfg: typeof import("../config");

beforeAll(async () => {
  dir = await useTempDataDir("pipeline-rate-limit");
  vi.resetModules();
  server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    const id = new URL(req.url!, "http://fixture").pathname.split("/")[1];
    const fixture = replies.get(id)!;
    received.push(fixture.schema);
    const overAllowance =
      fixture.schema === "use_case" &&
      useCaseAllowance !== undefined &&
      useCaseAllowance-- <= 0;
    if (limited.has(fixture.schema) || overAllowance) {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "X-RateLimit-Limit": "50",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(Date.now() + RESET_MS),
      });
      res.end(
        JSON.stringify({
          error: {
            code: 429,
            message: "Rate limit exceeded: free-models-per-day",
          },
        }),
      );
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        id: "fixture-response",
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify(fixture.value),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  // Test-only reply preparation; the real adapter, retries and rate-limit handling still run.
  vi.doMock("../llm/structured", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../llm/structured")>();
    const generateStructured = (async (
      opts: Parameters<typeof actual.generateStructured>[0],
    ) => {
      const id = "call-" + ++counter;
      replies.set(id, { value: opts.mock(), schema: opts.schemaName });
      return actual.generateStructured({
        ...opts,
        connection: { ...opts.connection, baseUrl: `${base}/${id}/v1` },
        mock: () => {
          throw Error("Real adapter must not use offline production branch");
        },
      });
    }) as typeof actual.generateStructured;
    return { ...actual, generateStructured };
  });
  store = await import("../storage/projectStore");
  settings = await import("../storage/settingsStore");
  demo = await import("../storage/demo");
  pipeline = await import("./pipeline");
  rateLimit = await import("../llm/rateLimit");
  failure = await import("../jobs/failure");
  cfg = await import("../config");
  await store.ensureDataDirs();
});
beforeEach(() => {
  rateLimit.resetRateLimits();
  received.length = 0;
  useCaseAllowance = undefined;
});
afterAll(async () => {
  vi.doUnmock("../llm/structured");
  server?.closeAllConnections();
  await new Promise<void>((r) => server?.close(() => r()));
  await removeDir(dir);
});

async function project(name: string) {
  const connection = await settings.createConnection({
    name,
    provider: "openai-compatible",
    modelIds: ["fixture-vision", "fixture-writer"],
    apiKey: "synthetic-rate-limit-key",
    baseUrl: base,
    vision: "yes",
    structuredOutput: "native",
    concurrency: 4,
  });
  const p = await demo.createDemoProject();
  p.generationPreferences = {
    ...DEFAULT_GENERATION_OPTIONS,
    visionConnectionId: connection.id,
    textConnectionId: connection.id,
    visionModelId: "fixture-vision",
    textModelId: "fixture-writer",
  };
  await store.saveProject(p);
  return p;
}

it("stops the run once when the writers hit a daily limit, without substitutes", async () => {
  limited = new Set(["use_case"]);
  const p = await project("Rate-limited writers");
  const ctx = recordingContext(p.id);
  const started = Date.now();
  const err = await pipeline
    .runGeneration(ctx, p.id, DEFAULT_GENERATION_OPTIONS)
    .catch((e: unknown) => e);
  expect(Date.now() - started).toBeLessThan(20_000);
  const described = failure.describeFailure(err)!;
  expect(described).toMatchObject({
    kind: "rate-limited",
    action: "wait",
    connectionName: "Rate-limited writers",
    model: "fixture-writer",
  });
  const resetAt = Date.parse(described.resetAt!);
  expect(resetAt).toBeGreaterThan(started + RESET_MS - 60_000);
  expect(described.message).toMatch(/should reset at about/);
  // Parallel writers stop together: at most one request each in flight, no retries.
  expect(received.filter((s) => s === "use_case").length).toBeLessThanOrEqual(
    4,
  );
  const text = ctx.logs.map((l) => l.message).join("\n");
  expect(text).not.toMatch(/generated it from the screen inventory instead/);
  expect(text).toMatch(/pausing calls to fixture-writer until/);
});

it("does not swap in a deterministic plan when planning hits the limit", async () => {
  limited = new Set(["journey_map"]);
  const p = await project("Rate-limited planner");
  const ctx = recordingContext(p.id);
  const err = await pipeline
    .runGeneration(ctx, p.id, DEFAULT_GENERATION_OPTIONS)
    .catch((e: unknown) => e);
  expect(failure.describeFailure(err)).toMatchObject({ kind: "rate-limited" });
  const text = ctx.logs.map((l) => l.message).join("\n");
  expect(text).not.toMatch(/from the screen inventory instead/);
  expect(received).not.toContain("use_case_plan");
});

it("fails a later call to the paused model without sending it", async () => {
  limited = new Set(["use_case"]);
  const p = await project("Paused model");
  await pipeline
    .runGeneration(recordingContext(p.id), p.id, DEFAULT_GENERATION_OPTIONS)
    .catch(() => undefined);
  received.length = 0;
  limited = new Set();
  // Readings reuse the cache from the stopped run; the writers are paused until the reset.
  const err = await pipeline
    .runGeneration(recordingContext(p.id), p.id, DEFAULT_GENERATION_OPTIONS)
    .catch((e: unknown) => e);
  expect(failure.describeFailure(err)).toMatchObject({ kind: "rate-limited" });
  expect(received).not.toContain("use_case");
});

it("resumes from the last finished step on Try again (tester build WP4)", async () => {
  limited = new Set();
  useCaseAllowance = 3;
  const p = await project("Resumed run");
  const first = await pipeline
    .runGeneration(recordingContext(p.id), p.id, DEFAULT_GENERATION_OPTIONS)
    .catch((e: unknown) => e);
  expect(failure.describeFailure(first)).toMatchObject({
    kind: "rate-limited",
  });

  // The limit resets; the BA presses Try again with the same choices.
  rateLimit.resetRateLimits();
  useCaseAllowance = undefined;
  received.length = 0;
  const ctx = recordingContext(p.id);
  const result = await pipeline.runGeneration(
    ctx,
    p.id,
    DEFAULT_GENERATION_OPTIONS,
  );
  expect(received).not.toContain("screen_analysis_v2");
  expect(received).not.toContain("journey_map");
  expect(received).not.toContain("use_case_plan");
  expect(received.filter((s) => s === "use_case")).toHaveLength(
    result.useCaseCount - 3,
  );
  const text = ctx.logs.map((l) => l.message).join("\n");
  expect(text).toContain(
    "Reused the journey map from the run that did not finish.",
  );
  expect(text).toContain("Reused the plan from the run that did not finish.");
  expect(
    text.match(/Reused UC-\d+ .* from the run that did not finish\./g),
  ).toHaveLength(3);
  expect(text).not.toMatch(/from the screen inventory instead/);

  // A saved generation clears its checkpoints.
  const { readdir } = await import("node:fs/promises");
  expect(
    await readdir(`${cfg.paths.projectDir(p.id)}/analysis-cache/stages`),
  ).toEqual([]);
});

it("re-runs only the stages a changed setting affects", async () => {
  limited = new Set();
  useCaseAllowance = 2;
  const p = await project("Changed granularity");
  await pipeline
    .runGeneration(recordingContext(p.id), p.id, DEFAULT_GENERATION_OPTIONS)
    .catch(() => undefined);
  rateLimit.resetRateLimits();
  useCaseAllowance = undefined;
  received.length = 0;
  const ctx = recordingContext(p.id);
  await pipeline.runGeneration(ctx, p.id, {
    ...DEFAULT_GENERATION_OPTIONS,
    granularity: "fine",
  });
  // The journey map does not depend on granularity; the plan, and so every use case, does.
  expect(received).not.toContain("journey_map");
  expect(received).toContain("use_case_plan");
  const text = ctx.logs.map((l) => l.message).join("\n");
  expect(text).toContain("Reused the journey map");
  expect(text).not.toContain("Reused the plan");
  expect(text).not.toMatch(/Reused UC-/);
});

it("starts fresh when screen reuse is switched off", async () => {
  limited = new Set();
  useCaseAllowance = 2;
  const p = await project("No reuse");
  await pipeline
    .runGeneration(recordingContext(p.id), p.id, DEFAULT_GENERATION_OPTIONS)
    .catch(() => undefined);
  rateLimit.resetRateLimits();
  useCaseAllowance = undefined;
  received.length = 0;
  await pipeline.runGeneration(recordingContext(p.id), p.id, {
    ...DEFAULT_GENERATION_OPTIONS,
    reuseScreenAnalyses: false,
  });
  expect(received).toContain("screen_analysis_v2");
  expect(received).toContain("journey_map");
  expect(received).toContain("use_case_plan");
});
