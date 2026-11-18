import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { makePng, makeJpeg, removeDir } from "./testUtils";
import type { SolutionModel } from "@shared/types";

let root: string;
let store: typeof import("./projectStore"),
  registry: typeof import("./projectRegistry"),
  guard: typeof import("./windowsStorageGuard"),
  life: typeof import("./projectLifecycle"),
  recovery: typeof import("./recovery"),
  io: typeof import("./fsUtils"),
  inventory: typeof import("./inventory");
beforeEach(async () => {
  vi.resetModules();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "coherence-test-portable-"));
  vi.stubEnv("SCREENSCRIBE_V2_DATA_DIR", path.join(root, "global"));
  vi.stubEnv("SCREENSCRIBE_V2_WORKSPACE_DIR", path.join(root, "workspace"));
  store = await import("./projectStore");
  registry = await import("./projectRegistry");
  guard = await import("./windowsStorageGuard");
  life = await import("./projectLifecycle");
  recovery = await import("./recovery");
  io = await import("./fsUtils");
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
const create = (name = "Portable synthetic") =>
  store.createProject({
    name,
    description: "Synthetic context",
    additionalContext: "Keep human business rules",
  });

it("rejects a physical foreign parent workspace even when that parent is absent from this profile's registry", async () => {
  const p = await create(),
    original = (await store.getProject(p.id)).projectPath!;
  const foreign = path.join(root, "unregistered-copy");
  await fs.cp(original, foreign, { recursive: true });
  const specs = path.join(foreign, "specs");
  await fs.mkdir(specs);
  const before = (await inventory.inventoryTree(foreign)).digest;
  await expect(registry.changeWorkspace(specs)).rejects.toThrow(
    /cannot contain/,
  );
  await expect(
    store.createProject({
      name: "Nested",
      description: "",
      workspaceDir: specs,
    }),
  ).rejects.toThrow(/cannot contain/);
  expect((await inventory.inventoryTree(foreign)).digest).toBe(before);
});

it("blocks late foreign child reads, writes, inventory, duplication and Trash without changing either project's bytes", async () => {
  const p = await create(),
    folder = (await store.getProject(p.id)).projectPath!;
  const c = await create("Child fixture"),
    cFolder = (await store.getProject(c.id)).projectPath!;
  const child = path.join(folder, "specs", "nested");
  await fs.mkdir(path.dirname(child), { recursive: true });
  await fs.cp(cFolder, child, { recursive: true });
  const canary = path.join(child, "specs", "human.md");
  await fs.mkdir(path.dirname(canary));
  await fs.writeFile(canary, "KEEP CHILD HUMAN CONTENT");
  const parentManifest = await fs.readFile(path.join(folder, "project.json"));
  await expect(io.readOwnedFile(canary)).rejects.toThrow(/cannot contain/);
  await expect(
    io.writeFileAtomic(canary, "UNREVIEWED PARENT WRITE"),
  ).rejects.toThrow(/cannot contain/);
  await expect(inventory.inventoryTree(folder)).rejects.toThrow(
    /cannot contain/,
  );
  await expect(life.duplicateProject(p.id)).rejects.toThrow(/cannot contain/);
  await expect(
    life.moveProjectToTrash(p.id, p.id, p.updatedAt),
  ).rejects.toThrow(/cannot contain/);
  expect(await fs.readFile(canary, "utf8")).toBe("KEEP CHILD HUMAN CONTENT");
  expect(await fs.readFile(path.join(folder, "project.json"))).toEqual(
    parentManifest,
  );
});

