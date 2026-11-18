/** Owner test notes 1 and 6 (tester build WP8): what uses a connection, and moving it before removal. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AnalysisModelDefaults } from "@shared/types";
import { projectConnectionChoices } from "@shared/generationContext";
import { removeDir, useTempDataDir } from "./testUtils";

let dir: string,
  settings: typeof import("./settingsStore"),
  store: typeof import("./projectStore"),
  usage: typeof import("./connectionUsage");
beforeEach(async () => {
  dir = await useTempDataDir("connection-usage");
  vi.resetModules();
  settings = await import("./settingsStore");
  store = await import("./projectStore");
  usage = await import("./connectionUsage");
});
afterEach(async () => {
  await removeDir(dir);
});

const account = (name: string, modelIds: string[]) =>
  settings.createConnection({
    name,
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "synthetic-usage-credential",
    modelIds,
    vision: "yes",
  });
async function save(
  defaults: AnalysisModelDefaults | undefined,
  keep: (id: string) => boolean = () => true,
  defaultConnectionId?: string,
) {
  const current = await settings.getSettings();
  return settings.replaceWorkspaceSettings({
    baseRevision: current.revision ?? 0,
    connections: current.connections
      .filter((c) => keep(c.id))
      .map((c) => ({ ...c, apiKey: undefined })),
    defaultConnectionId: defaultConnectionId ?? current.defaultConnectionId!,
    analysisDefaults: defaults,
    integrations: [],
    preferences: current.preferences ?? {},
  });
}
const uses = (
  connectionId: string,
  reading: string,
  writing: string,
  writingConnection = connectionId,
) => ({
  visionConnectionId: connectionId,
  visionModelId: reading,
  textConnectionId: writingConnection,
  textModelId: writing,
});

it("lists the defaults and projects that use a connection, with the exact models they chose", async () => {
  const a = await account("Gateway A", ["m1"]);
  const b = await account("Gateway B", ["m1", "m2"]);
  // Created before the defaults, so it stays on the Offline demo.
  await store.createProject({ name: "Elsewhere", description: "" });
  await save(uses(a.id, "m1", "m2", b.id));
  const both = await store.createProject({ name: "Both", description: "" });
  await store.updateProject(both.id, { llm: uses(a.id, "m1", "m1") });
  const reading = await store.createProject({
    name: "Reading",
    description: "",
  });
  await store.updateProject(reading.id, { llm: uses(a.id, "m1", "m2", b.id) });

  const result = await usage.connectionUsage(a.id);
  expect(result.readingDefault).toBe(true);
  expect(result.writingDefault).toBe(false);
  expect(result.projects.sort((x, y) => x.name.localeCompare(y.name))).toEqual([
    { id: both.id, name: "Both", roles: ["reading", "writing"] },
    { id: reading.id, name: "Reading", roles: ["reading"] },
  ]);
  expect(result.modelIds).toEqual(["m1"]);
});

it("moves projects to another connection keeping their exact models, and keeps any it cannot", async () => {
  const a = await account("Gateway A", ["m1", "m3"]);
  const b = await account("Gateway B", ["m1"]);
  const movable = await store.createProject({
    name: "Movable",
    description: "",
  });
  await store.updateProject(movable.id, { llm: uses(a.id, "m1", "m1") });
  const stuck = await store.createProject({ name: "Stuck", description: "" });
  await store.updateProject(stuck.id, { llm: uses(a.id, "m3", "m1") });

  expect(await usage.reassignConnection(a.id, b.id)).toEqual({
    moved: 1,
    kept: 1,
  });
  expect(
    projectConnectionChoices(await store.getProject(movable.id)),
  ).toMatchObject(uses(b.id, "m1", "m1"));
  // A model the target does not list is never guessed: the project keeps its choice.
  expect(
    projectConnectionChoices(await store.getProject(stuck.id)),
  ).toMatchObject(uses(a.id, "m3", "m1"));
});

it("refuses a save that removes a connection a default still uses, and allows it once the default moves", async () => {
  const a = await account("Gateway A", ["m1"]);
  const b = await account("Gateway B", ["m1"]);
  await save(uses(a.id, "m1", "m1"));
  const current = await settings.getSettings();
  await expect(
    save(current.analysisDefaults, (id) => id !== a.id, b.id),
  ).rejects.toThrow(/choose an available connection/);
  const saved = await save(uses(b.id, "m1", "m1"), (id) => id !== a.id, b.id);
  expect(saved.connections.map((c) => c.id)).not.toContain(a.id);
});
