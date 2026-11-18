import { beforeAll, afterAll, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { useTempDataDir, removeDir } from "../storage/testUtils";
let dir: string;
let settings: typeof import("../storage/settingsStore"),
  registry: typeof import("../llm/registry"),
  connections: typeof import("./connections"),
  store: typeof import("../storage/projectStore");
beforeAll(async () => {
  dir = await useTempDataDir("model-selection");
  vi.resetModules();
  settings = await import("../storage/settingsStore");
  registry = await import("../llm/registry");
  connections = await import("./connections");
  store = await import("../storage/projectStore");
  await store.ensureDataDirs();
});
afterAll(async () => {
  await removeDir(dir);
});

it("saves a provider without a required model or preset substitution", async () => {
  const c = await settings.createConnection({
    name: "Empty account",
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
  });
  expect(c.modelIds).toEqual([]);
  expect(c.model).toBeUndefined();
  expect(
    (await settings.getPublicSettings()).connections.find(
      (row) => row.id === c.id,
    )?.modelIds,
  ).toEqual([]);
  expect(() => registry.resolveModelSelection(c, undefined)).toThrow(
    /exact model ID/,
  );
});
it("resolves documented Gemini image support and output ceiling without inference, acknowledgement or stored runtime metadata", async () => {
  const c = await settings.createConnection({
    name: "Documented synthetic account",
    provider: "gemini",
    modelIds: ["gemini-3.5-flash-lite"],
  });
  const p = await store.createProject({
    name: "Documented synthetic project",
    description: "Synthetic",
  });
  const resolved = await connections.resolveJobConnection(
    p,
    c.id,
    [],
    undefined,
    { modelId: "gemini-3.5-flash-lite", reading: true },
  );
  expect(resolved.connection.model).toBe("gemini-3.5-flash-lite");
  expect(resolved.connection.vision).toBe("yes");
  expect(resolved.connection.modelOutputTokenLimit).toBe(65536);
  expect(resolved.acknowledged).toBe(false);
  expect(await settings.getConnection(c.id)).not.toHaveProperty(
    "modelOutputTokenLimit",
  );
});

it("shares one protected key across exact model IDs, with separate adapter cache entries", async () => {
  const key = "synthetic-account-selection-secret";
  const c = await settings.createConnection({
    name: "One account",
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: key,
    modelIds: ["Exact-Reader/VL:Q4", "Exact-Writer:Q8"],
  });
  const read = registry.resolveModelSelection(c, "Exact-Reader/VL:Q4", {
    reading: true,
    acknowledged: true,
  });
  const write = registry.resolveModelSelection(c, "Exact-Writer:Q8");
  expect(read.id).toBe(write.id);
  expect(read.apiKey).toBe(key);
  expect(write.apiKey).toBe(key);
  expect(read.model).toBe("Exact-Reader/VL:Q4");
  expect(write.model).toBe("Exact-Writer:Q8");
  expect(write.refusalFallback).toBe(false);
  const a = registry.createProvider(read),
    b = registry.createProvider(write);
  expect(a).not.toBe(b);
  expect(registry.createProvider(read)).toBe(a);
  expect(
    (await settings.getSettings()).connections.filter((row) => row.id === c.id),
  ).toHaveLength(1);
  const raw = await fs.readFile(path.join(dir, "settings.json"), "utf8");
  expect(raw).not.toContain(key);
  expect(JSON.stringify(await settings.getPublicSettings())).not.toContain(key);
  expect(c.modelIds).toEqual(["Exact-Reader/VL:Q4", "Exact-Writer:Q8"]);
});

it("keeps manual Azure deployment identity exact without requiring catalogue access", async () => {
  const c = await settings.createConnection({
    name: "Azure manual",
    provider: "azure-openai",
    baseUrl: "https://synthetic.openai.azure.com",
    modelIds: ["BA-Team-Deployment-42"],
    apiKey: "synthetic-azure-account-secret",
  });
  expect(registry.resolveModelSelection(c, "BA-Team-Deployment-42").model).toBe(
    "BA-Team-Deployment-42",
  );
  expect(() =>
    registry.resolveModelSelection(c, "ba-team-deployment-42"),
  ).toThrow(/no longer configured/);
});

it("does not use legacy model metadata when an exact project model is missing or removed", async () => {
  const c = await settings.createConnection({
    name: "Legacy form",
    provider: "ollama",
    model: "original-legacy-model",
    modelIds: ["Chosen-Model"],
  });
  expect(c.model).toBe("original-legacy-model");
  expect(() => registry.resolveModelSelection(c, undefined)).toThrow(
    /exact model ID/,
  );
  expect(() =>
    registry.resolveModelSelection(c, "original-legacy-model"),
  ).toThrow(/no longer configured/);
  expect(() => registry.resolveModelSelection(c, "preset-default")).toThrow(
    /no longer configured/,
  );
});

it("binds unverified image acknowledgement to the exact saved model", async () => {
  const c = await settings.createConnection({
    name: "Unknown capabilities",
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    modelIds: ["A", "B"],
  });
  const p = await store.createProject({
    name: "Acknowledgement fixture",
    description: "Synthetic fixture",
  });
  const saved = [
    { id: c.id, modelId: "A", acknowledged: true, use: "reading" },
  ];
  await expect(
    connections.resolveJobConnection(p, c.id, saved, undefined, {
      reading: true,
      modelId: "B",
    }),
  ).rejects.toThrow(/unverified/);
  const result = await connections.resolveJobConnection(
    p,
    c.id,
    saved,
    undefined,
    { reading: true, modelId: "B", acknowledged: true },
  );
  expect(result.connection.model).toBe("B");
  expect(result.acknowledged).toBe(true);
});

it("rejects a deleted account without selecting the new default, while the project remains readable", async () => {
  const c = await settings.createConnection({
    name: "Deleted account",
    provider: "ollama",
    modelIds: ["reader", "writer"],
  });
  const p = await store.createProject({
    name: "Retain project context",
    description: "Synthetic context stays",
  });
  await store.updateProject(p.id, {
    llm: {
      visionConnectionId: c.id,
      visionModelId: "reader",
      textConnectionId: c.id,
      textModelId: "writer",
    },
  });
  await settings.deleteConnection(c.id);
  await expect(
    connections.resolveJobConnection(await store.getProject(p.id), undefined, [
      { id: c.id, modelId: "reader", use: "reading" },
    ]),
  ).rejects.toThrow(/No replacement provider/);
  expect((await store.getProject(p.id)).description).toBe(
    "Synthetic context stays",
  );
  expect((await store.getProject(p.id)).llm.textConnectionId).toBe(c.id);
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected fixture network request"));
  try {
    const listing = await registry.listModelsFor({
      provider: "ollama",
      connectionId: c.id,
      baseUrl: "http://127.0.0.1:9",
    });
    expect(listing.error).toBeTruthy();
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
});

it("keeps endpoint credential isolation and local-only policy when models change", async () => {
  const c = await settings.createConnection({
    name: "Cloud fixture",
    provider: "gemini",
    apiKey: "synthetic-model-policy-secret",
    modelIds: ["Manual-A", "Manual-B"],
  });
  await expect(
    settings.updateConnection(c.id, {
      name: c.name,
      provider: c.provider,
      modelIds: c.modelIds,
      baseUrl: "https://unapproved.fixture.invalid",
    }),
  ).rejects.toThrow(/Re-enter the API key/);
  const p = await store.createProject({
    name: "Local policy fixture",
    description: "Synthetic fixture",
    localOnly: true,
  });
  await expect(
    connections.resolveJobConnection(p, c.id, [], undefined, {
      modelId: "Manual-A",
    }),
  ).rejects.toThrow(/local-only/);
});

it("keeps Offline built in and refuses a different simulated model identity", async () => {
  const c = (await settings.getSettings()).connections.find(
    (row) => row.provider === "mock",
  )!;
  expect(registry.resolveModelSelection(c, undefined).model).toBe("demo");
  expect(() => registry.resolveModelSelection(c, "arbitrary-other-id")).toThrow(
    /built-in/,
  );
});

it("never combines connection-only updates with a model or acknowledgement from an earlier assignment", async () => {
  const p = await store.createProject({
    name: "Pair update fixture",
    description: "Synthetic context",
  });
  p.llm = {
    visionConnectionId: "conn_A",
    visionModelId: "Saved-A",
    visionAcknowledged: true,
  };
  p.generationPreferences = {
    ...(await import("@shared/types")).DEFAULT_GENERATION_OPTIONS,
    visionConnectionId: "conn_B",
    visionModelId: "Last-run-B",
    visionAcknowledged: true,
  };
  await store.saveProject(p);
  const next = await store.updateProject(p.id, {
    llm: { visionConnectionId: "conn_A" },
  });
  expect(next.llm.visionModelId).toBeUndefined();
  expect(next.llm.visionAcknowledged).toBeUndefined();
  expect(next.generationPreferences?.visionConnectionId).toBe("conn_A");
  expect(next.generationPreferences?.visionModelId).toBeUndefined();
  expect(next.generationPreferences?.visionAcknowledged).toBeUndefined();
});

it("retains an explicit image override without certifying it, while known unsupported evidence still blocks reading", async () => {
  const c = await settings.createConnection({
    name: "Explicit image declaration",
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    modelIds: ["Manual-Exact"],
    vision: "yes",
  });
  expect(
    registry.resolveModelSelection(c, "Manual-Exact", {
      reading: true,
      imageEvidence: "unknown",
    }).vision,
  ).toBe("yes");
  expect(() =>
    registry.resolveModelSelection(c, "Manual-Exact", {
      reading: true,
      imageEvidence: "unsupported",
      acknowledged: true,
    }),
  ).toThrow(/text-only/);
  expect(
    registry.resolveModelSelection(c, "Manual-Exact", {
      imageEvidence: "unsupported",
    }).vision,
  ).toBe("no");
});