it("refuses reviewed purge if a foreign project appeared after the review", async () => {
  const p = await create(),
    folder = (await store.getProject(p.id)).projectPath!;
  await life.moveProjectToTrash(p.id, p.id, p.updatedAt);
  const [trash] = await recovery.listTrash(),
    review = await life.previewTrashDeletion(trash.id);
  const saved = registry.registryEntries("trash")[0].root;
  const nested = path.join(saved, "new-project");
  await fs.mkdir(nested);
  await fs.copyFile(
    path.join(saved, "project.json"),
    path.join(nested, "project.json"),
  );
  await fs.writeFile(path.join(nested, "human.md"), "KEEP TRASH CHILD");
  const ownManifest = await fs.readFile(path.join(saved, "project.json"));
  await expect(
    life.permanentlyDeleteTrashedProject(trash.id, trash.id, review.revision),
  ).rejects.toThrow(/cannot contain/);
  expect(await fs.readFile(path.join(nested, "human.md"), "utf8")).toBe(
    "KEEP TRASH CHILD",
  );
  expect(await fs.readFile(path.join(saved, "project.json"))).toEqual(
    ownManifest,
  );
  await expect(fs.access(folder)).rejects.toThrow();
});

it("separates global state from canonical files and refuses installed/global project destinations", async () => {
  const p = await create();
  const read = await store.getProject(p.id);
  expect(read.projectPath).toBe(path.join(root, "workspace", p.id));
  const raw = JSON.parse(
    await fs.readFile(path.join(read.projectPath!, "project.json"), "utf8"),
  );
  expect(raw.outputDir).toBe("specs");
  expect(raw.projectPath).toBeUndefined();
  expect(raw.storage.version).toBe(1);
  expect(await fs.readdir(path.join(root, "global"))).not.toContain("projects");
  expect(await fs.readdir(path.join(root, "global"))).not.toContain(".trash");
  await expect(
    store.createProject({
      name: "Unsafe",
      description: "",
      workspaceDir: process.cwd(),
    }),
  ).rejects.toThrow();
  await expect(
    store.createProject({
      name: "Unsafe",
      description: "",
      workspaceDir: path.join(root, "global"),
    }),
  ).rejects.toThrow();
  await expect(
    store.updateProject(p.id, { outputDir: path.join(root, "outside") }),
  ).rejects.toThrow(/portable|Requirements/);
});
it("gives same-name Unicode projects independent stable folders and remembers only future defaults", async () => {
  const a = await create("Analyste — 日本語"),
    b = await create("Analyste — 日本語");
  expect(a.id).not.toBe(b.id);
  const second = path.join(root, "other-volume-fixture");
  await fs.mkdir(second);
  await registry.changeWorkspace(second);
  const c = await create();
  expect((await store.getProject(a.id)).projectPath).toBe(
    path.join(root, "workspace", a.id),
  );
  expect((await store.getProject(c.id)).projectPath).toBe(
    path.join(second, c.id),
  );
  expect((await store.listProjects()).length).toBe(3);
});
it("retains screenshot originals/versions/notes and duplicates into an independent draft without analysis", async () => {
  const p = await create();
  const [screen] = await store.addScreens(p.id, [
    {
      originalName: "Evidence.png",
      mimeType: "image/png",
      buffer: await makePng(),
    },
  ]);
  await store.updateScreen(p.id, screen.id, {
    name: "Exact UI label",
    notes: "Human notes",
  });
  await store.replaceScreenImage(p.id, screen.id, {
    originalName: "New.jpg",
    mimeType: "image/jpeg",
    buffer: await makeJpeg(),
  });
  const source = await store.getProject(p.id);
  source.llm = {
    visionConnectionId: "missing-local-account",
    visionModelId: "local:exact",
    textConnectionId: "missing-writer",
  };
  source.status = "specified";
  source.generationPreferences = { preserveEdited: true } as never;
  await store.saveProject(source);
  await store.saveModel(p.id, {
    projectId: p.id,
    useCases: [{ id: "UC-001" }],
    screens: [],
    features: [],
    review: [],
    changeLog: [],
  } as unknown as SolutionModel);
  const copy = await life.duplicateProject(p.id);
  expect(copy.id).not.toBe(p.id);
  expect(copy.status).toBe("draft");
  expect(copy.llm).toEqual(source.llm);
  expect(await store.loadModel(copy.id)).toBeNull();
  const fresh = await store.getProject(copy.id);
  expect(fresh.screens[0].id).not.toBe(screen.id);
  expect(fresh.screens[0].notes).toBe("Human notes");
  expect(fresh.screens[0].name).toBe("Exact UI label");
  const a = path.join(source.projectPath!, "screens", screen.id),
    b = path.join(fresh.projectPath!, "screens", fresh.screens[0].id);
  expect(await fs.readdir(a)).toEqual(await fs.readdir(b));
  for (const name of await fs.readdir(a))
    expect(await fs.readFile(path.join(a, name))).toEqual(
      await fs.readFile(path.join(b, name)),
    );
  await store.deleteScreen(copy.id, fresh.screens[0].id);
  expect((await store.getProject(copy.id)).screens).toHaveLength(0);
  expect(await fs.readdir(b)).toEqual(await fs.readdir(a));
  expect(
    JSON.parse(
      await fs.readFile(
        path.join(
          fresh.projectPath!,
          "removed-screens",
          `${fresh.screens[0].id}.json`,
        ),
        "utf8",
      ),
    ).notes,
  ).toBe("Human notes");
});
it("protects unrelated parent/sibling files through full Trash, Restore and reviewed purge", async () => {
  const p = await create(),
    sibling = await create("Sibling");
  const saved = await store.getProject(p.id);
  await io.writeFileAtomic(
    path.join(saved.projectPath!, "human-note.md"),
    "SYNTHETIC HUMAN CONTENT",
  );
  const parentFile = path.join(root, "workspace", "unrelated.txt");
  await fs.writeFile(parentFile, "Keep unrelated personal document");
  const siblingBefore = await inventory.inventoryTree(
    (await store.getProject(sibling.id)).projectPath!,
  );
  await life.moveProjectToTrash(p.id, p.id, p.updatedAt);
  let trash = (await recovery.listTrash())[0];
  expect(trash.projectId).toBe(p.id);
  const restored = await recovery.restoreFromTrash(trash.id);
  expect(
    await fs.readFile(
      path.join(restored.projectPath!, "human-note.md"),
      "utf8",
    ),
  ).toBe("SYNTHETIC HUMAN CONTENT");
  await life.moveProjectToTrash(p.id, p.id, restored.updatedAt);
  trash = (await recovery.listTrash())[0];
  const plan = await life.previewTrashDeletion(trash.id);
  expect(plan.paths).toHaveLength(1);
  await life.permanentlyDeleteTrashedProject(trash.id, trash.id, plan.revision);
  expect(await recovery.listTrash()).toHaveLength(0);
  expect(await fs.readFile(parentFile, "utf8")).toBe(
    "Keep unrelated personal document",
  );
  expect(
    (
      await inventory.inventoryTree(
        (await store.getProject(sibling.id)).projectPath!,
      )
    ).digest,
  ).toBe(siblingBefore.digest);
});
it("rejects any complete-content deletion change after review, including a long Markdown tail", async () => {
  const p = await create(),
    project = await store.getProject(p.id);
  const text = "Synthetic requirement.\n".repeat(300) + "KEEP ORIGINAL END";
  await io.writeFileAtomic(
    path.join(project.projectPath!, "long-human.md"),
    text,
  );
  await life.moveProjectToTrash(p.id, p.id, p.updatedAt);
  const entry = (await recovery.listTrash())[0];
  const plan = await life.previewTrashDeletion(entry.id);
  const trashRoot = (await recovery.readTrashedProject(entry.id)).root;
  await fs.appendFile(
    path.join(trashRoot, "long-human.md"),
    "\nUNREVIEWED NEW HUMAN END",
  );
  await expect(
    life.permanentlyDeleteTrashedProject(entry.id, entry.id, plan.revision),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    await fs.readFile(path.join(trashRoot, "long-human.md"), "utf8"),
  ).toContain("UNREVIEWED NEW HUMAN END");
});
it("retains a missing project in discovery and explicitly reconnects a moved complete folder", async () => {
  const p = await create();
  const original = (await store.getProject(p.id)).projectPath!;
  const copy = path.join(root, "copy");
  await fs.cp(original, copy, { recursive: true });
  await expect(registry.openProjectFolder(copy)).rejects.toThrow(
    /original project is still present/,
  );
  await registry.releaseProjectLeases();
  const moved = path.join(root, "moved");
  await fs.rename(original, moved);
  const summary = (await store.listProjects())[0];
  expect(summary.availability).toBe("unavailable");
  expect(summary.id).toBe(p.id);
  await registry.openProjectFolder(moved, p.id);
  expect((await store.getProject(p.id)).projectPath).toBe(moved);
  expect((await store.listProjects())[0].availability).toBe("available");
});
it("fails closed for corrupt/newer manifests without changing unrelated files", async () => {
  const p = await create(),
    file = path.join(
      (await store.getProject(p.id)).projectPath!,
      "project.json",
    );
  const original = await fs.readFile(file, "utf8");
  await fs.writeFile(file, original.replace('"version": 1', '"version": 99'));
  await expect(store.getProject(p.id)).rejects.toThrow();
  expect((await store.listProjects())[0].availability).toBe("unavailable");
  await fs.writeFile(file, "{ damaged fixture");
  await expect(store.getProject(p.id)).rejects.toThrow();
  await fs.writeFile(file, original);
  expect((await store.getProject(p.id)).id).toBe(p.id);
});
it("refuses junctions, hardlinks, traversal, device/ADS paths and overlapping project authorities", async () => {
  const p = await create(),
    project = await store.getProject(p.id);
  const outside = path.join(root, "unrelated");
  await fs.mkdir(outside);
  await fs.writeFile(
    path.join(outside, "keep.md"),
    "Keep exact unrelated bytes",
  );
  const junction = path.join(project.projectPath!, "escape");
  await fs.symlink(outside, junction, "junction");
  await expect(inventory.inventoryTree(project.projectPath!)).rejects.toThrow();
  await expect(life.previewProjectDeletion(p.id)).rejects.toThrow();
  await fs.unlink(junction);
  await fs.link(
    path.join(outside, "keep.md"),
    path.join(project.projectPath!, "shared.md"),
  );
  await expect(inventory.inventoryTree(project.projectPath!)).rejects.toThrow();
  await fs.unlink(path.join(project.projectPath!, "shared.md"));
  const safety = await import("./pathSafety");
  for (const rel of ["../keep.md", "C:/outside", "a\\b", "a//b", "a/../b"])
    expect(() => safety.relativeFile(project.projectPath!, rel)).toThrow();
  for (const name of ["CON", "unsafe.", "stream:secret"])
    expect(() => safety.regularPath(path.join(root, name))).toThrow();
  await expect(
    store.createProject({
      name: "Nested",
      description: "",
      workspaceDir: project.projectPath,
    }),
  ).rejects.toThrow();
  expect(await fs.readFile(path.join(outside, "keep.md"), "utf8")).toBe(
    "Keep exact unrelated bytes",
  );
});
it("serialises simultaneous metadata writes without losing independent human fields", async () => {
  const p = await create();
  await Promise.all([
    store.updateProject(p.id, { name: "Human title" }),
    store.updateProject(p.id, {
      additionalContext: "Human business constraints",
    }),
  ]);
  const result = await store.getProject(p.id);
  expect(result.name).toBe("Human title");
  expect(result.additionalContext).toBe("Human business constraints");
});
it("will not permanently delete an active project or restore over an unrelated existing folder", async () => {
  const p = await create(),
    project = await store.getProject(p.id);
  await expect(
    life.permanentlyDeleteProject(p.id, p.id, p.updatedAt),
  ).rejects.toThrow(/Trash first/);
  await life.moveProjectToTrash(p.id, p.id, p.updatedAt);
  const entry = (await recovery.listTrash())[0];
  await fs.mkdir(project.projectPath!);
  await fs.writeFile(
    path.join(project.projectPath!, "unrelated.txt"),
    "Not owned by Coherence",
  );
  await expect(recovery.restoreFromTrash(entry.id)).rejects.toThrow(
    /already exists/,
  );
  expect(
    await fs.readFile(path.join(project.projectPath!, "unrelated.txt"), "utf8"),
  ).toBe("Not owned by Coherence");
  expect((await recovery.listTrash())[0].id).toBe(entry.id);
});
it("directory handles defeat a scheduled ancestor replacement during a write transaction", async () => {
  const p = await create(),
    project = await store.getProject(p.id);
  const folder = path.join(project.projectPath!, "protected");
  await io.ensureDir(folder);
  await guard.withDirectoryGuard(folder, async () => {
    await expect(
      fs.rename(folder, path.join(root, "replaced")),
    ).rejects.toThrow();
    await io.writeFileAtomic(
      path.join(folder, "human.md"),
      "Complete intended bytes",
    );
  });
  expect(await fs.readFile(path.join(folder, "human.md"), "utf8")).toBe(
    "Complete intended bytes",
  );
});
it("retains partial creation on an uncertain preparation failure without publishing it or touching its parent", async () => {
  const before = await fs.readdir(root);
  await expect(
    store.createProject({ name: "Interrupted", description: "" }, async () => {
      throw Error("Synthetic preparation interruption");
    }),
  ).rejects.toThrow("Synthetic preparation interruption");
  expect(await store.listProjects()).toHaveLength(0);
  expect(await fs.readdir(root)).toEqual(expect.arrayContaining(before));
});

