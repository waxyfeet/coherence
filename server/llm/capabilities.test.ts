import http from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import type { ProviderConnection, ProviderKind } from "@shared/types";
import { modelEvidence } from "@shared/modelCapabilities";
import { useTempDataDir, removeDir } from "../storage/testUtils";
let dir: string, base: string, server: http.Server;
let settings: typeof import("../storage/settingsStore"),
  capabilities: typeof import("./capabilities");
const key = "synthetic-capability-account-key",
  marker = "synthetic-confidential-response-marker";
let mode = "success",
  release: (() => void) | undefined,
  started: (() => void) | undefined;
const calls: {
  path: string;
  model: string;
  image: boolean;
  native: boolean;
  auth: boolean;
}[] = [];
const json = (res: http.ServerResponse, body: unknown, status = 200) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
beforeAll(async () => {
  dir = await useTempDataDir("capabilities");
  vi.resetModules();
  server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const image = !!JSON.stringify(body).match(
      /image_url|inlineData|"images"|"type":"image"/,
    );
    const native = !!(
      body.response_format?.type === "json_schema" ||
      body.output_config?.format ||
      body.generationConfig?.responseJsonSchema ||
      body.generationConfig?.responseSchema ||
      typeof body.format === "object"
    );
    const model =
      body.model ??
      decodeURIComponent(
        req.url!.match(/models\/([^:]+):/)?.[1] ??
          req.url!.match(/deployments\/([^/]+)/)?.[1] ??
          "",
      );
    calls.push({
      path: req.url!,
      model,
      image,
      native,
      auth: [
        req.headers.authorization,
        req.headers["api-key"],
        req.headers["x-api-key"],
        req.headers["x-goog-api-key"],
      ].some((v) => v === key || v === `Bearer ${key}`),
    });
    const respond = () => {
      if (req.url!.endsWith("/api/show")) {
        json(
          res,
          mode === "metadata-unknown"
            ? { model_info: { private: marker } }
            : {
                capabilities: ["completion", "vision", "thinking"],
                model_info: { "fixture.context_length": 8192, private: marker },
                modelfile: marker,
              },
        );
        return;
      }
      if (
        mode === "auth" ||
        mode === "rate" ||
        mode === "missing" ||
        mode === "unsupported" ||
        mode === "format-unsupported" ||
        mode === "generic400"
      ) {
        const status =
          mode === "auth"
            ? 401
            : mode === "rate"
              ? 429
              : mode === "missing"
                ? 404
                : 400;
        const message =
          mode === "unsupported"
            ? "This model does not support image input"
            : mode === "format-unsupported"
              ? "response_format json_schema is not supported by this model"
              : mode === "generic400"
                ? "invalid request"
                : marker;
        json(
          res,
          { error: { message, type: "invalid_request_error", code: status } },
          status,
        );
        return;
      }
      let text = image
        ? "yellow blue green"
        : native || raw.includes("Return only the JSON")
          ? '{"status":"ready","count":3}'
          : "OK";
      if (mode === "wrong") text = "Arbitrary response " + marker;
      if (mode === "empty") text = "";
      if (mode === "hold") text = "OK";
      const stop = mode === "truncated" ? "length" : "stop";
      const geminiAnswer = {
        modelVersion: model,
        candidates: [
          {
            content: { role: "model", parts: [{ text }] },
            finishReason: stop === "length" ? "MAX_TOKENS" : "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3 },
      };
      if (req.url!.includes(":streamGenerateContent")) {
        if (res.destroyed) return;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${JSON.stringify(geminiAnswer)}\n\n`);
        return;
      }
      if (req.url!.includes(":generateContent")) {
        json(res, geminiAnswer);
        return;
      }
      if (req.url!.includes("/messages")) {
        if (res.destroyed) return;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const event = (type: string, data: unknown) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        event("message_start", {
          type: "message_start",
          message: {
            id: "fixture",
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 4, output_tokens: 1 },
          },
        });
        event("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
        event("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        });
        event("content_block_stop", { type: "content_block_stop", index: 0 });
        event("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 3 },
        });
        event("message_stop", { type: "message_stop" });
        res.end();
        return;
      }
      if (req.url!.includes("/api/chat")) {
        json(res, {
          model,
          message: { role: "assistant", content: text },
          done: true,
          done_reason: stop,
          eval_count: 3,
          prompt_eval_count: 4,
        });
        return;
      }
      json(res, {
        id: "fixture",
        model: mode === "wrong-model" ? marker : model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: text,
              ...(mode === "refusal" ? { refusal: marker } : {}),
            },
            finish_reason: stop,
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      });
    };
    if (mode === "hold") {
      release = respond;
      started?.();
    } else respond();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  settings = await import("../storage/settingsStore");
  capabilities = await import("./capabilities");
});
afterAll(async () => {
  release?.();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await removeDir(dir);
});
async function account(
  provider: ProviderKind = "openai-compatible",
  extra: Partial<ProviderConnection> = {},
) {
  mode = "success";
  return settings.createConnection({
    name: "Synthetic capability fixture",
    provider,
    baseUrl:
      base + (["openai-compatible", "openai"].includes(provider) ? "/v1" : ""),
    apiKey: key,
    modelIds: ["Exact-Model", "Other-Model"],
    ...extra,
  });
}
it.each([
  "openai",
  "anthropic",
  "gemini",
  "azure-openai",
  "ollama",
  "openai-compatible",
] as const)(
  "tests exact %s text/image/native/prompt paths with protected credentials",
  async (provider) => {
    const c = await account(provider);
    const start = calls.length;
    for (const [capability, testMode] of [
      ["text", undefined],
      ["image", undefined],
      ["structured", "native"],
      ["structured", "prompt"],
    ] as const) {
      const result = await capabilities.testModelCapability(
        c,
        "Exact-Model",
        capability,
        testMode,
      );
      expect(
        result.record,
        JSON.stringify({ provider, capability }),
      ).toMatchObject({
        outcome: "passed",
        state: "tested",
      });
      expect(result.persisted).toBe(true);
      expect(result.modelId).toBe("Exact-Model");
      expect(JSON.stringify(result)).not.toContain(key);
    }
    const requests = calls.slice(start);
    expect(requests).toHaveLength(4);
    expect(requests.every((r) => r.model === "Exact-Model" && r.auth)).toBe(
      true,
    );
    expect(requests.filter((r) => r.image)).toHaveLength(1);
    expect(requests.filter((r) => r.native)).toHaveLength(1);
    if (provider === "azure-openai")
      expect(
        requests.every(
          (r) =>
            r.path.includes("/deployments/Exact-Model/") &&
            r.path.includes("api-version="),
        ),
      ).toBe(true);
    const e = modelEvidence(
      (await capabilities.cachedCapabilities(c))["Exact-Model"],
    );
    expect(e.text.state).toBe("tested");
    expect(e.image.state).toBe("tested");
    expect(e.nativeStructured.state).toBe("tested");
    expect(e.promptStructured.state).toBe("tested");
  },
);
it("LM Studio keeps the compatible inference dialect and exact ID", async () => {
  const c = await account("openai-compatible", { presetId: "lm-studio" });
  expect(
    (await capabilities.testModelCapability(c, "Exact-Model", "image")).ok,
  ).toBe(true);
  expect(calls.at(-1)?.path).toBe("/v1/chat/completions");
});
it.each(["wrong", "empty", "refusal", "truncated"])(
  "does not promote a %s response or retain its body",
  async (value) => {
    const c = await account();
    mode = value;
    const r = await capabilities.testModelCapability(c, "Exact-Model", "image");
    expect(r.ok).toBe(false);
    expect(r.record.state).toBe("unknown");
    expect(JSON.stringify(r)).not.toContain(marker);
    expect(
      await fs.readFile(path.join(dir, "model-capability-tests.json"), "utf8"),
    ).not.toContain(marker);
  },
);
it.each(["auth", "rate", "missing", "generic400"])(
  "%s remains a failure, not proof of unsupported capability",
  async (value) => {
    const c = await account();
    mode = value;
    const r = await capabilities.testModelCapability(c, "Exact-Model", "image");
    expect(r.ok).toBe(false);
    expect(r.record.state).toBe("unknown");
    expect(JSON.stringify(r)).not.toContain(marker);
  },
);
it("distinguishes a definitive image refusal from an invalid image/request", async () => {
  const c = await account();
  mode = "unsupported";
  const r = await capabilities.testModelCapability(c, "Exact-Model", "image");
  expect(r.record.state).toBe("unsupported");
});
it("does not turn an image-specific rejection into unsupported text, in public status or runtime policy", async () => {
  const c = await account();
  mode = "unsupported";
  const before = calls.length;
  const result = await capabilities.testModelCapability(
    c,
    "Exact-Model",
    "text",
  );
  expect(calls.slice(before)).toMatchObject([{ image: false, native: false }]);
  expect(result.record).toMatchObject({
    capability: "text",
    state: "unknown",
    outcome: "failed",
    reason: "failed",
  });
  const pub = (await settings.getPublicSettings()).connections.find(
    (r) => r.id === c.id,
  )!;
  expect(modelEvidence(pub.capabilities?.["Exact-Model"]).text.state).toBe(
    "unknown",
  );
  const store = await import("../storage/projectStore"),
    jobs = await import("../agents/connections"),
    p = await store.createProject({
      name: "Synthetic cross-capability error",
      description: "Synthetic regression fixture",
    });
  const after = calls.length;
  const writing = await jobs.resolveJobConnection(p, c.id, [], undefined, {
    modelId: "Exact-Model",
  });
  expect(writing.connection.model).toBe("Exact-Model");
  expect(calls.length).toBe(after);
});
it("native structured rejection does not erase or certify prompt-and-validate evidence", async () => {
  const c = await account();
  await capabilities.testModelCapability(
    c,
    "Exact-Model",
    "structured",
    "prompt",
  );
  mode = "format-unsupported";
  const r = await capabilities.testModelCapability(
    c,
    "Exact-Model",
    "structured",
    "native",
  );
  expect(r.record.state).toBe("unsupported");
  const e = modelEvidence(
    (await capabilities.cachedCapabilities(c))["Exact-Model"],
  );
  expect(e.promptStructured.state).toBe("tested");
  expect(e.nativeStructured.state).toBe("unsupported");
});
it.each([
  ["unsupported", "structured", "native"],
  ["unsupported", "structured", "prompt"],
  ["format-unsupported", "text", undefined],
  ["format-unsupported", "image", undefined],
  ["format-unsupported", "structured", "prompt"],
] as const)(
  "keeps %s unrelated to %s/%s unknown and preserves other dimensions",
  async (error, capability, testMode) => {
    const c = await account();
    await capabilities.testModelCapability(c, "Exact-Model", "text");
    await capabilities.testModelCapability(c, "Exact-Model", "image");
    mode = error;
    const result = await capabilities.testModelCapability(
      c,
      "Exact-Model",
      capability,
      testMode,
    );
    expect(result.record).toMatchObject({
      state: "unknown",
      reason: "failed",
      outcome: "failed",
    });
    const records = (await capabilities.cachedCapabilities(c))["Exact-Model"];
    const e = modelEvidence(records);
    expect(e.text.state).toBe(capability === "text" ? "unknown" : "tested");
    expect(e.image.state).toBe(capability === "image" ? "unknown" : "tested");
    expect(e.nativeStructured.state).toBe("unknown");
    expect(e.promptStructured.state).toBe("unknown");
  },
);
it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
  "tests, caches and resolves the legitimate exact model ID %s",
  async (id) => {
    const c = await account("openai-compatible", { modelIds: [id] });
    const before = calls.length;
    const result = await capabilities.testModelCapability(c, id, "text");
    expect(result.ok).toBe(true);
    expect(calls.slice(before)).toMatchObject([{ model: id }]);
    const inventory = (await settings.getPublicSettings()).connections.find(
      (r) => r.id === c.id,
    )!.capabilities!;
    expect(Object.hasOwn(inventory, id)).toBe(true);
    expect(modelEvidence(inventory[id]).text.state).toBe("tested");
    const { resolveJobConnection } = await import("../agents/connections"),
      { createProject } = await import("../storage/projectStore"),
      project = await createProject({
        name: "Synthetic special model ID",
        description: "Synthetic regression fixture",
      });
    expect(
      (
        await resolveJobConnection(project, c.id, [], undefined, {
          modelId: id,
        })
      ).connection.model,
    ).toBe(id);
    expect(calls.length).toBe(before + 1);
  },
);
it("invalidates version-1 summaries without modifying accounts, assignments or starting tests", async () => {
  const c = await account();
  const { providerEndpoint } = await import("../security/endpointPolicy");
  const legacyHash = createHash("sha256")
    .update(
      JSON.stringify([
        1,
        c.id,
        c.provider,
        providerEndpoint(c).replace(/\/+$/, ""),
        c.presetId ?? "",
        key,
        c.azureApiVersion ?? "",
        "Exact-Model",
        c.vision,
        c.structuredOutput,
        c.effort ?? "",
        c.temperature ?? null,
        c.maxOutputTokens ?? null,
        c.requestTimeoutSec,
      ]),
    )
    .digest("hex");
  const legacy = JSON.stringify({
    [legacyHash]: [
      {
        capability: "text",
        at: new Date().toISOString(),
        outcome: "failed",
        state: "unsupported",
        reason: "unsupported",
      },
    ],
  });
  const filename = path.join(dir, "model-capability-tests.json");
  await fs.writeFile(filename, legacy);
  const before = calls.length;
  const pub = (await settings.getPublicSettings()).connections.find(
    (r) => r.id === c.id,
  )!;
  expect(modelEvidence(pub.capabilities?.["Exact-Model"]).text.state).toBe(
    "unknown",
  );
  expect(await fs.readFile(filename, "utf8")).toBe(legacy);
  expect(await settings.getConnection(c.id)).toEqual(c);
  const { createProject } = await import("../storage/projectStore"),
    { resolveJobConnection } = await import("../agents/connections"),
    project = await createProject({
      name: "Synthetic legacy evidence",
      description: "Synthetic regression fixture",
    });
  expect(
    (
      await resolveJobConnection(project, c.id, [], undefined, {
        modelId: "Exact-Model",
      })
    ).connection.model,
  ).toBe("Exact-Model");
  expect(calls.length).toBe(before);
  mode = "success";
  expect(
    (await capabilities.testModelCapability(c, "Exact-Model", "text")).record
      .state,
  ).toBe("tested");
});
it("Ollama native metadata is explicit and allow-listed, without inference", async () => {
  const c = await account("ollama");
  const start = calls.length;
  const r = await capabilities.testModelCapability(
    c,
    "Exact-Model",
    "metadata",
  );
  expect(calls.slice(start)).toHaveLength(1);
  expect(calls.at(-1)?.path).toBe("/api/show");
  expect(r.record.state).toBe("provider-reported");
  const e = modelEvidence(r.records);
  expect(e.text.state).toBe("provider-reported");
  expect(e.image.state).toBe("provider-reported");
  expect(e.reasoning.state).toBe("provider-reported");
  expect(e.contextWindow).toBe(8192);
  expect(JSON.stringify(r)).not.toContain(marker);
});
it("unavailable metadata and Offline never make inference or certify support", async () => {
  const c = await account();
  const start = calls.length;
  const r = await capabilities.testModelCapability(
    c,
    "Exact-Model",
    "metadata",
  );
  expect(r.record.outcome).toBe("unavailable");
  const offline = (await settings.getSettings()).connections.find(
    (c) => c.provider === "mock",
  )!;
  const s = await capabilities.testModelCapability(offline, "demo", "text");
  expect(s.ok).toBe(false);
  expect(calls.length).toBe(start);
});
it("missing native metadata remains unknown without guessing from names", async () => {
  const c = await account("ollama");
  mode = "metadata-unknown";
  const r = await capabilities.testModelCapability(
    c,
    "Other-Model",
    "metadata",
  );
  expect(r.record.state).toBe("unknown");
  expect(modelEvidence(r.records).image.state).toBe("unknown");
});
it("binds verification to exact model, account, endpoint, key, Azure version and tuning", async () => {
  const c = await account();
  await capabilities.testModelCapability(c, "Exact-Model", "text");
  expect(
    modelEvidence((await capabilities.cachedCapabilities(c))["Other-Model"])
      .text.state,
  ).toBe("unknown");
  for (const change of [
    { id: "different-account" },
    { baseUrl: base + "/other/v1" },
    { apiKey: "synthetic-changed-key" },
    { vision: "no" as const },
    { structuredOutput: "prompt" as const },
    { temperature: 0.2 },
    { effort: "low" as const },
    { maxOutputTokens: 555 },
    { requestTimeoutSec: 321 },
    { azureApiVersion: "different-version" },
  ]) {
    expect(
      (await capabilities.cachedCapabilities({ ...c, ...change }))[
        "Exact-Model"
      ],
    ).toEqual([]);
  }
  const changed = await settings.updateConnection(c.id, {
    name: c.name,
    provider: c.provider,
    baseUrl: c.baseUrl,
    apiKey: "synthetic-new-credential",
    modelIds: c.modelIds,
  });
  expect(
    modelEvidence(
      (await capabilities.cachedCapabilities(changed))["Exact-Model"],
    ).text.state,
  ).toBe("unknown");
});
it("marks expired evidence unknown and does not probe on Settings/cache reads", async () => {
  const c = await account();
  await capabilities.testModelCapability(c, "Exact-Model", "text");
  const cacheFile = path.join(dir, "model-capability-tests.json"),
    cache = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  for (const records of Object.values(cache) as { at: string }[][])
    for (const row of records) row.at = "2020-01-01T00:00:00.000Z";
  await fs.writeFile(cacheFile, JSON.stringify(cache));
  const start = calls.length;
  const pub = await settings.getPublicSettings();
  const e = modelEvidence(
    pub.connections.find((r) => r.id === c.id)?.capabilities?.["Exact-Model"],
  );
  expect(e.text.state).toBe("unknown");
  expect(e.text.stale).toBe(true);
  expect(calls.length).toBe(start);
});
it("retains newer failure when an older test finishes late", async () => {
  const c = await account();
  let notify!: () => void;
  const ready = new Promise<void>((r) => (notify = r));
  started = notify;
  mode = "hold";
  const older = capabilities.testModelCapability(c, "Exact-Model", "text");
  await ready;
  mode = "auth";
  await capabilities.testModelCapability(c, "Exact-Model", "text");
  mode = "success";
  release!();
  await older;
  started = undefined;
  const records = (await capabilities.cachedCapabilities(c))["Exact-Model"];
  expect(records[0].reason).toBe("auth");
  expect(modelEvidence(records).text.state).toBe("unknown");
});
it("cancels and invalidates this attempt without retaining successful verification", async () => {
  const c = await account();
  await capabilities.testModelCapability(c, "Exact-Model", "text");
  let notify!: () => void;
  const ready = new Promise<void>((r) => (notify = r));
  started = notify;
  mode = "hold";
  const controller = new AbortController();
  const pending = capabilities.testModelCapability(
    c,
    "Exact-Model",
    "text",
    undefined,
    controller.signal,
  );
  await ready;
  controller.abort();
  const r = await pending;
  release!();
  started = undefined;
  expect(r.ok).toBe(false);
  expect(r.record.outcome).toBe("cancelled");
  expect(
    modelEvidence((await capabilities.cachedCapabilities(c))["Exact-Model"])
      .text.state,
  ).toBe("unknown");
});
it("bounds an unresponsive test and keeps timeout distinct from unsupported", async () => {
  const c = await account();
  mode = "hold";
  const r = await capabilities.testModelCapability(
    { ...c, requestTimeoutSec: 0.03 },
    "Exact-Model",
    "text",
  );
  release?.();
  expect(r.ok).toBe(false);
  expect(r.record.reason).toBe("timeout");
  expect(r.record.state).toBe("unknown");
});
it("rejects credential-bearing URLs before outbound work", async () => {
  const c = await account();
  const start = calls.length;
  await expect(
    capabilities.testModelCapability(
      { ...c, baseUrl: "https://user:synthetic-secret@example.invalid/v1" },
      "Exact-Model",
      "text",
    ),
  ).rejects.toThrow();
  expect(calls.length).toBe(start);
});
it("evidence is private, bounded summaries; catalogue/model membership never certifies a model", async () => {
  const c = await account();
  await capabilities.testModelCapability(c, "Exact-Model", "text");
  const raw = await fs.readFile(
    path.join(dir, "model-capability-tests.json"),
    "utf8",
  );
  expect(raw).not.toContain(key);
  expect(raw).not.toContain(base);
  expect(raw).not.toContain("Reply with");
  expect(raw).not.toContain("base64");
  expect(
    modelEvidence([], { id: "vision-llava-gpt", reported: undefined }).image
      .state,
  ).toBe("unknown");
  expect(
    modelEvidence([], { id: "x", reported: { vision: true } }).image.state,
  ).toBe("provider-reported");
  expect(
    modelEvidence([], { id: "x", reported: { vision: false } }).image.state,
  ).toBe("unsupported");
});

it("applies verified image evidence and optional controls only to the exact runtime model, without mutating saved values", async () => {
  const c = await account("openai-compatible", { temperature: 0.4 });
  const store = await import("../storage/projectStore"),
    jobs = await import("../agents/connections");
  const p = await store.createProject({
    name: "Synthetic runtime capability",
    description: "No private data",
  });
  await expect(
    jobs.resolveJobConnection(p, c.id, [], undefined, {
      reading: true,
      modelId: "Exact-Model",
    }),
  ).rejects.toThrow(/unverified/);
  let writing = await jobs.resolveJobConnection(p, c.id, [], undefined, {
    modelId: "Exact-Model",
  });
  expect(writing.connection.temperature).toBeUndefined();
  expect(writing.connection.vision).toBe("no");
  await capabilities.testModelCapability(c, "Exact-Model", "text");
  await capabilities.testModelCapability(c, "Exact-Model", "image");
  const reading = await jobs.resolveJobConnection(p, c.id, [], undefined, {
    reading: true,
    modelId: "Exact-Model",
  });
  expect(reading.connection.vision).toBe("yes");
  writing = await jobs.resolveJobConnection(p, c.id, [], undefined, {
    modelId: "Exact-Model",
  });
  expect(writing.connection.temperature).toBe(0.4);
  const other = await jobs.resolveJobConnection(p, c.id, [], undefined, {
    modelId: "Other-Model",
  });
  expect(other.connection.temperature).toBeUndefined();
  expect(other.connection.vision).toBe("no");
  expect((await settings.getConnection(c.id)).temperature).toBe(0.4);
  mode = "unsupported";
  await capabilities.testModelCapability(c, "Exact-Model", "image");
  await expect(
    jobs.resolveJobConnection(p, c.id, [], undefined, {
      reading: true,
      modelId: "Exact-Model",
      acknowledged: true,
    }),
  ).rejects.toThrow(/text-only/);
});

it("a saved model change/removal does not transfer earlier verification or delete project content", async () => {
  const c = await account();
  await capabilities.testModelCapability(c, "Exact-Model", "text");
  const updated = await settings.updateConnection(c.id, {
    name: c.name,
    provider: c.provider,
    baseUrl: c.baseUrl,
    modelIds: ["Other-Model"],
  });
  const pub = (await settings.getPublicSettings()).connections.find(
    (r) => r.id === updated.id,
  )!;
  expect(pub.capabilities?.["Exact-Model"]).toBeUndefined();
  expect(pub.capabilities?.["Other-Model"]).toEqual([]);
  await settings.deleteConnection(c.id);
  const before = calls.length;
  expect(
    (await settings.getPublicSettings()).connections.some((r) => r.id === c.id),
  ).toBe(false);
  expect(calls.length).toBe(before);
});

it("damaged/unknown fields in optional evidence cannot disclose provider bodies or block Settings", async () => {
  const c = await account();
  await capabilities.testModelCapability(c, "Exact-Model", "text");
  const filename = path.join(dir, "model-capability-tests.json"),
    cache = JSON.parse(await fs.readFile(filename, "utf8"));
  for (const records of Object.values(cache) as Record<string, unknown>[][])
    for (const r of records) r.raw = marker;
  await fs.writeFile(filename, JSON.stringify(cache));
  expect(JSON.stringify(await settings.getPublicSettings())).not.toContain(
    marker,
  );
  await fs.writeFile(filename, "{invalid");
  expect((await capabilities.cachedCapabilities(c))["Exact-Model"]).toEqual([]);
  await expect(settings.getPublicSettings()).resolves.toBeTruthy();
});

it("reports successful probing separately from unavailable evidence persistence without exposing local paths", async () => {
  const c = await account(),
    filename = path.join(dir, "model-capability-tests.json");
  await fs.unlink(filename);
  await fs.mkdir(filename);
  try {
    const result = await capabilities.testModelCapability(
      c,
      "Exact-Model",
      "text",
    );
    expect(result.ok).toBe(true);
    expect(result.persisted).toBe(false);
    expect(result.message).toContain("could not be retained locally");
    expect(JSON.stringify(result)).not.toContain(dir);
  } finally {
    await fs.rmdir(filename);
  }
});

it("binds Gemini's supported legacy environment-key alias to the actual tested credential", async () => {
  vi.stubEnv("SCREENSCRIBE_V2_GEMINI_API_KEY", "");
  vi.stubEnv(
    "SCREENSCRIBE_V2_GOOGLE_API_KEY",
    "synthetic-legacy-google-alias-one",
  );
  const fake = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: "OK" }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  try {
    const c = await settings.createConnection({
      name: "Synthetic legacy env alias",
      provider: "gemini",
      modelIds: ["Exact-Model"],
    });
    const result = await capabilities.testModelCapability(
      c,
      "Exact-Model",
      "text",
    );
    expect(result.ok).toBe(true);
    expect(result.persisted).toBe(true);
    expect(fake).toHaveBeenCalled();
    expect(
      modelEvidence((await capabilities.cachedCapabilities(c))["Exact-Model"])
        .text.state,
    ).toBe("tested");
    vi.stubEnv(
      "SCREENSCRIBE_V2_GOOGLE_API_KEY",
      "synthetic-legacy-google-alias-two",
    );
    expect((await capabilities.cachedCapabilities(c))["Exact-Model"]).toEqual(
      [],
    );
  } finally {
    fake.mockRestore();
    vi.unstubAllEnvs();
  }
});

it("does not mistake an unsupported image format/size or schema keyword for unsupported model capability", async () => {
  const { explicitlyRejectsImageInput, explicitlyRejectsStructuredOutput } =
    await import("./providers/common");
  for (const text of [
    "This model does not support image format PNG",
    "This model does not support images larger than 5 MB",
    "Unsupported image resolution",
    "Image decoding failed",
  ])
    expect(explicitlyRejectsImageInput(text)).toBe(false);
  for (const text of [
    "response_format schema contains an unsupported property",
    "json_schema has an unsupported keyword",
    "Invalid JSON schema",
  ])
    expect(explicitlyRejectsStructuredOutput(text)).toBe(false);
  expect(
    explicitlyRejectsImageInput("This model does not support image input"),
  ).toBe(true);
  expect(
    explicitlyRejectsStructuredOutput(
      "response_format json_schema is not supported by this model",
    ),
  ).toBe(true);
});
