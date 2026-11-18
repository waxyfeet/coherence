import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { removeDir, useTempDataDir } from "../storage/testUtils";

type RunState = typeof import("./runState");
let dataDir: string;
let store: typeof import("../storage/projectStore");
let cfg: typeof import("../config");
let state: RunState;

beforeAll(async () => {
  dataDir = await useTempDataDir("stage-checkpoints");
  vi.resetModules();
  store = await import("../storage/projectStore");
  cfg = await import("../config");
  state = await import("./runState");
  await store.ensureDataDirs();
});
afterAll(async () => {
  await removeDir(dataDir);
});

const isNote = (v: unknown): v is { note: string } =>
  !!v && typeof (v as { note?: unknown }).note === "string";

it("keeps a stage under the hash of its inputs, and only for those inputs", async () => {
  const p = await store.createProject({ name: "Stages", description: "" });
  const key = state.stageKey("journey", "writer", [1, 2]);
  expect(key).toBe(state.stageKey("journey", "writer", [1, 2]));
  expect(key).not.toBe(state.stageKey("journey", "writer", [1, 3]));
  await state.writeStage(p.id, "journey", key, { note: "kept" });
  expect(await state.readStage(p.id, "journey", key, isNote)).toEqual({
    note: "kept",
  });
  // Another key, a shape that fails the check, or an unknown name: the stage runs again.
  expect(
    await state.readStage(p.id, "journey", state.stageKey("other"), isNote),
  ).toBeUndefined();
  expect(
    await state.readStage(
      p.id,
      "journey",
      key,
      (v): v is { other: number } => !!v && "other" in (v as object),
    ),
  ).toBeUndefined();
  await state.writeStage(p.id, "../escape", key, { note: "x" });
  expect(await state.readStage(p.id, "../escape", key, isNote)).toBeUndefined();
});

it("ignores a damaged checkpoint", async () => {
  const p = await store.createProject({ name: "Damaged", description: "" });
  const key = state.stageKey("plan");
  await state.writeStage(p.id, "plan", key, { note: "kept" });
  const file = path.join(
    cfg.paths.projectDir(p.id),
    "analysis-cache",
    "stages",
    "plan.json",
  );
  await fs.writeFile(file, "{ not json");
  expect(await state.readStage(p.id, "plan", key, isNote)).toBeUndefined();
});

it("is cleared with the reading cache, leaving files it does not recognise", async () => {
  const p = await store.createProject({ name: "Cleared", description: "" });
  const key = state.stageKey("use-case", "UC-001");
  await state.writeStage(p.id, "use-case-UC-001", key, { note: "kept" });
  await state.writeStage(p.id, "journey", key, { note: "kept" });
  const stages = path.join(
    cfg.paths.projectDir(p.id),
    "analysis-cache",
    "stages",
  );
  await fs.writeFile(path.join(stages, "notes.json"), '{"human": true}');
  await state.clearAnalysisCache(p.id);
  expect(
    await state.readStage(p.id, "use-case-UC-001", key, isNote),
  ).toBeUndefined();
  expect((await fs.readdir(stages)).sort()).toEqual(["notes.json"]);
});

it("quietly skips a project that is not registered", async () => {
  const id = "never-created-project";
  const key = state.stageKey("x");
  await expect(
    state.writeStage(id, "journey", key, { note: "x" }),
  ).resolves.toBeUndefined();
  expect(await state.readStage(id, "journey", key, isNote)).toBeUndefined();
});
