import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useTempDataDir, removeDir } from "./testUtils";
import type { AnalysisModelDefaults } from "@shared/types";
let dir: string,
  settings: typeof import("./settingsStore"),
  store: typeof import("./projectStore");
beforeEach(async () => {
  for (const kind of [
    "ANTHROPIC",
    "OPENAI",
    "GEMINI",
    "GOOGLE",
    "AZURE_OPENAI",
  ])
    vi.stubEnv(`SCREENSCRIBE_V2_${kind}_API_KEY`, "");
  dir = await useTempDataDir("analysis-defaults");
  vi.resetModules();
  settings = await import("./settingsStore");
  store = await import("./projectStore");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await removeDir(dir);
});
async function account() {
  return settings.createConnection({
    name: "Synthetic default account",
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "synthetic-defaults-credential",
    modelIds: ["constructor", "writer", "alternate"],
    vision: "auto",
  });
}
async function save(defaults?: AnalysisModelDefaults, theme = "dark") {
  const current = await settings.getSettings();
  return settings.replaceWorkspaceSettings({
    baseRevision: current.revision ?? 0,
    connections: current.connections.map((c) => ({ ...c, apiKey: undefined })),
    defaultConnectionId: current.defaultConnectionId!,
    analysisDefaults: defaults,
    integrations: [],
    preferences: { ...(current.preferences ?? {}), theme },
  });
}
const pair = (id: string): AnalysisModelDefaults => ({
  visionConnectionId: id,
  visionModelId: "constructor",
  textConnectionId: id,
  textModelId: "writer",
});
it("starts new projects on Offline, regardless of the legacy real default connection", async () => {
  const c = await account();
  const p = await store.createProject({
    name: "New",
    description: "Synthetic",
  });
  expect((await settings.getSettings()).defaultConnectionId).toBe(c.id);
  expect(p.llm.visionModelId).toBe("demo");
  expect(p.llm.visionConnectionId).not.toBe(c.id);
});
it("snapshots distinct exact models, persists across reload, and does not grant image consent", async () => {
  const c = await account();
  const before = await store.createProject({
    name: "Before",
    description: "Synthetic",
  });
  const bytes = await fs.readFile(
    path.join(before.projectPath!, "project.json"),
    "utf8",
  );
  await save(pair(c.id));
  const next = await store.createProject({
    name: "After",
    description: "Synthetic",
  });
  expect(next.llm).toEqual(pair(c.id));
  expect(next.llm.visionAcknowledged).toBeUndefined();
  expect(
    await fs.readFile(path.join(before.projectPath!, "project.json"), "utf8"),
  ).toBe(bytes);
  await (await import("./projectRegistry")).releaseProjectLeases();
  await (await import("./windowsStorageGuard")).releaseFilesystemGuard();
  vi.resetModules();
  const reloaded = await import("./settingsStore");
  expect((await reloaded.getPublicSettings()).analysisDefaults).toEqual(
    pair(c.id),
  );
});
it("later defaults do not change existing or duplicated assignments and retained inputs", async () => {
  const c = await account();
  await save(pair(c.id));
  const first = await store.createProject({
    name: "First",
    description: "Human input",
  });
  await save({ ...pair(c.id), textModelId: "alternate" });
  const second = await store.createProject({
    name: "Second",
    description: "Synthetic",
  });
  expect(second.llm.textModelId).toBe("alternate");
  expect((await store.getProject(first.id)).llm).toEqual(pair(c.id));
  const { duplicateProject } = await import("./projectLifecycle");
  const copy = await duplicateProject(first.id);
  expect(copy.llm).toEqual(first.llm);
  expect(copy.description).toBe("Human input");
});
it("preserves unchanged stale defaults on unrelated saves and never substitutes another account", async () => {
  const c = await account();
  await save(pair(c.id));
  await settings.deleteConnection(c.id);
  await save(pair(c.id), "light");
  expect((await settings.getPublicSettings()).analysisDefaults).toEqual(
    pair(c.id),
  );
  const p = await store.createProject({
    name: "Needs reselection",
    description: "Synthetic",
  });
  expect(p.llm).toEqual(pair(c.id));
  await expect(
    save({ ...pair(c.id), textModelId: "different" }),
  ).rejects.toThrow(/available connection/);
});
it("preserves a removed model's reference while rejecting a new invalid selection atomically", async () => {
  const c = await account();
  await save(pair(c.id));
  await settings.updateConnection(c.id, { ...c, modelIds: ["writer"] });
  await save(pair(c.id), "light");
  const filename = path.join(dir, "settings.json"),
    before = await fs.readFile(filename, "utf8");
  await expect(
    save({ ...pair(c.id), visionModelId: "not-configured" }),
  ).rejects.toThrow(/configured model/);
  expect(await fs.readFile(filename, "utf8")).toBe(before);
});
it("an older client omitting the field cannot clear or retarget defaults", async () => {
  const c = await account();
  await save(pair(c.id));
  await save(undefined, "light");
  expect((await settings.getPublicSettings()).analysisDefaults).toEqual(
    pair(c.id),
  );
});
it("keeps demos Offline even with cloud-style defaults and preserves local-only choice", async () => {
  const c = await account();
  await save(pair(c.id));
  const { createDemoProject } = await import("./demo");
  const demo = await createDemoProject();
  const offline = (await settings.getSettings()).connections.find(
    (c) => c.provider === "mock",
  )!;
  expect(demo.llm.visionConnectionId).toBe(offline.id);
  expect(demo.llm.textConnectionId).toBe(offline.id);
  const local = await store.createProject({
    name: "Local",
    description: "Synthetic",
    localOnly: true,
  });
  expect(local.localOnly).toBe(true);
  expect(local.llm).toEqual(pair(c.id));
});
it("keeps a legacy unassigned project unchanged after defaults are saved", async () => {
  const legacy = await store.createProject({
    name: "Legacy",
    description: "Synthetic",
  });
  legacy.llm = {};
  await store.saveProject(legacy);
  const c = await account();
  await save(pair(c.id));
  expect((await store.getProject(legacy.id)).llm).toEqual({});
});
it("rejects a newly selected known text-only reader without changing settings", async () => {
  const c = await account();
  await settings.updateConnection(c.id, { ...c, vision: "no" });
  const filename = path.join(dir, "settings.json"),
    before = await fs.readFile(filename, "utf8");
  await expect(save(pair(c.id))).rejects.toThrow(/unable to read images/);
  expect(await fs.readFile(filename, "utf8")).toBe(before);
});
it("does not leave a claimed project folder when reading defaults fails", async () => {
  await settings.getSettings();
  const stub = vi
    .spyOn(settings, "getSettings")
    .mockRejectedValueOnce(new Error("Synthetic unavailable settings"));
  try {
    await expect(
      store.createProject({
        name: "Failed snapshot",
        description: "Synthetic",
      }),
    ).rejects.toThrow(/unavailable settings/);
    expect(
      await fs
        .stat(
          path.join(
            process.env.SCREENSCRIBE_V2_WORKSPACE_DIR!,
            "failed-snapshot",
          ),
        )
        .catch(() => undefined),
    ).toBeUndefined();
  } finally {
    stub.mockRestore();
  }
});
it("saves a new account and both defaults in one protected atomic workspace update", async () => {
  const s = await settings.getSettings(),
    id = "conn_synthetic_new_account";
  await settings.replaceWorkspaceSettings({
    baseRevision: s.revision ?? 0,
    connections: [
      ...s.connections,
      {
        id,
        name: "Synthetic new account",
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "synthetic-new-account-secret",
        modelIds: ["constructor", "writer"],
      },
    ],
    defaultConnectionId: s.defaultConnectionId!,
    analysisDefaults: pair(id),
    preferences: {},
    integrations: [],
  });
  expect((await settings.getPublicSettings()).analysisDefaults).toEqual(
    pair(id),
  );
  expect(
    (
      await store.createProject({
        name: "Atomic new defaults",
        description: "Synthetic",
      })
    ).llm,
  ).toEqual(pair(id));
  expect(
    await fs.readFile(path.join(dir, "settings.json"), "utf8"),
  ).not.toContain("synthetic-new-account-secret");
});
it("local-only policy still rejects inherited cloud defaults before any inference", async () => {
  const cloud = await settings.createConnection({
    name: "Synthetic cloud account",
    provider: "gemini",
    modelIds: ["constructor", "writer"],
  });
  await save(pair(cloud.id));
  const project = await store.createProject({
    name: "Local-only inherited cloud",
    description: "Synthetic",
    localOnly: true,
  });
  const { resolveJobConnection } = await import("../agents/connections");
  await expect(
    resolveJobConnection(project, cloud.id, [], undefined, {
      modelId: "constructor",
      reading: true,
    }),
  ).rejects.toThrow(/local-only/);
  expect((await store.getProject(project.id)).llm).toEqual(pair(cloud.id));
});
