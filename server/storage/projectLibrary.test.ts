import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makePng, removeDir } from "./testUtils";

// Installer finding ST-09 and decision D12: recover from profile loss and restores without hand-editing anything.
let root: string;
let store: typeof import("./projectStore"),
  registry: typeof import("./projectRegistry"),
  guard: typeof import("./windowsStorageGuard"),
  library: typeof import("./projectLibrary"),
  inventory: typeof import("./inventory");
beforeEach(async () => {
  vi.resetModules();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "coherence-test-library-"));
  vi.stubEnv("SCREENSCRIBE_V2_DATA_DIR", path.join(root, "global"));
  vi.stubEnv("SCREENSCRIBE_V2_WORKSPACE_DIR", path.join(root, "workspace"));
  store = await import("./projectStore");
  registry = await import("./projectRegistry");
  guard = await import("./windowsStorageGuard");
  library = await import("./projectLibrary");
  inventory = await import("./inventory");
  await store.ensureDataDirs();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await registry.releaseProjectLeases();
  await guard.releaseFilesystemGuard();
  vi.unstubAllEnvs();
  await removeDir(root);
});
const create = (name: string) =>
  store.createProject({ name, description: "Synthetic" });

it("finds projects in a folder and its Coherence Trash, says where the library has them, and flags non-projects", async () => {
  const a = await create("Alpha orders");
  const b = await create("Beta billing");
  const workspace = path.join(root, "workspace");
  const elsewhere = path.join(root, "backup");
  await fs.mkdir(path.join(elsewhere, ".coherence-trash"), { recursive: true });
  await fs.cp(
    (await store.getProject(a.id)).projectPath!,
    path.join(elsewhere, "alpha-copy"),
    { recursive: true },
  );
  await fs.cp(
    (await store.getProject(b.id)).projectPath!,
    path.join(elsewhere, ".coherence-trash", "beta-trashed"),
    { recursive: true },
  );
  await fs.mkdir(path.join(elsewhere, "other-tool"));
  await fs.writeFile(
    path.join(elsewhere, "other-tool", "project.json"),
    '{"name":"web-app"}',
  );

  const here = await library.findProjects(workspace);
  expect(here.map((p) => [p.name, p.library])).toEqual([
    ["Alpha orders", "here"],
    ["Beta billing", "here"],
  ]);
  const found = await library.findProjects(elsewhere);
  expect(
    found.map((p) => [p.name, p.library, p.inTrash, Boolean(p.problem)]),
  ).toEqual([
    ["Alpha orders", "elsewhere", false, false],
    ["Beta billing", "elsewhere", true, false],
    ["other-tool", "absent", false, true],
  ]);
});

it("removes only a project whose folder is gone from the library, touching no files", async () => {
  const p = await create("Gone soon");
  const original = (await store.getProject(p.id)).projectPath!;
  await expect(library.removeFromLibrary(p.id)).rejects.toMatchObject({
    status: 409,
  });
  await registry.releaseProjectLeases();
  const moved = path.join(root, "moved-away");
  await fs.rename(original, moved);
  const before = (await inventory.inventoryTree(moved)).digest;
  await library.removeFromLibrary(p.id);
  expect((await store.listProjects()).map((s) => s.id)).not.toContain(p.id);
  expect((await inventory.inventoryTree(moved)).digest).toBe(before);
});

it("reconnects a project restored at its original folder (new folder identity, same place)", async () => {
  const p = await create("Restored in place");
  const original = (await store.getProject(p.id)).projectPath!;
  await registry.releaseProjectLeases();
  const backup = path.join(root, "backup-copy");
  await fs.rename(original, backup);
  await fs.cp(backup, original, { recursive: true });
  expect((await store.listProjects())[0].availability).toBe("unavailable");
  await registry.openProjectFolder(original, p.id);
  expect((await store.getProject(p.id)).projectPath).toBe(original);
  expect((await store.listProjects())[0].availability).toBe("available");
});

it("exports the complete project as a .zip that Windows can open, without the regenerable analysis cache", async () => {
  const p = await create("Export me");
  await store.addScreens(p.id, [
    {
      originalName: "login.png",
      mimeType: "image/png",
      buffer: await makePng(),
    },
  ]);
  const folder = (await store.getProject(p.id)).projectPath!;
  await fs.mkdir(path.join(folder, "analysis-cache"), { recursive: true });
  await fs.writeFile(path.join(folder, "analysis-cache", "a.json"), "{}");

  const archive = await library.projectArchive(p.id);
  expect(archive.name).toBe(`${path.basename(folder)}.zip`);
  const zipFile = path.join(root, archive.name);
  await fs.writeFile(zipFile, archive.data);
  const out = path.join(root, "unzipped");
  await fs.mkdir(out);
  const tar = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "tar.exe",
  );
  execFileSync(tar, ["-xf", zipFile, "-C", out], { windowsHide: true });
  const unzipped = path.join(out, path.basename(folder));
  expect(await fs.readFile(path.join(unzipped, "project.json"), "utf8")).toBe(
    await fs.readFile(path.join(folder, "project.json"), "utf8"),
  );
  const original = (await inventory.inventoryTree(folder)).files
    .filter((f) => !f.path.startsWith("analysis-cache"))
    .map((f) => [f.path, f.sha256]);
  const copied = (await inventory.inventoryTree(unzipped)).files.map((f) => [
    f.path,
    f.sha256,
  ]);
  expect(copied).toEqual(original);
  expect(original.some(([file]) => String(file).startsWith("screens/"))).toBe(
    true,
  );
});
