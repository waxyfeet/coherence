import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ImpactReport, SolutionModel } from "@shared/types";
import {
  makeJpeg,
  makePng,
  makeWebp,
  removeDir,
  useTempDataDir,
} from "./testUtils";

type Store = typeof import("./projectStore");
type Config = typeof import("../config");
type Demo = typeof import("./demo");

let dataDir: string;
let store: Store;
let cfg: Config;
let demo: Demo;

beforeAll(async () => {
  dataDir = await useTempDataDir("store");
  vi.resetModules();
  store = await import("./projectStore");
  cfg = await import("../config");
  demo = await import("./demo");
  await store.ensureDataDirs();
});

afterAll(async () => {
  await removeDir(dataDir);
});

function minimalModel(projectId: string, useCases = 0): SolutionModel {
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
    summary: "",
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

describe("ensureDataDirs", () => {
  it("creates global discovery state without canonical projects or trash in AppData", async () => {
    expect(cfg.config.dataDir).toBe(path.resolve(dataDir));
    await expect(
      fs.stat(path.join(dataDir, "projects-index.json")),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(cfg.config.dataDir, "projects")),
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(cfg.config.dataDir, ".trash")),
    ).rejects.toThrow();
  });

  it("asks for an owner-only data folder (it holds settings.json with API keys)", async () => {
    const mkdir = vi.spyOn(fs, "mkdir");
    try {
      await store.ensureDataDirs();
      expect(mkdir).toHaveBeenCalledWith(cfg.config.dataDir, {
        recursive: true,
        mode: 0o700,
      });
    } finally {
      mkdir.mockRestore();
    }
  });
});

it("analysis-cache cleanup retains a nested foreign project and its human bytes", async () => {
  const p = await store.createProject({
    name: "Legacy cache boundary",
    description: "Synthetic",
  });
  const child = path.join(
    cfg.paths.projectDir(p.id),
    "analysis-cache",
    "foreign-project",
  );
  await fs.mkdir(child, { recursive: true });
  const marker = JSON.stringify({
    id: "foreign",
    storage: { format: "coherence-project" },
  });
  await fs.writeFile(path.join(child, "project.json"), marker);
  await fs.writeFile(
    path.join(child, "human.md"),
    "KEEP FOREIGN CACHE CONTENT",
  );
  await (await import("../agents/runState")).clearAnalysisCache(p.id);
  expect(await fs.readFile(path.join(child, "human.md"), "utf8")).toBe(
    "KEEP FOREIGN CACHE CONTENT",
  );
  expect(await fs.readFile(path.join(child, "project.json"), "utf8")).toBe(
    marker,
  );
});
it("screenshot deletion rejects foreign descendants before changing project metadata", async () => {
  const p = await store.createProject({
    name: "Legacy screenshot boundary",
    description: "Synthetic",
  });
  const [screen] = await store.addScreens(p.id, [
    {
      originalName: "synthetic.png",
      mimeType: "image/png",
      buffer: await makePng(),
    },
  ]);
  const child = path.join(
    path.dirname(store.screenImagePath(p.id, screen)),
    "foreign-project",
  );
  await fs.mkdir(child);
  await fs.writeFile(
    path.join(child, "project.json"),
    JSON.stringify({ id: "foreign", storage: { format: "coherence-project" } }),
  );
  await fs.writeFile(
    path.join(child, "human.md"),
    "KEEP FOREIGN SCREEN CONTENT",
  );
  const before = await fs.readFile(cfg.paths.projectFile(p.id));
  await expect(store.deleteScreen(p.id, screen.id)).rejects.toThrow(
    /cannot contain/,
  );
  expect(await fs.readFile(cfg.paths.projectFile(p.id))).toEqual(before);
  expect(await fs.readFile(path.join(child, "human.md"), "utf8")).toBe(
    "KEEP FOREIGN SCREEN CONTENT",
  );
});