it("native rename preserves exact Unicode and long names without appending uninitialised characters", async () => {
  const p = await create(),
    base = (await store.getProject(p.id)).projectPath!;
  for (const name of [
    "évidence 日本語.md",
    "a".repeat(160) + ".md",
    "short.md",
  ]) {
    const from = path.join(base, "from-" + name),
      to = path.join(base, name);
    await fs.writeFile(from, "Exact Unicode filename bytes");
    await guard.renameOwnedDirectory(
      from,
      to,
      (await fs.stat(from, { bigint: true })).ino.toString(),
    );
    expect(await fs.readdir(base)).toContain(name);
    expect(await fs.readFile(to, "utf8")).toBe("Exact Unicode filename bytes");
  }
});
it("a locked destination fails atomically, preserving its old bytes until a complete retry succeeds", async () => {
  const p = await create(),
    file = path.join(
      (await store.getProject(p.id)).projectPath!,
      "locked-human.md",
    );
  await io.writeFileAtomic(file, "Original complete human bytes");
  const script =
    "$ErrorActionPreference='Stop'; $p=[Console]::ReadLine(); $h=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None); [Console]::WriteLine('LOCKED'); try{[Console]::ReadLine()|Out-Null}finally{$h.Dispose()}";
  const child = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
  );
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
  });
  child.stdin.write(file + "\n");
  await ready;
  try {
    await expect(
      io.writeFileAtomic(file, "New complete bytes"),
    ).rejects.toThrow();
  } finally {
    const ended = new Promise<void>((r) => child.once("close", () => r()));
    child.stdin.end("\n");
    await ended;
  }
  expect(await fs.readFile(file, "utf8")).toBe("Original complete human bytes");
  await io.writeFileAtomic(file, "New complete bytes");
  expect(await fs.readFile(file, "utf8")).toBe("New complete bytes");
});
it("malformed model paths cannot write into another registered project", async () => {
  const a = await create(),
    b = await create("Protected sibling"),
    pa = await store.getProject(a.id),
    pb = await store.getProject(b.id);
  const before = await inventory.inventoryTree(pb.projectPath!);
  const { fixtureModel } = await import("../graph/testFixtures");
  const model = fixtureModel();
  model.projectId = a.id;
  model.useCases[0].id = "../../../" + b.id + "/specs/OVERRIDE";
  const specs = await import("../specs/specStore");
  await expect(
    specs.writeSpecs(pa, model, {
      preserveEdited: false,
      embedScreenImages: false,
    }),
  ).rejects.toThrow();
  expect((await inventory.inventoryTree(pb.projectPath!)).digest).toBe(
    before.digest,
  );
});
it("a partial purge keeps the Trash manifest discoverable and never removes newly added unrelated files", async () => {
  const p = await create();
  await life.moveProjectToTrash(p.id, p.id, p.updatedAt);
  const entry = (await recovery.listTrash())[0];
  const { root: trashed } = await recovery.readTrashedProject(entry.id);
  await io.writeFileAtomic(
    path.join(trashed, "first.txt"),
    "Reviewed disposable bytes",
  );
  const plan = await life.previewTrashDeletion(entry.id),
    remove = guard.removeReviewedPath;
  let added = false;
  vi.spyOn(guard, "removeReviewedPath").mockImplementation(
    async (file, id, hash, directory) => {
      await remove(file, id, hash, directory);
      if (!added) {
        added = true;
        await fs.writeFile(
          path.join(trashed, "new-unreviewed.txt"),
          "Never remove a late addition",
        );
      }
    },
  );
  await expect(
    life.permanentlyDeleteTrashedProject(entry.id, entry.id, plan.revision),
  ).rejects.toThrow();
  vi.restoreAllMocks();
  expect(
    await fs.readFile(path.join(trashed, "new-unreviewed.txt"), "utf8"),
  ).toBe("Never remove a late addition");
  expect((await recovery.listTrash())[0].projectId).toBe(p.id);
  const next = await life.previewTrashDeletion(entry.id);
  await life.permanentlyDeleteTrashedProject(entry.id, entry.id, next.revision);
  expect(await recovery.listTrash()).toHaveLength(0);
});

