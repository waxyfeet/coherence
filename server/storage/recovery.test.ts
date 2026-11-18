import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SolutionModel } from "@shared/types";
import { removeDir, useTempDataDir } from "./testUtils";

type Store = typeof import("./projectStore");
type Recovery = typeof import("./recovery");
type Config = typeof import("../config");

let dataDir: string;
let store: Store;
let recovery: Recovery;
let cfg: Config;

beforeAll(async () => {
  dataDir = await useTempDataDir("recovery");
  vi.resetModules();
  store = await import("./projectStore");
  recovery = await import("./recovery");
  cfg = await import("../config");
  await store.ensureDataDirs();
});

afterAll(async () => {
  await removeDir(dataDir);
});

function model(projectId: string, useCases: number): SolutionModel {
  const at = new Date().toISOString();
  return {
    schemaVersion: 1,
    projectId,
    formatId: "use-case-bdd",
    generatedAt: at,
    updatedAt: at,
    generator: { vision: "mock/demo", text: "mock/demo" },
    options: {
      thoroughness: "standard",
      granularity: "balanced",
      preserveEdited: true,
      embedScreenImages: true,
      reuseScreenAnalyses: true,
    },
    summary: `v${useCases}`,
    personas: [],
    screens: [],
    flows: [],
    features: [],
    useCases: Array.from(
      { length: useCases },
      (_, i) => ({ id: `UC-00${i + 1}` }) as SolutionModel["useCases"][number],
    ),
    review: [],
    changeLog: [],
  };
}

describe("model history", () => {
  it("lists snapshots newest first and restores one (snapshotting the current model)", async () => {
    const p = await store.createProject({
      name: "History restore",
      description: "",
    });
    expect(await recovery.listModelSnapshots(p.id)).toEqual([]);
    await store.saveModel(p.id, model(p.id, 1), { snapshot: true });
    await store.saveModel(p.id, model(p.id, 2), { snapshot: true });
    await store.saveModel(p.id, model(p.id, 3), { snapshot: true });

    const snapshots = await recovery.listModelSnapshots(p.id);
    expect(snapshots.map((s) => s.useCaseCount)).toEqual([2, 1]);
    expect(snapshots[0].savedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );

    const restored = await recovery.restoreModelSnapshot(p.id, snapshots[1].id);
    expect(restored.useCases).toHaveLength(1);
    expect((await store.loadModel(p.id))!.summary).toBe("v1");
    // The model that was current (3 use cases) is now in history, so the restore can be undone.
    expect(
      (await recovery.listModelSnapshots(p.id)).map((s) => s.useCaseCount),
    ).toEqual([3, 2, 1]);
    expect((await store.getProject(p.id)).status).toBe("specified");

    await expect(
      recovery.restoreModelSnapshot(p.id, "../../settings.json"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      recovery.restoreModelSnapshot(
        p.id,
        "model-2000-01-01T00-00-00-000Z.json",
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a snapshot that belongs to another project", async () => {
    const p = await store.createProject({
      name: "Foreign snapshot",
      description: "",
    });
    await fs.mkdir(cfg.paths.historyDir(p.id), { recursive: true });
    const name = "model-2026-01-01T00-00-00-000Z.json";
    await fs.writeFile(
      path.join(cfg.paths.historyDir(p.id), name),
      JSON.stringify(model("someone-else", 1)),
    );
    await expect(
      recovery.restoreModelSnapshot(p.id, name),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("trash", () => {
  it("lists deleted projects and restores them", async () => {
    const p = await store.createProject({
      name: "Trash me",
      description: "Deleted by mistake",
    });
    await store.deleteProject(p.id);
    const trash = await recovery.listTrash();
    const entry = trash.find((t) => t.projectId === p.id)!;
    expect(entry).toMatchObject({
      name: "Trash me",
      description: "Deleted by mistake",
      screenCount: 0,
    });
    expect(entry.deletedAt).toMatch(/Z$/);

    const restored = await recovery.restoreFromTrash(entry.id);
    expect(restored.id).toBe(p.id);
    expect((await store.getProject(p.id)).name).toBe("Trash me");
    expect((await recovery.listTrash()).some((t) => t.id === entry.id)).toBe(
      false,
    );
  });

  it("restores its exact identity alongside a same-named new project without overwriting it", async () => {
    const p = await store.createProject({ name: "Twice", description: "" });
    await store.deleteProject(p.id);
    const entry = (await recovery.listTrash()).find(
      (t) => t.projectId === p.id,
    )!;
    const newer = await store.createProject({
      name: "Twice",
      description: "new one",
    });
    expect(newer.id).not.toBe(p.id);
    expect((await recovery.restoreFromTrash(entry.id)).id).toBe(p.id);
    expect((await store.getProject(newer.id)).description).toBe("new one");
    await expect(
      recovery.restoreFromTrash("../projects"),
    ).rejects.toMatchObject({ status: 404 });
  });
});