describe("projects", () => {
  it("creates a project with a slug id, defaults and an atomic project.json", async () => {
    const p = await store.createProject({
      name: "  Customer Portal  ",
      description: "A portal.",
    });
    expect(p.id).toMatch(/^customer-portal-[a-z0-9-]{10}$/);
    expect(p.name).toBe("Customer Portal");
    expect(p.status).toBe("draft");
    expect(p.formatId).toBe("use-case-bdd");
    expect(p.outputDir).toBe(cfg.paths.defaultSpecsDir(p.id));
    expect(p.screens).toEqual([]);
    const onDisk = JSON.parse(
      await fs.readFile(cfg.paths.projectFile(p.id), "utf8"),
    );
    expect(onDisk.name).toBe("Customer Portal");
    // No temp files left behind.
    const files = await fs.readdir(cfg.paths.projectDir(p.id));
    expect(files.filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("makes ids unique", async () => {
    const a = await store.createProject({ name: "Dup Name", description: "" });
    const b = await store.createProject({ name: "Dup name", description: "" });
    const c = await store.createProject({ name: "dup-name", description: "" });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    for (const p of [a, b, c]) expect(p.id).toMatch(/^dup-name-[a-z0-9-]{10}$/);
  });

  it("handles concurrent creates with the same name", async () => {
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        store.createProject({ name: "Race", description: "" }),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(4);
  });

  it("rejects empty names and relative output folders", async () => {
    await expect(
      store.createProject({ name: "   ", description: "" }),
    ).rejects.toThrow(/cannot be empty/);
    await expect(
      store.createProject({
        name: "Rel",
        description: "",
        outputDir: "specs/here",
      }),
    ).rejects.toThrow(/workspace/);
    expect(() => cfg.paths.projectDir("rel")).toThrow(/not registered/);
  });

  it("getProject throws NotFound for unknown and traversal ids", async () => {
    await expect(store.getProject("nope")).rejects.toMatchObject({
      status: 404,
    });
    await expect(store.getProject("../settings")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("updates fields, validates outputDir and clears llm selections with null", async () => {
    const p = await store.createProject({
      name: "Updatable",
      description: "x",
    });
    const abs = path.join(dataDir, "custom-out");
    const updated = await store.updateProject(p.id, {
      name: "Updated name",
      description: "New description",
      llm: { visionConnectionId: "conn_a", textConnectionId: "conn_b" },
    });
    expect(updated.id).toBe(p.id);
    expect(updated.name).toBe("Updated name");
    expect(updated.outputDir).toBe(cfg.paths.defaultSpecsDir(p.id));
    await expect(
      store.updateProject(p.id, { outputDir: abs }),
    ).rejects.toMatchObject({ status: 400 });
    expect(updated.llm).toEqual({
      visionConnectionId: "conn_a",
      textConnectionId: "conn_b",
    });
    // Not created eagerly.
    await expect(fs.stat(abs)).rejects.toThrow();

    const cleared = await store.updateProject(p.id, {
      llm: { visionConnectionId: null },
    });
    expect(cleared.llm).toEqual({ textConnectionId: "conn_b" });

    const reset = await store.updateProject(p.id, { outputDir: "" });
    expect(reset.outputDir).toBe(cfg.paths.defaultSpecsDir(p.id));

    await expect(
      store.updateProject(p.id, { outputDir: "relative/path" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(Date.parse(cleared.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(p.updatedAt),
    );
  });

  it("listProjects returns summaries with use case counts, newest first", async () => {
    const p = await store.createProject({
      name: "Listed",
      description: "Listed description",
    });
    await store.addScreens(p.id, [
      {
        originalName: "home.png",
        mimeType: "image/png",
        buffer: await makePng(),
      },
    ]);
    await store.saveModel(p.id, minimalModel(p.id, 3));
    const list = await store.listProjects();
    const summary = list.find((s) => s.id === p.id)!;
    expect(summary).toMatchObject({
      name: "Listed",
      screenCount: 1,
      useCaseCount: 3,
      status: "draft",
    });
    expect(summary.thumbnailScreenId).toMatch(/^scr_/);
    expect(list[0].id).toBe(p.id);
    // Count follows model changes.
    await store.saveModel(p.id, minimalModel(p.id, 5));
    expect(
      (await store.listProjects()).find((s) => s.id === p.id)!.useCaseCount,
    ).toBe(5);
  });

  it("deleteProject moves the folder to .trash", async () => {
    const p = await store.createProject({ name: "To delete", description: "" });
    await store.deleteProject(p.id);
    await expect(store.getProject(p.id)).rejects.toMatchObject({ status: 409 });
    const { registryEntries } = await import("./projectRegistry");
    const trashed = registryEntries("trash").find((e) => e.id === p.id)!;
    expect(trashed.trashId).toMatch(new RegExp(`^${p.id}-`));
    await expect(
      fs.stat(path.join(trashed.root, "project.json")),
    ).resolves.toBeTruthy();
    // Writes into a deleted project are refused instead of resurrecting it.
    await expect(store.saveProject(p)).rejects.toMatchObject({ status: 409 });
    expect(() => cfg.paths.projectDir(p.id)).toThrow(/Trash/);
  });
});

describe("screens", () => {
  it("adds screens with magic-byte type detection and dimensions", async () => {
    const p = await store.createProject({ name: "Screens", description: "" });
    const screens = await store.addScreens(p.id, [
      {
        originalName: "Login_page.png",
        mimeType: "application/octet-stream",
        buffer: await makePng(40, 30),
      },
      {
        originalName: "Dashboard.jpeg",
        mimeType: "image/jpeg",
        buffer: await makeJpeg(32, 64),
      },
      {
        originalName: "icon.webp",
        mimeType: "image/webp",
        buffer: await makeWebp(24, 24),
      },
    ]);
    expect(
      screens.map((s) => [
        s.name,
        s.mimeType,
        s.width,
        s.height,
        s.order,
        s.version,
      ]),
    ).toEqual([
      ["Login page", "image/png", 40, 30, 0, 1],
      ["Dashboard", "image/jpeg", 32, 64, 1, 1],
      ["icon", "image/webp", 24, 24, 2, 1],
    ]);
    expect(screens[0].fileName).toBe(`${screens[0].id}/v1.png`);
    expect(screens[1].fileName).toBe(`${screens[1].id}/v1.jpg`);
    const file = store.screenImagePath(p.id, screens[0]);
    expect(file).toBe(
      path.join(cfg.paths.screensDir(p.id), screens[0].id, "v1.png"),
    );
    expect((await fs.stat(file)).size).toBe(screens[0].sizeBytes);
    expect((await store.getProject(p.id)).screens).toHaveLength(3);
  });

  it("rejects non-images and leaves nothing behind", async () => {
    const p = await store.createProject({
      name: "Bad upload",
      description: "",
    });
    await expect(
      store.addScreens(p.id, [
        {
          originalName: "ok.png",
          mimeType: "image/png",
          buffer: await makePng(),
        },
        {
          originalName: "notes.txt",
          mimeType: "image/png",
          buffer: Buffer.from("hello, not an image"),
        },
      ]),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("notes.txt"),
    });
    expect((await store.getProject(p.id)).screens).toHaveLength(0);
    await expect(fs.readdir(cfg.paths.screensDir(p.id))).rejects.toThrow();
    await expect(store.addScreens(p.id, [])).rejects.toMatchObject({
      status: 400,
    });
  });

  it("renames, adds notes, replaces images (keeping old versions) and serves versions", async () => {
    const p = await store.createProject({ name: "Replace", description: "" });
    const [screen] = await store.addScreens(p.id, [
      {
        originalName: "a.png",
        mimeType: "image/png",
        buffer: await makePng(10, 10),
      },
    ]);
    const renamed = await store.updateScreen(p.id, screen.id, {
      name: "  Sign in ",
      notes: "Has SSO",
    });
    expect(renamed).toMatchObject({ name: "Sign in", notes: "Has SSO" });
    await expect(
      store.updateScreen(p.id, screen.id, { name: " " }),
    ).rejects.toMatchObject({ status: 400 });

    const replaced = await store.replaceScreenImage(p.id, screen.id, {
      originalName: "b.jpg",
      mimeType: "image/jpeg",
      buffer: await makeJpeg(20, 50),
    });
    expect(replaced).toMatchObject({
      version: 2,
      fileName: `${screen.id}/v2.jpg`,
      mimeType: "image/jpeg",
      width: 20,
      height: 50,
      name: "Sign in",
    });
    const v1 = store.screenImagePath(p.id, replaced, 1);
    const v2 = store.screenImagePath(p.id, replaced);
    expect(path.basename(v1)).toBe("v1.png");
    expect(path.basename(v2)).toBe("v2.jpg");
    await expect(fs.stat(v1)).resolves.toBeTruthy();
    await expect(fs.stat(v2)).resolves.toBeTruthy();
    await expect(
      store.replaceScreenImage(p.id, "scr_missing", {
        originalName: "c.png",
        mimeType: "image/png",
        buffer: await makePng(),
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("reorders only with a full permutation", async () => {
    const p = await store.createProject({ name: "Reorder", description: "" });
    const added = await store.addScreens(
      p.id,
      await Promise.all(
        [1, 2, 3].map(async (n) => ({
          originalName: `s${n}.png`,
          mimeType: "image/png",
          buffer: await makePng(10 + n, 10),
        })),
      ),
    );
    const ids = added.map((s) => s.id);
    const reordered = await store.reorderScreens(p.id, [
      ids[2],
      ids[0],
      ids[1],
    ]);
    expect(reordered.map((s) => s.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(reordered.map((s) => s.order)).toEqual([0, 1, 2]);
    await expect(
      store.reorderScreens(p.id, [ids[0], ids[1]]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.reorderScreens(p.id, [ids[0], ids[0], ids[1]]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.reorderScreens(p.id, [ids[0], ids[1], "scr_other"]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("deleteScreen removes the active record, retains evidence and renumbers the order", async () => {
    const p = await store.createProject({
      name: "Delete screen",
      description: "",
    });
    const added = await store.addScreens(
      p.id,
      await Promise.all(
        [1, 2, 3].map(async (n) => ({
          originalName: `s${n}.png`,
          mimeType: "image/png",
          buffer: await makePng(10, 10 + n),
        })),
      ),
    );
    await store.deleteScreen(p.id, added[1].id);
    const project = await store.getProject(p.id);
    expect(project.screens.map((s) => [s.id, s.order])).toEqual([
      [added[0].id, 0],
      [added[2].id, 1],
    ]);
    await expect(
      fs.stat(path.join(cfg.paths.screensDir(p.id), added[1].id)),
    ).resolves.toBeTruthy();
    const removed = JSON.parse(
      await fs.readFile(
        path.join(
          cfg.paths.projectDir(p.id),
          "removed-screens",
          `${added[1].id}.json`,
        ),
        "utf8",
      ),
    );
    expect(removed.id).toBe(added[1].id);
    await expect(store.deleteScreen(p.id, added[1].id)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("model & history", () => {
  it("loadModel returns null before generation", async () => {
    const p = await store.createProject({ name: "No model", description: "" });
    expect(await store.loadModel(p.id)).toBeNull();
  });

  it("saveModel bumps updatedAt and retains the complete previous-model history", async () => {
    const p = await store.createProject({ name: "History", description: "" });
    const model = minimalModel(p.id, 1);
    model.updatedAt = "2000-01-01T00:00:00.000Z";
    await store.saveModel(p.id, model, { snapshot: true });
    expect(model.updatedAt).not.toBe("2000-01-01T00:00:00.000Z");
    // First save: nothing to snapshot yet.
    await expect(fs.readdir(cfg.paths.historyDir(p.id))).rejects.toThrow();

    for (let i = 0; i < 23; i++) {
      await store.saveModel(p.id, minimalModel(p.id, i + 2), {
        snapshot: true,
      });
      // Snapshot names have millisecond resolution; keep them distinct.
      await new Promise((r) => setTimeout(r, 2));
    }
    const snapshots = (await fs.readdir(cfg.paths.historyDir(p.id))).sort();
    expect(snapshots).toHaveLength(23);
    const newest = JSON.parse(
      await fs.readFile(
        path.join(cfg.paths.historyDir(p.id), snapshots.at(-1)!),
        "utf8",
      ),
    );
    expect(newest.useCases).toHaveLength(23);
    expect((await store.loadModel(p.id))!.useCases).toHaveLength(24);

    await store.saveModel(p.id, minimalModel(p.id, 0));
    expect(await fs.readdir(cfg.paths.historyDir(p.id))).toHaveLength(23);
  });

  it("reports a corrupt model.json clearly", async () => {
    const p = await store.createProject({
      name: "Corrupt model",
      description: "",
    });
    await fs.writeFile(cfg.paths.modelFile(p.id), "{ not json");
    await expect(store.loadModel(p.id)).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining("model.json"),
    });
  });
});

describe("impact reports", () => {
  it("saves, lists newest first and gets by id", async () => {
    const p = await store.createProject({ name: "Impact", description: "" });
    const base = {
      projectId: p.id,
      change: { targetKind: "free", description: "x", source: "manual" },
      deterministic: {
        seedNodeIds: [],
        directUseCaseIds: [],
        downstreamUseCaseIds: [],
        upstreamUseCaseIds: [],
        relatedUseCaseIds: [],
        affectedElementIds: [],
        affectedScreenIds: [],
        paths: [],
      },
      items: [],
      summary: "",
      risks: [],
      suggestedNewUseCases: [],
      status: "analysed",
      analysedBy: "mock/demo",
      previousStatuses: {},
    } as Omit<ImpactReport, "id" | "createdAt">;
    await store.saveImpactReport({
      ...base,
      id: "IR-20261014-aaaaaa",
      createdAt: "2026-10-14T10:00:00.000Z",
    });
    await store.saveImpactReport({
      ...base,
      id: "IR-20261014-bbbbbb",
      createdAt: "2026-10-14T11:00:00.000Z",
    });
    expect((await store.listImpactReports(p.id)).map((r) => r.id)).toEqual([
      "IR-20261014-bbbbbb",
      "IR-20261014-aaaaaa",
    ]);
    expect(
      (await store.getImpactReport(p.id, "IR-20261014-aaaaaa")).createdAt,
    ).toBe("2026-10-14T10:00:00.000Z");
    await expect(
      store.getImpactReport(p.id, "IR-missing"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      store.getImpactReport(p.id, "../../settings"),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("withProjectLock", () => {
  it("serialises critical sections per project", async () => {
    const order: string[] = [];
    const section = (name: string, ms: number) =>
      store.withProjectLock("lock-a", async () => {
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${name}:end`);
      });
    await Promise.all([
      section("one", 30),
      section("two", 1),
      section("three", 1),
    ]);
    expect(order).toEqual([
      "one:start",
      "one:end",
      "two:start",
      "two:end",
      "three:start",
      "three:end",
    ]);
  });

  it("does not block other projects", async () => {
    const order: string[] = [];
    const slow = store.withProjectLock("lock-b", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("b");
    });
    const fast = store.withProjectLock("lock-c", async () => {
      order.push("c");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["c", "b"]);
  });

  it("is re-entrant for nested calls on the same project", async () => {
    const result = await store.withProjectLock("lock-d", async () =>
      store.withProjectLock("lock-d", async () => 42),
    );
    expect(result).toBe(42);
  });

  it("releases the lock when the section throws", async () => {
    await expect(
      store.withProjectLock("lock-e", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(
      store.withProjectLock("lock-e", async () => "ok"),
    ).resolves.toBe("ok");
  });
});

describe("recoverInterruptedProjects", () => {
  it("resets projects stuck in generating", async () => {
    const p = await store.createProject({ name: "Stuck", description: "" });
    await store.withProjectLock(p.id, async () => {
      const project = await store.getProject(p.id);
      project.status = "generating";
      await store.saveProject(project);
    });
    const recovered = await store.recoverInterruptedProjects();
    expect(recovered).toContain(p.id);
    expect((await store.getProject(p.id)).status).toBe("draft");
  });
});

describe("demo project", () => {
  it("creates the Acme demo with four named, annotated screens and a unique name", async () => {
    const first = await demo.createDemoProject();
    expect(first.name).toBe(demo.DEMO_PROJECT_NAME);
    expect(first.screens.map((s) => s.name)).toEqual([
      "Login",
      "Dashboard",
      "Orders",
      "New order",
    ]);
    expect(first.screens.every((s) => s.notes.length > 20 && s.width > 0)).toBe(
      true,
    );
    expect(first.description).toMatch(/order/i);
    expect(first.additionalContext).toMatch(/Credit/i);
    const second = await demo.createDemoProject();
    expect(second.name).toBe(`${demo.DEMO_PROJECT_NAME} (2)`);
    expect(second.id).not.toBe(first.id);
  });
});