it("portable requirements retain R1 complete-review, cancel and stale-version protections", async () => {
  const project = await store.getProject((await create()).id),
    { fixtureModel } = await import("../graph/testFixtures");
  const model = fixtureModel();
  model.projectId = project.id;
  model.options.embedScreenImages = false;
  for (const uc of model.useCases) {
    uc.status = "approved";
    uc.notes = "Synthetic human narrative.\n".repeat(400) + "KEEP APPROVED END";
  }
  const specs = await import("../specs/specStore"),
    proposals = await import("../specs/revisionProposals");
  await store.saveModel(project.id, model);
  await specs.writeSpecs(project, model, {
    preserveEdited: false,
    embedScreenImages: false,
  });
  await store.saveModel(project.id, model);
  async function proposal(index: number) {
    const uc = model.useCases[index],
      file = await specs.readSpecFile(project, uc.filePath!);
    const saved = await proposals.createRevisionProposal(
      project,
      model,
      uc,
      {
        ...uc,
        notes: uc.notes + "\nIMPORTANT CHANGE BEYOND OLD PREVIEW LIMIT",
      },
      file.contentHash!,
    );
    const review = await proposals.reviewRevisionProposal(project.id, saved.id);
    expect(
      review.proposedMarkdown.indexOf("IMPORTANT CHANGE BEYOND"),
    ).toBeGreaterThan(4000);
    return { uc, file, saved, review };
  }
  const cancel = await proposal(0);
  await proposals.discardRevisionProposal(project.id, cancel.saved.id);
  expect((await specs.readSpecFile(project, cancel.uc.filePath!)).content).toBe(
    cancel.file.content,
  );
  const stale = await proposal(1);
  stale.saved.proposedMarkdown += "\nUNREVIEWED MUTATION";
  await io.writeJsonAtomic(
    path.join(project.projectPath!, "proposals", stale.saved.id + ".json"),
    stale.saved,
  );
  await expect(
    proposals.applyRevisionProposal(
      project.id,
      stale.saved.id,
      stale.review.reviewToken,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect((await specs.readSpecFile(project, stale.uc.filePath!)).content).toBe(
    stale.file.content,
  );
  const valid = await proposal(2);
  await proposals.applyRevisionProposal(
    project.id,
    valid.saved.id,
    valid.review.reviewToken,
  );
  expect((await specs.readSpecFile(project, valid.uc.filePath!)).content).toBe(
    valid.review.proposedMarkdown,
  );
  await expect(
    proposals.applyRevisionProposal(
      project.id,
      valid.saved.id,
      valid.review.reviewToken,
    ),
  ).rejects.toMatchObject({ status: 409 });
});

it("opening an incomplete portable copy fails without rewriting it", async () => {
  const p = await create(),
    [screen] = await store.addScreens(p.id, [
      {
        originalName: "synthetic.png",
        mimeType: "image/png",
        buffer: await makePng(),
      },
    ]);
  const copy = path.join(root, "incomplete-copy");
  await fs.cp((await store.getProject(p.id)).projectPath!, copy, {
    recursive: true,
  });
  await fs.unlink(path.join(copy, "screens", ...screen.fileName.split("/")));
  const before = (await inventory.inventoryTree(copy)).digest;
  await expect(registry.openProjectFolder(copy)).rejects.toThrow();
  expect((await inventory.inventoryTree(copy)).digest).toBe(before);
});

it("exclusive native creation never adopts an existing directory and pins the new directory before returning", async () => {
  const existing = path.join(root, "existing");
  await fs.mkdir(existing);
  await fs.writeFile(
    path.join(existing, "unrelated.txt"),
    "Unrelated existing bytes",
  );
  await expect(guard.createOwnedDirectory(existing)).rejects.toThrow();
  expect(await fs.readFile(path.join(existing, "unrelated.txt"), "utf8")).toBe(
    "Unrelated existing bytes",
  );
  const fresh = path.join(root, "fresh-atomic-directory"),
    release = await guard.createOwnedDirectory(fresh);
  try {
    await expect(
      fs.rename(fresh, path.join(root, "swapped")),
    ).rejects.toThrow();
  } finally {
    await release();
  }
  await fs.rename(fresh, path.join(root, "swapped"));
  expect(await fs.readdir(path.join(root, "swapped"))).toEqual([]);
});

it("shutdown refuses late writes and queued jobs before releasing ownership, while cleanup can still unlock handles", async () => {
  const p = await create(),
    folder = (await store.getProject(p.id)).projectPath!,
    file = path.join(folder, "saved-human.md");
  await io.writeFileAtomic(file, "Saved before shutdown");
  guard.beginFilesystemShutdown();
  await expect(
    io.writeFileAtomic(file, "Late uncommitted write"),
  ).rejects.toThrow(/closing/);
  const jobFile = path.join(folder, "jobs", "job_shutdown123.json");
  await expect(guard.writeQueuedRecord(folder, jobFile, "{}")).rejects.toThrow(
    /closing/,
  );
  expect(await fs.readFile(file, "utf8")).toBe("Saved before shutdown");
  await expect(fs.access(jobFile)).rejects.toThrow();
  await registry.releaseProjectLeases();
  await guard.releaseFilesystemGuard();
});

it("refuses a request that arrives while the guard is being released, instead of writing to its closed input", async () => {
  const p = await create(),
    file = path.join((await store.getProject(p.id)).projectPath!, "late.md");
  await io.writeFileAtomic(file, "Saved");
  await registry.releaseProjectLeases();
  const releasing = guard.releaseFilesystemGuard();
  await expect(guard.verifyRegularFile(file, "1")).rejects.toThrow(/closing/);
  await releasing;
});

it("cache cleanup removes only recognised reviewed cache records and retains unrelated human files", async () => {
  const p = await create(),
    project = await store.getProject(p.id),
    { fixtureModel } = await import("../graph/testFixtures"),
    state = await import("../agents/runState");
  const analysis = fixtureModel().screens[0];
  expect(await state.cacheAnalysis(p.id, "a".repeat(64), analysis)).toBe(true);
  expect((await state.readCachedAnalyses(p.id)).has(analysis.screenId)).toBe(
    true,
  );
  const folder = path.join(project.projectPath!, "analysis-cache");
  await io.writeFileAtomic(
    path.join(folder, "human-note.md"),
    "Keep unrelated human bytes",
  );
  await io.writeFileAtomic(
    path.join(folder, "references", "human-note.txt"),
    "Keep nested human bytes",
  );
  const before = await fs.readFile(
    path.join(project.projectPath!, "project.json"),
  );
  await state.clearAnalysisCache(p.id);
  await expect(
    fs.access(path.join(folder, analysis.screenId + ".json")),
  ).rejects.toThrow();
  expect(await fs.readFile(path.join(folder, "human-note.md"), "utf8")).toBe(
    "Keep unrelated human bytes",
  );
  expect(
    await fs.readFile(
      path.join(folder, "references", "human-note.txt"),
      "utf8",
    ),
  ).toBe("Keep nested human bytes");
  expect(
    await fs.readFile(path.join(project.projectPath!, "project.json")),
  ).toEqual(before);
});
