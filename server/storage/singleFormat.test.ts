import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useTempDataDir, removeDir, makePng } from "./testUtils";

let data: string;
let store: typeof import("./projectStore");
let registry: typeof import("./projectRegistry");
let guard: typeof import("./windowsStorageGuard");
beforeEach(async () => {
  data = await useTempDataDir("single-format");
  vi.resetModules();
  store = await import("./projectStore");
  registry = await import("./projectRegistry");
  guard = await import("./windowsStorageGuard");
  await store.ensureDataDirs();
});
afterEach(async () => {
  await registry.releaseProjectLeases();
  await guard.releaseFilesystemGuard();
  await removeDir(data);
});

it("does not enumerate, adopt or rewrite an old project placed in global data", async () => {
  const old = path.join(data, "projects", "old-demo");
  await fs.mkdir(old, { recursive: true });
  const manifest = JSON.stringify({
    id: "old-demo",
    name: "Parked demo",
    screens: [],
    llm: {},
    outputDir: "old-specs",
  });
  await fs.writeFile(path.join(old, "project.json"), manifest);
  await fs.writeFile(path.join(old, "human.md"), "KEEP PARKED HUMAN CONTENT");
  expect(await store.listProjectIds()).not.toContain("old-demo");
  await expect(store.getProject("old-demo")).rejects.toMatchObject({
    status: 404,
  });
  await expect(registry.openProjectFolder(old)).rejects.toThrow();
  expect(await fs.readFile(path.join(old, "project.json"), "utf8")).toBe(
    manifest,
  );
  expect(await fs.readFile(path.join(old, "human.md"), "utf8")).toBe(
    "KEEP PARKED HUMAN CONTENT",
  );
});

it("rejects unsupported complete-folder formats rather than adopting or migrating them", async () => {
  const folder = path.join(data + "-workspace", "unsupported");
  await fs.mkdir(folder);
  const manifest = JSON.stringify({
    id: "old-project",
    name: "Unsupported",
    screens: [],
    llm: {},
    outputDir: "specs",
  });
  await fs.writeFile(path.join(folder, "project.json"), manifest);
  await expect(registry.openProjectFolder(folder)).rejects.toThrow(
    /not a supported/,
  );
  expect(await fs.readFile(path.join(folder, "project.json"), "utf8")).toBe(
    manifest,
  );
  expect(await store.listProjectIds()).toEqual([]);
});

for (const marker of [
  "project.json",
  ".coherence.json",
  ".screenscribe.json",
]) {
  for (const depth of ["root", "child"]) {
    it(`retains foreign ${marker} and human bytes at cache ${depth} before reads, writes or cleanup`, async () => {
      const p = await store.createProject({
        name: "Cache boundary",
        description: "Synthetic",
      });
      const folder = path.join(p.projectPath!, "analysis-cache");
      const at = depth === "root" ? folder : path.join(folder, "foreign");
      await fs.mkdir(at, { recursive: true });
      const content = JSON.stringify(
        marker === "project.json"
          ? { id: "foreign" }
          : { projectId: "foreign" },
      );
      await fs.writeFile(path.join(at, marker), content);
      await fs.writeFile(
        path.join(at, "human.md"),
        "KEEP FOREIGN HUMAN CONTENT",
      );
      const before = await fs.readFile(
        path.join(p.projectPath!, "project.json"),
      );
      const state = await import("../agents/runState");
      const { fixtureModel } = await import("../graph/testFixtures");
      expect((await state.readCachedAnalyses(p.id)).size).toBe(0);
      expect(
        await state.cacheAnalysis(
          p.id,
          "a".repeat(64),
          fixtureModel().screens[0],
        ),
      ).toBe(false);
      await state.clearAnalysisCache(p.id);
      expect(await fs.readFile(path.join(at, marker), "utf8")).toBe(content);
      expect(await fs.readFile(path.join(at, "human.md"), "utf8")).toBe(
        "KEEP FOREIGN HUMAN CONTENT",
      );
      expect(
        await fs.readFile(path.join(p.projectPath!, "project.json")),
      ).toEqual(before);
    });
  }
}

it.each(["project.json", ".coherence.json", ".screenscribe.json"])(
  "refuses screenshot removal before metadata changes when its directory contains %s",
  async (marker) => {
    const p = await store.createProject({
      name: "Screenshot guard",
      description: "Synthetic",
    });
    const [screen] = await store.addScreens(p.id, [
      {
        originalName: "synthetic.png",
        mimeType: "image/png",
        buffer: await makePng(),
      },
    ]);
    const at = path.join(p.projectPath!, "screens", screen.id);
    await fs.writeFile(
      path.join(at, marker),
      JSON.stringify(
        marker === "project.json"
          ? { id: "foreign" }
          : { projectId: "foreign" },
      ),
    );
    const before = await fs.readFile(path.join(p.projectPath!, "project.json"));
    await expect(store.deleteScreen(p.id, screen.id)).rejects.toThrow(
      /cannot contain/,
    );
    expect(
      await fs.readFile(path.join(p.projectPath!, "project.json")),
    ).toEqual(before);
    expect(await fs.readFile(path.join(at, "v1.png"))).toEqual(await makePng());
  },
);
