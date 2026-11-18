/** Synthetic HTTP servers only; catalogue requests never perform inference. */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import type { ProviderConnection, ProviderKind } from "@shared/types";
import { visibleModels } from "@shared/modelCatalogue";
import { useTempDataDir, removeDir } from "../storage/testUtils";
let dir: string, base: string, server: http.Server;
let handler: (url: URL, res: http.ServerResponse) => void;
const calls: { path: string; method: string; authenticated: boolean }[] = [];
let catalogue: typeof import("./catalogue"),
  settings: typeof import("../storage/settingsStore");
const key = "synthetic-catalogue-account-secret";
const json = (res: http.ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
beforeAll(async () => {
  dir = await useTempDataDir("catalogue");
  vi.resetModules();
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture");
    calls.push({
      path: url.pathname + url.search,
      method: req.method!,
      authenticated: [
        req.headers.authorization,
        req.headers["x-api-key"],
        req.headers["x-goog-api-key"],
      ].some((v) => v === key || v === `Bearer ${key}`),
    });
    handler(url, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  catalogue = await import("./catalogue");
  settings = await import("../storage/settingsStore");
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await removeDir(dir);
});
async function account(
  provider: ProviderKind,
  extra: Partial<ProviderConnection> = {},
) {
  return settings.createConnection({
    name: "Catalogue synthetic fixture",
    provider,
    baseUrl:
      base + (["openai", "openai-compatible"].includes(provider) ? "/v1" : ""),
    apiKey: key,
    modelIds: ["Manual-ID"],
    ...extra,
  });
}

it.each(["openai", "anthropic", "gemini"] as const)(
  "uses native %s pagination and correct protected auth, with no inference",
  async (provider) => {
    const start = calls.length;
    handler = (url, res) => {
      if (provider === "gemini")
        json(res, {
          models: [
            {
              name: "models/Generation-A",
              displayName: "Generation A",
              supportedGenerationMethods: ["generateContent"],
              inputTokenLimit: 8000,
              outputTokenLimit: 4096,
            },
            {
              name: "models/Embedding-X",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
          ...(url.searchParams.has("pageToken")
            ? {}
            : { nextPageToken: "next cursor" }),
        });
      else
        json(res, {
          data: [
            {
              id: url.searchParams.has(
                provider === "anthropic" ? "after_id" : "after",
              )
                ? "Second"
                : "First",
              display_name: "Provider name",
              capabilities: { image_input: { supported: true } },
            },
          ],
          has_more: !url.searchParams.has(
            provider === "anthropic" ? "after_id" : "after",
          ),
          last_id: "cursor",
        });
    };
    const c = await account(provider),
      r = await catalogue.discoverCatalogue(c);
    expect(r.error).toBeUndefined();
    expect(r.catalogue?.complete).toBe(true);
    expect(r.models).toHaveLength(provider === "gemini" ? 1 : 2);
    expect(calls.slice(start)).toHaveLength(2);
    expect(
      calls.slice(start).every((c) => c.method === "GET" && c.authenticated),
    ).toBe(true);
    expect(calls[start].path).toContain(
      provider === "gemini" ? "/v1beta/models" : "/v1/models",
    );
    if (provider === "anthropic")
      expect(r.models[0].reported?.vision).toBe(true);
    else expect(r.models[0].reported?.vision).toBeUndefined(); // No capability guesses from IDs.
    expect(r.models.some((m) => m.id === "Embedding-X")).toBe(false);
    if (provider === "gemini")
      expect(r.models[0].reported?.outputTokenLimit).toBe(4096);
  },
);

it.each(["", "/api", "/v1"])(
  "uses the Ollama installed inventory with legacy %s suffix and no vision-name guesses",
  async (suffix) => {
    const start = calls.length;
    handler = (_url, res) =>
      json(res, {
        models: [
          { name: "qwen-vl-name-only:Q4", details: { families: ["clip"] } },
          { model: "Other:Q8" },
        ],
      });
    const r = await catalogue.discoverCatalogue(
      await account("ollama", { baseUrl: base + suffix }),
    );
    expect(r.models.map((m) => m.id)).toEqual([
      "Other:Q8",
      "qwen-vl-name-only:Q4",
    ]);
    expect(r.models.every((m) => !m.reported)).toBe(true);
    expect(calls.slice(start).map((c) => c.path)).toEqual(["/api/tags"]);
  },
);

it("keeps native LM Studio metadata attributed and excludes embedding resources", async () => {
  handler = (_url, res) =>
    json(res, {
      models: [
        {
          key: "Exact-Native-ID",
          type: "llm",
          display_name: "Native model",
          loaded_instances: [],
          capabilities: { vision: false },
          max_context_length: 32000,
        },
        { key: "Embedding-only", type: "embedding" },
      ],
    });
  const start = calls.length,
    r = await catalogue.discoverCatalogue(
      await account("openai-compatible", { presetId: "lm-studio" }),
    );
  expect(r.catalogue?.source).toBe("lm-studio-v1");
  expect(r.models).toEqual([
    {
      id: "Exact-Native-ID",
      label: "Native model",
      reported: { vision: false, contextWindow: 32000, loaded: false },
    },
  ]);
  expect(calls.slice(start).map((c) => c.path)).toEqual(["/api/v1/models"]);
});

it.each(["legacy", "compatible"])(
  "falls back only on an unsupported LM Studio catalogue, to %s",
  async (target) => {
    handler = (url, res) => {
      if (
        url.pathname === "/api/v1/models" ||
        (target === "compatible" && url.pathname === "/api/v0/models")
      )
        return json(res, {}, 404);
      json(res, {
        data: [{ id: "Exact-Fallback-ID", type: "vlm", state: "loaded" }],
      });
    };
    const start = calls.length,
      r = await catalogue.discoverCatalogue(
        await account("openai-compatible", { presetId: "lm-studio" }),
      );
    expect(r.catalogue?.source).toBe(
      target === "legacy" ? "lm-studio-v0" : "compatible",
    );
    expect(calls.slice(start)).toHaveLength(target === "legacy" ? 2 : 3);
    expect(r.models[0].reported?.vision).toBe(
      target === "legacy" ? true : undefined,
    );
  },
);

it.each([401, 403, 500, 302])(
  "never changes LM Studio listing paths after %s or forwards redirects",
  async (status) => {
    handler = (_url, res) => {
      res.setHeader("Location", "https://unapproved.fixture.invalid/models");
      json(res, { error: key }, status);
    };
    const start = calls.length,
      r = await catalogue.discoverCatalogue(
        await account("openai-compatible", { presetId: "lm-studio" }),
      );
    expect(r.error).toBeTruthy();
    expect(calls.slice(start)).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(key);
  },
);

it("does not mistake Azure base models for deployments or discover Offline", async () => {
  const c = await account("azure-openai");
  const start = calls.length;
  const azure = await catalogue.discoverCatalogue(c);
  expect(azure.unsupported).toBe(true);
  expect(azure.error).toMatch(/deployment/);
  expect(calls).toHaveLength(start);
  const mock = (await settings.getSettings()).connections.find(
    (c) => c.provider === "mock",
  )!;
  expect((await catalogue.discoverCatalogue(mock)).unsupported).toBe(true);
  expect(calls).toHaveLength(start);
});

it("keeps the last successful catalogue, timestamp and manual/curated models across failures and process-module reload", async () => {
  const c = await account("openai-compatible", {
    modelIds: ["Manual-ID", "Saved-hidden"],
    manualModelIds: ["Manual-ID"],
    visibleModelIds: ["Manual-ID"],
  });
  handler = (_url, res) =>
    json(res, {
      data: [{ id: "Listed-A" }, { id: "Listed-A" }, { id: "Listed-B" }],
    });
  const first = await catalogue.discoverCatalogue(c);
  expect(first.models).toHaveLength(2);
  handler = (_url, res) => json(res, { error: key }, 401);
  const failure = await catalogue.discoverCatalogue(c);
  expect(failure.cached).toBe(true);
  expect(failure.catalogue).toEqual(first.catalogue);
  expect(failure.errorCode).toBe("auth");
  expect(JSON.stringify(failure)).not.toContain(key);
  vi.resetModules();
  catalogue = await import("./catalogue");
  expect(await catalogue.cachedCatalogue(c)).toEqual(first.catalogue);
  const saved = await settings.getConnection(c.id);
  expect(saved.modelIds).toEqual(["Manual-ID", "Saved-hidden"]);
  expect(visibleModels(saved)).toEqual(["Manual-ID"]);
  const registry = await import("./registry");
  expect(registry.resolveModelSelection(saved, "Saved-hidden").model).toBe(
    "Saved-hidden",
  );
  expect(JSON.stringify(await settings.getPublicSettings())).not.toContain(key);
  expect(
    await fs.readFile(path.join(dir, "model-catalogues.json"), "utf8"),
  ).not.toContain(key);
});

it("accepts a real empty catalogue, rejects malformed documents, and retains a successful cache", async () => {
  const c = await account("openai-compatible");
  handler = (_url, res) => json(res, { data: [] });
  const empty = await catalogue.discoverCatalogue(c);
  expect(empty.error).toBeUndefined();
  expect(empty.models).toEqual([]);
  handler = (_url, res) => json(res, { unexpected: [] });
  const bad = await catalogue.discoverCatalogue(c);
  expect(bad.errorCode).toBe("malformed");
  expect(bad.catalogue).toEqual(empty.catalogue);
});

it("reports incomplete pages without erasing prior successful inventory or treating next URLs as destinations", async () => {
  const c = await account("anthropic");
  handler = (_url, res) =>
    json(res, { data: [{ id: "Prior" }], has_more: false });
  const prior = await catalogue.discoverCatalogue(c);
  handler = (url, res) =>
    url.searchParams.has("after_id")
      ? json(res, {}, 503)
      : json(res, {
          data: [{ id: "Partial" }],
          has_more: true,
          last_id: "https://unapproved.fixture.invalid/?token=opaque",
        });
  const r = await catalogue.discoverCatalogue(c);
  expect(r.partial).toBe(true);
  expect(r.cached).toBe(true);
  expect(r.catalogue).toEqual(prior.catalogue);
  expect(await catalogue.cachedCatalogue(c)).toEqual(prior.catalogue);
  expect(calls.at(-1)?.path).toContain("after_id=https%3A");
});

it("bounds repeated pagination and body sizes, with truthful partial results", async () => {
  const c = await account("anthropic");
  handler = (_url, res) =>
    json(res, { data: [{ id: "Repeated" }], has_more: true, last_id: "same" });
  const partial = await catalogue.discoverCatalogue(c);
  expect(partial.partial).toBe(true);
  expect(partial.errorCode).toBe("partial");
  handler = (_url, res) =>
    json(res, { data: [], padding: "x".repeat(2_000_001) });
  expect((await catalogue.discoverCatalogue(c)).errorCode).toBe("malformed");
});

it("does not persist credential-bearing model records, labels, URLs or unknown response metadata", async () => {
  const c = await account("openai-compatible");
  handler = (_url, res) =>
    json(res, {
      data: [
        { id: "Safe-ID", label: key, apiKey: key },
        { id: key },
        { id: "https://user:password@fixture.invalid/?api_key=synthetic" },
      ],
    });
  const r = await catalogue.discoverCatalogue(c);
  expect(r.errorCode).toBe("malformed");
  expect(JSON.stringify(r)).not.toContain(key);
  expect(
    await fs.readFile(path.join(dir, "model-catalogues.json"), "utf8"),
  ).not.toContain(key);
});

it("isolates cached metadata when keys, endpoints or preset protocols change, without probing on reads", async () => {
  const c = await account("openai-compatible", {
    presetId: "lm-studio",
    baseUrl: base + "/identity/v1",
  });
  handler = (_url, res) =>
    json(res, { models: [{ key: "Bound", type: "llm" }] });
  await catalogue.discoverCatalogue(c);
  const start = calls.length;
  expect(await catalogue.cachedCatalogue(c)).toBeTruthy();
  for (const patch of [
    { apiKey: "synthetic-other-key" },
    { baseUrl: base + "/other/v1" },
    { presetId: undefined },
  ])
    expect(await catalogue.cachedCatalogue({ ...c, ...patch })).toBeUndefined();
  expect(calls).toHaveLength(start);
});

it("retains unsaved discovery after saving, ignoring irrelevant Azure form defaults on compatible accounts", async () => {
  handler = (_url, res) =>
    json(res, { models: [{ key: "Unsaved-discovery", type: "llm" }] });
  const registry = await import("./registry");
  const baseUrl = base + "/save-roundtrip/v1";
  const r = await registry.listModelsFor({
    provider: "openai-compatible",
    presetId: "lm-studio",
    baseUrl,
    apiKey: key,
    azureApiVersion: "2025-04-01-preview",
  });
  expect(r.error).toBeUndefined();
  const c = await account("openai-compatible", {
    baseUrl,
    presetId: "lm-studio",
    azureApiVersion: "2025-04-01-preview",
  });
  expect(c.azureApiVersion).toBeUndefined();
  const row = (await settings.getPublicSettings()).connections.find(
    (v) => v.id === c.id,
  );
  expect(row?.catalogue).toEqual(r.catalogue);
});

it("an older request cannot replace a newer successful catalogue", async () => {
  const c = await account("openai-compatible");
  let release: (() => void) | undefined,
    firstReceived: (() => void) | undefined;
  const ready = new Promise<void>((r) => {
    firstReceived = r;
  });
  let n = 0;
  handler = (_url, res) => {
    if (++n === 1) {
      release = () => json(res, { data: [{ id: "Older" }] });
      firstReceived!();
    } else json(res, { data: [{ id: "Newer" }] });
  };
  const older = catalogue.discoverCatalogue(c);
  await ready;
  const newer = await catalogue.discoverCatalogue(c);
  release!();
  expect((await older).errorCode).toBe("superseded");
  expect((await catalogue.cachedCatalogue(c))?.models).toEqual(newer.models);
  expect(newer.models[0].id).toBe("Newer");
});

it("keeps native cloud credentials away from custom endpoints and refuses unsafe URLs and transport", async () => {
  const registry = await import("./registry");
  vi.stubEnv("SCREENSCRIBE_V2_OPENAI_API_KEY", key);
  const start = calls.length;
  expect(
    (
      await registry.listModelsFor({
        provider: "openai",
        baseUrl: base + "/v1",
      })
    ).errorCode,
  ).toBe("auth");
  for (const baseUrl of [
    "http://user:pass@127.0.0.1:1234/v1",
    "http://remote.fixture.invalid/v1",
    "https://unapproved.fixture.invalid/?api_key=synthetic",
  ]) {
    const r = await registry.listModelsFor({
      provider: "openai-compatible",
      baseUrl,
      apiKey: key,
    });
    expect(r.errorCode).toBe("policy");
  }
  expect(calls).toHaveLength(start);
  vi.unstubAllEnvs();
});

it.each(["headers", "body"])(
  "aborts catalogue timeout during %s without discarding a successful cache",
  async (stage) => {
    const c = await account("openai-compatible");
    handler = (_url, res) => json(res, { data: [{ id: "Retained" }] });
    const first = await catalogue.discoverCatalogue(c);
    const real = setTimeout;
    const timeout = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((fn: any, ms?: number, ...args: any[]) =>
        real(fn, ms === 30_000 ? 15 : ms, ...args)) as typeof setTimeout);
    handler = (_url, res) => {
      if (stage === "body") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"data":[');
      }
    };
    try {
      const r = await catalogue.discoverCatalogue(c);
      expect(r.errorCode).toBe("timeout");
      expect(r.catalogue).toEqual(first.catalogue);
    } finally {
      timeout.mockRestore();
    }
  },
);

it("bounds unique model/page counts without claiming partial inventories are complete", async () => {
  const c = await account("openai-compatible", {
    baseUrl: base + "/model-limit/v1",
  });
  handler = (_url, res) =>
    json(res, {
      data: Array.from({ length: 2001 }, (_, n) => ({ id: "model-" + n })),
    });
  const limited = await catalogue.discoverCatalogue(c);
  expect(limited.partial).toBe(true);
  expect(limited.models).toHaveLength(2000);
  expect(limited.catalogue?.complete).toBe(false);
  expect(await catalogue.cachedCatalogue(c)).toBeUndefined();
  const paged = await account("anthropic", { baseUrl: base + "/page-limit" });
  let page = 0;
  handler = (_url, res) =>
    json(res, {
      data: [{ id: "page-" + ++page }],
      has_more: true,
      last_id: "cursor-" + page,
    });
  const r = await catalogue.discoverCatalogue(paged);
  expect(r.partial).toBe(true);
  expect(page).toBe(20);
});

it("keeps omitted-empty Gemini fields valid and rejects malformed UTF-8 and pagination metadata", async () => {
  const c = await account("gemini", { baseUrl: base + "/empty-gemini" });
  handler = (_url, res) => json(res, {});
  const empty = await catalogue.discoverCatalogue(c);
  expect(empty.error).toBeUndefined();
  expect(empty.models).toEqual([]);
  handler = (_url, res) => json(res, { models: [], nextPageToken: 42 });
  expect((await catalogue.discoverCatalogue(c)).errorCode).toBe("malformed");
  handler = (_url, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(Buffer.from([0x7b, 0x22, 0xc0, 0x22, 0x3a, 0x31, 0x7d]));
  };
  expect((await catalogue.discoverCatalogue(c)).errorCode).toBe("malformed");
});

it("treats transport failure as unreachable without echoing exception details or dropping cached models", async () => {
  const c = await account("openai-compatible");
  handler = (_url, res) => json(res, { data: [{ id: "Before-offline" }] });
  const first = await catalogue.discoverCatalogue(c);
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new TypeError("Synthetic transport failed " + key));
  try {
    const r = await catalogue.discoverCatalogue(c);
    expect(r.errorCode).toBe("unreachable");
    expect(r.catalogue).toEqual(first.catalogue);
    expect(JSON.stringify(r)).not.toContain(key);
  } finally {
    network.mockRestore();
  }
});

it("honours cached reported image incompatibility for readers and avoids image attachments to auto-configured text writers", async () => {
  const c = await account("openai-compatible", {
    presetId: "lm-studio",
    baseUrl: base + "/text-only/v1",
    modelIds: ["text-vl-name-is-not-proof"],
  });
  handler = (_url, res) =>
    json(res, {
      models: [
        {
          type: "llm",
          key: "text-vl-name-is-not-proof",
          capabilities: { vision: false },
        },
      ],
    });
  await catalogue.discoverCatalogue(c);
  // Direct composition and the actual project resolver both retain the exact model identity.
  const registry = await import("./registry");
  expect(
    registry.resolveModelSelection(c, c.modelIds[0], { reportedVision: false })
      .vision,
  ).toBe("no");
  vi.resetModules();
  const store = await import("../storage/projectStore"),
    resolver = await import("../agents/connections");
  const project = await store.createProject({
    name: "Known image limit",
    description: "Synthetic fixture",
  });
  await expect(
    resolver.resolveJobConnection(project, c.id, [], undefined, {
      modelId: c.modelIds[0],
      reading: true,
      acknowledged: true,
    }),
  ).rejects.toThrow(/text-only/);
  expect(
    (
      await resolver.resolveJobConnection(project, c.id, [], undefined, {
        modelId: c.modelIds[0],
      })
    ).connection.vision,
  ).toBe("no");
});

it("keeps multi-byte cached inventories within the bounded readable file size", async () => {
  const c = await account("anthropic", { baseUrl: base + "/wide-cache" });
  const snapshot = {
    source: "compatible",
    complete: true,
    refreshedAt: new Date().toISOString(),
    models: Array.from({ length: 2000 }, (_, i) => ({
      id: "old-" + i + "界".repeat(290),
      label: "界".repeat(160),
    })),
  };
  const file = path.join(dir, "model-catalogues.json");
  await fs.writeFile(
    file,
    JSON.stringify(
      { ["a".repeat(64)]: snapshot, ["b".repeat(64)]: snapshot },
      null,
      2,
    ),
  );
  expect((await fs.stat(file)).size).toBeLessThan(8_000_000);
  let page = 0;
  handler = (_url, res) => {
    page++;
    json(res, {
      data: Array.from({ length: 100 }, (_, i) => ({
        id: "new-" + (page * 100 + i) + "界".repeat(290),
        display_name: "界".repeat(160),
      })),
      has_more: page < 20,
      last_id: "cursor-" + page,
    });
  };
  const r = await catalogue.discoverCatalogue(c);
  expect(r.error).toBeUndefined();
  expect(r.models).toHaveLength(2000);
  expect((await fs.stat(file)).size).toBeLessThan(8_000_000);
  expect((await catalogue.cachedCatalogue(c))?.models).toHaveLength(2000);
});

it("normalizes compatible capacity and optional reasoning without importing routing or secrets", async () => {
  const c = await account("openai-compatible", {
    baseUrl: base + "/capacity-contract",
  });
  handler = (_u, res) =>
    json(res, {
      data: [
        {
          id: "exact/synthetic",
          name: "Untrusted extra",
          context_length: 100000,
          top_provider: { context_length: 50000, max_completion_tokens: 12000 },
          architecture: { input_modalities: ["text", "image"] },
          supported_parameters: [
            "reasoning",
            "structured_outputs",
            "secret-field",
          ],
          reasoning: {
            mandatory: false,
            supported_efforts: ["low", "medium", "invalid-effort"],
          },
          url: "https://unapproved.invalid",
          api_key: "this-must-not-persist",
        },
      ],
    });
  const r = await catalogue.discoverCatalogue(c);
  expect(r.error).toBeUndefined();
  expect(r.models[0].reported).toMatchObject({
    vision: true,
    contextWindow: 50000,
    outputTokenLimit: 12000,
    supportedParameters: ["reasoning", "structured_outputs"],
    reasoning: { mandatory: false, supportedEfforts: ["low", "medium"] },
  });
  expect(JSON.stringify(r.catalogue)).not.toContain("this-must-not-persist");
  expect(JSON.stringify(r.catalogue)).not.toContain("unapproved.invalid");
});
it("keeps input-only Gemini capacity distinct from a shared context", async () => {
  const c = await account("gemini", { baseUrl: base + "/input-only" });
  handler = (_u, res) =>
    json(res, {
      models: [
        {
          name: "models/synthetic-input",
          supportedGenerationMethods: ["generateContent"],
          inputTokenLimit: 4096,
          outputTokenLimit: 2048,
        },
      ],
    });
  const r = await catalogue.discoverCatalogue(c);
  expect(r.models[0].reported).toMatchObject({
    inputTokenLimit: 4096,
    outputTokenLimit: 2048,
  });
  expect(r.models[0].reported?.contextWindow).toBeUndefined();
});
it("reuses fresh metadata, expires stale facts and refreshes only the approved endpoint", async () => {
  const c = await account("openai-compatible", {
    baseUrl: base + "/expiring-facts",
  });
  let output = 4096;
  handler = (_u, res) =>
    json(res, {
      data: [
        {
          id: "exact",
          context_length: 16384,
          top_provider: { max_completion_tokens: output },
        },
      ],
    });
  await catalogue.discoverCatalogue(c);
  const before = calls.length;
  expect(
    (await catalogue.executionCatalogue(c))?.models[0].reported
      ?.outputTokenLimit,
  ).toBe(4096);
  expect(calls.length).toBe(before);
  const file = path.join(dir, "model-catalogues.json"),
    cache = JSON.parse(await fs.readFile(file, "utf8"));
  for (const value of Object.values(cache) as any[])
    value.refreshedAt = new Date(
      Date.now() - catalogue.CATALOGUE_RUNTIME_TTL_MS - 1000,
    ).toISOString();
  await fs.writeFile(file, JSON.stringify(cache));
  output = 2048;
  expect(
    (await catalogue.executionCatalogue(c))?.models[0].reported
      ?.outputTokenLimit,
  ).toBe(2048);
  expect(calls.length).toBe(before + 1);
  expect(calls.at(-1)?.path).toBe("/expiring-facts/models");
});
it("leaves malformed optional capacity unknown without blocking exact manual IDs", async () => {
  const c = await account("openai-compatible", {
    baseUrl: base + "/bad-facts",
  });
  handler = (_u, res) =>
    json(res, {
      data: [
        {
          id: "constructor",
          context_length: -100,
          top_provider: {
            context_length: "huge",
            max_completion_tokens: Infinity,
          },
        },
      ],
    });
  const r = await catalogue.discoverCatalogue(c);
  expect(r.error).toBeUndefined();
  expect(r.models[0].id).toBe("constructor");
  expect(r.models[0].reported?.contextWindow).toBeUndefined();
  expect(r.models[0].reported?.outputTokenLimit).toBeUndefined();
});
