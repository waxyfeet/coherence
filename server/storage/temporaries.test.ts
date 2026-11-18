import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { removeDir, useTempDataDir } from "./testUtils";

let dir: string;
let temporaries: typeof import("./temporaries");
beforeAll(async () => {
  dir = await useTempDataDir("temporaries");
  vi.resetModules();
  temporaries = await import("./temporaries");
});
afterAll(async () => {
  await removeDir(dir);
});

it("removes only orphaned atomic-write temporaries, by verified identity, and leaves everything else", async () => {
  await fs.mkdir(dir, { recursive: true });
  const orphans = [
    "settings.json.tmp-0123456789ab",
    "projects-index.json.tmp-0123456789abcdef0123456789abcdef",
  ];
  const kept = [
    "settings.json",
    "notes.tmp-0123456789ab.txt",
    "settings.json.tmp-XYZ",
    // Not the writer's lower-case hex (a distinct name: Windows names ignore case).
    "model.json.tmp-0123456789AB",
    ".tmp-0123456789ab",
  ];
  for (const name of [...orphans, ...kept])
    await fs.writeFile(path.join(dir, name), name);
  // A hard-linked or folder-shaped "temporary" is never touched.
  await fs.link(
    path.join(dir, "settings.json"),
    path.join(dir, "linked.json.tmp-aaaaaaaaaaaa"),
  );
  await fs.mkdir(path.join(dir, "folder.json.tmp-bbbbbbbbbbbb"));
  kept.push("linked.json.tmp-aaaaaaaaaaaa", "folder.json.tmp-bbbbbbbbbbbb");

  expect(await temporaries.removeOrphanedTemporaries(dir)).toBe(2);
  expect((await fs.readdir(dir)).sort()).toEqual([...kept].sort());
  expect(await temporaries.removeOrphanedTemporaries(dir)).toBe(0);
  expect(
    await temporaries.removeOrphanedTemporaries(path.join(dir, "missing")),
  ).toBe(0);
});
