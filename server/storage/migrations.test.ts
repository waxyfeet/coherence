import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { removeDir, useTempDataDir } from "./testUtils";
import type { Migration } from "./migrations";

let dir: string;
let migrations: typeof import("./migrations");
beforeEach(async () => {
  dir = await useTempDataDir("migrations");
  await fs.mkdir(dir, { recursive: true });
  vi.resetModules();
  migrations = await import("./migrations");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await removeDir(dir);
});

const read = (name: string) => fs.readFile(path.join(dir, name), "utf8");
const exists = (name: string) =>
  fs.access(path.join(dir, name)).then(
    () => true,
    () => false,
  );
const journal = async () => JSON.parse(await read("migrations.json"));

/** A synthetic step: renames a field in settings.json and creates areas.json. */
function step(options: { fail?: boolean; runs?: { count: number } } = {}) {
  return {
    id: "settings-rename-theme",
    files: ["settings.json", "areas.json"],
    needed: async (root: string) =>
      "theme" in
      JSON.parse(await fs.readFile(path.join(root, "settings.json"), "utf8")),
    run: async (root: string) => {
      if (options.runs) options.runs.count++;
      const file = path.join(root, "settings.json");
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      await fs.writeFile(file, JSON.stringify({ appearance: value.theme }));
      await fs.writeFile(path.join(root, "areas.json"), "[]");
      if (options.fail) throw new Error("synthetic failure");
    },
  } satisfies Migration;
}

it("does nothing and writes nothing when no step is pending", async () => {
  expect(await migrations.runMigrations(dir, [])).toEqual([]);
  expect(await fs.readdir(dir)).toEqual([]);
});

it("backs up first, runs a step once, and records it", async () => {
  await fs.writeFile(path.join(dir, "settings.json"), '{"theme":"dark"}');
  const runs = { count: 0 };
  expect(await migrations.runMigrations(dir, [step({ runs })])).toEqual([
    "settings-rename-theme",
  ]);
  expect(await read("settings.json")).toBe('{"appearance":"dark"}');
  const done = await journal();
  expect(done.running).toBeUndefined();
  expect(done.applied).toHaveLength(1);
  expect(await read(path.join(done.applied[0].backup, "settings.json"))).toBe(
    '{"theme":"dark"}',
  );
  expect(await migrations.runMigrations(dir, [step({ runs })])).toEqual([]);
  expect(runs.count).toBe(1);
});

it("puts everything back and stops start-up when a step fails", async () => {
  await fs.writeFile(path.join(dir, "settings.json"), '{"theme":"dark"}');
  await expect(
    migrations.runMigrations(dir, [step({ fail: true })]),
  ).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
  expect(await read("settings.json")).toBe('{"theme":"dark"}');
  expect(await exists("areas.json")).toBe(false);
  const after = await journal();
  expect(after.running).toBeUndefined();
  expect(after.applied).toEqual([]);
});

it("undoes a step interrupted by a crash on the next start, then runs it again", async () => {
  await fs.writeFile(path.join(dir, "settings.json"), '{"theme":"dark"}');
  // What a power cut halfway through the step leaves behind: a backup, a journal saying "running", half the changes.
  const backup = path.join("backups", "settings-rename-theme-interrupted");
  await fs.mkdir(path.join(dir, backup), { recursive: true });
  await fs.copyFile(
    path.join(dir, "settings.json"),
    path.join(dir, backup, "settings.json"),
  );
  await fs.writeFile(
    path.join(dir, "migrations.json"),
    JSON.stringify({
      format: 1,
      applied: [],
      running: {
        id: "settings-rename-theme",
        backup,
        files: ["settings.json", "areas.json"],
        absent: ["areas.json"],
        startedAt: "2026-11-02T00:00:00.000Z",
      },
    }),
  );
  await fs.writeFile(path.join(dir, "settings.json"), '{"half":');
  await fs.writeFile(path.join(dir, "areas.json"), "[");
  const runs = { count: 0 };
  expect(await migrations.runMigrations(dir, [step({ runs })])).toEqual([
    "settings-rename-theme",
  ]);
  expect(runs.count).toBe(1);
  expect(await read("settings.json")).toBe('{"appearance":"dark"}');
  expect(await read("areas.json")).toBe("[]");
});

it("records a step whose data already has the new shape without running it", async () => {
  await fs.writeFile(path.join(dir, "settings.json"), '{"appearance":"dark"}');
  const runs = { count: 0 };
  expect(await migrations.runMigrations(dir, [step({ runs })])).toEqual([]);
  expect(runs.count).toBe(0);
  expect((await journal()).applied[0].id).toBe("settings-rename-theme");
});

it("refuses a journal written by a newer Coherence without changing it", async () => {
  await fs.writeFile(path.join(dir, "migrations.json"), '{"format":2}');
  await expect(migrations.runMigrations(dir, [step()])).rejects.toMatchObject({
    code: "DATA_NEWER",
  });
  expect(await read("migrations.json")).toBe('{"format":2}');
});
