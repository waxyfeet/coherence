import fs from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { authenticatedTestApp } from "../security/authTestUtils";
import { makePng, removeDir, useTempDataDir } from "./testUtils";
import { fixtureModel } from "../graph/testFixtures";

let dataDir: string, origin: string, server: Server;
let auth: Awaited<ReturnType<typeof authenticatedTestApp>>;
let store: typeof import("./projectStore"),
  life: typeof import("./projectLifecycle"),
  recovery: typeof import("./recovery"),
  cfg: typeof import("../config"),
  jobs: typeof import("../jobs/jobManager");
beforeAll(async () => {
  dataDir = await useTempDataDir("trash-lifecycle");
  vi.resetModules();
  store = await import("./projectStore");
  life = await import("./projectLifecycle");
  recovery = await import("./recovery");
  cfg = await import("../config");
  jobs = await import("../jobs/jobManager");
  await store.ensureDataDirs();
  auth = await authenticatedTestApp();
  server = auth.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  auth.authenticate(origin);
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await removeDir(dataDir);
});
async function api(url: string, body?: unknown) {
  const r = await auth.fetch(origin + "/api" + url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-ScreenScribe": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
async function move(name: string) {
  const project = await store.createProject({
    name,
    description: "Synthetic preserved brief",
  });
  await life.moveProjectToTrash(project.id, project.id, project.updatedAt);
  const entry = (await recovery.listTrash()).find(
    (e) => e.projectId === project.id,
  )!;
  return { project, entry };
}
async function trashRoot(trashId: string) {
  return (await recovery.readTrashedProject(trashId)).root;
}
async function bytes(
  root: string,
  prefix = "",
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of await fs.readdir(path.join(root, prefix))) {
    const relative = path.join(prefix, name),
      file = path.join(root, relative);
    if ((await fs.stat(file)).isDirectory())
      Object.assign(result, await bytes(root, relative));
    else result[relative] = (await fs.readFile(file)).toString("base64");
  }
  return result;
}

it("moves complete project bytes to trash and restores metadata, images, human specs, model and history without regeneration", async () => {
  let p = await store.createProject({
    name: "Complete reversible project",
    description: "Entered description",
    additionalContext: "Exact human context",
  });
  await store.addScreens(p.id, [
    {
      originalName: "evidence.png",
      mimeType: "image/png",
      buffer: await makePng(),
    },
  ]);
  const model = fixtureModel();
  model.projectId = p.id;
  await store.saveModel(p.id, model, { snapshot: true });
  await store.saveModel(p.id, model, { snapshot: true });
  await fs.mkdir(cfg.paths.defaultSpecsDir(p.id), { recursive: true });
  await fs.writeFile(
    path.join(cfg.paths.defaultSpecsDir(p.id), "human.md"),
    "Approved human requirement\n".repeat(230),
  );
  p = await store.getProject(p.id);
  const before = await bytes(cfg.paths.projectDir(p.id));
  const response = await api(`/projects/${p.id}/trash`, {
    confirmation: p.id,
    expectedUpdatedAt: p.updatedAt,
  });
  expect(response.status).toBe(200);
  expect((await store.listProjects()).some((x) => x.id === p.id)).toBe(false);
  const entry = (await recovery.listTrash()).find((x) => x.projectId === p.id)!;
  expect(await bytes(await trashRoot(entry.id))).toEqual(before);
  expect((await api(`/trash/${entry.id}/restore`, {})).status).toBe(200);
  const restored = await store.getProject(p.id);
  expect(restored).toMatchObject({
    id: p.id,
    name: p.name,
    description: p.description,
    additionalContext: p.additionalContext,
    screens: p.screens,
    outputDir: p.outputDir,
  });
  const after = await bytes(cfg.paths.projectDir(p.id));
  delete after["project.json"];
  delete before["project.json"];
  expect(after).toEqual(before);
});

it("requires exact confirmation and a current revision before moving a live project", async () => {
  const p = await store.createProject({
    name: "Move confirmation",
    description: "Keep",
  });
  expect((await api(`/projects/${p.id}/trash`, {})).status).toBe(400);
  expect(
    (
      await api(`/projects/${p.id}/trash`, {
        confirmation: "wrong",
        expectedUpdatedAt: p.updatedAt,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await api(`/projects/${p.id}/trash`, {
        confirmation: p.id,
        expectedUpdatedAt: "old",
      })
    ).status,
  ).toBe(409);
  expect((await store.getProject(p.id)).description).toBe("Keep");
  expect((await recovery.listTrash()).some((e) => e.projectId === p.id)).toBe(
    false,
  );
});

it("refuses active work and prevents a new job racing a reversible move", async () => {
  const p = await store.createProject({
    name: "Busy trash",
    description: "Keep",
  });
  let finish!: () => void;
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  const job = await jobs.startJob("generate", p.id, async () => gate);
  await expect(
    life.moveProjectToTrash(p.id, p.id, p.updatedAt),
  ).rejects.toMatchObject({ status: 409 });
  finish();
  await jobs.waitForJob(job.id);
  const liveRoot = cfg.paths.projectDir(p.id);
  const native = await import("./windowsStorageGuard"),
    original = native.renameOwnedDirectory;
  const spy = vi
    .spyOn(native, "renameOwnedDirectory")
    .mockImplementation(async (from, to, identity) => {
      if (String(from) === liveRoot)
        await expect(
          jobs.startJob("export", p.id, async () => null),
        ).rejects.toThrow(/being copied or deleted/i);
      await original(from, to, identity);
    });
  try {
    await life.moveProjectToTrash(
      p.id,
      p.id,
      (await store.getProject(p.id)).updatedAt,
    );
    expect(spy).toHaveBeenCalledOnce();
  } finally {
    spy.mockRestore();
  }
});

it("rejects wrong confirmation and stale saved proposals before removing any trash bytes", async () => {
  const { entry } = await move("Trash revision");
  const root = await trashRoot(entry.id);
  const plan = await life.previewTrashDeletion(entry.id);
  expect(
    (
      await api(`/trash/${entry.id}/permanent-delete`, {
        confirmation: "wrong",
        expectedRevision: plan.revision,
      })
    ).status,
  ).toBe(400);
  const record = JSON.parse(
    await fs.readFile(path.join(root, "project.json"), "utf8"),
  );
  record.description = "Changed after review";
  await fs.writeFile(path.join(root, "project.json"), JSON.stringify(record));
  const saved = await bytes(root);
  expect(
    (
      await api(`/trash/${entry.id}/permanent-delete`, {
        confirmation: entry.id,
        expectedRevision: plan.revision,
      })
    ).status,
  ).toBe(409);
  expect(await bytes(root)).toEqual(saved);
  const fresh = await life.previewTrashDeletion(entry.id);
  expect(
    (
      await api(`/trash/${entry.id}/permanent-delete`, {
        confirmation: entry.id,
        expectedRevision: fresh.revision,
      })
    ).status,
  ).toBe(200);
});

it("purges the exact saved project while preserving a same-named new project and its jobs", async () => {
  const project = await store.createProject({
    name: "Reusable project name",
    description: "Old saved data",
  });
  const oldJob = await jobs.startJob("export", project.id, async () => ({
    saved: true,
  }));
  await jobs.waitForJob(oldJob.id);
  // Finished jobs remain associated with their exact project identity.
  await store.deleteProject(project.id);
  const entry = (await recovery.listTrash()).find(
    (e) => e.projectId === project.id,
  )!;
  const current = await store.createProject({
    name: project.name,
    description: "New live data",
  });
  expect(current.id).not.toBe(project.id);
  const job = await jobs.startJob("export", current.id, async () => ({
    synthetic: true,
  }));
  await jobs.waitForJob(job.id);
  const plan = await life.previewTrashDeletion(entry.id);
  await life.permanentlyDeleteTrashedProject(entry.id, entry.id, plan.revision);
  expect((await store.getProject(current.id)).description).toBe(
    "New live data",
  );
  expect((await jobs.getJob(job.id)).projectId).toBe(current.id);
  await expect(jobs.getJob(oldJob.id)).rejects.toMatchObject({ status: 404 });
});

it("purges one saved project without damaging another same-named Trash entry", async () => {
  const older = await move("Repeated trash version");
  const oldRoot = await trashRoot(older.entry.id);
  const original = await bytes(oldRoot);
  const newer = await move(older.project.name);
  expect(newer.project.id).not.toBe(older.project.id);
  expect(newer.entry.id).not.toBe(older.entry.id);
  const plan = await life.previewTrashDeletion(newer.entry.id);
  await life.permanentlyDeleteTrashedProject(
    newer.entry.id,
    newer.entry.id,
    plan.revision,
  );
  expect(await bytes(oldRoot)).toEqual(original);
  expect((await recovery.restoreFromTrash(older.entry.id)).id).toBe(
    older.project.id,
  );
});

it("refuses junctions and invalid entry identifiers without touching their targets", async () => {
  const target = path.join(dataDir, "junction-target");
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "keep.txt"), "Keep");
  const id = "junction-2000-01-01T00-00-00-000Z",
    link = path.join(
      process.env.SCREENSCRIBE_V2_WORKSPACE_DIR!,
      ".coherence-trash",
      id,
    );
  await fs.symlink(
    target,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  try {
    await expect(life.previewTrashDeletion(id)).rejects.toThrow();
  } finally {
    await fs.unlink(link);
  }
  await expect(
    life.previewTrashDeletion("../settings.json"),
  ).rejects.toMatchObject({ status: 404 });
  expect(await fs.readFile(path.join(target, "keep.txt"), "utf8")).toBe("Keep");
});

it("retains the live project when the reversible move fails", async () => {
  const p = await store.createProject({
    name: "Move disk failure",
    description: "Keep",
  });
  const before = await bytes(cfg.paths.projectDir(p.id));
  const rename = vi
    .spyOn(await import("./windowsStorageGuard"), "renameOwnedDirectory")
    .mockRejectedValueOnce(
      Object.assign(new Error("Synthetic move failure"), { code: "EIO" }),
    );
  try {
    await expect(
      life.moveProjectToTrash(p.id, p.id, p.updatedAt),
    ).rejects.toThrow("Synthetic move failure");
  } finally {
    rename.mockRestore();
  }
  expect(await bytes(cfg.paths.projectDir(p.id))).toEqual(before);
});

it("keeps the saved record when permanent deletion hits an I/O failure", async () => {
  const { entry } = await move("Purge disk failure");
  const root = await trashRoot(entry.id),
    before = await bytes(root);
  const plan = await life.previewTrashDeletion(entry.id);
  const remove = vi
    .spyOn(await import("./inventory"), "purgeReviewedTree")
    .mockRejectedValueOnce(new Error("Synthetic removal failure"));
  try {
    await expect(
      life.permanentlyDeleteTrashedProject(entry.id, entry.id, plan.revision),
    ).rejects.toThrow("Synthetic removal failure");
  } finally {
    remove.mockRestore();
  }
  expect(await bytes(root)).toEqual(before);
});

it("serializes restore versus purge and refuses stale approvals after restore", async () => {
  const { project, entry } = await move("Concurrent recovery");
  const plan = await life.previewTrashDeletion(entry.id);
  const results = await Promise.allSettled([
    recovery.restoreFromTrash(entry.id),
    life.permanentlyDeleteTrashedProject(entry.id, entry.id, plan.revision),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const live = (await store.listProjects()).some((p) => p.id === project.id),
    saved = (await recovery.listTrash()).some((e) => e.id === entry.id);
  expect(saved).toBe(false);
  if (live)
    await expect(
      life.permanentlyDeleteTrashedProject(entry.id, entry.id, plan.revision),
    ).rejects.toMatchObject({ status: 404 });
});

it("authenticates new trash reads/writes and retains Origin/CSRF protection", async () => {
  const { entry } = await move("Private trash");
  for (const [url, method] of [
    [`/trash/${entry.id}/deletion-preview`, "GET"],
    [`/trash/${entry.id}/permanent-delete`, "POST"],
    ["/projects/private/trash", "POST"],
  ]) {
    expect(
      (
        await fetch(origin + "/api" + url, {
          method,
          headers: { "X-ScreenScribe": "1" },
        })
      ).status,
    ).toBe(401);
  }
  expect(
    (
      await auth.fetch(origin + `/api/trash/${entry.id}/permanent-delete`, {
        method: "POST",
        headers: {
          Origin: "https://unrelated.fixture.invalid",
          "Content-Type": "application/json",
          "X-ScreenScribe": "1",
        },
        body: "{}",
      })
    ).status,
  ).toBe(403);
  expect((await recovery.listTrash()).some((e) => e.id === entry.id)).toBe(
    true,
  );
});
