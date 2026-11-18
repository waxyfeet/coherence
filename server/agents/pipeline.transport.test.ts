/** Real Ollama/OpenAI-compatible HTTP transports and the full agent pipeline; replies are synthetic fixtures, never model inference. */
import http from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { DEFAULT_GENERATION_OPTIONS } from "@shared/types";
import { removeDir, useTempDataDir } from "../storage/testUtils";
import { recordingContext } from "./testContext";
let dir: string,
  base: string,
  server: http.Server,
  counter = 0;
let alterScreen = false;
const replies = new Map<string, { value: unknown; schema: string }>();
const received: {
  schema: string;
  body: any;
  url: string;
  authenticated: boolean;
}[] = [];
let store: typeof import("../storage/projectStore"),
  settings: typeof import("../storage/settingsStore"),
  demo: typeof import("../storage/demo"),
  pipeline: typeof import("./pipeline");
beforeAll(async () => {
  dir = await useTempDataDir("pipeline-transport");
  vi.resetModules();
  server = http.createServer(async (req, res) => {
    try {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      const id = new URL(req.url!, "http://fixture").pathname.split("/")[1];
      const fixture = replies.get(id);
      if (!fixture) throw Error("Unknown fixture request");
      received.push({
        schema: fixture.schema,
        body,
        url: req.url!,
        authenticated:
          req.headers.authorization === "Bearer synthetic-shared-account-key",
      });
      const content = JSON.stringify(fixture.value);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          req.url!.endsWith("/api/chat")
            ? {
                model: body.model,
                message: { role: "assistant", content },
                done: true,
                done_reason: "stop",
                prompt_eval_count: 20,
                eval_count: 10,
              }
            : {
                id: "fixture-response",
                model: body.model,
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content },
                    finish_reason: "stop",
                  },
                ],
                usage: {
                  prompt_tokens: 20,
                  completion_tokens: 10,
                  total_tokens: 30,
                },
              },
        ),
      );
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  // Test-only response preparation. Production generateStructured still performs serialization,
  // networking, schema validation, usage accounting and all orchestration through the selected adapter.
  vi.doMock("../llm/structured", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../llm/structured")>();
    const generateStructured = (async (
      opts: Parameters<typeof actual.generateStructured>[0],
    ) => {
      expect(opts.connection.provider).not.toBe("mock");
      const id = "call-" + ++counter;
      const value = opts.mock();
      if (alterScreen && opts.schemaName === "screen_analysis_v2") {
        const screen = value as { elements: { label: string }[] };
        screen.elements[0].label += " — synthetic changed label";
        alterScreen = false;
      }
      replies.set(id, { value, schema: opts.schemaName });
      return actual.generateStructured({
        ...opts,
        connection: {
          ...opts.connection,
          baseUrl: `${base}/${id}${opts.connection.provider === "ollama" ? "" : "/v1"}`,
        },
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
  await store.ensureDataDirs();
});
afterAll(async () => {
  vi.doUnmock("../llm/structured");
  server?.closeAllConnections();
  await new Promise<void>((r) => server?.close(() => r()));
  await removeDir(dir);
});
it.each(["ollama", "openai-compatible"] as const)(
  "routes two exact models through one account and the real %s HTTP adapter using fixture replies",
  async (provider) => {
    const start = received.length;
    const connection = await settings.createConnection({
      name: "Isolated transport fixture",
      provider,
      modelIds: ["fixture-vision", "fixture-writer"],
      apiKey:
        provider === "openai-compatible"
          ? "synthetic-shared-account-key"
          : undefined,
      baseUrl: base,
      vision: "yes",
      structuredOutput: "native",
      concurrency: 2,
    });
    const project = await demo.createDemoProject();
    project.generationPreferences = {
      ...DEFAULT_GENERATION_OPTIONS,
      visionConnectionId: connection.id,
      textConnectionId: connection.id,
      visionModelId: "fixture-vision",
      textModelId: "fixture-writer",
    };
    await store.saveProject(project);
    const ctx = recordingContext(project.id);
    const result = await pipeline.runGeneration(ctx, project.id, {
      ...DEFAULT_GENERATION_OPTIONS,
      thoroughness: "thorough",
    });
    const calls = received.slice(start);
    for (const call of calls) {
      expect(call.body.model).toBe(
        ["screen_analysis_v2", "screen_inspection"].includes(call.schema)
          ? "fixture-vision"
          : "fixture-writer",
      );
      if (provider === "openai-compatible")
        expect(call.authenticated).toBe(true);
    }
    expect(connection.model).toBeUndefined();
    expect(connection.modelIds).toEqual(["fixture-vision", "fixture-writer"]);
    expect(result.screenCount).toBe(4);
    expect(result.useCaseCount).toBeGreaterThan(8);
    for (const schema of [
      "screen_analysis_v2",
      "screen_inspection",
      "journey_map",
      "use_case_plan",
      "use_case",
      "review",
    ])
      expect(
        calls.some((c) => c.schema === schema),
        schema,
      ).toBe(true);
    const imageCalls = calls.filter((c) => c.schema === "screen_analysis_v2");
    expect(imageCalls).toHaveLength(4);
    for (const c of imageCalls) {
      expect(c.url).toContain(
        provider === "ollama" ? "/api/chat" : "/chat/completions",
      );
      if (provider === "ollama")
        expect(c.body.messages.some((m: any) => m.images?.length > 0)).toBe(
          true,
        );
      else
        expect(
          c.body.messages.some(
            (m: any) =>
              Array.isArray(m.content) &&
              m.content.some(
                (p: any) =>
                  p.type === "image_url" &&
                  p.image_url.url.startsWith("data:image/"),
              ),
          ),
        ).toBe(true);
    }
    expect(ctx.usage.inputTokens).toBe(calls.length * 20);
    expect(ctx.usage.outputTokens).toBe(calls.length * 10);
    const model = (await store.loadModel(project.id))!;
    expect(model.generator.vision).toBe(`${provider}/fixture-vision`);
    expect(model.generator.text).toBe(`${provider}/fixture-writer`);
    expect(model.options.visionModelId).toBe("fixture-vision");
    expect(model.options.textModelId).toBe("fixture-writer");
    expect(model.options.visionConnectionId).toBe(connection.id);
    expect(
      (await store.getProject(project.id)).generationPreferences
        ?.textConnectionId,
    ).toBe(connection.id);
    expect(model.useCases.every((u) => !!u.filePath)).toBe(true);
    expect(
      ctx.logs.some((l) =>
        /Writer agent failed|Planner agent failed|Journey Mapper agent failed/.test(
          l.message,
        ),
      ),
    ).toBe(false);

    // Changing next-run assignments must not rewrite the already saved run or its provenance.
    const historical = JSON.stringify(await store.loadModel(project.id));
    await store.updateProject(project.id, {
      llm: {
        visionConnectionId: connection.id,
        visionModelId: "fixture-writer",
        textConnectionId: connection.id,
        textModelId: "fixture-vision",
      },
    });
    expect(JSON.stringify(await store.loadModel(project.id))).toBe(historical);
    const changedStart = received.length;
    await pipeline.runGeneration(recordingContext(project.id), project.id, {
      ...DEFAULT_GENERATION_OPTIONS,
      reuseScreenAnalyses: true,
    });
    const newReading = received
      .slice(changedStart)
      .filter((call) => call.schema === "screen_analysis_v2");
    expect(newReading).toHaveLength(4); // The exact reader ID invalidates the old screen cache.
    expect(
      newReading.every((call) => call.body.model === "fixture-writer"),
    ).toBe(true);
    expect(
      (await settings.getSettings()).connections.filter(
        (c) => c.id === connection.id,
      ),
    ).toHaveLength(1);

    // Follow-on actions resolve the same exact pairs, rather than legacy connection.model.
    const followStart = received.length;
    const current = (await store.loadModel(project.id))!;
    const target = current.useCases[0];
    const revision = await (
      await import("./revise")
    ).runReviseUseCase(recordingContext(project.id), project.id, target.id, {
      instructions: "Clarify the synthetic confirmation step.",
      proposalOnly: true,
    });
    expect(revision).toBeTruthy();
    const impact = await import("../graph/impact");
    const report = await impact.runImpactAnalysis(
      recordingContext(project.id),
      project.id,
      {
        change: {
          targetKind: "usecase",
          targetId: target.id,
          source: "manual",
          description: "Synthetic change to confirmation business rules.",
        },
      },
    );
    expect(report.analysedBy).toBe(`${provider}/fixture-vision`);
    await impact.runApplyImpact(
      recordingContext(project.id),
      project.id,
      report.id,
      { useCaseIds: [target.id] },
    );
    expect(
      received
        .slice(followStart)
        .every((c) => c.body.model === "fixture-vision"),
    ).toBe(true);
    expect(
      received.slice(followStart).some((c) => c.schema === "impact_analysis"),
    ).toBe(true);
    expect(
      received.slice(followStart).filter((c) => c.schema === "use_case").length,
    ).toBeGreaterThanOrEqual(2);
    const screenStart = received.length;
    alterScreen = true;
    const reread = await impact.runScreenReanalysis(
      recordingContext(project.id),
      project.id,
      project.screens[0].id,
      {},
    );
    const screenCalls = received.slice(screenStart);
    expect(
      screenCalls.find((c) => c.schema === "screen_analysis_v2")?.body.model,
    ).toBe("fixture-writer");
    expect(
      screenCalls.find((c) => c.schema === "impact_analysis")?.body.model,
    ).toBe("fixture-vision");
    expect(reread.analysedBy).toBe(`${provider}/fixture-vision`);
    if (provider === "openai-compatible")
      expect(received.slice(followStart).every((c) => c.authenticated)).toBe(
        true,
      );
  },
  120_000,
);
