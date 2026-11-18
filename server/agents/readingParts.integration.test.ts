import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { useTempDataDir, removeDir } from "../storage/testUtils";
import { ScreenReadingSchema } from "./readerContract";
import { deterministicReview } from "./reviewer";
import { analysis, model } from "./testFixtures";
let dir: string,
  store: typeof import("../storage/projectStore"),
  state: typeof import("./runState"),
  paths: (typeof import("../config"))["paths"];
const fingerprint = "a".repeat(64),
  screenId = "scr_synthetic";
const output = ScreenReadingSchema.parse({
  title: "Synthetic",
  purpose: "Evidence",
  screenType: "form",
  personas: [],
  regions: [{ key: "main", name: "Main", purpose: "", layout: "" }],
  elements: [
    {
      key: "field",
      regionKey: "main",
      type: "text_input",
      label: "Exact synthetic label",
      bounds: { x: 5, y: 5, width: 10, height: 10 },
    },
  ],
  dataEntities: [],
  openQuestions: [],
});
const checkpoint = () => ({
  version: 1 as const,
  split: [""],
  completed: [{ path: "0", output }],
});
beforeAll(async () => {
  dir = await useTempDataDir("adaptive-parts");
  vi.resetModules();
  store = await import("../storage/projectStore");
  state = await import("./runState");
  paths = (await import("../config")).paths;
  await store.ensureDataDirs();
});
afterAll(async () => {
  await removeDir(dir);
});
it("retains resumable sections without changing project metadata or human content", async () => {
  const p = await store.createProject({
      name: "Synthetic checkpoints",
      description: "Fixture",
    }),
    manifest = await fs.readFile(paths.projectFile(p.id));
  const human = path.join(paths.projectDir(p.id), "human-note.md");
  await fs.writeFile(human, "Unchanged approved human note.");
  await state.cacheReadingParts(p.id, screenId, fingerprint, checkpoint());
  expect(await state.readReadingParts(p.id, screenId, fingerprint)).toEqual(
    checkpoint(),
  );
  expect(
    await state.readReadingParts(p.id, screenId, "b".repeat(64)),
  ).toBeUndefined();
  expect(await fs.readFile(paths.projectFile(p.id))).toEqual(manifest);
  expect(await fs.readFile(human, "utf8")).toBe(
    "Unchanged approved human note.",
  );
});
it("ignores corrupted section checkpoints and cleans only recognised records", async () => {
  const p = await store.createProject({
    name: "Synthetic damaged checkpoint",
    description: "Fixture",
  });
  await state.cacheReadingParts(p.id, screenId, fingerprint, checkpoint());
  const folder = path.join(paths.projectDir(p.id), "analysis-cache"),
    file = path.join(folder, screenId + ".parts.json"),
    human = path.join(folder, "human.txt");
  await fs.writeFile(human, "Keep this unknown content.");
  await fs.writeFile(file, '{"damaged":"synthetic"}');
  expect(
    await state.readReadingParts(p.id, screenId, fingerprint),
  ).toBeUndefined();
  await state.clearAnalysisCache(p.id);
  expect(await fs.readFile(human, "utf8")).toBe("Keep this unknown content.");
  expect(await fs.readFile(file, "utf8")).toContain("damaged");
  await state.cacheReadingParts(p.id, screenId, fingerprint, checkpoint());
  await state.clearAnalysisCache(p.id);
  expect(
    await fs.stat(file).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
  expect(await fs.readFile(human, "utf8")).toBe("Keep this unknown content.");
});
it("refuses checkpoint reads, writes and cleanup through a foreign project at the cache root", async () => {
  const p = await store.createProject({
      name: "Synthetic foreign cache",
      description: "Fixture",
    }),
    foreign = await store.createProject({
      name: "Synthetic protected child",
      description: "Fixture",
    });
  await state.cacheReadingParts(p.id, screenId, fingerprint, checkpoint());
  const folder = path.join(paths.projectDir(p.id), "analysis-cache"),
    manifest = await fs.readFile(paths.projectFile(foreign.id));
  await fs.writeFile(path.join(folder, "project.json"), manifest);
  const file = path.join(folder, screenId + ".parts.json"),
    before = await fs.readFile(file);
  expect(
    await state.readReadingParts(p.id, screenId, fingerprint),
  ).toBeUndefined();
  await state.cacheReadingParts(p.id, screenId, fingerprint, {
    version: 1,
    split: [],
    completed: [],
  });
  await state.clearAnalysisCache(p.id);
  expect(await fs.readFile(file)).toEqual(before);
  expect(await fs.readFile(path.join(folder, "project.json"))).toEqual(
    manifest,
  );
});
it("keeps incomplete inspection visible after reload and deterministic review", () => {
  const a = analysis("scr_synthetic", "synthetic", [], {
    reading: { version: 1, parts: 2, inspection: "failed" },
  });
  const reloaded = JSON.parse(JSON.stringify(a));
  const m = model([reloaded], []);
  expect(
    deterministicReview(m).some(
      (f) => f.message.includes("inspection did not complete") && !f.resolved,
    ),
  ).toBe(true);
  a.reading!.inspection = "passed";
  expect(deterministicReview(model([a], []))).toEqual([]);
});
