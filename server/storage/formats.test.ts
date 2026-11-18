import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { DestinationIdentity } from "@shared/delivery";
import { removeDir, useTempDataDir } from "./testUtils";

// Installer finding ST-06: data written by a newer Coherence is refused as such and never overwritten.
let dir: string;
let store: typeof import("./projectStore");
let registry: typeof import("./projectRegistry");
let profiles: typeof import("../delivery/profiles");
let service: typeof import("../delivery/service");
let discovery: typeof import("../delivery/discovery");
let fixtures: typeof import("../graph/testFixtures");
let cfg: typeof import("../config");
beforeAll(async () => {
  dir = await useTempDataDir("formats");
  vi.resetModules();
  store = await import("./projectStore");
  registry = await import("./projectRegistry");
  profiles = await import("../delivery/profiles");
  service = await import("../delivery/service");
  discovery = await import("../delivery/discovery");
  fixtures = await import("../graph/testFixtures");
  cfg = await import("../config");
  await store.ensureDataDirs();
});
afterAll(async () => {
  await removeDir(dir);
});

const newer = { status: 409, code: "DATA_NEWER" };

it("refuses a newer model, both when reading it and when a run would replace it", async () => {
  const p = await store.createProject({ name: "Newer model", description: "" });
  const file = cfg.paths.modelFile(p.id);
  const future = JSON.stringify({
    ...fixtures.fixtureModel(),
    schemaVersion: 2,
  });
  await fs.writeFile(file, future);
  await expect(store.loadModel(p.id)).rejects.toMatchObject(newer);
  await expect(
    store.saveModel(p.id, fixtures.fixtureModel(), { snapshot: true }),
  ).rejects.toMatchObject(newer);
  expect(await fs.readFile(file, "utf8")).toBe(future);
});

it("refuses a newer project manifest as newer, not as unsupported", async () => {
  const p = await store.createProject({
    name: "Newer manifest",
    description: "",
  });
  const manifest = path.join(p.projectPath!, "project.json");
  const raw = JSON.parse(await fs.readFile(manifest, "utf8"));
  raw.storage.version = 2;
  await fs.writeFile(manifest, JSON.stringify(raw));
  expect(() => registry.readPortableManifest(p.projectPath!)).toThrow(
    expect.objectContaining(newer),
  );
});

it("refuses a newer delivery mapping profile and plan instead of replacing them", async () => {
  const identity: DestinationIdentity = {
    system: "jira",
    base: "example.atlassian.net",
    container: "DEMO",
    variant: "cloud",
  };
  const file = path.join(
    cfg.config.dataDir,
    "delivery",
    "profiles",
    `${discovery.destinationKey(identity)}.json`,
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  const future = JSON.stringify({ schemaVersion: 2, id: "x", rules: [] });
  await fs.writeFile(file, future);
  await expect(profiles.readProfile(identity)).rejects.toMatchObject(newer);
  await expect(
    profiles.saveRules(identity, "fingerprint", []),
  ).rejects.toMatchObject(newer);
  expect(await fs.readFile(file, "utf8")).toBe(future);

  const p = await store.createProject({ name: "Newer plan", description: "" });
  const plan = path.join(p.projectPath!, "delivery", "plans", "jira.json");
  await fs.mkdir(path.dirname(plan), { recursive: true });
  await fs.writeFile(plan, JSON.stringify({ schemaVersion: 2 }));
  await expect(service.readPlan(p.id, "jira")).rejects.toMatchObject(newer);
});
